import assert from 'node:assert/strict';
import { normalizeSelectionRequest, selectInventoryProducts, buildSelectionPreview } from '../server/inventorySelections.js';
import { planInventoryOperation, inventoryProductFingerprint } from '../server/inventoryOperations.js';

const product = (id, extra = {}) => ({ id, name: 'Camisa café', productType: 'Ropa', productModel: 'Clásica', size: null, unit: 'unit', status: 'active', revision: 3, stockAvailable: 8, stockReserved: 2, price: 900, priceCurrency: 'UYU', attributes: {}, ...extra });
const products = [product('a'), product('b', { size: 'M' }), product('c', { name: 'Camisa cafe', size: 'L' })];
const mutation = { type: 'sku.update', changes: { price: 0 }, reason: 'Precio revisado' };
const request = (selector, extra = {}) => ({ requestId: 'selection-request', selector, mutation, ...extra });
const context = { businessId: 'selection-shop', actorId: 'selection-tests', selectionId: 'selection-one', expiresAt: '2030-01-01T00:00:00.000Z' };
const rejects = (fn, code) => assert.throws(fn, (error) => !!error.code && (!code || error.code === code));
const ids = (selector, source = products) => selectInventoryProducts(selector, source).map((entry) => entry.id).sort();
const filter = (equals) => ({ kind: 'filter', equals });

assert.deepEqual(ids({ kind: 'all' }), ['a', 'b', 'c']);
assert.deepEqual(ids({ kind: 'ids', skuIds: ['c', 'a'] }), ['a', 'c']);
assert.deepEqual(ids(filter({ name: '  CAMISA  CAFE\u0301 ' })), ['a', 'b']);
assert.deepEqual(ids(filter({ name: 'camisa cafe' })), ['c'], 'accents are not removed');
rejects(() => ids(filter({ name: 'café camisa' })), 'EMPTY_SELECTION');
rejects(() => ids(filter({ name: 'Camisa' })), 'EMPTY_SELECTION');
assert.deepEqual(ids(filter({ name: 'Camisa café', size: ' m ' })), ['b'], 'filter clauses combine with AND');
assert.deepEqual(ids(filter({ size: null }), [...products, product('empty', { size: '' })]), ['a', 'empty']);
assert.deepEqual(ids(filter({ productType: 'ropa', productModel: 'CLA\u0301SICA', unit: ' UNIT ', status: 'active' })), ['a', 'b', 'c']);

const typed = [product('absent'), ...['missing', 'unknown', 'not_applicable'].map((state) => product(state, { attributes: { color: { state, type: 'text' } } })), product('known', { attributes: { color: { state: 'known', type: 'text', value: 'AZUL' } } }), product('false', { attributes: { enabled: { state: 'known', type: 'boolean', value: false } } }), product('zero', { attributes: { count: { state: 'known', type: 'number', value: 0, unit: 'kg' } } })];
for (const state of ['missing', 'unknown', 'not_applicable']) assert.deepEqual(ids(filter({ attributes: { color: { state, type: 'text' } } }), typed), [state]);
assert.deepEqual(ids(filter({ attributes: { COLOR: { state: 'known', type: 'text', value: ' azul ' } } }), typed), ['known']);
assert.deepEqual(ids(filter({ attributes: { enabled: { state: 'known', type: 'boolean', value: false } } }), typed), ['false']);
assert.deepEqual(ids(filter({ attributes: { count: { state: 'known', type: 'number', value: 0, unit: 'KG' } } }), typed), ['zero']);
rejects(() => ids(filter({ attributes: { count: { state: 'known', type: 'number', value: 0, unit: 'g' } } }), typed), 'EMPTY_SELECTION');

