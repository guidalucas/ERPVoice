import assert from 'node:assert/strict';
import { InventoryOperationError, validateOperationPlan, planInventoryOperation, inventoryProductFingerprint, operationDigest } from '../server/inventoryOperations.js';
import { normalizeSelectionRequest, selectInventoryProducts, buildSelectionPreview } from '../server/inventorySelections.js';
import { parseMetaDeactivationCommand, deactivationPreviewReply, metaDeactivationReceiptReply } from '../server/inventoryMetaSelections.js';

const context = { businessId: 'deactivation-shop', actorId: 'deactivation-tests', permissions: ['inventory:receive', 'inventory:sell', 'inventory:reserve', 'inventory:adjust', 'inventory:update', 'inventory:deactivate'] };
const product = (extra = {}) => ({ id: 'sku', name: 'Discontinued SKU', unit: 'box', status: 'active', revision: 7, stockAvailable: 10, stockReserved: 0, price: 900, priceCurrency: 'UYU', attributes: {}, ...extra });
const action = (extra = {}) => ({ itemId: 'one', type: 'sku.deactivate', target: { kind: 'existing', skuId: 'sku', expectedRevision: 7 }, reason: 'Retirado del catálogo', ...extra });
const plan = (actions = [action()]) => ({ contractVersion: 1, operationId: 'deactivation-op', businessId: context.businessId, actions });
const throws = (fn, code = 'INVALID_OPERATION_PLAN') => assert.throws(fn, (error) => error instanceof InventoryOperationError && error.code === code);
const request = (selector = { kind: 'ids', skuIds: ['sku'] }, extra = {}) => ({ requestId: 'deactivation-selection', selector, mutation: { type: 'sku.deactivate', reason: action().reason }, ...extra });
const selectionContext = { ...context, selectionId: 'deactivation-selection', expiresAt: '2030-01-01T00:00:00.000Z' };

