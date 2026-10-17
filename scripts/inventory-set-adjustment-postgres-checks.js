import assert from 'node:assert/strict';

export async function runInventorySetAdjustmentChecks({ db, sql, check }) {
  const a = '59899000971', b = '59899000972';
  let sequence = 0;
  const id = () => `set-adjust-check-${++sequence}`;
  const context = (businessId = a, actorId = 'set-adjust-actor', permissions = ['inventory:adjust', 'inventory:receive']) => ({ businessId, actorId, permissions });
  const seed = (extra = {}) => db.createProductRecord({ name: `SET adjust SKU ${id()}`, stockAvailable: 10, stockReserved: 3, price: 99, unit: 'box', ...extra }, a, { operationId: id() });
  const input = (products, balances = { available: 0, reserved: 2 }, requestId = id()) => ({ requestId, selector: { kind: 'ids', skuIds: products.map(({ id }) => id) }, mutation: { type: 'stock.adjust', balances, reason: 'Conteo físico revisado del conjunto' } });
  const preview = (request, ctx = context()) => db.previewInventorySelection(request, ctx);
  const confirm = (p, ctx = context()) => db.confirmInventorySelection(p.selectionId, p.digest, ctx);
  const selection = async (p) => (await sql.query('SELECT * FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2', [a, p.selectionId])).rows[0];
  const state = async () => {
    const result = {};
    for (const table of ['products', 'inventory_operations', 'inventory_movements', 'transactions', 'account_movements', 'universal_operations']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [a])).rows;
    return result;
  };
  const receive = (product, quantity = 2) => db.executeInventoryOperation({ contractVersion: 1, businessId: a, operationId: id(), actions: [{ itemId: 'receive', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: quantity, unit: product.unit } }] }, context());

  await check('SET adjustment preview is effect free and shows exact current/final balances and per-SKU units', async () => {
    const products = [await seed(), await seed({ unit: 'unit' })], request = input(products), before = await state();
    const p = await preview(request);
    assert.deepEqual(await state(), before); assert.equal(p.status, 'pending');
    assert.ok(Date.parse(p.expiresAt) - Date.now() > 14 * 60 * 1000); assert.ok(Date.parse(p.expiresAt) - Date.now() <= 15 * 60 * 1000);
    for (const product of products) {
      const member = p.members.find(({ skuId }) => skuId === product.id);
      assert.deepEqual([member.stockAvailable, member.stockReserved, member.finalAvailable, member.finalReserved, member.unit, member.revision], [10, 3, 0, 2, product.unit, product.revision]);
    }
    assert.deepEqual(await preview(request), p);
    const result = await confirm(p);
    for (const item of result.items) {
      assert.equal(item.type, 'stock.adjust'); assert.equal(item.stockAvailable, 0); assert.equal(item.stockReserved, 2);
      const actual = (await state()).products.find(({ id }) => id === item.skuId);
      assert.equal(Number(actual.stock_available), 0); assert.equal(Number(actual.stock_reserved), 2); assert.equal(Number(actual.inventory_revision), 1); assert.equal(Number(actual.price), 99);
    }
    const reservedPreview = await preview(input(products, { reserved: 0 }));
    assert.ok(reservedPreview.members.every(({ finalAvailable, finalReserved }) => finalAvailable === 0 && finalReserved === 0));
    await confirm(reservedPreview);
    assert.ok((await state()).products.filter(({ id }) => products.some((product) => product.id === id)).every(({ stock_available, stock_reserved }) => Number(stock_available) === 0 && Number(stock_reserved) === 0));
  });

  await check('SET adjustment freezes filter membership and partial balances with one concurrent immutable confirmation', async () => {
    const name = 'SET Conjunto Congelado', first = await seed({ name, size: 'S' }), second = await seed({ name, size: 'M' });
    const request = { ...input([first, second], { available: 1 }), selector: { kind: 'filter', equals: { name } } }, p = await preview(request);
    const later = await seed({ name, size: 'L' });
    assert.deepEqual(await preview(request), p);
    assert.deepEqual(p.members.map(({ skuId }) => skuId).sort(), [first.id, second.id].sort());
    assert.ok(p.members.every(({ finalAvailable, finalReserved }) => finalAvailable === 1 && finalReserved === 3));
    const [one, two] = await Promise.all([confirm(p), confirm(p)]); assert.deepEqual(one, two);
    const after = await state();
    assert.equal(after.inventory_operations.filter(({ operation_id }) => operation_id === one.operationId).length, 1);
    const moves = after.inventory_movements.filter(({ operation_id }) => operation_id === one.operationId);
    assert.equal(moves.length, 2); assert.ok(moves.every(({ delta_available, delta_reserved }) => Number(delta_available) === -9 && Number(delta_reserved) === 0));
    assert.equal(after.transactions.filter(({ batch_id }) => batch_id === `${a}:${one.operationId}`).length, 2);
    assert.equal(Number(after.products.find(({ id }) => id === later.id).stock_available), 10);
    await receive(first);
    await sql.query("UPDATE inventory_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND selection_id=$2", [a, p.selectionId]);
    const changed = await state(); assert.deepEqual(await confirm(p), one); assert.deepEqual(await state(), changed); assert.equal((await selection(p)).status, 'applied');
  });

  await check('SET adjustment revision or fingerprint change rejects every frozen member with pending receipt', async () => {
    for (const kind of ['revision', 'fingerprint']) {
      const products = [await seed(), await seed()], p = await preview(input(products));
      if (kind === 'revision') await receive(products[1]);
      else await sql.query('UPDATE products SET name=$1 WHERE owner_phone=$2 AND id=$3', [`Identidad posterior ${id()}`, a, products[1].id]);
      const before = await state(), pending = await selection(p);
      await assert.rejects(confirm(p), { code: kind === 'revision' ? 'REVISION_MISMATCH' : 'SKU_FINGERPRINT_MISMATCH' });
      assert.deepEqual(await state(), before); assert.deepEqual(await selection(p), pending); assert.equal(pending.status, 'pending'); assert.equal(pending.result_json, null);
    }
  });

  await check('SET adjustment actor, business, permission, digest and expiry checks also protect replay', async () => {
    const product = await seed(), request = input([product]), p = await preview(request), before = await state();
    await assert.rejects(preview(request, context(a, 'set-adjust-actor', ['inventory:update'])), { code: 'FORBIDDEN' });
    await assert.rejects(confirm(p, context(a, 'set-adjust-actor', ['inventory:update'])), { code: 'FORBIDDEN' });
    await assert.rejects(confirm(p, context(a, 'other-actor')), { code: 'SELECTION_NOT_FOUND' });
    await assert.rejects(confirm(p, context(b)), { code: 'SELECTION_NOT_FOUND' });
    await assert.rejects(preview({ ...request, requestId: id() }, context(b)), { code: 'SKU_NOT_FOUND' });
    await assert.rejects(db.confirmInventorySelection(p.selectionId, '0'.repeat(64), context()), { code: 'SELECTION_CONFIRMATION_MISMATCH' });
    assert.deepEqual(await state(), before);
    const result = await confirm(p), after = await state();
    await assert.rejects(confirm(p, context(a, 'set-adjust-actor', [])), { code: 'FORBIDDEN' });
    await assert.rejects(preview(request, context(a, 'set-adjust-actor', [])), { code: 'FORBIDDEN' });
    assert.deepEqual(await state(), after); assert.deepEqual(await confirm(p), result);
    const expiring = await preview(input([product], { reserved: 0 }));
    await sql.query("UPDATE inventory_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND selection_id=$2", [a, expiring.selectionId]);
    const unchanged = await state(); await assert.rejects(confirm(expiring), { code: 'SELECTION_EXPIRED' }); assert.deepEqual(await state(), unchanged);
  });

  await check('SET adjustment closed safe balances and request IDs reject changed intent and bulk direct bypass', async () => {
    const products = [await seed(), await seed()], request = input(products), p = await preview(request), before = await state();
    for (const balances of [{}, { available: -1 }, { reserved: '2' }, { available: 0.5 }, { available: Number.MAX_SAFE_INTEGER + 1 }, { available: null }, { available: 0, price: 1 }]) await assert.rejects(preview(input(products, balances)));
    await assert.rejects(preview({ ...input(products), mutation: { ...request.mutation, changes: { price: 0 } } }));
    await assert.rejects(preview({ ...request, mutation: { ...request.mutation, balances: { available: 1 } } }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await preview(request), p);
    const direct = { contractVersion: 1, businessId: a, operationId: id(), actions: products.map((product, index) => ({ itemId: `adjust-${index}`, type: 'stock.adjust', target: { kind: 'existing', skuId: product.id, expectedRevision: product.revision }, balances: { available: 0 }, reason: 'Sin revisión del conjunto' })) };
    await assert.rejects(db.executeUniversalOperation(direct, context()), { code: 'SELECTION_REQUIRED' });
    assert.deepEqual(await state(), before);
  });

  for (const failure of ['movement', 'receipt', 'selection-status', 'history']) {
    await check(`SET adjustment ${failure} SQL failure rolls back every SKU, ledger, receipt, history and selection status`, async () => {
      const products = [await seed(), await seed()], p = await preview(input(products)), before = await state(), pending = await selection(p);
      const table = { movement: 'inventory_movements', receipt: 'inventory_operations', 'selection-status': 'inventory_selections', history: 'transactions' }[failure];
      await sql.query(`CREATE FUNCTION reject_set_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' THEN RAISE EXCEPTION 'SET adjustment ${failure} failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_set_adjustment BEFORE ${failure === 'selection-status' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_set_adjustment();`);
      try { await assert.rejects(confirm(p), new RegExp(`SET adjustment ${failure} failure`)); }
      finally { await sql.query(`DROP TRIGGER reject_set_adjustment ON ${table}; DROP FUNCTION reject_set_adjustment()`); }
      assert.deepEqual(await state(), before); assert.deepEqual(await selection(p), pending); assert.equal(pending.status, 'pending'); assert.equal(pending.result_json, null);
      const result = await confirm(p); assert.equal(result.items.length, 2); assert.equal((await selection(p)).status, 'applied'); assert.deepEqual(await confirm(p), result);
    });
  }
}