for (const selector of [null, {}, { kind: 'query', query: '*' }, { kind: 'all', equals: {} }, { kind: 'ids', skuIds: [] }, { kind: 'ids', skuIds: ['a', 'a'] }, { kind: 'ids', skuIds: [''] }, { kind: 'ids', skuIds: [1] }, filter({}), filter({ attributes: {} }), filter({ fuzzy: 'camisa' }), filter({ name: null }), filter({ unit: null }), filter({ status: null }), filter({ name: { contains: 'Camisa' } }), filter({ attributes: { color: 'blue' } }), filter({ attributes: { color: { state: 'known', type: 'number', value: '0' } } }), { kind: 'filter', equals: { size: null }, limit: 1 }]) rejects(() => normalizeSelectionRequest(request(selector)));
for (const extra of [{ extra: true }, { requestId: '' }, { requestId: null }, { mutation: { ...mutation, extra: true } }, { mutation: { ...mutation, reason: '' } }, { mutation: { ...mutation, type: 'stock.adjust' } }, { mutation: { ...mutation, changes: { stockAvailable: 0 } } }, { mutation: { ...mutation, changes: {} } }]) rejects(() => normalizeSelectionRequest(request({ kind: 'all' }, extra)));
const polluted = JSON.parse('{"kind":"filter","equals":{"__proto__":"oops"}}');
rejects(() => normalizeSelectionRequest(request(polluted)));
const sparse = ['a']; sparse.length = 2;
rejects(() => normalizeSelectionRequest(request({ kind: 'ids', skuIds: sparse })));
let getterCalls = 0;
const accessorSelector = { kind: 'filter', get equals() { getterCalls++; return { name: 'Camisa café' }; } };
rejects(() => normalizeSelectionRequest(request(accessorSelector)));
assert.equal(getterCalls, 0, 'untrusted accessors are rejected without invoking them');
rejects(() => normalizeSelectionRequest(request({ kind: 'ids', skuIds: Array.from({ length: 101 }, (_, i) => `sku-${i}`) })), 'SELECTION_TOO_LARGE');
rejects(() => selectInventoryProducts({ kind: 'ids', skuIds: ['a', 'missing'] }, products), 'SKU_NOT_FOUND');

const input = request({ kind: 'ids', skuIds: ['a', 'b'] });
const before = JSON.stringify({ input, products });
const { preview, plan } = buildSelectionPreview(input, products, context);
assert.equal(preview.selectionId, context.selectionId);
assert.equal(preview.expiresAt, context.expiresAt);
assert.equal(preview.status, 'pending');
assert.match(preview.digest, /^[a-f0-9]{64}$/);
assert.deepEqual(preview.mutation, mutation);
assert.deepEqual(preview.members.map(({ skuId, name, size, revision, stockAvailable, stockReserved, price, priceCurrency }) => ({ skuId, name, size, revision, stockAvailable, stockReserved, price, priceCurrency })), products.slice(0, 2).map(({ id: skuId, name, size, revision, stockAvailable, stockReserved, price, priceCurrency }) => ({ skuId, name, size, revision, stockAvailable, stockReserved, price, priceCurrency })));
assert.deepEqual(plan.actions.map((action) => action.target.skuId).sort(), ['a', 'b']);
for (const action of plan.actions) {
  assert.equal(action.target.expectedRevision, 3);
  assert.equal(action.target.expectedFingerprint, inventoryProductFingerprint(products.find((entry) => entry.id === action.target.skuId)));
}
assert.equal(planInventoryOperation(plan, products).changedProducts.length, 2);
assert.equal(JSON.stringify({ input, products }), before, 'preview and selection are pure');
assert.equal(buildSelectionPreview(input, products, context).preview.digest, preview.digest);
for (const changedContext of [{ businessId: 'other-shop' }, { actorId: 'another-actor' }, { selectionId: 'selection-two' }, { expiresAt: '2031-01-01T00:00:00.000Z' }]) assert.notEqual(buildSelectionPreview(input, products, { ...context, ...changedContext }).preview.digest, preview.digest);
assert.notEqual(buildSelectionPreview(request(input.selector, { mutation: { ...mutation, changes: { price: 1 } } }), products, context).preview.digest, preview.digest);
assert.notEqual(buildSelectionPreview(input, products.map((entry) => ({ ...entry, revision: 4 })), context).preview.digest, preview.digest);
rejects(() => buildSelectionPreview(request(filter({ name: 'no match' })), products, context), 'EMPTY_SELECTION');
rejects(() => buildSelectionPreview(request({ kind: 'all' }), Array.from({ length: 101 }, (_, i) => product(`many-${i}`, { name: `Unique ${i}` })), context), 'SELECTION_TOO_LARGE');
rejects(() => buildSelectionPreview(request({ kind: 'ids', skuIds: ['a'] }), [product('a', { status: 'inactive' })], context), 'SKU_INACTIVE');
rejects(() => buildSelectionPreview(input, products, { ...context, permissions: ['inventory:receive'] }), 'FORBIDDEN');
rejects(() => buildSelectionPreview(request({ kind: 'ids', skuIds: ['a'] }, { mutation: { ...mutation, changes: { name: products[2].name, size: 'L' } } }), products, context), 'DUPLICATE_SKU_IDENTITY');
console.log('Inventory selection contract, exact matching and frozen preview tests passed');

