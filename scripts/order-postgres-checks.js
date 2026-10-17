import assert from 'node:assert/strict';

export async function runOrderChecks({ db, sql, check }) {
  let partyFixtureSequence = 0;
  const createFixtureClient = (input, businessId) => db.createClientRecord({ ...input, operationId: 'order-postgres-checks-party-' + ++partyFixtureSequence }, businessId);
  const createFixtureProveedor = (input, businessId) => db.createProveedorRecord({ ...input, operationId: 'order-postgres-checks-party-' + ++partyFixtureSequence }, businessId);

  const a = '59899000871', b = '59899000872';
  let sequence = 0;
  const id = (label) => `order-check-${label}-${++sequence}`;
  const client = await createFixtureClient({ name: 'Cliente pedidos core' }, a);
  const foreign = await createFixtureClient({ name: 'Cliente ajeno pedidos' }, b);
  const seed = async (label, balance = 10) => db.createProductRecord({ name: `Order SKU ${label}`, stockAvailable: balance, unit: 'box', price: 11, priceCurrency: 'UYU' }, a, { operationId: id(label) });
  const create = (product, extra = {}) => db.createPedidoRecord({ operationId: id('create'), clienteId: client.id,
    producto: `Label ${product.id}`, productId: product.id, qty: 5, ...extra }, a);
  const update = (pedido, changes, operationId = id('update')) => db.updatePedidoRecord(pedido.id, { operationId, expectedRevision: pedido.revision, ...changes }, a);
  const row = async (product) => (await sql.query('SELECT * FROM products WHERE id=$1 AND owner_phone=$2', [product.id,a])).rows[0];
  const order = async (pedido) => (await db.getStateSnapshotStrict(a)).pedidos.find((p) => p.id === pedido.id);
  await check('orders add procurement once, keep immutable receipts, and use exact net postings for quantity and exit', async () => {
    const product = await seed('net'), pending = await create(product);
    assert.equal(Number((await row(product)).stock_available), 10);
    const op = id('achieve'), body = { operationId: op, expectedRevision: pending.revision, estado: 'conseguido' };
    const [first, replay] = await Promise.all([db.updatePedidoRecord(pending.id,body,a), db.updatePedidoRecord(pending.id,body,a)]);
    assert.deepEqual(first,replay); assert.deepEqual(first.stockPosting, { skuId: product.id, quantity: 5, unit: 'box' });
    assert.equal(Number((await row(product)).stock_available), 15);
    const increased = await update(first,{ qty: 7 }); assert.equal(Number((await row(product)).stock_available), 17);
    const lowered = await update(increased,{ qty: 3 }); assert.equal(Number((await row(product)).stock_available), 13);
    const exited = await update(lowered,{ estado: 'descartado', producto: 'Different literal label', qty: 99 });
    assert.equal(exited.stockPosting,null); assert.equal(Number((await row(product)).stock_available),10);
    assert.deepEqual(await db.updatePedidoRecord(pending.id,body,a),first);
    await assert.rejects(db.updatePedidoRecord(pending.id,{ ...body,estado:'descartado' },a),{ code:'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(update(first,{ notas:'stale' }),{ code:'ORDER_REVISION_MISMATCH' });
  });
  await check('achieved creation and deletion share inventory receipt and deletion replay survives the row', async () => {
    const product = await seed('delete',0), achieved = await create(product,{ estado:'conseguido' });
    assert.equal(Number((await row(product)).stock_available),5);
    await assert.rejects(db.deleteClientRecord(client.id,a,{operationId:id('delete-client'),expectedRevision:client.metadataRevision,expectedAccountRevision:client.accountRevision,reason:'Baja de cliente con pedidos'}),{ code:'CLIENT_HAS_ORDERS' });
    const input = { operationId:id('delete'),expectedRevision:achieved.revision };
    const deleted = await db.deletePedidoRecord(achieved.id,a,input);
    assert.equal(deleted.deleted,true); assert.equal(deleted.inventoryResult.items[0].type,'stock.withdraw');
    assert.equal(Object.hasOwn(deleted.inventoryResult.items[0],'price'),false); assert.equal(Number((await row(product)).stock_available),0);
    assert.equal(await order(achieved),undefined); assert.deepEqual(await db.deletePedidoRecord(achieved.id,a,input),deleted);
  });
  await check('orders never clip reversals or partially transfer postings to another SKU', async () => {
    const first = await seed('switch-first',0), second = await seed('switch-second',0), achieved = await create(first,{ estado:'conseguido' });
    await db.executeInventoryOperation({ contractVersion:1, businessId:a, operationId:id('sale'), actions:[{ itemId:'sale',type:'stock.sell',target:{ kind:'existing',skuId:first.id },quantity:{value:4,unit:'box'} }] },{ businessId:a,actorId:a,permissions:['inventory:sell'] });
    const before = await row(first);
    await assert.rejects(update(achieved,{ estado:'pendiente' }),{code:'INSUFFICIENT_STOCK'});
    await assert.rejects(update(achieved,{ productId:second.id }),{code:'INSUFFICIENT_STOCK'});
    assert.deepEqual(await row(first),before); assert.equal(Number((await row(second)).stock_available),0);
    assert.deepEqual(await order(achieved),achieved);
    const raised = await update(achieved,{ qty:6 }); assert.equal(Number((await row(first)).stock_available),2);
    assert.equal(raised.stockPosting.quantity,6);
  });
  await check('order revisions serialize distinct requests and tenant/foreign client/SKU inputs fail closed', async () => {
    const product = await seed('race'), pending = await create(product);
    const results = await Promise.allSettled([update(pending,{ estado:'conseguido' }),update(pending,{ estado:'descartado' })]);
    assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);
    assert.equal(results.find((r)=>r.status==='rejected').reason.code,'ORDER_REVISION_MISMATCH');
    await assert.rejects(db.updatePedidoRecord(pending.id,{operationId:id('foreign-order'),expectedRevision:0,estado:'conseguido'},b),{code:'ORDER_NOT_FOUND'});
    await assert.rejects(create(product,{clienteId:foreign.id,estado:'conseguido'}),{code:'CLIENT_NOT_FOUND'});
    const outside = await db.createProductRecord({name:'Foreign order SKU'},b,{operationId:id('foreign-sku')});
    await assert.rejects(create(outside,{estado:'conseguido'}),{code:'SKU_NOT_FOUND'});
    await assert.rejects(db.createPedidoRecord({clienteId:client.id,producto:'Missing stable ID'},a),{code:'OPERATION_ID_REQUIRED'});
  });
  await check('orders compatibility batch is atomic, has exact receipts/outbox, and does not re-ground on replay', async () => {
    const product = await seed('batch'), first = await create(product), second = await create(product);
    const actions = [first,second].map((p)=>({type:'update_pedido',pedidoId:p.id,expectedRevision:p.revision,productName:p.producto,estado:'conseguido'}));
    const opts = {operationId:id('batch'),messageId:id('message'),recipient:a,actorId:a,channel:'panel'};
    const result = await db.applyActionsToDatabase(actions,'Dos pedidos conseguidos',a,opts);
    assert.equal(result.operationResult.receipts.length,2); assert.equal(Number((await row(product)).stock_available),20);
    const sent = (await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1',[opts.messageId])).rows[0];
    assert.equal(sent.reply_text,result.replyText); assert.match(result.replyText,/Ingreso aplicado: 5 box/);
    const current = await order(first); await update(current,{estado:'pendiente'});
    const replay = await db.applyActionsToDatabase(actions,'Dos pedidos conseguidos',a,opts);
    assert.deepEqual(replay.operationResult,result.operationResult); assert.equal(replay.replyText,result.replyText);
    const fresh = await order(first), untouched = await row(product);
    await assert.rejects(db.applyActionsToDatabase([{type:'update_pedido',pedidoId:fresh.id,expectedRevision:fresh.revision,productName:fresh.producto,estado:'conseguido'},
      {type:'update_pedido',pedidoId:second.id,expectedRevision:99,productName:second.producto,estado:'pendiente'}],'Atomic failure',a,{operationId:id('failed-batch')}),{code:'ORDER_REVISION_MISMATCH'});
    assert.deepEqual(await row(product),untouched); assert.deepEqual(await order(first),fresh);
  });
  await check('ambiguous order names and unlinked SKU hints cannot authorize stock mutations', async () => {
    const product = await seed('ambiguous'), one = await create(product,{producto:'Exact shared order'});
    await create(product,{producto:one.producto});
    await assert.rejects(db.applyActionsToDatabase([{type:'update_pedido',productName:one.producto,estado:'conseguido'}],'Ambiguous',a,{messageId:id('ambiguous'),channel:'meta'}),{code:'ORDER_SELECTION_REQUIRED'});
    const unlinked = await db.createPedidoRecord({operationId:id('unlinked'),clienteId:client.id,producto:product.name},a);
    await assert.rejects(db.applyActionsToDatabase([{type:'update_pedido',productName:unlinked.producto,productId:product.id,estado:'conseguido'}],'Injected model SKU',a,{messageId:id('unlinked-meta'),channel:'meta'}),{code:'SKU_SELECTION_REQUIRED'});
    assert.equal(Number((await row(product)).stock_available),10);
    await sql.query("INSERT INTO pedidos(id,owner_phone,cliente_id,producto,qty,estado) VALUES($1,$2,$3,'Legacy achieved',3,'conseguido')",[id('legacy'),a,client.id]);
    const legacy = (await db.getStateSnapshotStrict(a)).pedidos.find((p)=>p.producto==='Legacy achieved');
    await assert.rejects(update(legacy,{estado:'pendiente',productId:product.id}),{code:'ORDER_RECONCILIATION_REQUIRED'});
  });
  await check('SQL movement failure rolls back order, posting, receipt and history before retry', async () => {
    const product = await seed('rollback'), pending = await create(product), op = id('retry');
    const before = await row(product), count = Number((await sql.query('SELECT count(*) FROM order_operations WHERE owner_phone=$1',[a])).rows[0].count);
    await sql.query(`CREATE OR REPLACE FUNCTION reject_order_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.sku_id='${product.id}' THEN RAISE EXCEPTION 'order test movement rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_order_movement BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION reject_order_movement();`);
    try { await assert.rejects(update(pending,{estado:'conseguido'},op),/order test movement rejection/); }
    finally { await sql.query('DROP TRIGGER reject_order_movement ON inventory_movements; DROP FUNCTION reject_order_movement()'); }
    assert.deepEqual(await row(product),before); assert.deepEqual(await order(pending),pending);
    assert.equal(Number((await sql.query('SELECT count(*) FROM order_operations WHERE owner_phone=$1',[a])).rows[0].count),count);
    const applied = await update(pending,{estado:'conseguido'},op); assert.equal(applied.stockPosting.quantity,5);
  });
  await check('supplier deletion and client merge invalidate order revisions without changing stock provenance', async () => {
    const product = await seed('indirect'), supplier = await createFixtureProveedor({name:'Proveedor revisión pedidos'},a);
    const pedido = await create(product,{estado:'conseguido',proveedorId:supplier.id});
    const before = await row(product);
    await db.deleteProveedorRecord(supplier.id,a,{operationId:id('delete-supplier'),expectedRevision:supplier.metadataRevision,reason:'Desvincular proveedor explícitamente'});
    const withoutSupplier = await order(pedido); assert.equal(withoutSupplier.revision,pedido.revision+1); assert.equal(withoutSupplier.proveedorId,null);
    assert.deepEqual(withoutSupplier.stockPosting,pedido.stockPosting);
    await assert.rejects(update(pedido,{estado:'pendiente'}),{code:'ORDER_REVISION_MISMATCH'});
    const keep = await createFixtureClient({name:'Cliente conserva pedidos'},a);
    await db.mergeClientRecords(keep.id,client.id,a,{operationId:id('client-merge'),expectedKeepRevision:0,expectedMergeRevision:0,expectedKeepMetadataRevision:keep.metadataRevision,expectedMergeMetadataRevision:client.metadataRevision});
    const moved = await order(pedido); assert.equal(moved.clienteId,keep.id); assert.equal(moved.revision,withoutSupplier.revision+1);
    assert.deepEqual(moved.stockPosting,pedido.stockPosting); assert.deepEqual(await row(product),before);
  });
  await check('outbox failure rolls back a whole order batch including auto-created parties and stock', async () => {
    const localClient = await createFixtureClient({name:'Cliente rollback outbox pedidos'},a);
    const product = await seed('outbox'), pending = await create(product,{clienteId:localClient.id});
    const before = await row(product);
    const partyOperationsBefore = (await sql.query('SELECT * FROM party_operations WHERE owner_phone=$1 ORDER BY operation_id', [a])).rows;
    const opts = {operationId:id('outbox-batch'),messageId:id('outbox-message'),recipient:a,channel:'whatsapp'};
    const actions = [{type:'client_order',clientName:'Cliente transitorio rollback',productName:'Pending rollback item'},
      {type:'update_pedido',productName:pending.producto,estado:'conseguido'}];
    await sql.query(`CREATE FUNCTION reject_order_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${opts.messageId}' THEN RAISE EXCEPTION 'order outbox rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_order_outbox BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION reject_order_outbox();`);
    try { await assert.rejects(db.applyActionsToDatabase(actions,'Atomic outbox failure',a,opts),/order outbox rejection/); }
    finally {await sql.query('DROP TRIGGER reject_order_outbox ON meta_reply_outbox; DROP FUNCTION reject_order_outbox()');}
    assert.deepEqual(await row(product),before); assert.deepEqual(await order(pending),pending);
    assert.equal((await db.getStateSnapshotStrict(a)).clients.some((c)=>c.name==='Cliente transitorio rollback'),false);
    assert.deepEqual((await sql.query('SELECT * FROM party_operations WHERE owner_phone=$1 ORDER BY operation_id', [a])).rows, partyOperationsBefore);
    await db.applyActionsToDatabase(actions,'Atomic outbox failure',a,opts);
    assert.equal(Number((await row(product)).stock_available),15);
  });
}
