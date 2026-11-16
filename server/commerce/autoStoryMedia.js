import sharp from 'sharp';
import { fail } from './errors.js';
import { matches, signature } from './autoStorySecurity.js';

export const JPEG_LIMIT = 8 * 1024 * 1024;
export const MEDIA_PATH = '/api/instagram-story-media';
const mediaSignature = (key, id, expires) => signature(key, `auto-story-media\n${id}\n${expires}`);
export function temporaryStoryUrl(config, id, expires) {
  return `${config.origin}${MEDIA_PATH}/${id}/${expires}/${mediaSignature(config.mediaKey, id, expires)}.jpg`;
}

export function validMediaSignature(key, id, expires, signed, now = Date.now()) {
  return key && /^[a-f0-9-]{36}$/.test(id) && /^\d{13}$/.test(expires) && Number(expires) > now
    && matches(signed, mediaSignature(key, id, expires));
}

export async function validateStoryJpeg(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > JPEG_LIMIT
      || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new Error();
    const input = { failOn: 'warning', limitInputPixels: 1080 * 1920 };
    const metadata = await sharp(bytes, input).metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== 1080 || metadata.height !== 1920 || metadata.space !== 'srgb') throw new Error();
    await sharp(bytes, input).stats(); // Fully decode scan data, including truncated or damaged JPEGs.
  } catch {
    fail('AUTO_STORY_INVALID_JPEG', 'Se necesita un JPG RGB de 1080 × 1920 y hasta 8 MB.', 422);
  }
}
