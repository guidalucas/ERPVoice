import { createHash } from 'node:crypto';
import { InventoryOperationError } from './inventoryOperations.js';

const fail = (code, message) => { throw new InventoryOperationError(code, message); };
const invalid = (message) => fail('INVALID_ORDER_OPERATION', message);
export const ORDER_STATES = new Set(['pendiente', 'conseguido', 'descartado']);
const dataFields = ['clienteId', 'proveedorId', 'producto', 'productType', 'productModel', 'talle', 'qty', 'estado', 'notas', 'productId'];
const stable = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const orderRequestDigest = (request) => createHash('sha256').update(JSON.stringify(stable(request))).digest('hex');
const text = (value, field) => { if (typeof value !== 'string' || !value.trim()) invalid(`${field} debe ser texto no vacío.`); return value.trim(); };

/** Closed request, normalized without reading current state, so replay also works after delete. */
export function normalizeOrderRequest(kind, pedidoId, input) {
  if (!['create', 'update', 'delete'].includes(kind)) invalid('Operación de pedido desconocida.');
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('Pedido debe ser un objeto.');
  const allowed = ['operationId', ...(kind !== 'create' ? ['expectedRevision'] : []), ...(kind !== 'delete' ? dataFields : [])];
  const patch = {};
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!allowed.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) invalid(`Campo no permitido: ${String(key)}`);
    if (property.value !== undefined) patch[key] = property.value;
  }
  if (typeof patch.operationId !== 'string' || !patch.operationId.trim()) fail('OPERATION_ID_REQUIRED', 'El pedido necesita un ID estable para reintentar.');
  const result = { contractVersion: 1, kind, operationId: patch.operationId.trim(), pedidoId: kind === 'create' ? null : text(pedidoId, 'pedidoId'), changes: {} };
  if (kind !== 'create') {
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0) invalid('expectedRevision debe ser un entero no negativo.');
    result.expectedRevision = patch.expectedRevision;
  }
  for (const field of dataFields) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    if (field === 'qty') { if (!Number.isSafeInteger(value) || value < 1) invalid('qty debe ser un entero seguro positivo.'); result.changes[field] = value; }
    else if (field === 'estado') { if (!ORDER_STATES.has(value)) invalid('Estado de pedido inválido.'); result.changes[field] = value; }
    else result.changes[field] = value === null && !['clienteId', 'producto'].includes(field) ? null : text(value, field);
  }
  if (kind === 'create') {
    text(result.changes.clienteId, 'clienteId'); text(result.changes.producto, 'producto');
    result.changes = { proveedorId: null, productType: null, productModel: null, talle: null, notas: null, productId: null, qty: 1, estado: 'pendiente', ...result.changes };
  }
  if (kind === 'update' && !Object.keys(result.changes).length) invalid('No hay cambios de pedido.');
  return result;
}

/** Procurement orders: conseguido owns a net receipt, never a sale or reservation. */
export function planOrderTransition(request, current, products) {
  if (request.kind !== 'create' && !current) fail('ORDER_NOT_FOUND', 'Pedido no encontrado.');
  if (current && current.revision !== request.expectedRevision) fail('ORDER_REVISION_MISMATCH', 'El pedido cambió. Revisá su estado antes de confirmar.');
  const next = request.kind === 'delete' ? null : { ...(current ?? {}), ...request.changes };
  const old = current?.stockPosting ?? null;
  if (old && (current.estado !== 'conseguido' || old.skuId !== current.productId || old.quantity !== current.qty || !Number.isSafeInteger(old.quantity) || old.quantity < 1 || typeof old.unit !== 'string')) fail('ORDER_POSTING_INVALID', 'La procedencia del stock del pedido requiere revisión.');
  const changesStock = !next || next.estado !== current?.estado || next.qty !== current?.qty || next.productId !== current?.productId;
  if (current?.estado === 'conseguido' && !old && changesStock) fail('ORDER_RECONCILIATION_REQUIRED', 'Este pedido histórico no tiene un ingreso verificable. Conciliá su stock antes de cambiarlo.');
  const product = next?.productId ? products.find((entry) => entry.id === next.productId) : null;
  if (next?.productId && !product) fail('SKU_NOT_FOUND', 'El SKU elegido no pertenece al inventario del negocio.');
  if (product && (product.status ?? 'active') !== 'active' && changesStock) fail('SKU_INACTIVE', 'El SKU elegido está desactivado.');
  if (next?.estado === 'conseguido' && !next.productId && changesStock) fail('SKU_SELECTION_REQUIRED', 'Elegí un SKU explícito antes de marcar conseguido.');
  const desired = next?.estado === 'conseguido' && !(current?.estado === 'conseguido' && !old)
    ? { skuId: next.productId, quantity: next.qty, unit: product.unit ?? 'unit' } : null;
  const deltas = [];
  if (old && desired && old.skuId === desired.skuId && old.unit === desired.unit) deltas.push({ ...desired, delta: desired.quantity - old.quantity });
  else {
    if (old) deltas.push({ ...old, delta: -old.quantity });
    if (desired) deltas.push({ ...desired, delta: desired.quantity });
  }
  const actions = deltas.filter(({ delta }) => delta !== 0).map(({ skuId, unit, delta }, index) => ({
    itemId: `order-${index + 1}`, type: delta > 0 ? 'stock.receive' : 'stock.withdraw',
    target: { kind: 'existing', skuId }, quantity: { value: Math.abs(delta), unit },
    ...(delta < 0 ? { reason: 'Reversión del ingreso verificable del pedido' } : {}),
  }));
  return { next: next ? { ...next, stockPosting: desired } : null, actions };
}
