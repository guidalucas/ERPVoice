import assert from 'node:assert/strict';

/** The caller owns PostgreSQL startup, teardown and reporting. */
export async function runInventoryCreateChecks({ db, sql, check }) {
  const a = '59899000979', b = '59899000989';
  const context = (businessId = a, permissions = ['inventory:create', 'inventory:reserve', 'inventory:receive', 'inventory:sell', 'inventory:deactivate']) => ({ businessId, actorId: 'inventory-create-checks', permissions });
  const plan = (operationId, actions, businessId = a) => ({ contractVersion: 1, businessId, operationId, actions });
  const create = (name, available = 0, reserved = 0, extra = {}) => ({ itemId: 'create', type: 'sku.create', target: { kind: 'new', sku: { name, unit: 'unit' } }, initialStock: { available, reserved }, price: { amount: 0, currency: 'UYU', policy: 'initialize' }, reason: 'Alta confirmada de inventario', ...extra });
  const execute = (id, actions, ctx = context()) => db.executeInventoryOperation(plan(id, actions, ctx.businessId), ctx);
  const rows = async (owner = a) => (await sql.query('SELECT * FROM products WHERE owner_phone=$1 ORDER BY id', [owner])).rows;
  const row = async (id, owner = a) => (await rows(owner)).find((value) => value.id === id);
  const ledger = async () => ({ operations: (await sql.query('SELECT * FROM inventory_operations WHERE owner_phone=$1 ORDER BY operation_id', [a])).rows, movements: (await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 ORDER BY operation_id,item_id', [a])).rows, transactions: (await sql.query('SELECT * FROM transactions WHERE owner_phone=$1 ORDER BY id', [a])).rows });
  const movements = async (id) => (await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2 ORDER BY item_id', [a, id])).rows;
  const options = (operationId) => ({ operationId, actorId: context().actorId, reason: 'Alta manual confirmada', channel: 'panel' });
  const product = (name, extra = {}) => ({ name, stockAvailable: 0, stockReserved: 0, price: 0, ...extra });
  const model = (productModel, extra = {}) => ({ productType: 'Create shirt', productModel, variants: [{ size: 'S', stockAvailable: 0, price: 0 }, { size: 'M', stockAvailable: 5, stockReserved: 2, price: 900 }], ...extra });
  const verifyReceipt = async (result, balances) => {
    assert.equal(result.items.length, balances.length);
    for (let i = 0; i < balances.length; i++) {
      const item = result.items[i], actual = await row(item.skuId), [available, reserved] = balances[i];
      assert.deepEqual([Number(actual.stock_available), Number(actual.stock_reserved), Number(actual.inventory_revision), actual.inventory_status], [available, reserved, 0, 'active']);
      assert.deepEqual([item.type, item.created, item.stockAvailable, item.stockReserved], ['sku.create', true, available, reserved]);
      assert.deepEqual([item.product.id, item.product.revision, item.product.status, item.product.stockAvailable, item.product.stockReserved], [item.skuId, 0, 'active', available, reserved]);
      assert.deepEqual([item.product.price, item.product.priceCurrency, item.product.unit], [Number(actual.price), actual.price_currency, actual.inventory_unit]);
      assert.equal(Object.hasOwn(item, 'quantity'), false);
    }
    assert.deepEqual((await movements(result.operationId)).map((entry) => [Number(entry.delta_available), Number(entry.delta_reserved)]), balances);
    assert.deepEqual((await sql.query('SELECT result_json FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [a, result.operationId])).rows[0].result_json, result);
  };
  let completed = 0;
  const run = async (label, fn) => { await check(`inventory create: ${label}`, fn); completed++; };

  await run('zero and positive initial balances produce exact SQL stock, audit movements and frozen receipts', async () => {
    const zero = await execute('create-zero', [create('Create zero')]); await verifyReceipt(zero, [[0, 0]]);
    const positive = await execute('create-positive', [create('Create positive', 7, 3)]); await verifyReceipt(positive, [[7, 3]]);
    const id = positive.items[0].skuId;
    await execute('create-positive-later-sale', [{ itemId: 'sell', type: 'stock.sell', target: { kind: 'existing', skuId: id }, quantity: { value: 2, unit: 'unit' } }]);
    assert.deepEqual(await execute('create-positive', [create('Create positive', 7, 3)]), positive);
    assert.equal(Number((await row(id)).stock_available), 5);
  });

  await run('same request concurrency creates one SKU, operation and movement; changed content conflicts', async () => {
    const input = create('Create concurrent', 4, 1);
    const results = await Promise.all([execute('create-concurrent', [input]), execute('create-concurrent', [input])]);
    assert.deepEqual(results[0], results[1]); await verifyReceipt(results[0], [[4, 1]]);
    assert.equal((await rows()).filter(({ name }) => name === 'Create concurrent').length, 1);
    assert.equal((await sql.query('SELECT * FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [a, 'create-concurrent'])).rowCount, 1);
    await assert.rejects(execute('create-concurrent', [create('Create concurrent', 5, 1)]), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await run('different requests for one identity serialize to one winner; inactive identity remains protected', async () => {
    const results = await Promise.allSettled([execute('create-identity-a', [create('Create identity race')]), execute('create-identity-b', [create('Create identity race')])]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'DUPLICATE_SKU_IDENTITY');
    const winner = results.find(({ status }) => status === 'fulfilled').value, id = winner.items[0].skuId;
    await execute('create-identity-deactivate', [{ itemId: 'deactivate', type: 'sku.deactivate', target: { kind: 'existing', skuId: id, expectedRevision: 0 }, reason: 'Retiro confirmado' }]);
    await assert.rejects(execute('create-identity-after-archive', [create('Create identity race')]), { code: 'SKU_INACTIVE' });
    assert.equal((await rows()).filter(({ name }) => name === 'Create identity race').length, 1);
  });

  await run('create permissions and business boundaries reject unauthorized writes without requiring receive', async () => {
    const before = await rows(), history = await ledger();
    await assert.rejects(execute('create-no-permission', [create('Forbidden create')], context(a, ['inventory:receive'])), { code: 'FORBIDDEN' });
    await assert.rejects(execute('create-no-reserve', [create('Forbidden reserve', 0, 1)], context(a, ['inventory:create'])), { code: 'FORBIDDEN' });
    await assert.rejects(db.executeInventoryOperation(plan('create-wrong-business', [create('Wrong business')]), context(b)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await ledger(), history);
    await execute('create-without-receive', [create('Only create permission', 3)], context(a, ['inventory:create']));
    const foreign = await execute('create-isolated-id', [create('Tenant identical name')], context(b));
    const local = await execute('create-isolated-id', [create('Tenant identical name')]);
    assert.notEqual(local.items[0].skuId, foreign.items[0].skuId);
    assert.equal((await rows(b)).filter(({ name }) => name === 'Tenant identical name').length, 1);
  });

  await run('single compatibility create requires a stable ID and persists metadata, defaults and retries', async () => {
    await assert.rejects(db.createProductRecord(product('Missing request'), a), { code: 'OPERATION_ID_REQUIRED' });
    const attributes = { material: { state: 'known', type: 'text', value: 'acero' } };
    const input = product('Create adapter typed', { stockAvailable: 6, stockReserved: 2, price: 1200, priceCurrency: 'USD', unit: 'box', attributes, productType: null, productModel: null, size: null });
    const results = await Promise.all([db.createProductRecord(input, a, options('adapter-single')), db.createProductRecord(input, a, options('adapter-single'))]);
    assert.deepEqual(results[0], results[1]);
    const actual = await row(results[0].id);
    assert.deepEqual([Number(actual.stock_available), Number(actual.stock_reserved), Number(actual.price), actual.price_currency, actual.inventory_unit, actual.attributes_json], [6, 2, 1200, 'USD', 'box', attributes]);
    assert.equal((await movements('product-create:adapter-single')).length, 1);
    await assert.rejects(db.createProductRecord({ ...input, price: 1201 }, a, options('adapter-single')), { code: 'IDEMPOTENCY_CONFLICT' });
    const defaults = await db.createProductRecord({ name: 'Create adapter defaults' }, a, options('adapter-defaults'));
    assert.deepEqual([defaults.stockAvailable, defaults.stockReserved, defaults.price], [0, 0, 0]);
  });

  await run('single and model adapters reject unsafe numeric input without partial products or ledger', async () => {
    const before = await rows(), history = await ledger();
    for (const field of ['stockAvailable', 'stockReserved', 'price']) for (const value of [null, '1', -1, 0.25, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      await assert.rejects(db.createProductRecord(product(`Invalid single ${field}`, { [field]: value }), a, options(`invalid-single-${field}-${String(value)}`)));
      await assert.rejects(db.createProductModelRecords(model('Invalid model', { variants: [{ size: 'S', stockAvailable: 1, price: 1 }, { size: 'M', stockAvailable: 2, price: 2, [field]: value }] }), a, options(`invalid-model-${field}-${String(value)}`)));
    }
    assert.deepEqual(await rows(), before); assert.deepEqual(await ledger(), history);
  });

  await run('model create is one atomic operation preserving unit, attributes, currency and frozen retry products', async () => {
    await assert.rejects(db.createProductModelRecords(model('Missing request'), a), { code: 'OPERATION_ID_REQUIRED' });
    const attributes = { material: { state: 'known', type: 'text', value: 'cotton' } };
    const input = model('Atomic model', { unit: 'box', attributes, priceCurrency: 'USD' });
    const products = await db.createProductModelRecords(input, a, options('adapter-model'));
    assert.equal(products.length, 2);
    for (const p of products) { const actual = await row(p.id); assert.deepEqual([actual.inventory_unit, actual.attributes_json, actual.price_currency], ['box', attributes, 'USD']); }
    const entries = await movements('model-create:adapter-model');
    assert.deepEqual(entries.map((entry) => [Number(entry.delta_available), Number(entry.delta_reserved)]).sort((left, right) => left[0] - right[0]), [[0, 0], [5, 2]]);
    const positive = products.find(({ stockAvailable }) => stockAvailable === 5);
    await execute('create-model-later-sale', [{ itemId: 'sell', type: 'stock.sell', target: { kind: 'existing', skuId: positive.id }, quantity: { value: 1, unit: 'box' } }]);
    assert.deepEqual(await db.createProductModelRecords(input, a, options('adapter-model')), products);
    await assert.rejects(db.createProductModelRecords({ ...input, variants: [...input.variants, { size: 'L', stockAvailable: 1, price: 1 }] }, a, options('adapter-model')), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await run('SQL movement failure rolls back every model SKU and ledger and allows retry', async () => {
    const input = model('Rollback model'), before = await rows(), history = await ledger();
    await sql.query(`CREATE FUNCTION create_movement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' AND NEW.operation_id='model-create:rollback-model' THEN RAISE EXCEPTION 'simulated create movement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER create_movement_failure BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION create_movement_failure()`);
    try {
      await assert.rejects(db.createProductModelRecords(input, a, options('rollback-model')), /simulated create movement failure/);
      assert.deepEqual(await rows(), before); assert.deepEqual(await ledger(), history);
    } finally { await sql.query('DROP TRIGGER create_movement_failure ON inventory_movements; DROP FUNCTION create_movement_failure()'); }
    assert.equal((await db.createProductModelRecords(input, a, options('rollback-model'))).length, 2);
  });
  return completed;
}
