import assert from 'node:assert/strict';

/** The caller owns PostgreSQL startup, teardown and reporting. */
export async function runInventoryDeactivationChecks({ db, sql, check }) {
  const a = '59899000949', b = '59899000959';
  const context = (businessId = a, actorId = 'inventory-deactivation-checks') => ({ businessId, actorId, permissions: ['inventory:receive', 'inventory:sell', 'inventory:reserve', 'inventory:adjust', 'inventory:update', 'inventory:deactivate'] });
  const plan = (operationId, actions, owner = a) => ({ contractVersion: 1, businessId: owner, operationId, actions });
  const target = (skuId, expectedRevision) => ({ kind: 'existing', skuId, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  const rows = async (owner = a) => (await sql.query('SELECT * FROM products WHERE owner_phone=$1 ORDER BY id', [owner])).rows;
  const row = async (id, owner = a) => (await rows(owner)).find((entry) => entry.id === id);
  const selection = async (id) => (await sql.query('SELECT * FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2', [a, id])).rows[0];
  const history = async () => ({ operations: (await sql.query('SELECT * FROM inventory_operations WHERE owner_phone=$1 ORDER BY operation_id', [a])).rows, movements: (await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 ORDER BY operation_id,item_id', [a])).rows, transactions: (await sql.query('SELECT * FROM transactions WHERE owner_phone=$1 ORDER BY id', [a])).rows });
  const seed = async (id, { owner = a, name = `Deactivation check ${id}`, size } = {}) => {
    const result = await db.executeInventoryOperation(plan(`${id}-seed`, [{ itemId: 'seed', type: 'stock.receive', target: { kind: 'new', sku: { name, unit: 'box', ...(size === undefined ? {} : { size }) } }, quantity: { value: 10, unit: 'box' }, price: { amount: 900, currency: 'UYU', policy: 'initialize' } }], owner), context(owner));
    return result.items[0].skuId;
  };
  const request = (requestId, skuIds) => ({ requestId, selector: { kind: 'ids', skuIds }, mutation: { type: 'sku.deactivate', reason: 'Retiro confirmado del catálogo' } });
  const preview = (input, ctx = context()) => db.previewInventorySelection(input, ctx);
  const confirm = (p, ctx = context()) => db.confirmInventorySelection(p.selectionId, p.digest, ctx);
  const sell = (id, operationId) => db.executeInventoryOperation(plan(operationId, [{ itemId: 'sale', type: 'stock.sell', target: target(id), quantity: { value: 2, unit: 'box' } }]), context());
  const assertPreserved = (actual, before) => {
    assert.equal(actual.inventory_status, 'inactive');
    assert.equal(Number(actual.inventory_revision), Number(before.inventory_revision) + 1);
    for (const field of ['stock_available', 'stock_reserved', 'price', 'price_currency', 'name', 'inventory_unit']) assert.equal(actual[field], before[field], `${field} must survive deactivation`);
  };
  const assertReceipt = async (result, ids) => {
    assert.deepEqual(result.items.map((item) => item.skuId).sort(), [...ids].sort());
    for (const item of result.items) {
      const actual = await row(item.skuId);
      assert.equal(item.type, 'sku.deactivate'); assert.equal(item.status, 'inactive');
      assert.equal(item.product.status, 'inactive'); assert.equal(item.product.id, item.skuId);
      assert.equal(item.product.revision, Number(actual.inventory_revision));
      assert.equal(item.revision, Number(actual.inventory_revision));
      assert.equal(Object.hasOwn(item, 'quantity'), false);
    }
    const movements = (await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2 ORDER BY item_id', [a, result.operationId])).rows;
    assert.equal(movements.length, ids.length);
    for (const movement of movements) assert.deepEqual([Number(movement.delta_available), Number(movement.delta_reserved), movement.unit], [0, 0, 'box']);
    assert.deepEqual((await sql.query('SELECT result_json FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [a, result.operationId])).rows[0].result_json, result);
  };
  let completed = 0;
  const run = async (label, fn) => { await check(`inventory deactivation: ${label}`, fn); completed++; };

  await run('single reviewed delete preserves SQL product, balances and complete prior history', async () => {
    const id = await seed('deactivate-single');
    await sell(id, 'deactivate-single-prior-sale');
    const original = await row(id), ledgerBefore = await history();
    const p = await preview(request('deactivate-single', [id]));
    assert.deepEqual(await row(id), original); assert.deepEqual(await history(), ledgerBefore);
    assert.equal(await db.deleteProductRecord(id, a, { selectionId: p.selectionId, digest: p.digest, actorId: context().actorId }), true);
    const result = await confirm(p);
    await assertReceipt(result, [id]); assertPreserved(await row(id), original);
    const after = await history();
    for (const key of ['operations', 'movements', 'transactions']) {
      for (const entry of ledgerBefore[key]) assert.ok(after[key].some((value) => JSON.stringify(value) === JSON.stringify(entry)), `prior ${key} survive`);
    }
    assert.equal((await db.getStateSnapshotStrict(a)).products.some((entry) => entry.id === id), false, 'query snapshots hide inactive stock');
    await assert.rejects(preview(request('deactivate-single-again', [id])), { code: 'SKU_INACTIVE' });
  });

  await run('batch uses frozen members and all selector excludes inactive products', async () => {
    const name = 'Deactivation frozen variants';
    const first = await seed('deactivate-batch-first', { name, size: 'S' }), second = await seed('deactivate-batch-second', { name, size: 'M' });
    const originals = [await row(first), await row(second)];
    const input = { ...request('deactivate-batch', []), selector: { kind: 'filter', equals: { name } } };
    const p = await preview(input);
    const later = await seed('deactivate-batch-later', { name, size: 'L' });
    assert.deepEqual(await preview(input), p);
    assert.equal(await db.deleteProductRecords({ selectionId: p.selectionId, digest: p.digest }, a, { actorId: context().actorId }), 2);
    await assertReceipt(await confirm(p), [first, second]);
    assertPreserved(await row(first), originals[0]); assertPreserved(await row(second), originals[1]);
    assert.equal((await row(later)).inventory_status, 'active');
    const all = await preview({ ...request('deactivate-all-active', []), selector: { kind: 'all' } });
    assert.ok(all.members.every((entry) => ![first, second].includes(entry.skuId)));
    await assert.rejects(preview({ ...request('deactivate-explicit-inactive', []), selector: { kind: 'filter', equals: { status: 'inactive' } } }), { code: 'SKU_INACTIVE' });
  });

  await run('identical concurrent confirmations apply exactly once and replay the receipt', async () => {
    const id = await seed('deactivate-confirm-race'), original = await row(id);
    const p = await preview(request('deactivate-confirm-race', [id]));
    const results = await Promise.all([confirm(p), confirm(p)]);
    assert.deepEqual(results[0], results[1]); assertPreserved(await row(id), original);
    await assertReceipt(results[0], [id]);
    assert.equal((await sql.query('SELECT * FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [a, results[0].operationId])).rowCount, 1);
    assert.equal((await selection(p.selectionId)).status, 'applied');
    await sql.query("UPDATE inventory_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND selection_id=$2", [a, p.selectionId]);
    assert.deepEqual(await confirm(p), results[0]);
  });

  await run('sale versus reviewed deactivation serializes and cannot sell inactive stock', async () => {
    const id = await seed('deactivate-sale-race');
    const p = await preview(request('deactivate-sale-race', [id]));
    const results = await Promise.allSettled([confirm(p), sell(id, 'deactivate-racing-sale')]);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    const failure = results.find((entry) => entry.status === 'rejected').reason;
    assert.ok(['REVISION_MISMATCH', 'SKU_INACTIVE'].includes(failure.code));
    const actual = await row(id);
    if (results[0].status === 'fulfilled') {
      assert.equal(actual.inventory_status, 'inactive'); assert.equal(Number(actual.stock_available), 10);
      await assert.rejects(sell(id, 'deactivate-after-inactive-sale'), { code: 'SKU_INACTIVE' });
    } else {
      assert.equal(actual.inventory_status, 'active'); assert.equal(Number(actual.stock_available), 8);
      const newer = await preview(request('deactivate-after-sale', [id])); await confirm(newer);
      await assert.rejects(sell(id, 'deactivate-after-sale-inactive'), { code: 'SKU_INACTIVE' });
    }
  });

  await run('stale batch and movement insertion failures roll back every member and ledger', async () => {
    const first = await seed('deactivate-stale-first'), second = await seed('deactivate-stale-second');
    const stale = await preview(request('deactivate-stale', [first, second]));
    await sell(second, 'deactivate-stale-sale');
    let before = await rows(), ledgerBefore = await history();
    await assert.rejects(confirm(stale), { code: 'REVISION_MISMATCH' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
    assert.equal((await selection(stale.selectionId)).status, 'pending');
    const p = await preview(request('deactivate-rollback', [first, second]));
    before = await rows(); ledgerBefore = await history();
    await sql.query(`CREATE FUNCTION deactivation_movement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' THEN RAISE EXCEPTION 'simulated deactivation movement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER deactivation_movement_failure BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION deactivation_movement_failure()`);
    try {
      await assert.rejects(confirm(p), /simulated deactivation movement failure/);
      assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
      assert.equal((await selection(p.selectionId)).status, 'pending'); assert.equal((await selection(p.selectionId)).result_json, null);
    } finally {
      await sql.query('DROP TRIGGER deactivation_movement_failure ON inventory_movements; DROP FUNCTION deactivation_movement_failure()');
    }
    await assertReceipt(await confirm(p), [first, second]);
  });

  await run('reservations prohibit preview and invalidate earlier reviewed deactivation', async () => {
    const id = await seed('deactivate-reservations');
    const p = await preview(request('deactivate-before-reserve', [id]));
    await db.executeInventoryOperation(plan('deactivate-reserve', [{ itemId: 'reserve', type: 'stock.reserve', target: target(id), quantity: { value: 1, unit: 'box' } }]), context());
    const before = await rows(), ledgerBefore = await history();
    await assert.rejects(preview(request('deactivate-reserved-preview', [id])), { code: 'SKU_HAS_RESERVATIONS' });
    await assert.rejects(confirm(p), { code: 'REVISION_MISMATCH' });
    const revision = Number((await row(id)).inventory_revision);
    await assert.rejects(db.executeInventoryOperation(plan('deactivate-reserved-direct', [{ itemId: 'one', type: 'sku.deactivate', target: target(id, revision), reason: 'Retiro' }]), context()), { code: 'SKU_HAS_RESERVATIONS' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
  });

  await run('tenant, actor, permission, digest and expiry boundaries make no stock writes', async () => {
    const id = await seed('deactivate-boundary');
    await seed('deactivate-foreign', { owner: b });
    const p = await preview(request('deactivate-boundary', [id]));
    const before = await rows(), ledgerBefore = await history();
    await assert.rejects(confirm(p, context(b)), { code: 'SELECTION_NOT_FOUND' });
    await assert.rejects(confirm(p, context(a, 'foreign-actor')), { code: 'SELECTION_NOT_FOUND' });
    await assert.rejects(confirm(p, { ...context(), permissions: ['inventory:update'] }), { code: 'FORBIDDEN' });
    await assert.rejects(preview(request('deactivate-forbidden', [id]), { ...context(), permissions: [] }), { code: 'FORBIDDEN' });
    await assert.rejects(preview(request('deactivate-cross-tenant', [id]), context(b)), { code: 'SKU_NOT_FOUND' });
    await assert.rejects(db.confirmInventorySelection(p.selectionId, '0'.repeat(64), context()), { code: 'SELECTION_CONFIRMATION_MISMATCH' });
    await sql.query("UPDATE inventory_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND selection_id=$2", [a, p.selectionId]);
    await assert.rejects(confirm(p), { code: 'SELECTION_EXPIRED' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
  });

  await run('legacy deletes require deactivation selection of the exact single scope', async () => {
    const first = await seed('deactivate-gate-first'), second = await seed('deactivate-gate-second');
    const p = await preview(request('deactivate-gate', [first]));
    const update = await preview({ ...request('deactivate-wrong-type', [first]), mutation: { type: 'sku.update', changes: { price: 1 }, reason: 'Precio revisado' } });
    const many = await preview(request('deactivate-wrong-scope', [first, second]));
    const before = await rows(), ledgerBefore = await history();
    await assert.rejects(db.deleteProductRecord(first, a), { code: 'SELECTION_REQUIRED' });
    await assert.rejects(db.deleteProductRecords([first], a), { code: 'SELECTION_REQUIRED' });
    await assert.rejects(db.deleteProductRecord(second, a, { selectionId: p.selectionId, digest: p.digest, actorId: context().actorId }), { code: 'SELECTION_SCOPE_MISMATCH' });
    await assert.rejects(db.deleteProductRecord(first, a, { selectionId: many.selectionId, digest: many.digest, actorId: context().actorId }), { code: 'SELECTION_SCOPE_MISMATCH' });
    await assert.rejects(db.deleteProductRecord(first, a, { selectionId: update.selectionId, digest: update.digest, actorId: context().actorId }), { code: 'SELECTION_OPERATION_MISMATCH' });
    await assert.rejects(db.deleteProductRecords({ selectionId: update.selectionId, digest: update.digest }, a, { actorId: context().actorId }), { code: 'SELECTION_OPERATION_MISMATCH' });
    await assert.rejects(db.applyActionsToDatabase([{ type: 'delete_product', productName: '*' }], 'Borrá todo', a), { code: 'SELECTION_REQUIRED' });
    await assert.rejects(db.applyActionsToDatabase([{ type: 'delete_product', productId: first, productName: 'Deactivation check' }], 'Borrá este', a), { code: 'SELECTION_REQUIRED' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
    await db.applyActionsToDatabase([{ type: 'delete_product', productId: first }], 'Retiro revisado', a,
      { selectionId: p.selectionId, digest: p.digest, actorId: context().actorId });
    assert.equal((await row(first)).inventory_status, 'inactive');
    assert.equal((await row(second)).inventory_status, 'active');
  });

  await run('legacy whole writers preserve inactive rows and direct orders cannot resurrect them', async () => {
    const name = 'Deactivation legacy protected';
    const id = await seed('deactivate-legacy', { name });
    const customer = await db.createClientRecord({ name: 'Cliente retiro' }, a);
    const pending = await db.createPedidoRecord({ clienteId: customer.id, producto: name, qty: 2, estado: 'pendiente' }, a);
    const p = await preview(request('deactivate-legacy', [id])); await confirm(p);
    const inactive = await row(id);
    await db.applyActionsToDatabase([{ type: 'client_order', clientName: 'Cliente escritura posterior', productName: 'Deactivation unrelated pending order', qty: 1 }], 'Nuevo pedido', a,
      { messageId: 'deactivate-legacy-whole-writer' });
    assert.deepEqual(await row(id), inactive, 'whole-state writer retains the inactive row intact');
    await assert.rejects(db.updatePedidoRecord(pending.id, { estado: 'conseguido' }, a), { code: 'SKU_INACTIVE' });
    await assert.rejects(db.applyActionsToDatabase([{ type: 'update_pedido', productName: name, estado: 'conseguido' }], 'Pedido conseguido', a,
      { messageId: 'deactivate-legacy-inactive-order' }), { code: 'SKU_INACTIVE' });
    assert.deepEqual(await row(id), inactive);
    await assert.rejects(db.executeInventoryOperation(plan('deactivate-duplicate-receive', [{ itemId: 'new', type: 'stock.receive', target: { kind: 'new', sku: { name, unit: 'box' } }, quantity: { value: 1, unit: 'box' } }]), context()), { code: 'DUPLICATE_SKU_IDENTITY' });
    for (const type of ['stock.receive', 'stock.sell', 'stock.reserve', 'stock.adjust', 'sku.update']) {
      const fields = type === 'stock.adjust' ? { balances: { available: 1 }, reason: 'Conteo' }
        : type === 'sku.update' ? { changes: { price: 0 }, reason: 'Precio' } : { quantity: { value: 1, unit: 'box' } };
      await assert.rejects(db.executeInventoryOperation(plan(`deactivate-inactive-${type}`, [{ itemId: 'one', type, target: target(id, Number(inactive.inventory_revision)), ...fields }]), context()), { code: 'SKU_INACTIVE' });
    }
    assert.deepEqual(await row(id), inactive);
  });
  return completed;
}
