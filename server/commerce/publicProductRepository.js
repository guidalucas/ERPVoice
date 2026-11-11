import { inventoryRowToProduct } from '../inventoryPostgres.js';
import { rowToCommercialProduct } from './productRepository.js';
import { buildCommercialReadiness } from './readiness.js';

export const publicCatalogSelect = `SELECT c.owner_phone,c.slug,p.brand_name,p.brand_preset,p.sales_whatsapp,p.revision,to_jsonb(p)->'appearance' AS appearance
  FROM commerce_catalogs c JOIN commerce_profiles p ON p.owner_phone=c.owner_phone
  WHERE c.slug=$1 AND c.public_enabled=true AND p.enabled=true AND p.sales_whatsapp IS NOT NULL`;

const linkedRows = mediaKeys => `sku_rows AS (SELECT l.commercial_product_id,l.identity_fingerprint_at_link,l.sort_order AS link_sort_order,
    p.id,p.owner_phone,p.name,p.product_type,p.product_model,p.size,p.attributes_json,p.inventory_unit,
    p.inventory_status,p.inventory_revision,p.stock_available,p.stock_reserved,p.price,p.price_currency,p.family_id,p.family_version
    FROM product_scope t JOIN commercial_product_skus l ON l.owner_phone=t.owner_phone AND l.commercial_product_id=t.id
    JOIN products p ON p.owner_phone=l.owner_phone AND p.id=l.sku_id),
    image_rows AS (SELECT i.commercial_product_id,i.id,i.status,i.alt_text,i.sort_order,i.focal_x,i.focal_y,i.revision,i.width,i.height,i.error_code
      ${mediaKeys ? ',i.master_key,i.thumbnail_key,i.master_sha256' : ''}
      FROM product_scope t JOIN commercial_product_images i ON i.owner_phone=t.owner_phone AND i.commercial_product_id=t.id
      WHERE i.status<>'deleted')`;

const linkedProjection = `COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.commercial_product_id,s.link_sort_order,s.id) FROM sku_rows s),'[]'::jsonb) AS skus,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.commercial_product_id,i.sort_order,i.id) FROM image_rows i),'[]'::jsonb) AS images,
      (SELECT jsonb_build_object('currency',currency,'storageUnit',storage_unit,'fractionDigits',fraction_digits,'revision',revision)
        FROM inventory_money_policies WHERE owner_phone=(SELECT owner_phone FROM product_scope LIMIT 1)) AS policy`;

// Keep the same readiness rules as Studio, including changed SKU identities and money.
function assemblePublicProducts(rows, { skus, images, policy }, mediaKeys) {
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

// One round trip for the linked data of a bounded page, inside the caller's snapshot.
export async function readPublicProducts(client, owner, rows) {
  if (!rows.length) return [];
  const data = (await client.query(`WITH product_scope AS (SELECT $1::text AS owner_phone,unnest($2::uuid[]) AS id),
    ${linkedRows(false)}
    SELECT ${linkedProjection}`, [owner, rows.map(row => row.id)])).rows[0];
  return assemblePublicProducts(rows, data, false);
}

// A single SELECT gives detail and media reads one consistent PostgreSQL snapshot.
export async function readPublicProductSnapshot(client, shop, productSlug, { mediaKeys = false } = {}) {
  const row = (await client.query(`WITH catalog AS (${publicCatalogSelect}),
    product_scope AS (
      SELECT p.* FROM catalog c JOIN commercial_products p ON p.owner_phone=c.owner_phone
      JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
      WHERE p.slug=$2 AND p.status='ready' AND s.status='published'
    ), ${linkedRows(mediaKeys)}
    SELECT p.*,to_jsonb(c) AS catalog,${linkedProjection}
    FROM product_scope p JOIN catalog c ON c.owner_phone=p.owner_phone`, [shop, productSlug])).rows[0];
  if (!row) return null;
  const [product] = assemblePublicProducts([row], row, mediaKeys);
  return { catalog: row.catalog, product };
}
