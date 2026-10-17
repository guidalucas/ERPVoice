import assert from 'node:assert/strict';
import { inventoryProductFingerprint } from '../server/inventoryOperations.js';

/** PostgreSQL integration checks for the inventory operation contract. */
export async function runInventoryCoreChecks({ db, sql, check }) {
  const context = (businessId) => ({ businessId, actorId: 'inventory-core-checks', permissions: ['inventory:receive'] });
  const plan = (businessId, operationId, actions) => ({ contractVersion: 1, businessId, operationId, actions });
  const fresh = (itemId, name, value = 2, extra = {}) => ({
    itemId, type: 'stock.receive', target: { kind: 'new', sku: { name, attributes: extra.attributes ?? {}, unit: extra.unit ?? 'unit' } },
    quantity: { value, unit: extra.unit ?? 'unit' }, ...(extra.price ? { price: extra.price } : {}),
  });
  const a = '59899000303', b = '59899000404';
  let completed = 0;
  const run = async (label, fn) => { await check(`inventory core: ${label}`, fn); completed++; };
  const counts = async (owner, operationId) => {
    const ops = await sql.query('SELECT result_json FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, operationId]);
    const movements = await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2', [owner, operationId]);
    return { ops, movements };
  };

  await run('concurrent exact replay applies one receipt and one movement', async () => {
    const p = plan(a, 'core-concurrent', [fresh('item-1', 'Core concurrent')]);
    const results = await Promise.all(Array.from({ length: 8 }, () => db.executeInventoryOperation(p, context(a))));
    assert.ok(results.every((r) => r.status === 'applied' && r.items[0].quantity.value === 2));
    const sku = results[0].items[0].skuId;
    const row = await sql.query('SELECT stock_available FROM products WHERE owner_phone=$1 AND id=$2', [a, sku]);
    assert.equal(Number(row.rows[0].stock_available), 2);
    const { ops, movements } = await counts(a, 'core-concurrent'); assert.equal(ops.rowCount, 1); assert.equal(movements.rowCount, 1);
  });

  await run('reusing operation ID with changed quantity is rejected', async () => {
    await assert.rejects(db.executeInventoryOperation(plan(a, 'core-concurrent', [fresh('item-1', 'Core concurrent', 3)]), context(a)), { code: 'IDEMPOTENCY_CONFLICT' });
  });

  await run('operation IDs are independent across businesses', async () => {
    const p = plan(b, 'core-concurrent', [fresh('item-1', 'Other tenant concurrent', 5)]);
    const result = await db.executeInventoryOperation(p, context(b));
    const row = await sql.query('SELECT stock_available FROM products WHERE owner_phone=$1 AND id=$2', [b, result.items[0].skuId]);
    assert.equal(Number(row.rows[0].stock_available), 5);
    assert.equal((await counts(b, 'core-concurrent')).ops.rowCount, 1);
  });

  await run('foreign tenant SKU cannot be received and scope mismatch is forbidden', async () => {
    const other = await db.executeInventoryOperation(plan(b, 'core-own-target', [fresh('item-1', 'Tenant B SKU')]), context(b));
    const existing = { itemId: 'item-1', type: 'stock.receive', target: { kind: 'existing', skuId: other.items[0].skuId }, quantity: { value: 1, unit: 'unit' } };
    await assert.rejects(db.executeInventoryOperation(plan(a, 'core-foreign-target', [existing]), context(a)), { code: 'SKU_NOT_FOUND' });
    await assert.rejects(db.executeInventoryOperation(plan(a, 'core-wrong-context', [fresh('item-1', 'Wrong context')]), context(b)), { code: 'BUSINESS_SCOPE_MISMATCH' });
  });

  await run('a bad second target rolls back the whole batch', async () => {
    const actions = [fresh('item-1', 'Core rollback first'), { itemId: 'item-2', type: 'stock.receive', target: { kind: 'existing', skuId: 'no-such-core-sku' }, quantity: { value: 1, unit: 'unit' } }];
    await assert.rejects(db.executeInventoryOperation(plan(a, 'core-batch-rollback', actions), context(a)), { code: 'SKU_NOT_FOUND' });
    assert.equal((await sql.query("SELECT id FROM products WHERE owner_phone=$1 AND name='Core rollback first'", [a])).rowCount, 0);
    assert.equal((await counts(a, 'core-batch-rollback')).ops.rowCount, 0);
  });

  await run('typed attributes and conversion direction persist distinctly', async () => {
    const attributes = { width: { state: 'known', type: 'number', value: 12 }, material: { state: 'known', type: 'text', value: 'acero' } };
    const result = await db.executeInventoryOperation(plan(a, 'core-typed-units', [fresh('item-1', 'Core typed unit', 4, { attributes, unit: 'box' })]), context(a));
    const row = await sql.query('SELECT attributes_json, inventory_unit FROM products WHERE owner_phone=$1 AND id=$2', [a, result.items[0].skuId]);
    assert.deepEqual(row.rows[0].attributes_json, attributes); assert.equal(row.rows[0].inventory_unit, 'box');
    const directions = await db.executeInventoryOperation(plan(a, 'core-converter-directions', [
      fresh('forward', 'Convertidor de 12 V a 24 V', 2),
      fresh('reverse', 'Convertidor de 24 V a 12 V', 3),
    ]), context(a));
    assert.notEqual(directions.items[0].skuId, directions.items[1].skuId);
    const converted = await db.getStateSnapshotStrict(a);
    assert.equal(converted.products.find((product) => product.id === directions.items[0].skuId).stockAvailable, 2);
    assert.equal(converted.products.find((product) => product.id === directions.items[1].skuId).stockAvailable, 3);
    await assert.rejects(db.executeInventoryOperation(plan(a, 'core-opposite-direction', [{ itemId: 'item-1', type: 'stock.receive', target: { kind: 'existing', skuId: result.items[0].skuId }, quantity: { value: 1, unit: 'piece' } }]), context(a)), { code: 'UNIT_MISMATCH' });
  });

  await run('price initialization conflict writes no SKU or ledger rows', async () => {
    const p = plan(a, 'core-price-conflict', [fresh('item-1', 'Core price conflict', 1, { price: { amount: 900, currency: 'USD', policy: 'initialize' } })]);
    await db.executeInventoryOperation(p, context(a));
    const skuId = (await counts(a, 'core-price-conflict')).ops.rows[0].result_json.items[0].skuId;
    const before = await sql.query('SELECT price,stock_available FROM products WHERE id=$1', [skuId]);
    await assert.rejects(db.executeInventoryOperation(plan(a, 'core-price-conflict-next', [{ itemId: 'item-1', type: 'stock.receive', target: { kind: 'existing', skuId }, quantity: { value: 1, unit: 'unit' }, price: { amount: 901, currency: 'USD', policy: 'initialize' } }]), context(a)), { code: 'PRICE_CONFLICT' });
    const after = await sql.query('SELECT price,stock_available FROM products WHERE id=$1', [skuId]);
    assert.deepEqual(after.rows, before.rows); assert.equal((await counts(a, 'core-price-conflict-next')).ops.rowCount, 0);
  });

  await run('fingerprint detects an identity change made directly in PostgreSQL', async () => {
    const created = await db.executeInventoryOperation(plan(a, 'core-fingerprint-create', [fresh('item-1', 'Core fingerprint')]), context(a));
    const skuId = created.items[0].skuId;
    const row = await sql.query('SELECT * FROM products WHERE owner_phone=$1 AND id=$2', [a, skuId]);
    const product = { id: row.rows[0].id, name: row.rows[0].name, productType: row.rows[0].product_type, productModel: row.rows[0].product_model, size: row.rows[0].size, attributes: row.rows[0].attributes_json, unit: row.rows[0].inventory_unit, status: row.rows[0].inventory_status };
    const fingerprint = inventoryProductFingerprint(product);
    await sql.query("UPDATE products SET inventory_unit='case' WHERE owner_phone=$1 AND id=$2", [a, skuId]);
    const existing = { itemId: 'item-1', type: 'stock.receive', target: { kind: 'existing', skuId, expectedFingerprint: fingerprint }, quantity: { value: 1, unit: 'case' } };
    await assert.rejects(db.executeInventoryOperation(plan(a, 'core-fingerprint-stale', [existing]), context(a)), { code: 'SKU_FINGERPRINT_MISMATCH' });
    assert.equal((await counts(a, 'core-fingerprint-stale')).ops.rowCount, 0);
  });

  await run('movement insert failure rolls back products and operation receipt', async () => {
    await sql.query(`CREATE FUNCTION core_inventory_movement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated inventory movement failure'; END $$; CREATE TRIGGER core_inventory_movement_failure BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION core_inventory_movement_failure()`);
    try {
      await assert.rejects(db.executeInventoryOperation(plan(a, 'core-trigger-rollback', [fresh('item-1', 'Core trigger rollback')]), context(a)));
      assert.equal((await sql.query("SELECT id FROM products WHERE owner_phone=$1 AND name='Core trigger rollback'", [a])).rowCount, 0);
      assert.equal((await counts(a, 'core-trigger-rollback')).ops.rowCount, 0);
    } finally {
      await sql.query('DROP TRIGGER core_inventory_movement_failure ON inventory_movements; DROP FUNCTION core_inventory_movement_failure()');
    }
  });

  await run('legacy whole-table writer retains inventory metadata', async () => {
    const received = await db.executeInventoryOperation(plan(a, 'core-legacy-preserve', [fresh('item-1', 'Core legacy preserve', 1, { attributes: { finish: { state: 'known', type: 'text', value: 'mate' } }, unit: 'pack', price: { amount: 1250, currency: 'UYU', policy: 'initialize' } })]), context(a));
    const skuId = received.items[0].skuId;
    await db.applyActionsToDatabase([{ type: 'payment_received', clientName: 'Metadata preservation check', amount: 0 }], 'legacy metadata preservation', a, { messageId: 'core-legacy-preserve' });
    const row = await sql.query('SELECT attributes_json, inventory_unit, price_currency, stock_available FROM products WHERE owner_phone=$1 AND id=$2', [a, skuId]);
    assert.deepEqual(row.rows[0].attributes_json, { finish: { state: 'known', type: 'text', value: 'mate' } });
    assert.equal(row.rows[0].inventory_unit, 'pack'); assert.equal(row.rows[0].price_currency, 'UYU'); assert.equal(Number(row.rows[0].stock_available), 1);
  });

  await run('safe integer quantities above 32-bit range persist', async () => {
    const quantity = 2147483648;
    const result = await db.executeInventoryOperation(plan(b, 'core-bigint', [fresh('item-1', 'Core bigint', quantity)]), context(b));
    const row = await sql.query('SELECT stock_available FROM products WHERE owner_phone=$1 AND id=$2', [b, result.items[0].skuId]);
    assert.equal(Number(row.rows[0].stock_available), quantity);
  });
  return completed;
}
