import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOrderRequest, planOrderTransition, orderRequestDigest } from '../server/orderOperations.js';
import { validateOperationPlan, planInventoryOperation } from '../server/inventoryOperations.js';
import { inventoryResultActions } from '../server/inventoryResults.js';

const products = [{ id: 'sku-a', name: 'A', unit: 'box', stockAvailable: 10, stockReserved: 2, price: 30, priceCurrency: 'UYU' },
  { id: 'sku-b', name: 'B', unit: 'unit', stockAvailable: 0, stockReserved: 0, price: 0 }];
const current = { id: 'order-a', clienteId: 'client', producto: 'Literal label', qty: 5, estado: 'conseguido', revision: 2,
  productId: 'sku-a', stockPosting: { skuId: 'sku-a', quantity: 5, unit: 'box' } };
const request = (changes, kind = 'update') => normalizeOrderRequest(kind, 'order-a', { operationId: 'request', ...(kind !== 'create' ? { expectedRevision: 2 } : {}), ...changes });
const context = { businessId: 'tenant', actorId: 'actor', permissions: ['inventory:withdraw', 'inventory:receive'] };
const execute = (actions, rows = products) => {
  const plan = { contractVersion: 1, operationId: 'inventory', businessId: 'tenant', actions };
  return planInventoryOperation(validateOperationPlan(plan, context), rows);
};
test('order requests reject coercion, hidden fields, mutable provenance and malformed revisions', () => {
  for (const qty of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => request({ qty }), { code: 'INVALID_ORDER_OPERATION' });
  for (const extra of [{ ownerPhone: 'foreign' }, { stockPosting: {} }, { revision: 0 }, { expectedRevision: null }, { estado: 'anything' }, { producto: null }]) assert.throws(() => request(extra), { code: 'INVALID_ORDER_OPERATION' });
  assert.throws(() => request({ operationId: '' }), { code: 'OPERATION_ID_REQUIRED' });
  assert.throws(() => request(Object.defineProperty({}, 'qty', { get() { throw Error('getter ran'); } })), { code: 'INVALID_ORDER_OPERATION' });
  assert.notEqual(orderRequestDigest(request({ notas: null })), orderRequestDigest(request({ qty: 5 })));
  const created = request({ clienteId: ' client ', producto: ' label ' }, 'create');
  assert.equal(created.changes.qty, 1); assert.equal(created.changes.estado, 'pendiente'); assert.equal(created.changes.producto, 'label');
});
test('order net postings handle quantity changes, original SKU reversal and metadata without matching names', () => {
  const before = JSON.stringify({ current, products });
  const increase = planOrderTransition(request({ qty: 7 }), current, products);
  assert.equal(increase.actions[0].quantity.value, 2); assert.equal(increase.actions[0].type, 'stock.receive'); assert.equal(increase.next.stockPosting.quantity, 7);
  const decrease = planOrderTransition(request({ qty: 3 }), current, products);
  assert.equal(decrease.actions[0].type, 'stock.withdraw'); assert.equal(decrease.actions[0].quantity.value, 2);
  const exit = planOrderTransition(request({ estado: 'descartado', producto: 'Other label', qty: 100 }), current, products);
  assert.equal(exit.actions[0].target.skuId, 'sku-a'); assert.equal(exit.actions[0].quantity.value, 5); assert.equal(exit.next.stockPosting, null);
  assert.equal(planOrderTransition(request({ producto: 'Rename only' }), current, products).actions.length, 0);
  assert.equal(JSON.stringify({ current, products }), before);
  const switched = planOrderTransition(request({ productId: 'sku-b' }), current, products);
  assert.deepEqual(switched.actions.map((a) => [a.type,a.target.skuId,a.quantity.value,a.quantity.unit]), [['stock.withdraw','sku-a',5,'box'],['stock.receive','sku-b',5,'unit']]);
  assert.throws(() => execute(switched.actions, products.map((p) => p.id === 'sku-a' ? { ...p, stockAvailable: 4 } : p)), { code: 'INSUFFICIENT_STOCK' });
});
test('legacy achieved orders require reconciliation for stock edits and never get guessed provenance', () => {
  const legacy = { ...current, productId: null, stockPosting: null };
  for (const changes of [{ qty: 6 }, { estado: 'pendiente' }, { productId: 'sku-a' }]) assert.throws(() => planOrderTransition(request(changes), legacy, products), { code: 'ORDER_RECONCILIATION_REQUIRED' });
  assert.throws(() => planOrderTransition(request({}, 'delete'), legacy, products), { code: 'ORDER_RECONCILIATION_REQUIRED' });
  assert.equal(planOrderTransition(request({ notas: 'Historical note' }), legacy, products).next.stockPosting, null);
  assert.throws(() => planOrderTransition(request({ estado: 'conseguido' }), { ...legacy, estado: 'pendiente' }, products), { code: 'SKU_SELECTION_REQUIRED' });
  assert.throws(() => planOrderTransition(request({ qty: 6 }), { ...current, revision: 3 }, products), { code: 'ORDER_REVISION_MISMATCH' });
});
test('withdrawals use same deterministic stock arithmetic with exact deltas and no financial meaning', () => {
  const { actions } = planOrderTransition(request({}, 'delete'), current, products);
  const result = execute(actions);
  assert.equal(result.changedProducts[0].stockAvailable, 5); assert.equal(result.changedProducts[0].stockReserved, 2);
  assert.equal(result.movements[0].deltaAvailable, -5); assert.equal(result.movements[0].deltaReserved, 0);
  assert.equal(Object.hasOwn(result.items[0], 'price'), false); assert.equal(Object.hasOwn(result.items[0], 'totalAmount'), false);
  assert.equal(inventoryResultActions(result)[0].type, 'withdraw_stock');
  const plan = { contractVersion: 1, operationId: 'test', businessId: 'tenant', actions };
  assert.throws(() => validateOperationPlan(plan, { ...context, permissions: ['inventory:sell'] }), { code: 'FORBIDDEN' });
  for (const extra of [{ reason: '' }, { price: { amount: 0, currency: 'UYU', policy: 'preserve' } }, { salePrice: { amount: 1, currency: 'UYU' } }, { quantity: { value: 0, unit: 'box' } }]) assert.throws(() => validateOperationPlan({ ...plan, actions: [{ ...actions[0], ...extra }] }, context), { code: 'INVALID_OPERATION_PLAN' });
  assert.throws(() => validateOperationPlan({ ...plan, operationId: 'order-stock:reserved' }, context), { code: 'FORBIDDEN' });
});
