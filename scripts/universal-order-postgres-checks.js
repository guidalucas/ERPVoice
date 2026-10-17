import assert from 'node:assert/strict';

export async function runUniversalOrderChecks({ db, sql, check }) {
  const owner = '59899000965', foreign = '59899000966'; let sequence = 0;
  const id = () => `universal-order-${++sequence}`;
  const permissions = ['orders:create', 'orders:update', 'orders:delete', 'orders:reconcile', 'inventory:receive', 'accounts:payment'];
  const context = (businessId = owner, allowed = permissions) => ({ businessId, actorId: owner, permissions: allowed });
  const plan = (actions, operationId = id()) => ({ contractVersion: 1, businessId: owner, operationId, actions });
  const run = (p, ctx = context()) => db.executeUniversalOperation(p, ctx);
  const customer = (business = owner) => db.createClientRecord({ operationId: id(), name: `Universal pedidos cliente ${id()}` }, business);
  const seed = (business = owner, extra = {}) => db.createProductRecord({ name: `Universal pedidos SKU ${id()}`, stockAvailable: 0, unit: 'box', ...extra }, business, { operationId: id() });
  const create = (client, product, itemId = 'order', extra = {}) => ({ itemId, type: 'order.create', order: { clienteId: client.id, producto: 'Etiqueta explícita de pedido', productId: product.id, qty: 5, estado: 'conseguido', ...extra } });
  const target = (pedido) => ({ kind: 'existing', pedidoId: pedido.id, expectedRevision: pedido.revision });
  const change = (pedido, changes) => ({ itemId: 'update', type: 'order.update', target: target(pedido), changes });
  const remove = (pedido) => ({ itemId: 'delete', type: 'order.delete', target: target(pedido) });
  const stock = async (product) => (await sql.query('SELECT stock_available,stock_reserved FROM products WHERE owner_phone=$1 AND id=$2', [owner, product.id])).rows[0];
  const state = async () => {
    const result = {};
    for (const table of ['products', 'clients', 'proveedores', 'pedidos', 'universal_operations', 'order_operations', 'inventory_operations', 'account_operations', 'party_operations', 'inventory_movements', 'account_movements', 'transactions']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows;
    return result;
  };
  const block = (result) => result.domain === 'orders' ? result.domainResult : result.receipts.find((receipt) => Array.isArray(receipt.receipts));
  const assertStored = async (result) => {
    assert.deepEqual((await sql.query('SELECT result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, result.operationId])).rows[0].result_json, result);
    const receipt = block(result); assert.ok(receipt.operationId.startsWith('universal-child:'));
    assert.deepEqual((await sql.query('SELECT result_json FROM order_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, receipt.operationId])).rows[0].result_json, receipt);
    for (const item of receipt.receipts) {
      assert.ok(item.operationId.startsWith('universal-child:')); assert.ok(item.itemId);
      const stored = (await sql.query('SELECT result_json FROM order_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, item.operationId])).rows[0].result_json;
      const { itemId, ...actual } = item; assert.deepEqual(stored, actual);
    }
  };

  await check('universal orders: achieved multi-create concurrency stores one immutable block and per-item stock receipts', async () => {
    const client = await customer(), products = [await seed(), await seed()], input = plan(products.map((product, index) => create(client, product, `order-${index}`))), before = await state();
    const [one, two] = await Promise.all([run(input), run(input)]); assert.deepEqual(one, two); assert.equal(one.domain, 'orders');
    await assertStored(one); assert.deepEqual(block(one).receipts.map(({ itemId }) => itemId), ['order-0', 'order-1']);
    for (const [index, product] of products.entries()) {
      assert.equal(Number((await stock(product)).stock_available), 5);
      assert.deepEqual(block(one).receipts[index].pedido.stockPosting, { skuId: product.id, quantity: 5, unit: 'box' });
      assert.equal(block(one).receipts[index].inventoryResult.items[0].type, 'stock.receive');
    }
    const after = await state(); assert.equal(after.order_operations.length, before.order_operations.length + 3); assert.equal(after.pedidos.length, before.pedidos.length + 2); assert.equal(after.inventory_movements.length, before.inventory_movements.length + 2); assert.equal(after.transactions.length, before.transactions.length + 4);
    for (const receipt of block(one).receipts) await run(plan([remove(receipt.pedido)]));
    const later = await state(); assert.deepEqual(await run(input), one); assert.deepEqual(await state(), later);
    await assert.rejects(run({ ...input, actions: [create(client, products[0], 'order-0', { qty: 6 }), input.actions[1]] }), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await check('universal orders: quantity/status transitions and deletion reverse exact procurement without consuming reserved stock', async () => {
    const client = await customer(), product = await seed(owner, { stockReserved: 2 });
    let pedido = block(await run(plan([create(client, product)]))).receipts[0].pedido;
    pedido = block(await run(plan([change(pedido, { qty: 7 })]))).receipts[0].pedido; assert.equal(Number((await stock(product)).stock_available), 7);
    pedido = block(await run(plan([change(pedido, { estado: 'pendiente' })]))).receipts[0].pedido; assert.equal(Number((await stock(product)).stock_available), 0);
    pedido = block(await run(plan([change(pedido, { estado: 'conseguido', qty: 3 })]))).receipts[0].pedido;
    const deletion = plan([remove(pedido)]), result = await run(deletion);
    assert.equal(block(result).receipts[0].deleted, true); assert.equal(block(result).receipts[0].inventoryResult.items[0].type, 'stock.withdraw');
    assert.deepEqual(Object.values(await stock(product)).map(Number), [0, 2]); assert.deepEqual(await run(deletion), result);
    const second = await seed(), achieved = block(await run(plan([create(client, second)]))).receipts[0].pedido;
    await db.executeInventoryOperation({ ...plan([{ itemId: 'sale', type: 'stock.sell', target: { kind: 'existing', skuId: second.id }, quantity: { value: 4, unit: 'box' } }]) }, context(owner, ['inventory:sell']));
    const before = await state(); await assert.rejects(run(plan([remove(achieved)])), { code: 'INSUFFICIENT_STOCK' }); assert.deepEqual(await state(), before);
  });

  await check('universal orders: tenant, explicit SKU/client, reviewed revision and permission constraints protect all effects', async () => {
    const client = await customer(), product = await seed(), outsideClient = await customer(foreign), outsideProduct = await seed(foreign), before = await state();
    await assert.rejects(run(plan([create(outsideClient, product)])), { code: 'CLIENT_NOT_FOUND' });
    await assert.rejects(run(plan([create(client, outsideProduct)])), { code: 'SKU_NOT_FOUND' });
    await assert.rejects(run(plan([create(client, product, 'order', { productId: null })])), { code: 'SKU_SELECTION_REQUIRED' });
    await assert.rejects(run(plan([create(client, product)]), context(foreign)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    await assert.rejects(run(plan([create(client, product)]), context(owner, [])), { code: 'FORBIDDEN' }); assert.deepEqual(await state(), before);
    const pedido = block(await run(plan([create(client, product)]))).receipts[0].pedido;
    await run(plan([change(pedido, { qty: 6 })])); const later = await state();
    await assert.rejects(run(plan([change(pedido, { qty: 7 })])), { code: 'ORDER_REVISION_MISMATCH' }); assert.deepEqual(await state(), later);
  });

  await check('universal orders: earlier inventory and earlier achieved order both roll back on later block failure', async () => {
    const client = await customer(), product = await seed();
    const receive = { itemId: 'receive', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 2, unit: 'box' } };
    const before = await state(); await assert.rejects(run(plan([receive, create({ id: 'missing-order-client' }, product)])), { code: 'CLIENT_NOT_FOUND' }); assert.deepEqual(await state(), before);
    const payment = { itemId: 'payment', type: 'account.payment', target: { kind: 'existing', clientId: client.id }, amount: { value: 1, unit: 'legacy-money' }, reason: 'Pago sin saldo' };
    await assert.rejects(run(plan([create(client, product), payment])), { code: 'PAYMENT_EXCEEDS_DEBT' }); assert.deepEqual(await state(), before);
  });

  await check('universal orders: root and order-block receipt failures roll back order, derived stock, history and every child receipt', async () => {
    const client = await customer(), product = await seed();
    for (const table of ['universal_operations', 'order_operations']) {
      const input = plan([create(client, product)]), before = await state();
      await sql.query(`CREATE FUNCTION universal_order_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' ${table === 'order_operations' ? "AND NEW.result_json ? 'receipts'" : ''} THEN RAISE EXCEPTION 'universal order receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER universal_order_receipt_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION universal_order_receipt_failure()`);
      try { await assert.rejects(run(input), /universal order receipt failure/); } finally { await sql.query(`DROP TRIGGER universal_order_receipt_failure ON ${table}; DROP FUNCTION universal_order_receipt_failure()`); }
      assert.deepEqual(await state(), before); const result = await run(input); await assertStored(result);
    }
  });

  await check('universal orders: historical reconciliation records zero delta and replays proof after order deletion', async () => {
    const client = await customer(), product = await seed(owner, { stockAvailable: 8, stockReserved: 1 }), pedidoId = id();
    await sql.query("INSERT INTO pedidos(id,owner_phone,cliente_id,producto,qty,estado) VALUES($1,$2,$3,'Histórico universal',5,'conseguido')", [pedidoId, owner, client.id]);
    const pedido = (await db.getStateSnapshotStrict(owner)).pedidos.find(({ id }) => id === pedidoId);
    const reconciliation = { productId: product.id, expectedProductRevision: product.revision, expectedFingerprint: product.identityFingerprint, available: 8, reserved: 1, quantity: 5, unit: 'box', reason: 'Conteo físico histórico explícito', confirmed: true };
    const input = plan([{ itemId: 'proof', type: 'order.reconcile', target: target(pedido), reconciliation }]), result = await run(input), receipt = block(result).receipts[0];
    await assertStored(result); assert.equal(receipt.pedido.revision, 1); assert.equal(receipt.inventoryResult.items[0].type, 'stock.adjust');
    assert.deepEqual((await sql.query('SELECT delta_available,delta_reserved FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2', [owner, receipt.inventoryResult.operationId])).rows.map((row) => [Number(row.delta_available), Number(row.delta_reserved)]), [[0, 0]]);
    await run(plan([remove(receipt.pedido)])); const later = await state(); assert.deepEqual(await run(input), result); assert.deepEqual(await state(), later);
  });

  await check('universal orders: derived stock permission never authorizes explicit withdrawal and reserved child IDs cannot enter order core', async () => {
    const client = await customer(), product = await seed(owner, { stockAvailable: 5 }), before = await state();
    const withdraw = { itemId: 'withdraw', type: 'stock.withdraw', target: { kind: 'existing', skuId: product.id }, quantity: { value: 1, unit: 'box' }, reason: 'Retiro explícito sin permiso' };
    await assert.rejects(run(plan([create(client, product), withdraw])), { code: 'FORBIDDEN' }); assert.deepEqual(await state(), before);
    const result = await run(plan([create(client, product)])), receipt = block(result).receipts[0], after = await state();
    await assert.rejects(db.executeOrderOperation('create', null, { ...create(client, product).order, operationId: receipt.operationId }, owner), { code: 'FORBIDDEN' }); assert.deepEqual(await state(), after);
  });
}
