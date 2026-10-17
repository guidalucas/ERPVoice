import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryOperationError, validateOperationPlan, planInventoryOperation, operationDigest } from '../server/inventoryOperations.js';
import { productCreationToPlan } from '../server/productCreationAdapter.js';

const context = { businessId: 'create-shop', actorId: 'create-tests', permissions: ['inventory:create', 'inventory:reserve', 'inventory:receive'] };
const attributes = { material: { state: 'known', type: 'text', value: 'acero' }, width: { state: 'known', type: 'number', value: 12, unit: 'mm' } };
const action = (extra = {}) => ({ itemId: 'new', type: 'sku.create', target: { kind: 'new', sku: { name: 'Create SKU', unit: 'box', attributes } }, initialStock: { available: 0, reserved: 0 }, price: { amount: 0, currency: 'UYU', policy: 'initialize' }, reason: 'Alta manual confirmada', ...extra });
const plan = (actions = [action()]) => ({ contractVersion: 1, operationId: 'create-operation', businessId: context.businessId, actions });
const fail = (fn, code = 'INVALID_OPERATION_PLAN') => assert.throws(fn, (error) => error instanceof InventoryOperationError && error.code === code);
const execute = (input = plan(), products = []) => planInventoryOperation(input, products, { createId: () => 'created-sku' });

test('creation adapter validates names before coercion and rejects hidden or foreign fields', () => {
  let coerced = false;
  const name = { toString() { coerced = true; return 'Untrusted name'; } };
  for (const invalid of [{ name }, { name: { toString: null } }, { name: null }, { name: 'SKU', ownerPhone: 'foreign' },
    { name: 'SKU', status: 'inactive' }, { name: 'SKU', price: '0' }, { name: 'SKU', stockAvailable: 0.25 }]) {
    fail(() => productCreationToPlan(invalid, context.businessId, { operationId: 'adapter-boundary' }));
  }
  assert.equal(coerced, false);
  const accessor = { name: 'SKU' };
  Object.defineProperty(accessor, 'unit', { enumerable: true, get() { throw new Error('Getter must not run'); } });
  fail(() => productCreationToPlan(accessor, context.businessId, { operationId: 'adapter-boundary' }));
  const adapted = productCreationToPlan({ name: 'Explicit zero', unit: 'box', attributes }, context.businessId, { operationId: 'adapter-zero' });
  validateOperationPlan(adapted, context);
  assert.deepEqual(adapted.actions[0].initialStock, { available: 0, reserved: 0 });
  assert.equal(Object.hasOwn(adapted.actions[0], 'quantity'), false);
});

test('sku.create records explicit zero balances and catalog price without a synthetic quantity', () => {
  const input = plan(), before = JSON.stringify(input);
  const validated = validateOperationPlan(input, context);
  assert.deepEqual(validated, input);
  assert.ok(Object.isFrozen(validated.actions[0].initialStock));
  assert.ok(Object.isFrozen(validated.actions[0].target.sku.attributes.width));
  const result = execute(input), item = result.items[0], product = result.changedProducts[0];
  assert.equal(result.changedProducts.length, 1);
  assert.deepEqual([product.id, product.stockAvailable, product.stockReserved, product.price, product.priceCurrency, product.revision, product.status], ['created-sku', 0, 0, 0, 'UYU', 0, 'active']);
  assert.deepEqual(product.attributes, attributes);
  assert.deepEqual([item.type, item.created, item.stockAvailable, item.stockReserved, item.price, item.currency, item.unit], ['sku.create', true, 0, 0, 0, 'UYU', 'box']);
  assert.equal(Object.hasOwn(item, 'quantity'), false);
  assert.deepEqual(result.movements.map(({ deltaAvailable, deltaReserved, unit }) => [deltaAvailable, deltaReserved, unit]), [[0, 0, 'box']]);
  assert.equal(JSON.stringify(input), before);
});

test('creation preserves independent initial available and reserved balances and optional defaults', () => {
  const result = execute(plan([action({ initialStock: { available: 7, reserved: 3 } })]));
  assert.deepEqual([result.changedProducts[0].stockAvailable, result.changedProducts[0].stockReserved], [7, 3]);
  assert.deepEqual(result.movements.map(({ deltaAvailable, deltaReserved }) => [deltaAvailable, deltaReserved]), [[7, 3]]);
  const reservedOnly = execute(plan([action({ initialStock: { available: 0, reserved: 3 } })]));
  assert.deepEqual([reservedOnly.changedProducts[0].stockAvailable, reservedOnly.changedProducts[0].stockReserved], [0, 3]);
  const boundary = execute(plan([action({ initialStock: { available: Number.MAX_SAFE_INTEGER, reserved: Number.MAX_SAFE_INTEGER } })]));
  assert.equal(boundary.changedProducts[0].stockAvailable, Number.MAX_SAFE_INTEGER);
  const minimal = action({ target: { kind: 'new', sku: { name: 'Minimal' } } }); delete minimal.price;
  const normalized = validateOperationPlan(plan([minimal]), context);
  assert.equal(normalized.actions[0].target.sku.unit, 'unit');
  const product = execute(plan([minimal])).changedProducts[0];
  assert.deepEqual([product.price, product.priceCurrency, product.unit], [0, 'XXX', 'unit']);
});

