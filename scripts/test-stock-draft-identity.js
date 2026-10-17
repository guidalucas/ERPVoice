import assert from 'node:assert/strict';
import { reconcileDraftItemIds } from '../server/stockDraftIdentity.js';

let serial = 0;
const createId = () => `fresh-${++serial}`;
const a = { itemId: 'old-a', type: 'add_stock', productName: 'Convertidor de 12 V a 24 V', qty: 1 };
const b = { itemId: 'old-b', type: 'add_stock', productName: 'Convertidor de 24 V a 12 V', qty: 2 };
const c = { itemId: 'model-supplied', type: 'add_stock', productName: 'Caja Ámbar', size: '250 ml', qty: 1 };
const original = JSON.stringify([a, b]);
let result = reconcileDraftItemIds([a, b], [{ ...b, itemId: 'item-1', qty: 3, price: 5 }, c, { ...a, itemId: 'item-3' }], { createId });
assert.deepEqual(result.map((item) => item.itemId), ['old-b', 'fresh-1', 'old-a']);
assert.equal(result[0].qty, 3); assert.equal(result[0].price, 5);
assert.equal(JSON.stringify([a, b]), original);
assert.equal(c.itemId, 'model-supplied');
// Neither name ordering nor a changed attribute/unit may reuse an unrelated ID.
for (const changes of [{ productName: 'Convertidor de 24 V a 12 V' }, { unit: 'box' }, { size: 'L' },
  { productType: 'otro tipo' }, { attributes: { color: { state: 'known', type: 'text', value: 'azul' } } }]) {
  result = reconcileDraftItemIds([a], [{ ...a, ...changes }], { createId });
  assert.notEqual(result[0].itemId, a.itemId);
}
assert.equal(reconcileDraftItemIds([c], [{ ...c, productName: '  CAJA ÁMBAR ' }], { createId })[0].itemId, c.itemId);
// Duplicate identities, duplicate old IDs and invalid identities remain ambiguous.
for (const prior of [[a, { ...a, itemId: 'other-a' }], [a, { ...b, itemId: a.itemId }]]) {
  assert.notEqual(reconcileDraftItemIds(prior, [a], { createId })[0].itemId, a.itemId);
}
result = reconcileDraftItemIds([a], [a, { ...a, itemId: 'model-duplicate' }], { createId });
assert.equal(new Set(result.map((item) => item.itemId)).size, 2);
assert.ok(result.every((item) => item.itemId !== a.itemId));
let attempts = 0;
result = reconcileDraftItemIds([a], [c], { createId: () => ++attempts === 1 ? a.itemId : 'collision-free' });
assert.equal(result[0].itemId, 'collision-free');
assert.throws(() => reconcileDraftItemIds([a], [c], { createId: () => a.itemId }), /unique draft item ID/);
console.log('Draft replacement identity: reorder, added/removed items, quantities, direction, metadata, ambiguity and collisions passed');
