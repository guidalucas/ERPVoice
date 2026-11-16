import { operationRequestDigest } from '../operationHash.js';
import { createStorySnapshot, storyContent, validateStorySnapshot } from './storyService.js';
import { readProductDetail } from './productRepository.js';
import { fail } from './errors.js';

export async function selectAutoStory(client, context, snapshotId, instagramId) {
  // SQL narrows the candidates. The manual story's commercial rules decide eligibility.
  const candidates = (await client.query(`
    WITH history AS (
      SELECT product_id,cycle FROM commerce_auto_story_jobs
      WHERE owner_phone=$1 AND instagram_id=$2 AND status='published'
    ), current_cycle AS (SELECT COALESCE(max(cycle),1) AS number FROM history)
    SELECT p.id, number + seen::int AS cycle FROM commercial_products p CROSS JOIN current_cycle
    CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM history WHERE product_id=p.id AND cycle=number) AS seen) r
    WHERE p.owner_phone=$1 AND p.status='ready' AND p.auto_story_enabled
      AND EXISTS (SELECT 1 FROM commercial_product_images i WHERE i.owner_phone=p.owner_phone
        AND i.commercial_product_id=p.id AND i.id=p.cover_image_id AND i.status='ready')
      AND EXISTS (SELECT 1 FROM commercial_product_skus l JOIN products s ON s.owner_phone=l.owner_phone AND s.id=l.sku_id
        WHERE l.owner_phone=p.owner_phone AND l.commercial_product_id=p.id
          AND s.inventory_status='active' AND s.stock_available>0 AND s.price>0)
    ORDER BY seen,random()`, [context.businessId, instagramId])).rows;
  for (const candidate of candidates) {
    const product = await readProductDetail(client, context.businessId, candidate.id);
    if (!product.readiness.canGenerateStory) continue;
    const photo = product.images.find(image => image.id === product.coverImageId);
    const skuIds = product.variants.filter(variant => variant.active && variant.identityReviewed && variant.stockAvailable > 0 && variant.price)
      .map(variant => variant.skuId).sort();
    if (skuIds.length > 100) continue;
    const content = await storyContent(client, context, product.id, {
      templateId: 'available', templateVersion: 1, imageId: photo.id, expectedImageRevision: photo.revision,
      skuIds, showPrice: true, fit: 'contain', zoom: 1.1, focalX: photo.focalX, focalY: photo.focalY,
      caption: '', cta: '', promotion: null,
    }, { checkImageRevision: true });
    return { cycle: candidate.cycle, snapshot: createStorySnapshot(snapshotId, content) };
  }
  return null;
}

export async function revalidateAutoStory(client, context, snapshot) {
  const { productId, imageId } = snapshot.content;
  const { rows } = await client.query('SELECT auto_story_enabled,cover_image_id FROM commercial_products WHERE owner_phone=$1 AND id=$2',
    [context.businessId, productId]);
  if (!rows[0]?.auto_story_enabled || rows[0].cover_image_id !== imageId) fail('STORY_SELECTION_CHANGED', 'Cambió la selección de la historia.', 409);
  const result = await validateStorySnapshot(client, context, snapshot);
  if (!result.valid) fail(result.reasons[0], 'Los datos comerciales de la historia cambiaron.', 409);
  // Newly available presentations must also be reflected in the advertised sizes.
  const product = await readProductDetail(client, context.businessId, productId);
  const ids = product.variants.filter(variant => variant.active && variant.identityReviewed && variant.stockAvailable > 0 && variant.price)
    .map(variant => variant.skuId).sort();
  if (operationRequestDigest(ids) !== operationRequestDigest(snapshot.content.settings.skuIds)) fail('STORY_STOCK_CHANGED', 'Cambió el stock de la historia.', 409);
}
