import assert from 'node:assert/strict';
import { InventoryOperationError, validateOperationPlan, planInventoryOperation, inventoryProductFingerprint, operationDigest } from '../server/inventoryOperations.js';
import { confirmedStockActionsToPlan, productUpdateActions } from '../server/stockOperationAdapter.js';
import { inventoryResultActions } from '../server/inventoryResults.js';

const context = { businessId: 'adjustment-shop', actorId: 'adjustment-tests', permissions: ['inventory:adjust', 'inventory:update', 'inventory:sell'] };
const product = (extra = {}) => ({ id: 'sku', name: 'Adjustment SKU', unit: 'box', status: 'active', revision: 7, stockAvailable: 10, stockReserved: 3, price: 900, priceCurrency: 'UYU', attributes: {}, ...extra });
const action = (type = 'stock.adjust', extra = {}) => ({ itemId: 'one', type, target: { kind: 'existing', skuId: 'sku', expectedRevision: 7 }, reason: 'Conteo confirmado', ...(type === 'stock.adjust' ? { balances: { available: 4, reserved: 0 } } : { changes: { name: 'Renamed SKU', price: 0, priceCurrency: 'USD' } }), ...extra });
const plan = (actions = [action()]) => ({ contractVersion: 1, operationId: 'adjustments-op', businessId: context.businessId, actions });
const throws = (fn, code = 'INVALID_OPERATION_PLAN') => assert.throws(fn, (error) => error instanceof InventoryOperationError && error.code === code);

