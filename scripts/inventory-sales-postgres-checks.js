import assert from 'node:assert/strict';

/** Real PostgreSQL checks; the caller owns database startup, teardown and reporting. */
export async function runInventorySalesChecks({ db, sql, check }) {
  const a = '59899000707', b = '59899000808';
  const context = (businessId) => ({ businessId, actorId: 'inventory-sales-checks', permissions: ['inventory:receive', 'inventory:sell', 'inventory:reserve'] });
  const plan = (businessId, operationId, actions) => ({ contractVersion: 1, businessId, operationId, actions });
  const action = (type, skuId, value, itemId = 'one', extra = {}) => ({ itemId, type, target: { kind: 'existing', skuId }, quantity: { value, unit: 'unit' }, ...extra });
  const receive = async (owner, id, quantity = 10) => {
    const receipt = await db.executeInventoryOperation(plan(owner, `${id}-receive`, [{ itemId: 'seed', type: 'stock.receive', target: { kind: 'new', sku: { name: `Sales check ${id}`, unit: 'unit' } }, quantity: { value: quantity, unit: 'unit' }, price: { amount: 900, currency: 'UYU', policy: 'initialize' } }]), context(owner));
    return receipt.items[0].skuId;
  };
  const rows = async (owner, skuId) => (await sql.query('SELECT stock_available,stock_reserved,price,price_currency FROM products WHERE owner_phone=$1 AND id=$2', [owner, skuId])).rows;
  const ledger = async (owner, operationId) => ({
    receipts: (await sql.query('SELECT result_json FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, operationId])).rows,
    movements: (await sql.query('SELECT item_id,sku_id,delta_available,delta_reserved FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2 ORDER BY item_id', [owner, operationId])).rows,
  });
  const emptyLedger = async (owner, id) => assert.deepEqual(await ledger(owner, id), { receipts: [], movements: [] });
  let completed = 0;
  const run = async (label, fn) => { await check(`inventory sales: ${label}`, fn); completed++; };

  await run('concurrent sale and reservation cannot oversell the same SKU', async () => {
    const skuId = await receive(a, 'sales-race', 5);
    const settled = await Promise.allSettled([
      db.executeInventoryOperation(plan(a, 'sales-race-sell', [action('stock.sell', skuId, 4)]), context(a)),
      db.executeInventoryOperation(plan(a, 'sales-race-reserve', [action('stock.reserve', skuId, 4)]), context(a)),
    ]);
    const winners = settled.filter((entry) => entry.status === 'fulfilled');
    const losers = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(winners.length, 1); assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'INSUFFICIENT_STOCK');
    const row = (await rows(a, skuId))[0];
    assert.equal(Number(row.stock_available), 1);
    assert.equal(Number(row.stock_reserved), winners[0].value.items[0].type === 'stock.reserve' ? 4 : 0);
    const stored = await Promise.all(['sales-race-sell', 'sales-race-reserve'].map((id) => ledger(a, id)));
    assert.equal(stored.reduce((sum, value) => sum + value.receipts.length, 0), 1);
    assert.equal(stored.reduce((sum, value) => sum + value.movements.length, 0), 1);
    assert.equal(stored.flatMap((value) => value.movements).reduce((sum, movement) => sum + Number(movement.delta_available), 0), -4);
  });

  await run('concurrent exact replay records one sale with receipt money distinct from catalog', async () => {
    const skuId = await receive(a, 'sales-replay', 12);
    const p = plan(a, 'sales-replay-sell', [action('stock.sell', skuId, 3, 'one', { salePrice: { amount: 125, currency: 'USD' } })]);
    const results = await Promise.all(Array.from({ length: 6 }, () => db.executeInventoryOperation(p, context(a))));
    for (const result of results) {
      assert.deepEqual(result, results[0]);
      assert.equal(result.items[0].price, 125); assert.equal(result.items[0].currency, 'USD');
      assert.equal(result.items[0].totalAmount, 375); assert.equal(result.items[0].catalogPrice, 900);
      assert.equal(result.items[0].quantity.value, 3);
    }
    const row = (await rows(a, skuId))[0];
    assert.equal(Number(row.stock_available), 9); assert.equal(Number(row.stock_reserved), 0);
    assert.equal(Number(row.price), 900); assert.equal(row.price_currency, 'UYU');
    const stored = await ledger(a, p.operationId);
    assert.equal(stored.receipts.length, 1); assert.deepEqual(stored.receipts[0].result_json, results[0]);
    assert.equal(stored.movements.length, 1); assert.equal(Number(stored.movements[0].delta_available), -3); assert.equal(Number(stored.movements[0].delta_reserved), 0);
    for (const changed of [plan(a, p.operationId, [action('stock.sell', skuId, 4)]), plan(a, p.operationId, [action('stock.reserve', skuId, 3)]), plan(a, p.operationId, [action('stock.sell', skuId, 3, 'one', { salePrice: { amount: 126, currency: 'USD' } })])]) {
      await assert.rejects(db.executeInventoryOperation(changed, context(a)), { code: 'IDEMPOTENCY_CONFLICT' });
    }
    assert.deepEqual(await rows(a, skuId), [row]);
  });

  await run('mixed sequential batch preserves unknown and explicit zero prices in stored receipt', async () => {
    const skuId = await receive(a, 'sales-mixed', 6);
    const id = 'sales-mixed-apply';
    const result = await db.executeInventoryOperation(plan(a, id, [action('stock.receive', skuId, 2, 'one'), action('stock.sell', skuId, 3, 'two'), action('stock.reserve', skuId, 2, 'three', { salePrice: { amount: 0, currency: 'USD' } })]), context(a));
    // The persisted receipt exposes final balances; the pure planner tests cover
    // the intermediate balances for repeated SKU actions.
    assert.deepEqual(result.items.map((item) => [item.stockAvailable, item.stockReserved]), [[3, 2], [3, 2], [3, 2]]);
    assert.equal(result.items[1].price, null); assert.equal(result.items[1].currency, null); assert.equal(result.items[1].totalAmount, null);
    assert.equal(result.items[2].price, 0); assert.equal(result.items[2].currency, 'USD'); assert.equal(result.items[2].totalAmount, 0);
    const stored = await ledger(a, id);
    assert.deepEqual(stored.receipts[0].result_json, result);
    assert.deepEqual(stored.movements.map((movement) => [Number(movement.delta_available), Number(movement.delta_reserved)]), [[2, 0], [-2, 2], [-3, 0]]);
    const row = (await rows(a, skuId))[0];
    assert.equal(Number(row.stock_available), 3); assert.equal(Number(row.stock_reserved), 2); assert.equal(Number(row.price), 900); assert.equal(row.price_currency, 'UYU');
  });

  await run('foreign SKU, scope and action permission failures leave no receipt', async () => {
    const foreign = await receive(b, 'sales-foreign');
    for (const type of ['stock.sell', 'stock.reserve']) {
      const id = `sales-foreign-${type}`;
      await assert.rejects(db.executeInventoryOperation(plan(a, id, [action(type, foreign, 1)]), context(a)), { code: 'SKU_NOT_FOUND' });
      await emptyLedger(a, id);
      await assert.rejects(db.executeInventoryOperation(plan(b, `${id}-permission`, [action(type, foreign, 1)]), { ...context(b), permissions: ['inventory:receive'] }), { code: 'FORBIDDEN' });
      await emptyLedger(b, `${id}-permission`);
    }
    await assert.rejects(db.executeInventoryOperation(plan(a, 'sales-scope', [action('stock.sell', foreign, 1)]), context(b)), { code: 'BUSINESS_SCOPE_MISMATCH' });
    assert.equal(Number((await rows(b, foreign))[0].stock_available), 10);
  });

  await run('insufficient later SKU rolls back earlier sale and all ledger rows', async () => {
    const first = await receive(a, 'sales-atomic-first', 7), second = await receive(a, 'sales-atomic-second', 1);
    const before = [await rows(a, first), await rows(a, second)];
    await assert.rejects(db.executeInventoryOperation(plan(a, 'sales-atomic-fail', [action('stock.sell', first, 3), action('stock.reserve', second, 2, 'two')]), context(a)), { code: 'INSUFFICIENT_STOCK' });
    assert.deepEqual([await rows(a, first), await rows(a, second)], before);
    await emptyLedger(a, 'sales-atomic-fail');
  });

  await run('movement failure rolls back sale, reservation and receipt', async () => {
    const skuId = await receive(a, 'sales-movement-failure', 9);
    const before = await rows(a, skuId);
    await sql.query(`CREATE FUNCTION sales_inventory_movement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${a}' AND NEW.operation_id='sales-trigger-fail' THEN RAISE EXCEPTION 'simulated sales movement failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER sales_inventory_movement_failure BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION sales_inventory_movement_failure()`);
    try {
      await assert.rejects(db.executeInventoryOperation(plan(a, 'sales-trigger-fail', [action('stock.sell', skuId, 2), action('stock.reserve', skuId, 3, 'two')]), context(a)));
      assert.deepEqual(await rows(a, skuId), before); await emptyLedger(a, 'sales-trigger-fail');
    } finally {
      await sql.query('DROP TRIGGER sales_inventory_movement_failure ON inventory_movements; DROP FUNCTION sales_inventory_movement_failure()');
    }
  });

  await run('confirmed compatibility sales use explicit SKU and receipt prices with exact replay', async () => {
    const skuId = await receive(a, 'sales-compatibility', 10);
    const actions = [{ type: 'sell', productId: skuId, productName: 'Ignored misleading display label', qty: 2, unit: 'unit', price: 125, priceCurrency: 'USD' }, { type: 'reserve_stock', productId: skuId, qty: 3, unit: 'unit' }];
    const options = { operationId: 'sales-compatibility-apply', channel: 'panel', actorId: 'sales-checks' };
    const result = await db.applyActionsToDatabase(actions, 'Confirmed sale and reserve', a, options);
    const again = await db.applyActionsToDatabase(actions, 'Confirmed sale and reserve', a, options);
    assert.deepEqual(again.operationResult, result.operationResult);
    assert.ok(Array.isArray(result.products), 'returns authoritative snapshot');
    assert.equal(result.products.find((product) => product.id === skuId).stockAvailable, 5);
    assert.equal(result.operationResult.items[0].price, 125); assert.equal(result.operationResult.items[0].totalAmount, 250);
    assert.equal(result.operationResult.items[1].price, null); assert.equal(result.operationResult.items[1].totalAmount, null);
    const row = (await rows(a, skuId))[0];
    assert.equal(Number(row.stock_available), 5); assert.equal(Number(row.stock_reserved), 3); assert.equal(Number(row.price), 900);
    const stored = await ledger(a, 'panel:sales-compatibility-apply');
    assert.equal(stored.receipts.length, 1); assert.equal(stored.movements.length, 2);
  });

  await run('compatibility rejects fuzzy and missing SKUs and mixed financial actions atomically', async () => {
    const skuId = await receive(a, 'sales-compat-invalid', 10);
    const before = await rows(a, skuId);
    const productCount = (await sql.query('SELECT count(*) AS count FROM products WHERE owner_phone=$1', [a])).rows[0].count;
    let sequence = 0;
    for (const actions of [[{ type: 'sell', productName: 'Sales check sales-compat-invalid', qty: 1 }], [{ type: 'reserve_stock', productId: 'missing-sales-sku', productName: 'Must not create', qty: 1 }], [{ type: 'sell', productId: skuId, qty: 1 }, { type: 'register_debt', clientName: 'Must not create', amount: 100 }]]) {
      const operationId = `sales-compat-invalid-${++sequence}`;
      await assert.rejects(db.applyActionsToDatabase(actions, 'Invalid compatibility batch', a, { operationId, channel: 'panel', actorId: 'sales-checks' }));
      await emptyLedger(a, `panel:${operationId}`);
      assert.deepEqual(await rows(a, skuId), before);
      assert.equal((await sql.query('SELECT count(*) AS count FROM products WHERE owner_phone=$1', [a])).rows[0].count, productCount);
    }
  });
  await run('query prefix and exact sale response share atomic outbox and survive replay', async () => {
    const skuId = await receive(a, 'sales-outbox-prefix', 5);
    const actions = [{ type: 'sell', productId: skuId, qty: 2 }];
    const options = { operationId: 'sales-outbox-prefix', messageId: 'sales-outbox-prefix', channel: 'whatsapp',
      recipient: a, actorId: a, replyPrefix: 'Consulta: hay cinco unidades antes de esta venta.', replyText: 'No usar: vendí 999' };
    const result = await db.applyActionsToDatabase(actions, 'Consulta y venta', a, options);
    assert.match(result.replyText, /Consulta:/); assert.match(result.replyText, /Venta registrada: 2/);
    assert.match(result.replyText, /Disponible: 3/); assert.doesNotMatch(result.replyText, /999/);
    const outbox = (await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', [options.messageId])).rows[0];
    assert.equal(outbox.reply_text, result.replyText);
    const again = await db.applyActionsToDatabase(actions, 'Consulta y venta', a, { ...options, replyPrefix: 'Consulta recalculada, no reemplazar' });
    assert.equal(again.replyText, result.replyText);
    assert.equal(Number((await rows(a, skuId))[0].stock_available), 3);
  });
  await run('outbox failure rolls back stock, receipt and compatible transactions', async () => {
    const skuId = await receive(a, 'sales-outbox-rollback', 5);
    const operationId = 'sales-outbox-rollback';
    const before = await rows(a, skuId);
    await sql.query(`CREATE FUNCTION sales_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='sales-outbox-rollback' THEN RAISE EXCEPTION 'simulated sales outbox failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER sales_outbox_failure BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION sales_outbox_failure()`);
    const actions = [{ type: 'reserve_stock', productId: skuId, qty: 2 }];
    const options = { operationId, messageId: operationId, channel: 'whatsapp', recipient: a, actorId: a };
    try {
      await assert.rejects(db.applyActionsToDatabase(actions, 'Reserva atómica', a, options));
      assert.deepEqual(await rows(a, skuId), before); await emptyLedger(a, `whatsapp:${operationId}`);
      assert.equal((await sql.query('SELECT id FROM transactions WHERE owner_phone=$1 AND batch_id=$2', [a, `${a}:whatsapp:${operationId}`])).rowCount, 0);
    } finally { await sql.query('DROP TRIGGER sales_outbox_failure ON meta_reply_outbox; DROP FUNCTION sales_outbox_failure()'); }
    assert.equal((await db.applyActionsToDatabase(actions, 'Reserva atómica', a, options)).operationResult.items[0].stockReserved, 2);
  });
  await run('concurrent reviewed metadata edit cannot overwrite sale or reserved quantities', async () => {
    const skuId = await receive(a, 'sales-legacy-race', 10);
    await Promise.all([
      db.applyActionsToDatabase([{ type: 'sell', productId: skuId, qty: 2 }], 'Venta', a, { operationId: 'legacy-race-sell', channel: 'panel', actorId: a }),
      db.applyActionsToDatabase([{ type: 'reserve_stock', productId: skuId, qty: 3 }], 'Reserva', a, { operationId: 'legacy-race-reserve', channel: 'panel', actorId: a }),
      db.updateProductRecord(skuId, { name: 'Sales check renamed', productType: 'Tools', productModel: 'New label' }, a,
        { operationId: 'sales-rename-race', expectedRevision: 0, reason: 'Ficha revisada' }).catch((error) => { assert.equal(error.code, 'REVISION_MISMATCH'); }),
    ]);
    const row = (await rows(a, skuId))[0];
    assert.equal(Number(row.stock_available), 5); assert.equal(Number(row.stock_reserved), 3); assert.equal(Number(row.price), 900);
  });
  return completed;
}
