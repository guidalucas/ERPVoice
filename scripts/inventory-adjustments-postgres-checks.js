import assert from 'node:assert/strict';

/** The caller owns PostgreSQL startup, teardown and reporting. */
export async function runInventoryAdjustmentsChecks({ db, sql, check }) {
  let partyFixtureSequence = 0;
  const createFixtureClient = (input, businessId) => db.createClientRecord({ ...input, operationId: 'inventory-adjustments-postgres-checks-party-' + ++partyFixtureSequence }, businessId);

  const a = '59899000909', b = '59899000919';
  const context = (businessId) => ({ businessId, actorId: 'inventory-adjustment-checks', permissions: ['inventory:receive', 'inventory:sell', 'inventory:adjust', 'inventory:update'] });
  const plan = (businessId, operationId, actions) => ({ contractVersion: 1, businessId, operationId, actions });
  const adjust = (skuId, revision, balances, itemId = 'one') => ({ itemId, type: 'stock.adjust', target: { kind: 'existing', skuId, expectedRevision: revision }, balances, reason: 'Conteo físico confirmado' });
  const update = (skuId, revision, changes, itemId = 'one') => ({ itemId, type: 'sku.update', target: { kind: 'existing', skuId, expectedRevision: revision }, changes, reason: 'Metadatos confirmados' });
  const rows = async (owner, skuId) => (await sql.query('SELECT *,inventory_revision AS revision FROM products WHERE owner_phone=$1 AND id=$2', [owner, skuId])).rows;
  const row = async (owner, skuId) => (await rows(owner, skuId))[0];
  const ledger = async (owner, id) => ({ receipts: (await sql.query('SELECT result_json FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, id])).rows, movements: (await sql.query('SELECT item_id,delta_available,delta_reserved,unit FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2 ORDER BY item_id', [owner, id])).rows });
  const emptyLedger = async (owner, id) => assert.deepEqual(await ledger(owner, id), { receipts: [], movements: [] });
  const seed = async (owner, id, quantity = 10) => {
    const result = await db.executeInventoryOperation(plan(owner, `${id}-seed`, [{ itemId: 'seed', type: 'stock.receive', target: { kind: 'new', sku: { name: `Adjustment check ${id}`, unit: 'box' } }, quantity: { value: quantity, unit: 'box' }, price: { amount: 900, currency: 'UYU', policy: 'initialize' } }]), context(owner));
    const skuId = result.items[0].skuId;
    return { skuId, revision: Number((await row(owner, skuId)).revision) };
  };
  let completed = 0;
  const run = async (label, fn) => { await check(`inventory adjustments: ${label}`, fn); completed++; };

  await run('concurrent adjustments with the same revision have exactly one winner', async () => {
    const { skuId, revision } = await seed(a, 'adjust-race');
    const results = await Promise.allSettled([2, 7].map((available) => db.executeInventoryOperation(plan(a, `adjust-race-${available}`, [adjust(skuId, revision, { available })]), context(a))));
    const winners = results.filter((entry) => entry.status === 'fulfilled'), losers = results.filter((entry) => entry.status === 'rejected');
    assert.equal(winners.length, 1); assert.equal(losers.length, 1); assert.equal(losers[0].reason.code, 'REVISION_MISMATCH');
    const actual = await row(a, skuId);
    assert.equal(Number(actual.revision), revision + 1);
    assert.equal(Number(actual.stock_available), winners[0].value.items[0].stockAvailable);
    const entries = await Promise.all([2, 7].map((available) => ledger(a, `adjust-race-${available}`)));
    assert.equal(entries.reduce((sum, entry) => sum + entry.receipts.length, 0), 1);
    assert.equal(entries.reduce((sum, entry) => sum + entry.movements.length, 0), 1);
  });

  await run('a sale invalidates an older adjustment revision', async () => {
    const { skuId, revision } = await seed(a, 'adjust-after-sale');
    await db.executeInventoryOperation(plan(a, 'adjust-sale', [{ itemId: 'sale', type: 'stock.sell', target: { kind: 'existing', skuId }, quantity: { value: 2, unit: 'box' } }]), context(a));
    assert.equal(Number((await row(a, skuId)).revision), revision + 1);
    await assert.rejects(db.executeInventoryOperation(plan(a, 'adjust-stale-sale', [adjust(skuId, revision, { available: 0 })]), context(a)), { code: 'REVISION_MISMATCH' });
    await emptyLedger(a, 'adjust-stale-sale');
    assert.equal(Number((await row(a, skuId)).stock_available), 8);
  });

  await run('a reviewed model edit advances revision and invalidates older absolute adjustments', async () => {
    const { skuId, revision } = await seed(a, 'adjust-legacy-model');
    const preview = await db.previewInventorySelection({ requestId: 'adjust-legacy-model', selector: { kind: 'ids', skuIds: [skuId] },
      mutation: { type: 'sku.update', changes: { name: 'Legacy renamed model', productType: 'Widget', productModel: 'Adjusted' }, reason: 'Modelo revisado' } }, context(a));
    await db.updateProductModelRecords({ selectionId: preview.selectionId, digest: preview.digest }, a, { actorId: context(a).actorId });
    const actual = await row(a, skuId);
    assert.equal(actual.name, 'Legacy renamed model'); assert.equal(Number(actual.revision), revision + 1);
    await assert.rejects(db.executeInventoryOperation(plan(a, 'adjust-stale-model', [adjust(skuId, revision, { available: 0 })]), context(a)), { code: 'REVISION_MISMATCH' });
    await emptyLedger(a, 'adjust-stale-model'); assert.equal(Number((await row(a, skuId)).stock_available), 10);
  });

  await run('order core serializes stock effects with sales and advances revisions', async () => {
    const { skuId, revision } = await seed(a, 'adjust-legacy-direct-order');
    const customer = await createFixtureClient({ name: 'Cliente conteo directo' }, a);
    const pedido = await db.createPedidoRecord({ operationId: 'order-adjust-direct-create', productId: skuId, clienteId: customer.id, producto: 'Adjustment check adjust-legacy-direct-order', qty: 2, estado: 'pendiente' }, a);
    await Promise.all([
      db.updatePedidoRecord(pedido.id, { operationId: 'order-adjust-direct-update', expectedRevision: pedido.revision, estado: 'conseguido' }, a),
      db.executeInventoryOperation(plan(a, 'adjust-direct-order-sale', [{ itemId: 'sale', type: 'stock.sell',
        target: { kind: 'existing', skuId }, quantity: { value: 2, unit: 'box' } }]), context(a)),
    ]);
    const actual = await row(a, skuId);
    assert.equal(Number(actual.stock_available), 10); assert.equal(Number(actual.revision), revision + 2);
    await assert.rejects(db.executeInventoryOperation(plan(a, 'adjust-stale-direct-order', [adjust(skuId, revision, { available: 0 })]), context(a)), { code: 'REVISION_MISMATCH' });
  });

  await run('order compatibility adapter advances revision without losing metadata', async () => {
    const { skuId, revision } = await seed(a, 'adjust-legacy-replace-order');
    const name = 'Adjustment check adjust-legacy-replace-order';
    const customer = await createFixtureClient({ name: 'Cliente conteo reemplazo' }, a);
    await db.createPedidoRecord({ operationId: 'order-adjust-batch-create', productId: skuId, clienteId: customer.id, producto: name, qty: 3, estado: 'pendiente' }, a);
    await db.applyActionsToDatabase([{ type: 'update_pedido', productName: name, estado: 'conseguido' }], 'Pedido confirmado', a,
      { messageId: 'adjust-legacy-replace-order' });
    const actual = await row(a, skuId);
    assert.equal(Number(actual.stock_available), 13); assert.equal(Number(actual.revision), revision + 1);
    assert.equal(actual.inventory_unit, 'box'); assert.equal(actual.price_currency, 'UYU');
    await assert.rejects(db.executeInventoryOperation(plan(a, 'adjust-stale-replace-order', [adjust(skuId, revision, { available: 0 })]), context(a)), { code: 'REVISION_MISMATCH' });
  });

  await run('one mixed plan increments revision once and stores exact deltas and metadata', async () => {
    const { skuId, revision } = await seed(a, 'adjust-mixed');
    const changes = { name: 'Adjusted metadata', productType: null, productModel: 'Model zero', size: null, attributes: { enabled: { state: 'known', type: 'boolean', value: false } }, price: 0, priceCurrency: 'USD' };
    const p = plan(a, 'adjust-mixed-apply', [update(skuId, revision, changes), adjust(skuId, revision, { available: 0, reserved: 4 }, 'two')]);
    const result = await db.executeInventoryOperation(p, context(a));
    const actual = await row(a, skuId);
    assert.equal(Number(actual.revision), revision + 1); assert.equal(Number(actual.stock_available), 0); assert.equal(Number(actual.stock_reserved), 4); assert.equal(Number(actual.price), 0); assert.equal(actual.price_currency, 'USD');
    for (const item of result.items) {
      assert.equal(item.revision, revision + 1); assert.equal(item.skuName, changes.name);
      assert.equal(item.product.name, changes.name); assert.deepEqual(item.product.attributes, changes.attributes);
      assert.equal(item.stockAvailable, 0); assert.equal(item.stockReserved, 4); assert.equal(Object.hasOwn(item, 'quantity'), false);
    }
    const stored = await ledger(a, p.operationId);
    assert.deepEqual(stored.receipts[0].result_json, result);
    assert.deepEqual(stored.movements.map((movement) => [Number(movement.delta_available), Number(movement.delta_reserved), movement.unit]), [[0, 0, 'box'], [-10, 4, 'box']]);
    assert.deepEqual(await db.executeInventoryOperation(p, context(a)), result);
    await db.executeInventoryOperation(plan(a, 'adjust-mixed-later', [adjust(skuId, revision + 1, { available: 8 })]), context(a));
    assert.deepEqual(await db.executeInventoryOperation(p, context(a)), result, 'replay must preserve receipt despite later mutations');
  });

  await run('a later stale SKU rolls back a mixed plan and every ledger row', async () => {
    const first = await seed(a, 'adjust-atomic-first'), second = await seed(a, 'adjust-atomic-second');
    const before = [await rows(a, first.skuId), await rows(a, second.skuId)];
    await assert.rejects(db.executeInventoryOperation(plan(a, 'adjust-atomic-fail', [adjust(first.skuId, first.revision, { available: 1 }), update(second.skuId, second.revision + 1, { price: 0 }, 'two')]), context(a)), { code: 'REVISION_MISMATCH' });
    assert.deepEqual([await rows(a, first.skuId), await rows(a, second.skuId)], before); await emptyLedger(a, 'adjust-atomic-fail');
  });

  await run('tenant scope and individual permissions protect adjustments and metadata', async () => {
    const { skuId, revision } = await seed(b, 'adjust-foreign');
    for (const act of [adjust(skuId, revision, { available: 0 }), update(skuId, revision, { price: 0 })]) {
      const id = `adjust-foreign-${act.type}`;
      await assert.rejects(db.executeInventoryOperation(plan(a, id, [act]), context(a)), { code: 'SKU_NOT_FOUND' }); await emptyLedger(a, id);
      await assert.rejects(db.executeInventoryOperation(plan(b, id, [act]), { ...context(b), permissions: ['inventory:receive'] }), { code: 'FORBIDDEN' }); await emptyLedger(b, id);
      await assert.rejects(db.executeInventoryOperation(plan(b, id, [act]), context(a)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    }
    assert.equal(Number((await row(b, skuId)).revision), revision);
  });

  await run('duplicate identity metadata update rolls back the whole batch', async () => {
    const first = await seed(a, 'adjust-identity-first'), second = await seed(a, 'adjust-identity-second');
    const before = await rows(a, first.skuId);
    const existing = await row(a, second.skuId);
    await assert.rejects(db.executeInventoryOperation(plan(a, 'adjust-identity-fail', [adjust(first.skuId, first.revision, { available: 0 }), update(first.skuId, first.revision, { name: existing.name }, 'two')]), context(a)), { code: 'DUPLICATE_SKU_IDENTITY' });
    assert.deepEqual(await rows(a, first.skuId), before); await emptyLedger(a, 'adjust-identity-fail');
  });

  await run('direct product update returns an immutable receipt product on later replay', async () => {
    const { skuId, revision } = await seed(a, 'adjust-direct');
    const updates = { name: 'Direct confirmed update', price: 0, stockAvailable: 0, stockReserved: 2 };
    const reviewed = (await db.getStateSnapshotStrict(a)).products.find((entry) => entry.id === skuId);
    const options = { operationId: 'adjust-direct-apply', expectedRevision: revision, expectedFingerprint: reviewed.identityFingerprint, reason: 'Corrección de ficha' };
    const result = await db.updateProductRecord(skuId, updates, a, options);
    assert.equal(result.id, skuId); assert.equal(result.revision, revision + 1); assert.equal(result.stockAvailable, 0); assert.equal(result.stockReserved, 2); assert.equal(result.price, 0); assert.equal(result.name, updates.name);
    await db.executeInventoryOperation(plan(a, 'adjust-direct-later', [adjust(skuId, result.revision, { available: 6 })]), context(a));
    assert.deepEqual(await db.updateProductRecord(skuId, updates, a, options), result);
    assert.equal(Number((await row(a, skuId)).stock_available), 6);
  });

  await run('compatibility requires explicit SKU and revision and combines price plus stock atomically', async () => {
    const { skuId, revision } = await seed(a, 'adjust-compat');
    const options = { channel: 'panel', actorId: a, operationId: 'adjust-compat-apply' };
    const actions = [{ type: 'update_product', productId: skuId, expectedRevision: revision, price: 0, stockAvailable: 0, stockReserved: 2, reason: 'Confirmado' }];
    const result = await db.applyActionsToDatabase(actions, 'Actualización confirmada', a, options);
    assert.equal(result.operationResult.items.length, 2);
    assert.deepEqual(new Set(result.operationResult.items.map((item) => item.type)), new Set(['sku.update', 'stock.adjust']));
    const actual = await row(a, skuId); assert.equal(Number(actual.stock_available), 0); assert.equal(Number(actual.stock_reserved), 2); assert.equal(Number(actual.price), 0); assert.equal(Number(actual.revision), revision + 1);
    assert.deepEqual((await db.applyActionsToDatabase(actions, 'Actualización confirmada', a, options)).operationResult, result.operationResult);
    for (const [suffix, action, code] of [['missing-id', { type: 'update_product', productName: actual.name, expectedRevision: revision + 1, price: 1 }, 'SKU_SELECTION_REQUIRED'], ['missing-revision', { type: 'update_product', productId: skuId, price: 1 }, 'INVALID_OPERATION_PLAN']]) {
      await assert.rejects(db.applyActionsToDatabase([action], 'Inválida', a, { ...options, operationId: `adjust-${suffix}` }), { code }); await emptyLedger(a, `panel:adjust-${suffix}`);
    }
  });
  return completed;
}
