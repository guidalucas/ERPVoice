import { assembleProducts, linkedRows, linkedProjection } from './productReadModel.js';
import { productSlugPrefix } from './productIdentity.js';
export { readProductDetails as readPublicProducts } from './productReadModel.js';

export const publicCatalogSelect = `SELECT c.owner_phone,c.slug,p.brand_name,p.brand_preset,p.sales_whatsapp,p.revision,to_jsonb(p)->'appearance' AS appearance
  FROM commerce_catalogs c JOIN commerce_profiles p ON p.owner_phone=c.owner_phone
  WHERE c.slug=$1 AND c.public_enabled=true AND p.enabled=true AND p.sales_whatsapp IS NOT NULL`;

// A single SELECT gives detail and media reads one consistent PostgreSQL snapshot.
export async function readPublicProductSnapshot(client, shop, productSlug, { mediaKeys = false } = {}) {
  const row = (await client.query(`WITH catalog AS (${publicCatalogSelect}),
    product_scope AS (
      SELECT p.* FROM catalog c JOIN commercial_products p ON p.owner_phone=c.owner_phone
      JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
      WHERE (p.slug=$2 OR ($3::text IS NOT NULL AND left(replace(p.id::text,'-',''),10)=$3)) AND p.status='ready' AND s.status='published'
      ORDER BY (p.slug=$2) DESC LIMIT 1
    ), ${linkedRows(mediaKeys)}
    SELECT p.*,to_jsonb(c) AS catalog,${linkedProjection}
    FROM product_scope p JOIN catalog c ON c.owner_phone=p.owner_phone`, [shop, productSlug, productSlugPrefix(productSlug)])).rows[0];
  if (!row) return null;
  const [product] = assembleProducts([row], row, mediaKeys);
  return { catalog: row.catalog, product };
}
