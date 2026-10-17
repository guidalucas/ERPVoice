import assert from 'node:assert/strict';

/** The caller owns PostgreSQL startup, teardown and reporting. */
export async function runInventorySelectionsChecks({ db, sql, check }) {
  const a = '59899000929', b = '59899000939';
  const context = (businessId = a, actorId = 'inventory-selection-checks') => ({ businessId, actorId, permissions: ['inventory:receive', 'inventory:update', 'inventory:adjust', 'inventory:sell'] });
  const mutation = (changes = { price: 0 }) => ({ type: 'sku.update', changes, reason: 'Cambios de conjunto revisados' });
  const request = (requestId, skuIds, changes) => ({ requestId, selector: { kind: 'ids', skuIds }, mutation: mutation(changes) });
  const rows = async (owner = a) => (await sql.query('SELECT * FROM products WHERE owner_phone=$1 ORDER BY id', [owner])).rows;
  const row = async (id, owner = a) => (await rows(owner)).find((entry) => entry.id === id);
  const selection = async (id, owner = a) => (await sql.query('SELECT * FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2', [owner, id])).rows[0];
  const history = async () => ({ operations: (await sql.query('SELECT * FROM inventory_operations WHERE owner_phone=$1 ORDER BY operation_id', [a])).rows, movements: (await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 ORDER BY operation_id,item_id', [a])).rows, transactions: (await sql.query('SELECT * FROM transactions WHERE owner_phone=$1 ORDER BY id', [a])).rows });
  const seed = async (id, { owner = a, name = `Selection check ${id}`, size } = {}) => {
    const result = await db.executeInventoryOperation({ contractVersion: 1, businessId: owner, operationId: `${id}-seed`, actions: [{ itemId: 'seed', type: 'stock.receive', target: { kind: 'new', sku: { name, unit: 'box', ...(size === undefined ? {} : { size }) } }, quantity: { value: 10, unit: 'box' }, price: { amount: 900, currency: 'UYU', policy: 'initialize' } }] }, context(owner));
    return result.items[0].skuId;
  };
  const preview = (input, ctx = context()) => db.previewInventorySelection(input, ctx);
  const confirm = (value, ctx = context()) => db.confirmInventorySelection(value.selectionId, value.digest, ctx);
  const adjust = async (id, operationId, available) => {
    const current = await row(id);
    return db.executeInventoryOperation({ contractVersion: 1, businessId: a, operationId, actions: [{ itemId: 'adjust', type: 'stock.adjust', target: { kind: 'existing', skuId: id, expectedRevision: Number(current.inventory_revision) }, balances: { available }, reason: 'Cambio posterior a la vista previa' }] }, context());
  };
  let completed = 0;
  const run = async (label, fn) => { await check(`inventory selections: ${label}`, fn); completed++; };

  await run('preview freezes exact members without inventory or ledger writes', async () => {
    const name = 'Selection frozen model';
    const first = await seed('selection-frozen-first', { name, size: 'S' });
    const second = await seed('selection-frozen-second', { name, size: 'M' });
    const input = { requestId: 'selection-frozen', selector: { kind: 'filter', equals: { name } }, mutation: mutation() };
    const before = await rows(), ledgerBefore = await history();
    const p = await preview(input);
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
    assert.deepEqual(p.members.map((entry) => entry.skuId).sort(), [first, second].sort());
    assert.deepEqual(await preview(input), p, 'request replay returns the frozen preview');
    const later = await seed('selection-frozen-later', { name, size: 'L' });
    assert.deepEqual(await preview(input), p, 'matching later SKU cannot enlarge the preview');
    const result = await confirm(p);
    assert.deepEqual(result.items.map((entry) => entry.skuId).sort(), [first, second].sort());
    assert.equal(Number((await row(first)).price), 0); assert.equal(Number((await row(second)).price), 0);
    assert.equal(Number((await row(later)).price), 900);
    await adjust(first, 'selection-frozen-later-adjust', 4);
    assert.deepEqual(await confirm(p), result, 'applied replay returns the original result after later inventory changes');
    await sql.query('UPDATE inventory_selections SET expires_at=NOW()-INTERVAL \'1 minute\' WHERE owner_phone=$1 AND selection_id=$2', [a, p.selectionId]);
    assert.deepEqual(await confirm(p), result, 'applied receipts remain replayable after expiry');
  });

  await run('two concurrent confirmations apply once and replay exactly', async () => {
    const id = await seed('selection-confirm-race');
    const original = await row(id);
    const p = await preview(request('selection-confirm-race', [id]));
    const results = await Promise.all([confirm(p), confirm(p)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(Number((await row(id)).inventory_revision), Number(original.inventory_revision) + 1);
    const operations = await sql.query('SELECT * FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [a, results[0].operationId]);
    assert.equal(operations.rowCount, 1);
    assert.equal((await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2', [a, results[0].operationId])).rowCount, 1);
    assert.equal((await selection(p.selectionId)).status, 'applied');
  });

  await run('stale member aborts the entire frozen batch and keeps pending status', async () => {
    const first = await seed('selection-stale-first'), second = await seed('selection-stale-second');
    const p = await preview(request('selection-stale', [first, second]));
    await adjust(second, 'selection-stale-adjust', 3);
    const before = await rows(), ledgerBefore = await history();
    await assert.rejects(confirm(p), { code: 'REVISION_MISMATCH' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
    assert.equal((await selection(p.selectionId)).status, 'pending');
  });

  await run('digest, expiry, tenant, actor and permissions protect confirmation', async () => {
    const id = await seed('selection-boundary');
    const p = await preview(request('selection-boundary', [id]));
    const before = await rows(), ledgerBefore = await history();
    await assert.rejects(db.confirmInventorySelection(p.selectionId, '0'.repeat(64), context()), { code: 'SELECTION_CONFIRMATION_MISMATCH' });
    await assert.rejects(confirm(p, context(b)), { code: 'SELECTION_NOT_FOUND' });
    await assert.rejects(confirm(p, context(a, 'foreign-actor')), { code: 'SELECTION_NOT_FOUND' });
    await assert.rejects(confirm(p, { ...context(), permissions: ['inventory:receive'] }), { code: 'FORBIDDEN' });
    await assert.rejects(preview(request('selection-forbidden-preview', [id]), { ...context(), permissions: [] }), { code: 'FORBIDDEN' });
    await assert.rejects(preview(request('selection-cross-tenant', [id]), context(b)), { code: 'SKU_NOT_FOUND' });
    await sql.query('UPDATE inventory_selections SET expires_at=NOW()-INTERVAL \'1 minute\' WHERE owner_phone=$1 AND selection_id=$2', [a, p.selectionId]);
    await assert.rejects(confirm(p), { code: 'SELECTION_EXPIRED' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
    assert.equal((await selection(p.selectionId)).status, 'pending');
  });

  await run('request ID reuse rejects changed mutation or selector', async () => {
    const first = await seed('selection-request-first'), second = await seed('selection-request-second');
    const input = request('selection-request-conflict', [first]);
    const p = await preview(input);
    await assert.rejects(preview(request(input.requestId, [first], { price: 1 })), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(preview(request(input.requestId, [second])), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await preview(input), p);
  });

  await run('new identity conflict aborts all selected updates', async () => {
    const first = await seed('selection-identity-first', { size: 'S' }), second = await seed('selection-identity-second', { size: 'M' });
    const targetName = 'Selection identity destination';
    // Distinct sizes retain distinct target identities in the reviewed batch.
    const p = await preview(request('selection-identity', [first, second], { name: targetName }));
    await seed('selection-identity-conflict', { name: targetName, size: 'M' });
    const before = await rows(), ledgerBefore = await history();
    await assert.rejects(confirm(p), { code: 'DUPLICATE_SKU_IDENTITY' });
    assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
    assert.equal((await selection(p.selectionId)).status, 'pending');
  });

  await run('movement insertion failure rolls back inventory, history and selection status', async () => {
    const first = await seed('selection-failure-first'), second = await seed('selection-failure-second');
    const p = await preview(request('selection-movement-failure', [first, second]));
    const before = await rows(), ledgerBefore = await history();
    await sql.query(`CREATE FUNCTION selection_movement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' THEN RAISE EXCEPTION 'simulated selection movement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER selection_movement_failure BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION selection_movement_failure()`);
    try {
      await assert.rejects(confirm(p), /simulated selection movement failure/);
      assert.deepEqual(await rows(), before); assert.deepEqual(await history(), ledgerBefore);
      assert.equal((await selection(p.selectionId)).status, 'pending');
      assert.equal((await selection(p.selectionId)).result_json, null);
    } finally {
      await sql.query('DROP TRIGGER selection_movement_failure ON inventory_movements; DROP FUNCTION selection_movement_failure()');
    }
    assert.equal((await confirm(p)).items.length, 2, 'same pending selection may retry after transient database failure');
  });

  await run('legacy model writer requires reviewed selection and delegates confirmation', async () => {
    const id = await seed('selection-legacy-model');
    const p = await preview(request('selection-legacy-model', [id], { price: 15 }));
    await assert.rejects(db.updateProductModelRecords({ ids: [id], price: 1 }, a), { code: 'SELECTION_REQUIRED' });
    await assert.rejects(db.updateProductModelRecords({ selectionId: p.selectionId, digest: p.digest }, a, { actorId: 'foreign-actor' }), { code: 'SELECTION_NOT_FOUND' });
    const result = await db.updateProductModelRecords({ selectionId: p.selectionId, digest: p.digest }, a, { actorId: context().actorId });
    assert.deepEqual(result, (await confirm(p)).items.map((item) => item.product));
    assert.equal(Number((await row(id)).price), 15);
  });
  return completed;
}
