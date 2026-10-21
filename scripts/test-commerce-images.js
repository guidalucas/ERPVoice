import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { processCommercialImage } from '../server/commerce/imageProcessor.js';
import { createMediaStorage } from '../server/commerce/mediaStorage.js';

test('orientation is applied to pixels and source EXIF is removed', async () => {
  const bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ff6a00' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await processCommercialImage(bytes), metadata = await sharp(result.master).metadata();
  assert.equal(metadata.width, 40); assert.equal(metadata.height, 80); assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
  assert.equal(result.mimeType, 'image/jpeg');
});
test('actual SVG and corrupt bytes cannot masquerade as commercial photos', async () => {
  await assert.rejects(() => processCommercialImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')), { code: 'IMAGE_FORMAT_INVALID' });
  await assert.rejects(() => processCommercialImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])), { code: 'IMAGE_DECODE_FAILED' });
});
test('compressed images exceeding the pixel limit are rejected before decoding', async () => {
  const bytes = await sharp({ create: { width: 5001, height: 4800, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.ok(bytes.length < 12 * 1024 * 1024);
  await assert.rejects(() => processCommercialImage(bytes), { code: 'IMAGE_DECODE_FAILED' });
});
test('production never silently uses local or missing photo storage', async () => {
  const storage = createMediaStorage({ NODE_ENV: 'production', COMMERCE_MEDIA_ADAPTER: 'local', COMMERCE_MEDIA_DIRECTORY: 'C:/fake' });
  assert.equal(storage.configured, false);
  await assert.rejects(() => storage.put('anything', Buffer.from('a')), { code: 'MEDIA_NOT_CONFIGURED' });
});
