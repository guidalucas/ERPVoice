import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { record, text, uuid } from './validation.js';
import { fail } from './errors.js';
import { requireCommerceAccess } from './operationRepository.js';
import { processCommercialImage } from './imageProcessor.js';

export const defaultAppearance = Object.freeze({ logoId: null, coverId: null, primaryColor: '#001A4D', accentColor: '#FF6A00',
  tagline: 'Tu colección, con identidad', heroTitle: 'Encontrá tu próxima camiseta',
  heroDescription: 'Explorá nuestra colección y consultanos por WhatsApp.', collectionTitle: 'La colección' });
export const appearanceOf = profile => ({ ...defaultAppearance, ...profile?.appearance });
export const textOnColor = hex => {
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '#000000' : '#FFFFFF';
};
export function normalizeAppearance(input) {
  const data = record(input, Object.keys(defaultAppearance), 'appearance');
  const result = {};
  for (const key of ['logoId', 'coverId']) result[key] = data[key] == null ? null : uuid(data[key]);
  for (const key of ['primaryColor', 'accentColor']) {
    if (typeof data[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(data[key])) fail('INVALID_COMMAND', 'Elegí un color válido.', 400);
    result[key] = data[key].toUpperCase();
  }
  for (const [key, max] of Object.entries({ tagline: 80, heroTitle: 120, heroDescription: 300, collectionTitle: 60 }))
    result[key] = text(data[key], max, key, { empty: key === 'tagline' || key === 'heroDescription' });
  return result;
}
export async function requireAppearanceSchema(client) {
  if (!(await client.query("SELECT 1 FROM commerce_schema_migrations WHERE version=4")).rowCount)
    fail('APPEARANCE_SCHEMA_NOT_READY', 'La personalización necesita una actualización del servicio comercial.', 503);
}
export async function validateAppearanceAssets(client, businessId, appearance) {
  for (const kind of ['logo', 'cover']) {
    const id = appearance[`${kind}Id`];
    if (id && !(await client.query('SELECT 1 FROM commerce_brand_assets WHERE owner_phone=$1 AND id=$2 AND kind=$3', [businessId, id, kind])).rowCount)
      fail('BRAND_ASSET_NOT_FOUND', 'Volvé a cargar la imagen de tu negocio.', 422);
  }
}
export function createBrandAssetService(runtime) {
  return {
    upload: (context, kind, bytes) => runtime.transaction(async client => {
      await requireCommerceAccess(client, context, 'commerce:settings'); await requireAppearanceSchema(client);
      if (!['logo', 'cover'].includes(kind)) fail('INVALID_COMMAND', 'Tipo de imagen inválido.', 400);
      // Validate signatures, dimensions and animation before the second decode.
      await processCommercialImage(bytes);
      const pipeline = sharp(bytes, { limitInputPixels: 24_000_000 }).rotate().resize({ width: kind === 'logo' ? 400 : 1600,
        height: kind === 'logo' ? 400 : 1000, fit: 'inside', withoutEnlargement: true });
      const content = kind === 'logo' ? await pipeline.png().toBuffer() : await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
      if (content.length > 1048576) fail('IMAGE_SIZE_INVALID', 'La imagen procesada supera 1 MB. Probá una imagen más simple.', 413);
      const id = randomUUID(), mimeType = kind === 'logo' ? 'image/png' : 'image/jpeg';
      await client.query('INSERT INTO commerce_brand_assets(owner_phone,id,kind,mime_type,content) VALUES($1,$2,$3,$4,$5)', [context.businessId, id, kind, mimeType, content]);
      return { id, kind };
    }),
    content: (context, id) => runtime.transaction(async client => {
      await requireCommerceAccess(client, context, 'commerce:read'); await requireAppearanceSchema(client);
      const row = (await client.query('SELECT mime_type,content FROM commerce_brand_assets WHERE owner_phone=$1 AND id=$2', [context.businessId, uuid(id)])).rows[0];
      if (!row) fail('RESOURCE_NOT_FOUND', 'Imagen no disponible.', 404); return row;
    }, { readOnly: true }),
  };
}