for (const type of ['stock.adjust', 'sku.update']) {
  const input = plan([action(type)]), products = [product()];
  const before = JSON.stringify({ input, products });
  const validated = validateOperationPlan(input, context);
  assert.deepEqual(validated, input);
  assert.ok(Object.isFrozen(validated.actions[0].target));
  assert.ok(Object.isFrozen(validated.actions[0][type === 'stock.adjust' ? 'balances' : 'changes']));
  const effects = planInventoryOperation(input, products);
  assert.equal(effects.changedProducts.length, 1);
  assert.equal(effects.changedProducts[0].revision, 7, 'persistence owns the revision increment');
  assert.equal(effects.items[0].type, type);
  assert.equal(effects.items[0].skuId, 'sku');
  assert.equal(effects.items[0].reason, input.actions[0].reason);
  assert.equal(Object.hasOwn(effects.items[0], 'quantity'), false);
  if (type === 'stock.adjust') {
    assert.deepEqual([effects.changedProducts[0].stockAvailable, effects.changedProducts[0].stockReserved], [4, 0]);
    assert.equal(effects.changedProducts[0].price, 900);
    assert.deepEqual(effects.movements.map(({ deltaAvailable, deltaReserved, unit }) => [deltaAvailable, deltaReserved, unit]), [[-6, -3, 'box']]);
    assert.deepEqual([effects.items[0].deltaAvailable, effects.items[0].deltaReserved], [-6, -3]);
  } else {
    assert.equal(effects.changedProducts[0].name, 'Renamed SKU');
    assert.equal(effects.changedProducts[0].price, 0);
    assert.equal(effects.changedProducts[0].priceCurrency, 'USD');
    assert.deepEqual([effects.changedProducts[0].stockAvailable, effects.changedProducts[0].stockReserved], [10, 3]);
    assert.deepEqual(effects.movements.map(({ deltaAvailable, deltaReserved }) => [deltaAvailable, deltaReserved]), [[0, 0]]);
    assert.deepEqual([effects.items[0].deltaAvailable, effects.items[0].deltaReserved], [0, 0]);
  }
  assert.equal(JSON.stringify({ input, products }), before, 'planner must not mutate its inputs');
  throws(() => planInventoryOperation(input, [product({ revision: 8 })]), 'REVISION_MISMATCH');
  throws(() => planInventoryOperation(input, [product({ status: 'inactive' })]), 'SKU_INACTIVE');
  throws(() => planInventoryOperation(input, []), 'SKU_NOT_FOUND');
  throws(() => planInventoryOperation(plan([action(type, { target: { ...action(type).target, expectedFingerprint: inventoryProductFingerprint(product({ name: 'Old identity' })) } })]), products), 'SKU_FINGERPRINT_MISMATCH');
  throws(() => validateOperationPlan(input, { ...context, permissions: ['inventory:receive'] }), 'FORBIDDEN');
  throws(() => validateOperationPlan(input, { ...context, businessId: 'other' }), 'BUSINESS_SCOPE_MISMATCH');
  for (const revision of [undefined, null, -1, 0.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const target = { kind: 'existing', skuId: 'sku', ...(revision === undefined ? {} : { expectedRevision: revision }) };
    throws(() => validateOperationPlan(plan([action(type, { target })]), context));
  }
  for (const reason of [undefined, null, '', ' ', 7]) throws(() => validateOperationPlan(plan([action(type, { reason })]), context));
  for (const field of ['quantity', 'price', 'salePrice', 'unexpected', ...(type === 'stock.adjust' ? ['changes'] : ['balances'])]) {
    throws(() => validateOperationPlan(plan([action(type, { [field]: {} })]), context));
  }
  throws(() => validateOperationPlan(plan([action(type, { target: { kind: 'new', sku: { name: 'Forbidden' } } })]), context));
  assert.notEqual(operationDigest(input), operationDigest(plan([action(type, { reason: 'Another confirmed reason' })])));
}

for (const balances of [{}, null, { available: null }, { available: -1 }, { reserved: 1.5 }, { available: '0' }, { available: Number.MAX_SAFE_INTEGER + 1 }, { available: 1, unit: 'unit' }]) throws(() => validateOperationPlan(plan([action('stock.adjust', { balances })]), context));
for (const changes of [{}, null, { name: null }, { name: ' ' }, { productType: 2 }, { productModel: false }, { size: 12 }, { attributes: null }, { attributes: { color: 'blue' } }, { price: null }, { price: -1 }, { price: 0.5 }, { priceCurrency: 'usd' }, { priceCurrency: 'US' }, { unit: 'unit' }, { stockAvailable: 0 }, { revision: 8 }]) throws(() => validateOperationPlan(plan([action('sku.update', { changes })]), context));
const metadata = { productType: null, productModel: null, size: null, attributes: { color: { state: 'known', type: 'text', value: 'blue' }, count: { state: 'known', type: 'number', value: 0 }, enabled: { state: 'known', type: 'boolean', value: false } } };
const updated = planInventoryOperation(plan([action('sku.update', { changes: metadata })]), [product({ size: 'M' })]);
for (const field of ['productType', 'productModel', 'size']) assert.equal(updated.changedProducts[0][field], null);
assert.deepEqual(updated.changedProducts[0].attributes, metadata.attributes);
for (const balances of [{ available: 0 }, { reserved: 0 }, { available: 10, reserved: 3 }]) {
  const effect = planInventoryOperation(plan([action('stock.adjust', { balances })]), [product()]);
  assert.equal(effect.changedProducts[0].stockAvailable, balances.available ?? 10);
  assert.equal(effect.changedProducts[0].stockReserved, balances.reserved ?? 3);
}
const batch = plan([action('sku.update'), action('stock.adjust', { itemId: 'two' })]);
assert.equal(planInventoryOperation(batch, [product()]).changedProducts.length, 1, 'same original revision may target the same SKU twice');
const reviewedFingerprint = inventoryProductFingerprint(product());
const fingerprintBatch = plan(productUpdateActions('sku', { name: 'Renamed with stock', stockAvailable: 0 },
  { expectedRevision: 7, expectedFingerprint: reviewedFingerprint, reason: 'Reviewed snapshot' }));
assert.equal(planInventoryOperation(fingerprintBatch, [product()]).changedProducts[0].stockAvailable, 0,
  'all preconditions refer to the original snapshot, including after metadata changes');
const originals = [{ type: 'update_product', price: 0, stockAvailable: 9 },
  { type: 'reserve_stock', clientName: 'Ana' }, { type: 'reserve_stock', clientName: 'Bob' }];
const projected = inventoryResultActions({ items: [
  { itemId: 'item-1-update', type: 'sku.update', changes: { price: 0 }, price: 0 },
  { itemId: 'item-1-adjust', type: 'stock.adjust', balances: { available: 9 }, stockAvailable: 9 },
  ...['item-2', 'item-3'].map((itemId) => ({ itemId, type: 'stock.reserve', quantity: { value: 1, unit: 'box' }, price: null })),
] }, originals);
assert.deepEqual(projected.slice(2).map((item) => item.clientName), ['Ana', 'Bob'], 'expanded update items must retain later source action associations');
const duplicateProducts = [product(), product({ id: 'other', name: 'Other SKU' })];
throws(() => planInventoryOperation(plan([action('sku.update', { changes: { name: 'Other SKU' } })]), duplicateProducts), 'DUPLICATE_SKU_IDENTITY');
const atomicBefore = JSON.stringify(duplicateProducts);
throws(() => planInventoryOperation(plan([action(), action('sku.update', { itemId: 'two', changes: { name: 'Other SKU' } })]), duplicateProducts), 'DUPLICATE_SKU_IDENTITY');
assert.equal(JSON.stringify(duplicateProducts), atomicBefore);
const zeroRevision = action('stock.adjust', { target: { kind: 'existing', skuId: 'sku', expectedRevision: 0 } });
assert.equal(planInventoryOperation(plan([zeroRevision]), [product({ revision: 0 })]).changedProducts.length, 1);
const compatibility = (actions) => confirmedStockActionsToPlan({ actions, sourceText: 'Confirmado', ownerPhone: context.businessId, operationId: 'compat-op', products: [product()] });
const adapted = compatibility([{ type: 'update_product', productId: 'sku', expectedRevision: 7, price: 0, stockAvailable: 0, stockReserved: 2 }]);
assert.deepEqual(adapted.actions.map((entry) => entry.type), ['sku.update', 'stock.adjust']);
assert.ok(adapted.actions.every((entry) => entry.reason === 'Actualización confirmada' && entry.target.expectedRevision === 7));
validateOperationPlan(adapted, context);
throws(() => compatibility([{ type: 'update_product', productName: product().name, expectedRevision: 7, price: 0 }]), 'SKU_SELECTION_REQUIRED');
throws(() => validateOperationPlan(compatibility([{ type: 'update_product', productId: 'sku', price: 0 }]), context));
assert.deepEqual(productUpdateActions('sku', { productType: null, price: 0, stockAvailable: 0 }, { expectedRevision: 0, reason: 'Explicit reason' }).map((entry) => entry.target.expectedRevision), [0, 0]);
console.log('Inventory adjustment/update contract and pure planner tests passed');
