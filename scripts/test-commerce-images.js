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
  await assert.rejects(() => processCommercialImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])), {
    code: 'IMAGE_DECODE_FAILED', message: 'No pude leer la foto. Probá con otra imagen JPG, PNG o WebP.', status: 422,
  });
});
test('24.47-megapixel phone photos are accepted, oriented and reduced for storage', async () => {
  const bytes = await sharp({ create: { width: 5712, height: 4284, channels: 3, background: '#12ab34' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await processCommercialImage(bytes);
  const master = await sharp(result.master).metadata(), thumbnail = await sharp(result.thumbnail).metadata();
  assert.equal(result.width, 1800); assert.equal(result.height, 2400);
  assert.equal(master.width, 1800); assert.equal(master.height, 2400);
  assert.equal(thumbnail.width, 360); assert.equal(thumbnail.height, 480);
  assert.equal(master.exif, undefined); assert.equal(master.orientation, undefined);
  assert.equal(result.mimeType, 'image/jpeg');
});

test('photos at exactly 32 megapixels are accepted and reduced', async () => {
  const bytes = await sharp({ create: { width: 6400, height: 5000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const result = await processCommercialImage(bytes);
  assert.equal(result.width, 2400); assert.equal(result.height, 1875);
});

test('compressed images exceeding the pixel limit are rejected before decoding', async () => {
  const bytes = await sharp({ create: { width: 6401, height: 5000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.ok(bytes.length < 12 * 1024 * 1024);
  await assert.rejects(() => processCommercialImage(bytes), {
    code: 'IMAGE_RESOLUTION_EXCEEDED', message: 'La foto supera el máximo de 32 megapíxeles. Reducí sus dimensiones y volvé a intentar.', status: 422,
  });
});

test('the 12-MiB file size limit still applies', async () => {
  await assert.rejects(() => processCommercialImage(Buffer.alloc(12 * 1024 * 1024 + 1)), { code: 'IMAGE_SIZE_INVALID', status: 413 });
});
test('production never silently uses local or missing photo storage', async () => {
  const storage = createMediaStorage({ NODE_ENV: 'production', COMMERCE_MEDIA_ADAPTER: 'local', COMMERCE_MEDIA_DIRECTORY: 'C:/fake' });
  assert.equal(storage.configured, false);
  await assert.rejects(() => storage.put('anything', Buffer.from('a')), { code: 'MEDIA_NOT_CONFIGURED' });
});
