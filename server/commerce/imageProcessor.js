import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fail } from './errors.js';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Decode the actual bytes, orient pixels and re-encode without source metadata. */
export async function processCommercialImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_INVALID', 'La foto debe pesar hasta 12 MB.', 413);
  try {
    const options = { limitInputPixels: 24_000_000, failOn: 'warning', animated: false };
    const metadata = await sharp(bytes, options).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) fail('IMAGE_FORMAT_INVALID', 'Usá una foto JPG, PNG o WebP sin animación.', 415);
    const { data: master, info } = await sharp(bytes, options).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(master).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    return { master, thumbnail, width: info.width, height: info.height, mimeType: 'image/jpeg', masterSha256: sha256(master) };
  } catch (error) {
    if (error?.code?.startsWith('IMAGE_')) throw error;
    fail('IMAGE_DECODE_FAILED', 'No pude leer la foto. Probá con otra imagen JPG, PNG o WebP de hasta 24 megapíxeles.', 422);
  }
}
