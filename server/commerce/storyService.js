import { operationRequestDigest } from '../operationHash.js';
import { record, uuid, integer, text, denseArray } from './validation.js';
import { fail } from './errors.js';
import { executeCommerceCommand, requireCommerceAccess } from './operationRepository.js';
import { readProductDetail, readProfile } from './productRepository.js';
import { normalizePromotion, requireActivePromotion, promotionalAmount } from './promotions.js';

export const storyTemplates = Object.freeze({ arrival: { version: 1, heading: 'NUEVO INGRESO' },
  available: { version: 1, heading: 'STOCK DISPONIBLE' }, last_unit: { version: 1, heading: 'ÚLTIMA UNIDAD' },
  matchday: { version: 1, heading: 'LA PASIÓN SE LLEVA PUESTA' }, promo: { version: 1, heading: 'PROMO FULLMATCH' } });
const settingsOf = input => {
  const data = record(input, ['templateId', 'templateVersion', 'imageId', 'expectedImageRevision', 'skuIds', 'showPrice', 'fit', 'zoom', 'focalX', 'focalY', 'caption', 'cta', 'promotion']);
  if (!Object.hasOwn(storyTemplates, data.templateId) || data.templateVersion !== 1) fail('STORY_TEMPLATE_INVALID', 'Elegí una plantilla vigente.', 400);
  const range = (value, min, max) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('INVALID_COMMAND', 'Encuadre inválido.', 400); return value; };
  const skuIds = denseArray(data.skuIds, 100, 'story variants').map(id => text(id, 180, 'SKU id'));
  if (new Set(skuIds).size !== skuIds.length || !skuIds.length || typeof data.showPrice !== 'boolean' || !['contain', 'cover'].includes(data.fit)) fail('INVALID_COMMAND', 'Selección de historia inválida.', 400);
  const promotion = data.promotion == null ? null : normalizePromotion(data.promotion);
  if ((data.templateId === 'promo') !== Boolean(promotion)) fail('PROMOTION_INVALID', 'Usá una promoción completa con su plantilla correspondiente.', 400);
  return { templateId: data.templateId, templateVersion: 1, imageId: uuid(data.imageId), expectedImageRevision: integer(data.expectedImageRevision, 1), promotion,
    skuIds: [...skuIds].sort(), showPrice: data.showPrice, fit: data.fit, zoom: range(data.zoom, 1, 2), focalX: range(data.focalX, 0, 1), focalY: range(data.focalY, 0, 1),
    caption: text(data.caption, 100, 'caption', { empty: true }), cta: text(data.cta, 50, 'CTA', { empty: true }) };
};

