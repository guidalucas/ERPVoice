import { inventoryRowToProduct } from '../inventoryPostgres.js';
import { rowToCommercialProduct } from './productRepository.js';
import { buildCommercialReadiness } from './readiness.js';

// One bounded page, one snapshot, one round trip regardless of the number of products.
// Keep the same readiness rules as Studio, including changed SKU identities and money.
export async function readPublicProducts(client, owner, rows, { mediaKeys = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id), scope = [owner, ids];
  const data = (await client.query(`WITH sku_rows AS (SELECT l.commercial_product_id,l.identity_fingerprint_at_link,l.sort_order AS link_sort_order,
    p.id,p.owner_phone,p.name,p.product_type,p.product_model,p.size,p.attributes_json,p.inventory_unit,
    p.inventory_status,p.inventory_revision,p.stock_available,p.stock_reserved,p.price,p.price_currency,p.family_id,p.family_version
    FROM commercial_product_skus l JOIN products p ON p.owner_phone=l.owner_phone AND p.id=l.sku_id
    WHERE l.owner_phone=$1 AND l.commercial_product_id=ANY($2::uuid[]) ORDER BY l.commercial_product_id,l.sort_order,p.id),
    image_rows AS (SELECT commercial_product_id,id,status,alt_text,sort_order,focal_x,focal_y,revision,width,height,error_code
    ${mediaKeys ? ',master_key,thumbnail_key,master_sha256' : ''}
    FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=ANY($2::uuid[]) AND status<>'deleted'
    ORDER BY commercial_product_id,sort_order,id)
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.commercial_product_id,s.link_sort_order,s.id) FROM sku_rows s),'[]'::jsonb) AS skus,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.commercial_product_id,i.sort_order,i.id) FROM image_rows i),'[]'::jsonb) AS images,
      (SELECT jsonb_build_object('currency',currency,'storageUnit',storage_unit,'fractionDigits',fraction_digits,'revision',revision)
        FROM inventory_money_policies WHERE owner_phone=$1) AS policy`, scope)).rows[0];
  const { skus, images, policy } = data;
  const group = values => { const map = new Map(); for (const value of values) {
    const list = map.get(value.commercial_product_id) ?? []; list.push(value); map.set(value.commercial_product_id, list);
  } return map; };
  const skuGroups = group(skus), imageGroups = group(images);
  return rows.map(row => {
    const product = rowToCommercialProduct(row);
    const variants = (skuGroups.get(row.id) ?? []).map(sku => ({ ...inventoryRowToProduct(sku), linkFingerprint: sku.identity_fingerprint_at_link }));
    const photos = (imageGroups.get(row.id) ?? []).map(image => ({ id: image.id, status: image.status, altText: image.alt_text,
      sortOrder: image.sort_order, focalX: Number(image.focal_x), focalY: Number(image.focal_y), revision: Number(image.revision),
      width: image.width, height: image.height, errorCode: image.error_code,
      ...(mediaKeys ? { masterKey: image.master_key, thumbnailKey: image.thumbnail_key, masterSha256: image.master_sha256 } : {}) }));
    return { ...product, images: photos, ...buildCommercialReadiness(product, variants, photos, policy) };
  });
}
