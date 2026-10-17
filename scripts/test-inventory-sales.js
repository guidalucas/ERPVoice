import assert from 'node:assert/strict';
import { groundActionsAgainstCatalog } from '../server/voiceCatalogContext.js';
import { InventoryOperationError, validateOperationPlan, operationDigest, inventoryProductFingerprint, planInventoryOperation, planInventoryReceipt } from '../server/inventoryOperations.js';

const permissions = ['inventory:receive', 'inventory:sell', 'inventory:reserve'];
const context = { businessId: 'sales-shop', actorId: 'sales-tests', permissions };
const action = (type = 'stock.sell', itemId = 'one', value = 2, extra = {}) => ({ itemId, type, target: { kind: 'existing', skuId: 'sku' }, quantity: { value, unit: 'unit' }, ...extra });
const plan = (actions = [action()]) => ({ contractVersion: 1, operationId: 'sales-op', businessId: context.businessId, actions });
const product = (extra = {}) => ({ id: 'sku', name: 'Sales test SKU', unit: 'unit', status: 'active', stockAvailable: 10, stockReserved: 3, price: 900, priceCurrency: 'UYU', ...extra });
const throws = (fn, code) => assert.throws(fn, (error) => error instanceof InventoryOperationError && error.code === code);

for (const type of ['stock.sell', 'stock.reserve']) {
  const input = plan([action(type)]), products = [product()];
  const before = JSON.stringify({ input, products });
  const validated = validateOperationPlan(input, context);
  assert.deepEqual(validated, input);
  assert.ok(Object.isFrozen(validated.actions[0].quantity));
  const effects = planInventoryOperation(input, products);
  assert.equal(effects.changedProducts.length, 1);
  assert.equal(effects.changedProducts[0].stockAvailable, 8);
  assert.equal(effects.changedProducts[0].stockReserved, type === 'stock.reserve' ? 5 : 3);
  assert.equal(effects.changedProducts[0].price, 900);
  assert.equal(effects.changedProducts[0].priceCurrency, 'UYU');
  assert.equal(effects.items[0].price, null);
  assert.equal(effects.items[0].currency, null);
  assert.equal(effects.items[0].totalAmount, null);
  assert.equal(effects.items[0].catalogPrice, 900);
  assert.equal(effects.items[0].catalogCurrency, 'UYU');
  assert.deepEqual(effects.movements.map(({ deltaAvailable, deltaReserved }) => [deltaAvailable, deltaReserved]), [[-2, type === 'stock.reserve' ? 2 : 0]]);
  assert.equal(JSON.stringify({ input, products }), before, 'planner must not mutate any input');
  assert.deepEqual(planInventoryReceipt(input, products), effects, 'receipt alias shares the general engine');

  for (const amount of [0, 75]) {
    const priced = planInventoryOperation(plan([action(type, 'one', 2, { salePrice: { amount, currency: 'USD' } })]), products);
    assert.equal(priced.items[0].price, amount);
    assert.equal(priced.items[0].currency, 'USD');
    assert.equal(priced.items[0].totalAmount, amount * 2);
    assert.equal(priced.items[0].catalogPrice, 900);
    assert.equal(priced.changedProducts[0].price, 900);
    assert.equal(priced.changedProducts[0].priceCurrency, 'UYU');
  }
  throws(() => planInventoryOperation(plan([action(type, 'one', 2, { salePrice: { amount: Number.MAX_SAFE_INTEGER, currency: 'USD' } })]), products), 'MONEY_OVERFLOW');
  throws(() => planInventoryOperation(input, [product({ status: 'inactive' })]), 'SKU_INACTIVE');
  throws(() => planInventoryOperation(input, [product({ unit: 'box' })]), 'UNIT_MISMATCH');
  throws(() => planInventoryOperation(input, []), 'SKU_NOT_FOUND');
  throws(() => planInventoryOperation(plan([action(type, 'one', 2, { target: { kind: 'existing', skuId: 'sku', expectedFingerprint: inventoryProductFingerprint(product({ name: 'Old identity' })) } })]), products), 'SKU_FINGERPRINT_MISMATCH');
  const exact = planInventoryOperation(plan([action(type, 'one', 10)]), products);
  assert.equal(exact.items[0].stockAvailable, 0, 'exact depletion is valid');
  assert.throws(() => planInventoryOperation(plan([action(type, 'one', 11)]), products), (error) => {
    assert.equal(error.code, 'INSUFFICIENT_STOCK');
    assert.equal(error.details.skuId, 'sku');
    assert.equal(error.details.requested, 11);
    assert.equal(error.details.available, 10);
    return error instanceof InventoryOperationError;
  });
  throws(() => validateOperationPlan(input, { ...context, permissions: ['inventory:receive'] }), 'FORBIDDEN');
  throws(() => validateOperationPlan(input, { ...context, permissions: [type === 'stock.sell' ? 'inventory:reserve' : 'inventory:sell'] }), 'FORBIDDEN');
  assert.equal(validateOperationPlan(input, { ...context, permissions: new Set([type === 'stock.sell' ? 'inventory:sell' : 'inventory:reserve']) }).actions[0].type, type);
  throws(() => validateOperationPlan(input, { ...context, businessId: 'other' }), 'BUSINESS_SCOPE_MISMATCH');
  for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', NaN, Infinity]) throws(() => validateOperationPlan(plan([action(type, 'one', value)]), context), 'INVALID_OPERATION_PLAN');
  for (const quantity of [{ value: 1 }, { value: 1, unit: '' }]) throws(() => validateOperationPlan(plan([action(type, 'one', 1, { quantity })]), context), 'INVALID_OPERATION_PLAN');
  throws(() => validateOperationPlan(plan([action(type, 'one', 1, { target: { kind: 'new', sku: { name: 'Must not create' } } })]), context), 'INVALID_OPERATION_PLAN');
  throws(() => validateOperationPlan(plan([action(type, 'one', 1, { price: { amount: 1, currency: 'USD', policy: 'set' } })]), context), 'INVALID_OPERATION_PLAN');
  for (const salePrice of [{ amount: -1, currency: 'USD' }, { amount: 1.5, currency: 'USD' }, { amount: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' }, { amount: 1, currency: 'usd' }, { amount: 1, currency: 'US' }, { amount: 1 }, { amount: 1, currency: 'USD', policy: 'set' }, null]) throws(() => validateOperationPlan(plan([action(type, 'one', 1, { salePrice })]), context), 'INVALID_OPERATION_PLAN');
}

const mixed = plan([action('stock.receive', 'receive', 4), action('stock.sell', 'sell', 3), action('stock.reserve', 'reserve', 2), action('stock.sell', 'sell-again', 1)]);
const mixedProducts = [product({ revision: 7 })];
const beforeMixed = JSON.stringify({ mixed, mixedProducts });
const effects = planInventoryOperation(mixed, mixedProducts);
assert.equal(effects.changedProducts.length, 1);
assert.equal(effects.changedProducts[0].revision, 7);
assert.deepEqual(effects.items.map((item) => [item.stockAvailable, item.stockReserved]), [[14, 3], [11, 3], [9, 5], [8, 5]]);
assert.deepEqual(effects.movements.map((item) => [item.deltaAvailable, item.deltaReserved]), [[4, 0], [-3, 0], [-2, 2], [-1, 0]]);
assert.equal(JSON.stringify({ mixed, mixedProducts }), beforeMixed);
throws(() => validateOperationPlan(mixed, { ...context, permissions: ['inventory:receive', 'inventory:sell'] }), 'FORBIDDEN');
throws(() => planInventoryOperation(plan([action('stock.reserve')]), [product({ stockReserved: Number.MAX_SAFE_INTEGER })]), 'STOCK_OVERFLOW');
const atomicProducts = [product(), product({ id: 'other-sku', name: 'Other SKU', stockAvailable: 1 })];
const atomicBefore = JSON.stringify(atomicProducts);
throws(() => planInventoryOperation(plan([action('stock.sell'), action('stock.reserve', 'two', 2, { target: { kind: 'existing', skuId: 'other-sku' } })]), atomicProducts), 'INSUFFICIENT_STOCK');
assert.equal(JSON.stringify(atomicProducts), atomicBefore, 'a later failure must not mutate earlier SKU');
throws(() => planInventoryOperation(plan([action('stock.sell', 'one', 8), action('stock.reserve', 'two', 3)]), [product()]), 'INSUFFICIENT_STOCK');
throws(() => validateOperationPlan(plan([action('stock.receive', 'one', 1, { salePrice: { amount: 1, currency: 'USD' } })]), context), 'INVALID_OPERATION_PLAN');
assert.notEqual(operationDigest(plan()), operationDigest(plan([action('stock.reserve')])));
assert.notEqual(operationDigest(plan()), operationDigest(plan([action('stock.sell', 'one', 2, { salePrice: { amount: 0, currency: 'USD' } })])));
const catalog = { products: [
  { id: 'forward', name: 'Convertidor de 12 V a 24 V', stockAvailable: 10 },
  { id: 'reverse', name: 'Convertidor de 24 V a 12 V', stockAvailable: 10 },
] };
const parsed = { type: 'sell', productName: catalog.products[1].name, productId: 'forward', resolvedProductId: 'forward', qty: 2 };
const bound = groundActionsAgainstCatalog([parsed, parsed], catalog, 'Vendí dos y otros dos');
assert.equal(bound.actions.length, 2);
assert.ok(bound.actions.every((item) => item.productId === 'reverse' && item.resolvedProductId === undefined));
assert.equal(groundActionsAgainstCatalog([{ type: 'sell', productName: 'Convertidor', qty: 1 }], catalog, 'Vendí un convertidor').missingFields.includes('productMatch'), true);
const sized = { products: [{ id: 'm', name: 'Caja Delta', size: 'M', stockAvailable: 2 }] };
assert.equal(groundActionsAgainstCatalog([{ type: 'reserve_stock', productName: 'Caja Delta', qty: 1 }], sized, 'Reservá una Caja Delta').missingFields.includes('productMatch'), true);
console.log('Inventory sale/reservation contract, pure planner and safe grounding tests passed');