/** Explicit semantic projection: revisions alone neither prove nor disprove freshness. */
async function storyContent(client, context, productId, settings, { checkImageRevision = false } = {}) {
  const detail = await readProductDetail(client, context.businessId, productId);
  if (!detail.readiness.canGenerateStory) fail('STORY_PRODUCT_NOT_READY', 'Revisá la ficha, las fotos y el stock antes de generar la historia.', 422, { blockers: detail.readiness.blockers });
  const photo = detail.images.find(image => image.id === settings.imageId && image.status === 'ready');
  if (!photo) fail('STORY_IMAGE_UNAVAILABLE', 'La foto elegida ya no está disponible.', 409);
  if (checkImageRevision && photo.revision !== settings.expectedImageRevision) fail('REVISION_CONFLICT', 'La foto cambió. Revisá el encuadre.', 409);
  const variants = settings.skuIds.map(id => detail.variants.find(variant => variant.skuId === id));
  if (variants.some(variant => !variant || !variant.active || !variant.identityReviewed || !variant.stockAvailable || !variant.price)) fail('STORY_STOCK_CHANGED', 'Una variante elegida ya no está disponible.', 409);
  const selected = variants.filter(Boolean), exactTotal = selected.reduce((sum, variant) => sum + BigInt(variant.stockAvailable), 0n);
  if (exactTotal > BigInt(Number.MAX_SAFE_INTEGER)) fail('STORY_STOCK_INVALID', 'Revisá las cantidades antes de generar.', 422);
  const total = Number(exactTotal);
  let assertion = 'available', heading = storyTemplates[settings.templateId].heading;
  if (settings.templateId === 'last_unit') {
    if (detail.availableQuantity === 1 && total === 1) assertion = 'last_total';
    else if (selected.length === 1 && selected[0].stockAvailable === 1) { assertion = 'last_size'; heading = `ÚLTIMA UNIDAD · TALLE ${selected[0].size}`; }
    else fail('LAST_UNIT_NOT_TRUE', 'Elegí un talle con una unidad o usá Stock disponible.', 422);
  }
  const profile = await readProfile(client, context.businessId);
  const image = (await client.query('SELECT master_sha256 FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3', [context.businessId, productId, settings.imageId])).rows[0];
  const amounts = selected.map(variant => BigInt(variant.price.amountMinor)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const currencies = new Set(selected.map(variant => variant.price.currency));
  if (currencies.size !== 1) fail('STORY_MONEY_INVALID', 'Las variantes no comparten moneda.', 422);
  let promotion = null;
  if (settings.promotion) {
    requireActivePromotion(settings.promotion);
    const promotional = selected.map(variant => promotionalAmount(variant.price.amountMinor, settings.promotion.percentage))
      .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    promotion = { ...settings.promotion, minAmountMinor: promotional[0], maxAmountMinor: promotional.at(-1) }; heading = promotion.label;
  }
  return { productId, title: detail.title, description: detail.description, teamName: detail.teamName, season: detail.season,
    kitKey: detail.kitKey, versionKey: detail.versionKey, sleeveKey: detail.sleeveKey,
    brandName: profile.brand_name, brandPreset: profile.brand_preset, salesWhatsapp: profile.sales_whatsapp,
    imageId: settings.imageId, imageSha256: image.master_sha256, imageAlt: photo.altText,
    heading, assertion, promotion, availableQuantity: total, totalProductQuantity: detail.availableQuantity,
    variants: selected.map(variant => ({ skuId: variant.skuId, size: variant.size, stockAvailable: variant.stockAvailable,
      price: variant.price, identityFingerprint: variant.identityFingerprint })),
    price: { currency: selected[0].price.currency, fractionDigits: selected[0].price.fractionDigits,
      minAmountMinor: amounts[0].toString(), maxAmountMinor: amounts.at(-1).toString() }, moneyPolicyRevision: detail.moneyPolicyRevision,
    settings: { ...settings, expectedImageRevision: undefined } };
}

export function createCommerceStoryService(runtime) {
  const readSnapshot = async (client, context, id) => {
    const row = (await client.query("SELECT result_json FROM commercial_operations WHERE owner_phone=$1 AND operation_id=$2 AND operation_type='story.prepare'", [context.businessId, uuid(id)])).rows[0];
    if (!row) fail('RESOURCE_NOT_FOUND', 'No encontré la historia preparada.', 404);
    return row.result_json.result;
  };
  const read = (context, callback) => runtime.transaction(async client => {
    await requireCommerceAccess(client, context, 'commerce:story'); return callback(client);
  }, { readOnly: true, repeatableRead: true });
  return {
    prepare: (context, productId, input) => {
      productId = uuid(productId);
      const data = record(input, ['operationId', 'expectedProductRevision', 'settings']);
      const command = { expectedProductRevision: integer(data.expectedProductRevision, 1), settings: settingsOf(data.settings) };
      return executeCommerceCommand(runtime, context, { operationId: uuid(data.operationId), type: 'story.prepare', entityId: productId,
        command, permission: 'commerce:story', repeatableRead: true }, async client => {
        const detail = await readProductDetail(client, context.businessId, productId);
        if (detail.revision !== command.expectedProductRevision) fail('REVISION_CONFLICT', 'La ficha cambió. Actualizá la previsualización.', 409);
        const content = await storyContent(client, context, productId, command.settings, { checkImageRevision: true });
        const now = Date.now();
        return { snapshotId: data.operationId, schemaVersion: 1, rendererVersion: 2, width: 1080, height: 1920,
          createdAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 86_400_000, content.promotion ? Date.parse(content.promotion.endsAt) : Infinity)).toISOString(),
          content, contentFingerprint: operationRequestDigest(content) };
      });
    },
    recover: (context, id) => read(context, client => readSnapshot(client, context, id)),
    validate: (context, id) => read(context, async client => {
      const snapshot = await readSnapshot(client, context, id), checkedAt = new Date().toISOString();
      if (Date.parse(snapshot.expiresAt) <= Date.now()) return { valid: false, reasons: ['SNAPSHOT_EXPIRED'], checkedAt };
      try {
        const current = await storyContent(client, context, snapshot.content.productId, { ...snapshot.content.settings, expectedImageRevision: 1 });
        const valid = operationRequestDigest(current) === snapshot.contentFingerprint;
        return { valid, reasons: valid ? [] : ['COMMERCIAL_CONTENT_CHANGED'], checkedAt };
      } catch (error) {
        if (error?.code && Number(error.status) >= 400 && Number(error.status) < 500) return { valid: false, reasons: [error.code], checkedAt };
        throw error;
      }
    }),
  };
}