const input = plan(), products = [product()], before = JSON.stringify({ input, products });
const validated = validateOperationPlan(input, context);
assert.deepEqual(validated, input);
assert.ok(Object.isFrozen(validated.actions[0].target));
const effect = planInventoryOperation(input, products);
assert.equal(effect.changedProducts.length, 1);
assert.deepEqual(effect.changedProducts[0], { ...product(), status: 'inactive' });
assert.equal(effect.items[0].type, 'sku.deactivate');
assert.equal(effect.items[0].status, 'inactive');
assert.equal(effect.items[0].reason, action().reason);
assert.equal(effect.items[0].skuId, 'sku');
assert.equal(Object.hasOwn(effect.items[0], 'quantity'), false);
assert.deepEqual(effect.movements.map(({ deltaAvailable, deltaReserved, unit }) => [deltaAvailable, deltaReserved, unit]), [[0, 0, 'box']]);
assert.equal(JSON.stringify({ input, products }), before, 'deactivation planning is pure');
throws(() => planInventoryOperation(input, [product({ stockReserved: 1 })]), 'SKU_HAS_RESERVATIONS');
throws(() => planInventoryOperation(input, [product({ status: 'inactive' })]), 'SKU_INACTIVE');
throws(() => planInventoryOperation(input, [product({ revision: 8 })]), 'REVISION_MISMATCH');
throws(() => planInventoryOperation(input, []), 'SKU_NOT_FOUND');
throws(() => planInventoryOperation(plan([action({ target: { ...action().target, expectedFingerprint: inventoryProductFingerprint(product({ name: 'Old name' })) } })]), products), 'SKU_FINGERPRINT_MISMATCH');
throws(() => validateOperationPlan(input, { ...context, permissions: ['inventory:update'] }), 'FORBIDDEN');
throws(() => validateOperationPlan(input, { ...context, businessId: 'other' }), 'BUSINESS_SCOPE_MISMATCH');
for (const revision of [undefined, null, -1, 0.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  throws(() => validateOperationPlan(plan([action({ target: { kind: 'existing', skuId: 'sku', ...(revision === undefined ? {} : { expectedRevision: revision }) } })]), context));
}
for (const reason of [undefined, null, '', ' ', 7]) throws(() => validateOperationPlan(plan([action({ reason })]), context));
for (const field of ['quantity', 'price', 'salePrice', 'balances', 'changes', 'unexpected']) {
  throws(() => validateOperationPlan(plan([action({ [field]: {} })]), context));
}
throws(() => validateOperationPlan(plan([action({ target: { kind: 'new', sku: { name: 'Forbidden' } } })]), context));
assert.notEqual(operationDigest(input), operationDigest(plan([action({ reason: 'Otra razón revisada' })])));
assert.equal(planInventoryOperation(plan([action({ target: { ...action().target, expectedRevision: 0 } })]), [product({ revision: 0 })]).changedProducts[0].status, 'inactive');
assert.equal(planInventoryOperation(input, [product({ stockAvailable: 0 })]).changedProducts[0].stockAvailable, 0);

const inactive = product({ status: 'inactive' });
for (const type of ['stock.receive', 'stock.sell', 'stock.reserve', 'stock.adjust', 'sku.update', 'sku.deactivate']) {
  const fields = type === 'stock.adjust' ? { balances: { available: 1 }, reason: 'Conteo' }
    : type === 'sku.update' ? { changes: { price: 0 }, reason: 'Precio' }
      : type === 'sku.deactivate' ? { reason: 'Retirado' } : { quantity: { value: 1, unit: 'box' } };
  throws(() => planInventoryOperation(plan([{ itemId: 'one', type, target: action().target, ...fields }]), [inactive]), 'SKU_INACTIVE');
}
throws(() => planInventoryOperation(plan([{ itemId: 'new', type: 'stock.receive', target: { kind: 'new', sku: { name: inactive.name, unit: inactive.unit } }, quantity: { value: 1, unit: 'box' } }]), [inactive], { createId: () => 'replacement' }), 'DUPLICATE_SKU_IDENTITY');
const batchSource = [product(), product({ id: 'reserved', name: 'Reserved', stockReserved: 1 })];
const batchBefore = JSON.stringify(batchSource);
throws(() => planInventoryOperation(plan([action(), action({ itemId: 'two', target: { ...action().target, skuId: 'reserved' } })]), batchSource), 'SKU_HAS_RESERVATIONS');
assert.equal(JSON.stringify(batchSource), batchBefore, 'failing batch cannot partially deactivate inputs');

assert.deepEqual(normalizeSelectionRequest(request()).mutation, request().mutation);
const selected = buildSelectionPreview(request(), products, selectionContext);
assert.equal(selected.plan.contractVersion, 1);
assert.equal(selected.plan.actions[0].type, 'sku.deactivate');
assert.equal(selected.plan.actions[0].target.expectedRevision, 7);
assert.equal(selected.plan.actions[0].target.expectedFingerprint, inventoryProductFingerprint(product()));
assert.deepEqual(selected.preview.mutation, request().mutation);
assert.match(selected.preview.digest, /^[a-f0-9]{64}$/);
assert.equal(buildSelectionPreview(request(), products, selectionContext).preview.digest, selected.preview.digest);
assert.notEqual(buildSelectionPreview(request(undefined, { mutation: { type: 'sku.deactivate', reason: 'Otra razón' } }), products, selectionContext).preview.digest, selected.preview.digest);
assert.deepEqual(selectInventoryProducts({ kind: 'all' }, [...products, { ...inactive, id: 'inactive' }]).map(({ id }) => id), ['sku']);
assert.deepEqual(selectInventoryProducts({ kind: 'filter', equals: { name: product().name } }, [...products, { ...inactive, id: 'inactive' }]).map(({ id }) => id), ['sku']);
assert.deepEqual(selectInventoryProducts({ kind: 'filter', equals: { status: 'inactive' } }, [inactive]).map(({ id }) => id), ['sku']);
throws(() => buildSelectionPreview(request(), [inactive], selectionContext), 'SKU_INACTIVE');
throws(() => buildSelectionPreview(request({ kind: 'filter', equals: { status: 'inactive' } }), [inactive], selectionContext), 'SKU_INACTIVE');
throws(() => buildSelectionPreview(request(), [product({ stockReserved: 1 })], selectionContext), 'SKU_HAS_RESERVATIONS');
throws(() => buildSelectionPreview(request(), products, { ...selectionContext, permissions: ['inventory:update'] }), 'FORBIDDEN');
for (const field of ['changes', 'quantity', 'price', 'balances']) {
  assert.throws(() => normalizeSelectionRequest(request(undefined, { mutation: { ...request().mutation, [field]: {} } })));
}
assert.deepEqual(parseMetaDeactivationCommand('CONFIRMAR BAJA ABCDEF12'), { confirm: true, code: 'abcdef12' });
assert.deepEqual(parseMetaDeactivationCommand('cancelar baja abcdef12'), { confirm: false, code: 'abcdef12' });
for (const text of ['sí', 'confirmar baja abcdef123', 'no confirmar baja abcdef12', 'confirmar baja abcdef12 y vender 2']) assert.equal(parseMetaDeactivationCommand(text), null);
throws(() => deactivationPreviewReply({ digest: 'a'.repeat(64), members: Array.from({ length: 100 }, () => ({ name: 'SKU extenso '.repeat(20), stockAvailable: 4, stockReserved: 0 })) }), 'SELECTION_PREVIEW_TOO_LARGE');
const largeReceipt = { items: Array.from({ length: 50 }, (_, i) => ({ type: 'sku.deactivate', skuId: `sku-${i}`, skuName: 'SKU largo '.repeat(20), stockAvailable: 4, stockReserved: 0 })) };
assert.ok(metaDeactivationReceiptReply(largeReceipt).length < 3500);
assert.match(metaDeactivationReceiptReply(largeReceipt), /50 productos/);
console.log('Inventory deactivation contract, inactive guards and frozen selection tests passed');
