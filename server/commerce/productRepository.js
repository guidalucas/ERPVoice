import { inventoryRowToProduct } from '../inventoryPostgres.js';
import { buildCommercialReadiness } from './readiness.js';
import { fail } from './errors.js';

export const rowToCommercialProduct = row => ({ id: row.id, title: row.title, description: row.description,
  teamKey: row.team_key, teamName: row.team_name, teamKind: row.team_kind, season: row.season,
  kitKey: row.kit_key, versionKey: row.version_key, sleeveKey: row.sleeve_key, identityKey: row.identity_key,
  slug: row.slug, status: row.status, coverImageId: row.cover_image_id, revision: Number(row.revision),
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

export async function readProfile(client, businessId) {
  return (await client.query('SELECT * FROM commerce_profiles WHERE owner_phone=$1', [businessId])).rows[0] ?? null;
}
export async function readMoneyPolicy(client, businessId) {
  const row = (await client.query('SELECT * FROM inventory_money_policies WHERE owner_phone=$1', [businessId])).rows[0];
  return row ? { currency: row.currency, storageUnit: row.storage_unit, fractionDigits: Number(row.fraction_digits), revision: Number(row.revision) } : null;
}
export async function requireProduct(client, businessId, id, { lock = false } = {}) {
  const row = (await client.query(`SELECT * FROM commercial_products WHERE owner_phone=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [businessId, id])).rows[0];
  if (!row) fail('RESOURCE_NOT_FOUND', 'No encontré la ficha comercial.', 404);
  return row;
}
export async function readProductDetail(client, businessId, id) {
  const product = rowToCommercialProduct(await requireProduct(client, businessId, id));
  const rows = (await client.query(`SELECT p.*,l.identity_fingerprint_at_link FROM commercial_product_skus l
    JOIN products p ON p.owner_phone=l.owner_phone AND p.id=l.sku_id
    WHERE l.owner_phone=$1 AND l.commercial_product_id=$2 ORDER BY l.sort_order,p.id`, [businessId, id])).rows;
  const skus = rows.map(row => ({ ...inventoryRowToProduct(row), linkFingerprint: row.identity_fingerprint_at_link }));
  const images = (await client.query(`SELECT id,status,alt_text,sort_order,focal_x,focal_y,revision,width,height,error_code
    FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=$2 AND status<>'deleted'
    ORDER BY sort_order,id`, [businessId, id])).rows.map(row => ({ id: row.id, status: row.status, altText: row.alt_text,
    sortOrder: row.sort_order, focalX: Number(row.focal_x), focalY: Number(row.focal_y), revision: Number(row.revision),
    width: row.width, height: row.height, errorCode: row.error_code }));
  const policy = await readMoneyPolicy(client, businessId);
  return { ...product, images, ...buildCommercialReadiness(product, skus, images, policy),
    moneyPolicyRevision: policy?.revision ?? null, readAt: new Date().toISOString() };
}

const productValues = data => [data.title, data.description, data.teamKey, data.teamName, data.teamKind,
  data.season, data.kitKey, data.versionKey, data.sleeveKey, data.identityKey];
export async function insertProduct(client, businessId, actorId, id, slug, data) {
  await client.query(`INSERT INTO commercial_products(owner_phone,id,slug,title,description,team_key,team_name,team_kind,
    season,kit_key,version_key,sleeve_key,identity_key,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`, [businessId, id, slug, ...productValues(data), actorId]);
}
export async function updateProduct(client, businessId, actorId, id, data, { invalidate = true } = {}) {
  await client.query(`UPDATE commercial_products SET title=$3,description=$4,team_key=$5,team_name=$6,team_kind=$7,
    season=$8,kit_key=$9,version_key=$10,sleeve_key=$11,identity_key=$12,revision=revision+1,updated_by=$13,updated_at=NOW(),
    status=CASE WHEN $14 THEN 'draft' ELSE status END WHERE owner_phone=$1 AND id=$2`, [businessId, id, ...productValues(data), actorId, invalidate]);
}
