import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryOperationError, validateOperationPlan, planInventoryOperation, operationDigest, inventoryProductFingerprint } from '../server/inventoryOperations.js';
import { productCreationToPlan } from '../server/productCreationAdapter.js';
import { confirmedStockActionsToPlan, bindStockConsumptionAction, resolvedStockBatchToPlan } from '../server/stockOperationAdapter.js';

const context = { businessId: 'create-shop', actorId: 'create-tests', permissions: ['inventory:create', 'inventory:reserve', 'inventory:receive'] };
const attributes = { material: { state: 'known', type: 'text', value: 'acero' }, width: { state: 'known', type: 'number', value: 12, unit: 'mm' } };
const action = (extra = {}) => ({ itemId: 'new', type: 'sku.create', target: { kind: 'new', sku: { name: 'Create SKU', unit: 'box', attributes } }, initialStock: { available: 0, reserved: 0 }, price: { amount: 0, currency: 'UYU', policy: 'initialize' }, reason: 'Alta manual confirmada', ...extra });
const plan = (actions = [action()]) => ({ contractVersion: 1, operationId: 'create-operation', businessId: context.businessId, actions });
const fail = (fn, code = 'INVALID_OPERATION_PLAN') => assert.throws(fn, (error) => error instanceof InventoryOperationError && error.code === code);
const execute = (input = plan(), products = []) => planInventoryOperation(input, products, { createId: () => 'created-sku' });

test('stock adapters preserve explicit family references and never change a pinned version implicitly',()=>{
  const family={id:'electrical',version:1},input={type:'add_stock',itemId:'incoming',productName:'Converter',unit:'unit',qty:2,attributes:{},family};
  const adapted=confirmedStockActionsToPlan({actions:[input],products:[],ownerPhone:context.businessId,sourceText:'Ingreso',operationId:'family-adapter'});
  assert.deepEqual(adapted.actions[0].target.sku.family,family);
  const resolved=resolvedStockBatchToPlan({id:'family-batch',ownerPhone:context.businessId,sourceText:'Ingreso',sourceMessageId:'message',payload:{actions:[{...input,resolution:{kind:'new'}}]}});
  assert.deepEqual(resolved.actions[0].target.sku.family,family);
  const sku={...adapted.actions[0].target.sku,id:'family-sku',stockAvailable:4,stockReserved:0,price:0,revision:1};
  assert.equal(bindStockConsumptionAction({...input,type:'sell'},[sku]).productId,sku.id);
  assert.equal(bindStockConsumptionAction({...input,type:'sell',family:{...family,version:2}},[sku]),null);
  assert.throws(()=>confirmedStockActionsToPlan({actions:[{...input,productId:sku.id,family:{...family,version:2}}],products:[sku],ownerPhone:context.businessId,sourceText:'Ingreso',operationId:'changed-family'}),{code:'SKU_FAMILY_MISMATCH'});
  assert.throws(()=>planInventoryOperation(adapted,[],{createId:()=> 'new-family-sku'}),{code:'PRODUCT_SCHEMA_NOT_FOUND'});
});

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

test('an inactive creation conflict exposes a review snapshot and never reactivates implicitly', () => {
  const archived = { ...action().target.sku, id: 'archived', status: 'inactive', revision: 4, stockAvailable: 3, stockReserved: 1, price: 90, priceCurrency: 'UYU' };
  const before = structuredClone(archived);
  assert.throws(() => execute(plan(), [archived]), error => {
    assert.equal(error.code, 'SKU_INACTIVE');
    assert.deepEqual(error.details.inactiveProduct, { id: archived.id, name: archived.name, size: null, status: 'inactive', revision: 4,
      identityFingerprint: inventoryProductFingerprint(archived), stockAvailable: 3, stockReserved: 1, price: 90, priceCurrency: 'UYU' });
    return true;
  });
  assert.deepEqual(archived, before);
});

test('explicit reactivation preserves SKU identity, revision and balances, auditing only the added stock', () => {
  const archived = { ...action().target.sku, id: 'archived', status: 'inactive', revision: 4, stockAvailable: 3, stockReserved: 1, price: 90, priceCurrency: 'UYU' };
  const reactivate = { skuId: archived.id, expectedRevision: 4, expectedFingerprint: inventoryProductFingerprint(archived) };
  const input = plan([action({ reactivate, initialStock: { available: 2, reserved: 0 }, price: { amount: 100, currency: 'UYU', policy: 'initialize' } })]);
  const permissions = { ...context, permissions: [...context.permissions, 'inventory:update'] };
  validateOperationPlan(input, permissions);
  const effect = execute(input, [archived]);
  assert.deepEqual([effect.changedProducts[0].id, effect.changedProducts[0].revision, effect.changedProducts[0].status,
    effect.changedProducts[0].stockAvailable, effect.changedProducts[0].stockReserved, effect.changedProducts[0].price], ['archived', 4, 'active', 5, 1, 100]);
  assert.deepEqual([effect.items[0].created, effect.items[0].reactivated], [false, true]);
  assert.deepEqual(effect.movements.map(m => [m.deltaAvailable, m.deltaReserved]), [[2, 0]]);
  assert.equal(archived.status, 'inactive');
  fail(() => validateOperationPlan(input, context), 'FORBIDDEN');
  for (const changed of [{ ...archived, revision: 5 }, { ...archived, status: 'active' }, { ...archived, name: 'Other SKU' }]) {
    fail(() => execute(input, [changed]), 'REVISION_MISMATCH');
  }
  fail(() => execute(plan([action({ reactivate: { ...reactivate, expectedFingerprint: 'changed' } })]), [archived]), 'REVISION_MISMATCH');
  fail(() => execute(input, []), 'REVISION_MISMATCH');
  for (const invalid of [{ skuId: 'archived' }, { ...reactivate, expectedRevision: -1 }, { ...reactivate, confirmed: true }]) {
    fail(() => validateOperationPlan(plan([action({ reactivate: invalid })]), permissions));
  }
  assert.notEqual(operationDigest(input), operationDigest(plan([action()])));
  const zero = execute(plan([action({ reactivate })]), [archived]);
  assert.deepEqual([zero.changedProducts[0].stockAvailable, zero.changedProducts[0].stockReserved], [3, 1]);
  assert.deepEqual(zero.movements.map(m => [m.deltaAvailable, m.deltaReserved]), [[0, 0]]);
  const overflow = { ...archived, stockAvailable: Number.MAX_SAFE_INTEGER };
  fail(() => execute(plan([action({ initialStock: { available: 1, reserved: 0 }, reactivate: { ...reactivate, expectedFingerprint: inventoryProductFingerprint(overflow) } })]), [overflow]), 'STOCK_OVERFLOW');
});
