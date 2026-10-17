import crypto from 'node:crypto';
import { InventoryOperationError } from './inventoryOperations.js';
import { executeInventoryPlanInTransaction, inventoryRowToProduct } from './inventoryPostgres.js';
import { normalizeOrderRequest, orderRequestDigest, planOrderTransition, orderReceiptAction } from './orderOperations.js';

export const ORDER_SCHEMA_SQL = `
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS product_id TEXT;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS stock_posting_json JSONB;
  ALTER TABLE pedidos ALTER COLUMN qty TYPE BIGINT;
  CREATE TABLE IF NOT EXISTS order_operations (
    owner_phone TEXT NOT NULL, operation_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, request_json JSONB NOT NULL, result_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(owner_phone,operation_id)
  );
`;

export const orderRowToPedido = (row) => ({ id: row.id, ownerPhone: row.owner_phone,
  clienteId: row.cliente_id, proveedorId: row.proveedor_id ?? null, producto: row.producto,
  productType: row.product_type ?? null, productModel: row.product_model ?? null, talle: row.talle ?? null,
  qty: Number(row.qty), estado: row.estado, fechaPedido: new Date(row.fecha_pedido).toISOString(), notas: row.notas ?? null,
  productId: row.product_id ?? null, revision: Number(row.revision ?? 0), stockPosting: row.stock_posting_json ?? null });

/** One transaction, caller-controlled, for order + universal inventory receipt + history/outbox. */
export async function executeOrderInTransaction(client, kind, pedidoId, input, context, persistInventoryTransactions) {
  if (!context?.businessId || context.businessId === '__default__' || !context.actorId) throw new InventoryOperationError('BUSINESS_SCOPE_REQUIRED', 'Falta el contexto autorizado.');
  if (!context.permissions?.includes(`orders:${kind}`)) throw new InventoryOperationError('FORBIDDEN', 'No tenés permiso para esta operación de pedido.');
  const request = normalizeOrderRequest(kind, pedidoId, input), requestHash = orderRequestDigest(request);
  if (request.operationId.startsWith('order-batch-item:') && !context.internalOrderBatch) throw new InventoryOperationError('FORBIDDEN', 'ID reservado para lotes de pedidos.');
  const scope = [context.businessId, request.operationId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['order', ...scope])]);
  const replay = await client.query('SELECT request_hash,result_json FROM order_operations WHERE owner_phone=$1 AND operation_id=$2', scope);
  if (replay.rowCount) {
    if (replay.rows[0].request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID de pedido ya corresponde a otro contenido.');
    return replay.rows[0].result_json;
  }
  const operationId = `order-stock:${crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
  // Same global ordering as the inventory executor: operation lock, products, order row.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([context.businessId, operationId])]);
  await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
  const owners = context.ownerPhoneVariants ?? [context.businessId];
  const existing = kind === 'create' ? null : (await client.query('SELECT * FROM pedidos WHERE id=$1 AND owner_phone=ANY($2) FOR UPDATE', [pedidoId, owners])).rows[0];
  const current = existing ? orderRowToPedido(existing) : null;
  const products = (await client.query('SELECT * FROM products WHERE owner_phone=ANY($1) ORDER BY id FOR UPDATE', [owners])).rows.map(inventoryRowToProduct);
  const transition = planOrderTransition(request, current, products), next = transition.next;
  if (next) {
    const customer = await client.query('SELECT id FROM clients WHERE id=$1 AND owner_phone=ANY($2) FOR KEY SHARE', [next.clienteId, owners]);
    if (!customer.rowCount) throw new InventoryOperationError('CLIENT_NOT_FOUND', 'El cliente no pertenece al negocio.');
    if (next.proveedorId) {
      const supplier = await client.query('SELECT id FROM proveedores WHERE id=$1 AND owner_phone=ANY($2) FOR KEY SHARE', [next.proveedorId, owners]);
      if (!supplier.rowCount) throw new InventoryOperationError('SUPPLIER_NOT_FOUND', 'El proveedor no pertenece al negocio.');
    }
  }
  let inventoryResult = null;
  if (transition.actions.length) {
    const plan = { contractVersion: 1, operationId, businessId: context.businessId,
      source: { channel: context.channel ?? 'orders', text: `Pedido ${kind}: ${current?.id ?? request.operationId}` }, actions: transition.actions };
    inventoryResult = await executeInventoryPlanInTransaction(client, plan, { ...context, internalOrderOperation: true });
    await persistInventoryTransactions(client, plan, inventoryResult);
  }
  let pedido;
  if (!next) {
    const removed = await client.query('DELETE FROM pedidos WHERE id=$1 AND owner_phone=ANY($2) RETURNING id', [pedidoId, owners]);
    if (removed.rowCount !== 1) throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH', 'El pedido no se eliminó como estaba previsto.');
    pedido = current;
  } else {
    const id = current?.id ?? `pedido-${crypto.randomUUID()}`;
    const values = [id, context.businessId, next.clienteId, next.proveedorId, next.producto, next.productType, next.productModel,
      next.talle, next.qty, next.estado, next.notas, next.productId, JSON.stringify(next.stockPosting), (current?.revision ?? -1) + 1];
    const saved = kind === 'create'
      ? await client.query(`INSERT INTO pedidos(id,owner_phone,cliente_id,proveedor_id,producto,product_type,product_model,talle,qty,estado,notas,product_id,stock_posting_json,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *`, values)
      : await client.query(`UPDATE pedidos SET owner_phone=$2,cliente_id=$3,proveedor_id=$4,producto=$5,product_type=$6,product_model=$7,
          talle=$8,qty=$9,estado=$10,notas=$11,product_id=$12,stock_posting_json=$13::jsonb,revision=$14
          WHERE id=$1 AND owner_phone=ANY($15) AND revision=$16 RETURNING *`, [...values, owners, current.revision]);
    if (saved.rowCount !== 1) throw new InventoryOperationError('ORDER_REVISION_MISMATCH', 'El pedido cambió antes de guardarlo.');
    pedido = orderRowToPedido(saved.rows[0]);
    const savedFields = ['clienteId', 'proveedorId', 'producto', 'productType', 'productModel', 'talle', 'qty', 'estado', 'notas', 'productId', 'stockPosting'];
    if (pedido.id !== id || pedido.ownerPhone !== context.businessId || pedido.revision !== values[13]
      || savedFields.some((key) => orderRequestDigest(pedido[key]) !== orderRequestDigest(next[key]))) throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH', 'El pedido persistido difiere del plan.');
  }
  const result = { contractVersion: 1, kind, operationId: request.operationId, businessId: context.businessId, status: 'applied', deleted: kind === 'delete', pedido, inventoryResult };
  await client.query(`INSERT INTO order_operations(owner_phone,operation_id,actor_id,request_hash,request_json,result_json)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`, [...scope, context.actorId, requestHash, JSON.stringify(request), JSON.stringify(result)]);
  const action = orderReceiptAction(kind, pedido);
  await client.query(`INSERT INTO transactions(id,owner_phone,timestamp,source_text,summary,actions_json)
    VALUES($1,$2,NOW(),$3,$4,$5::jsonb)`, [`order-${crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`, context.businessId,
    `Pedido ${kind}`, `${kind === 'delete' ? 'Pedido eliminado' : 'Pedido guardado'}: ${pedido.producto}; ${pedido.estado}; cantidad ${pedido.qty}`, JSON.stringify([action])]);
  return result;
}