test('creation requires create permission and reserve permission only for positive reserved stock', () => {
  validateOperationPlan(plan(), { ...context, permissions: ['inventory:create'] });
  validateOperationPlan(plan([action({ initialStock: { available: 5, reserved: 0 } })]), { ...context, permissions: ['inventory:create'] });
  fail(() => validateOperationPlan(plan(), { ...context, permissions: ['inventory:receive'] }), 'FORBIDDEN');
  fail(() => validateOperationPlan(plan([action({ initialStock: { available: 0, reserved: 1 } })]), { ...context, permissions: ['inventory:create'] }), 'FORBIDDEN');
  fail(() => validateOperationPlan(plan(), { ...context, businessId: 'other-shop' }), 'BUSINESS_SCOPE_MISMATCH');
});

test('creation rejects ambiguous targets, missing balances, coercion, unsupported prices and extra mutation fields', () => {
  for (const target of [{ kind: 'existing', skuId: 'existing' }, { ...action().target, skuId: 'existing' }, { ...action().target, expectedRevision: 0 }]) fail(() => validateOperationPlan(plan([action({ target })]), context));
  for (const initialStock of [undefined, null, {}, { available: 0 }, { reserved: 0 }, { available: 0, reserved: 0, quantity: 1 }]) {
    const input = action({ initialStock }); if (initialStock === undefined) delete input.initialStock;
    fail(() => validateOperationPlan(plan([input]), context));
  }
  for (const field of ['available', 'reserved']) for (const value of [null, '1', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) fail(() => validateOperationPlan(plan([action({ initialStock: { available: 0, reserved: 0, [field]: value } })]), context));
  for (const value of [null, '1', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) fail(() => validateOperationPlan(plan([action({ price: { ...action().price, amount: value } })]), context));
  for (const price of [{ amount: 1, currency: 'uyu', policy: 'initialize' }, { amount: 1, currency: 'UYU', policy: 'set' }, { amount: 1, currency: 'UYU' }]) fail(() => validateOperationPlan(plan([action({ price })]), context));
  for (const reason of [undefined, null, '', ' ', 9]) { const input = action({ reason }); if (reason === undefined) delete input.reason; fail(() => validateOperationPlan(plan([input]), context)); }
  for (const field of ['quantity', 'balances', 'changes', 'salePrice']) fail(() => validateOperationPlan(plan([action({ [field]: {} })]), context));
  for (const field of ['productType', 'productModel', 'size']) fail(() => validateOperationPlan(plan([action({ target: { kind: 'new', sku: { name: 'Null metadata', [field]: null } } })]), context));
});

test('creation identity includes typed attributes, unit and conservative name normalization', () => {
  const existing = { ...action().target.sku, id: 'existing', revision: 2, status: 'active', stockAvailable: 4, stockReserved: 0, price: 0, priceCurrency: 'UYU' };
  const before = JSON.stringify(existing);
  fail(() => execute(plan(), [existing]), 'DUPLICATE_SKU_IDENTITY');
  fail(() => execute(plan(), [{ ...existing, name: '  CREATE SKU ', status: 'inactive' }]), 'SKU_INACTIVE');
  execute(plan([action({ target: { kind: 'new', sku: { ...action().target.sku, unit: 'unit' } } })]), [existing]);
  execute(plan([action({ target: { kind: 'new', sku: { ...action().target.sku, attributes: { ...attributes, width: { state: 'known', type: 'text', value: '12', unit: 'mm' } } } } })]), [existing]);
  assert.equal(JSON.stringify(existing), before);
  fail(() => execute(plan([action(), action({ itemId: 'second' })])), 'DUPLICATE_SKU_IDENTITY');
});

test('creation participates atomically in mixed operations and initial stock affects the digest', () => {
  const existing = { id: 'old', name: 'Existing', stockAvailable: 9, stockReserved: 0, price: 4, priceCurrency: 'UYU', unit: 'box', attributes: {}, status: 'active', revision: 3 };
  const sell = { itemId: 'sell', type: 'stock.sell', target: { kind: 'existing', skuId: 'old' }, quantity: { value: 2, unit: 'box' } };
  const input = plan([action({ initialStock: { available: 2, reserved: 1 } }), sell]);
  const before = JSON.stringify(existing), result = execute(input, [existing]);
  assert.equal(result.changedProducts.find(({ id }) => id === 'old').stockAvailable, 7);
  assert.equal(result.items[0].created, true); assert.equal(Object.hasOwn(result.items[0], 'quantity'), false);
  assert.equal(result.items[1].quantity.value, 2);
  assert.equal(JSON.stringify(existing), before);
  fail(() => execute(plan([action(), { ...sell, quantity: { value: 10, unit: 'box' } }]), [existing]), 'INSUFFICIENT_STOCK');
  assert.equal(JSON.stringify(existing), before);
  assert.notEqual(operationDigest(plan()), operationDigest(plan([action({ initialStock: { available: 1, reserved: 0 } })])));
});
