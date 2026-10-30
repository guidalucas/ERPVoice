import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSkuMetadataChanges } from '../server/commerce/skuMetadata.js';

const change = changes => [{ skuId: 'sku-test', expectedRevision: 0, expectedFingerprint: 'fingerprint', changes }];
test('rubro metadata allows only optional type, model and variant fields', () => {
  assert.deepEqual(normalizeSkuMetadataChanges(change({ productType: ' Jean ', productModel: '', size: null }))[0].changes, { productType: 'Jean', productModel: null, size: null });
  for (const field of ['price', 'stockAvailable', 'attributes', 'ownerPhone', 'name']) assert.throws(() => normalizeSkuMetadataChanges(change({ [field]: 'value' })), { code: 'INVALID_COMMAND' });
  for (const changes of [{}, { size: 42 }, { productType: 'x'.repeat(181) }]) assert.throws(() => normalizeSkuMetadataChanges(change(changes)), { code: 'INVALID_COMMAND' });
  assert.throws(() => normalizeSkuMetadataChanges([...change({ size: 'S' }), ...change({ size: 'M' })]), { code: 'INVALID_COMMAND' });
  let invoked = false;
  const changes = {}; Object.defineProperty(changes, 'size', { enumerable: true, get() { invoked = true; return 'M'; } });
  assert.throws(() => normalizeSkuMetadataChanges(change(changes)), { code: 'INVALID_COMMAND' }); assert.equal(invoked, false);
});
