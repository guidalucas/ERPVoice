import { randomUUID } from 'node:crypto';
import { record, uuid, integer, text, denseArray } from './validation.js';
import { fail } from './errors.js';
import { requireCommerceAccess, executeCommerceCommand } from './operationRepository.js';
import { readProductDetail, requireProduct } from './productRepository.js';
import { inspectCatalogSchema } from './catalogMigration.js';
import { createMediaStorage } from './mediaStorage.js';
import { sha256 } from './imageProcessor.js';
import { operationRequestDigest } from '../operationHash.js';
import { formatMoneyAmount } from './moneyPresentation.js';
import { appearanceOf, requireAppearanceSchema } from './appearance.js';

const catalogDTO = row => row ? { slug: row.slug, publicEnabled: row.public_enabled, revision: Number(row.revision), path: `/c/${row.slug}` } : null;
const publicationDTO = row => ({ status: row?.status ?? 'hidden', revision: Number(row?.revision ?? 0), publishedAt: row?.published_at?.toISOString() ?? null });
const notFound = () => fail('RESOURCE_NOT_FOUND', 'No encontré ese catálogo o producto.', 404);
const slug = value => { if (typeof value !== 'string' || value.length < 3 || value.length > 120 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) notFound(); return value; };
const assertRevision = (row, revision) => { if (Number(row?.revision ?? 0) !== revision) fail('REVISION_CONFLICT', 'La publicación cambió. Actualizá los datos antes de guardar.', 409); };
const photoUrl = (shop, product, image, thumbnail = false) => `/api/catalog/v1/${shop}/products/${product}/images/${image}${thumbnail ? '?variant=thumbnail' : ''}`;

/** Deliberate allowlist; never spread a private product/profile in a public DTO. */
export function publicProductProjection(product, shop) {
  return { slug: product.slug, title: product.title, description: product.description, teamKey: product.teamKey, teamName: product.teamName,
    teamKind: product.teamKind, season: product.season, kitKey: product.kitKey, versionKey: product.versionKey, sleeveKey: product.sleeveKey,
    priceRange: product.priceRange, available: product.availability === 'in_stock',
    sizes: product.variants.filter(item => item.active).map(item => ({ size: item.size, available: item.stockAvailable > 0, price: item.price })),
    photos: product.images.filter(image => image.status === 'ready').map(image => ({ id: image.id, alt: image.altText,
      url: photoUrl(shop, product.slug, image.id), thumbnailUrl: photoUrl(shop, product.slug, image.id, true), cover: image.id === product.coverImageId })),
    path: `/c/${shop}/p/${product.slug}` };
}

export function createCatalogService(runtime, storage = createMediaStorage()) {
  let initialized;
  const ensure = async () => {
    initialized ??= runtime.withClient(async client => { if (!(await inspectCatalogSchema(client)).ready) fail('CATALOG_SCHEMA_NOT_READY', 'La preparación del catálogo está pendiente.', 503); })
      .catch(error => { initialized = undefined; throw error; }); await initialized;
  };
  const privateRead = async (context, callback) => {
    await ensure(); return runtime.transaction(async client => { await requireCommerceAccess(client, context, 'commerce:read'); return callback(client); }, { readOnly: true, repeatableRead: true });
  };
  const mutate = async (context, meta, callback) => {
    await ensure(); try { return await executeCommerceCommand(runtime, context, meta, callback); }
    catch (error) { if (error.code === '23505') fail('CATALOG_SLUG_TAKEN', 'Ese identificador de catálogo ya está ocupado.', 409); throw error; }
  };
  const requireCatalog = async (client, shop) => {
    slug(shop);
    const row = (await client.query(`SELECT c.owner_phone,c.slug,p.brand_name,p.brand_preset,p.sales_whatsapp,to_jsonb(p)->'appearance' AS appearance
      FROM commerce_catalogs c JOIN commerce_profiles p ON p.owner_phone=c.owner_phone
      WHERE c.slug=$1 AND c.public_enabled=true AND p.enabled=true AND p.sales_whatsapp IS NOT NULL`, [shop])).rows[0];
    if (!row) notFound(); return row;
  };
  const publicRead = async (shop, callback) => { await ensure(); return runtime.transaction(async client => callback(client, await requireCatalog(client, shop)), { readOnly: true, repeatableRead: true }); };
  const publicProduct = async (client, catalog, productSlug) => {
    slug(productSlug);
    const row = (await client.query(`SELECT p.id FROM commercial_products p JOIN commercial_publications s
      ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id WHERE p.owner_phone=$1 AND p.slug=$2 AND p.status='ready' AND s.status='published'`, [catalog.owner_phone, productSlug])).rows[0];
    if (!row) notFound(); const detail = await readProductDetail(client, catalog.owner_phone, row.id);
    if (!detail.readiness.canPrepare) notFound(); return detail;
  };
  const publicBrand = row => ({ slug: row.slug, brandName: row.brand_name, brandPreset: row.brand_preset, salesWhatsapp: row.sales_whatsapp,
    appearance: appearanceOf(row), path: `/c/${row.slug}` });
  return {
    brandAsset: (shop, id) => publicRead(shop, async (client, row) => {
      uuid(id); const appearance = appearanceOf(row);
      if (![appearance.logoId, appearance.coverId].includes(id)) notFound();
      await requireAppearanceSchema(client);
      const asset = (await client.query('SELECT mime_type,content FROM commerce_brand_assets WHERE owner_phone=$1 AND id=$2', [row.owner_phone, id])).rows[0];
      if (!asset) notFound(); return asset;
    }),
    configuration: context => privateRead(context, async client => catalogDTO((await client.query('SELECT * FROM commerce_catalogs WHERE owner_phone=$1', [context.businessId])).rows[0])),
    configure: (context, input) => {
      const data = record(input, ['operationId', 'expectedRevision', 'slug', 'publicEnabled']);
      const command = { expectedRevision: integer(data.expectedRevision), slug: text(data.slug, 64, 'catalog slug'), publicEnabled: data.publicEnabled };
      if (command.slug.length < 3 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(command.slug) || ['api', 'admin', 'assets', 'studio'].includes(command.slug) || typeof command.publicEnabled !== 'boolean') fail('INVALID_COMMAND', 'Elegí un identificador público válido para el catálogo.', 400);
      return mutate(context, { operationId: uuid(data.operationId), type: 'catalog.configure', command, permission: 'commerce:settings' }, async client => {
        await client.query('SELECT owner_phone FROM commerce_profiles WHERE owner_phone=$1 FOR UPDATE', [context.businessId]);
        const row = (await client.query('SELECT * FROM commerce_catalogs WHERE owner_phone=$1 FOR UPDATE', [context.businessId])).rows[0]; assertRevision(row, command.expectedRevision);
        if (row && row.slug !== command.slug) fail('CATALOG_SLUG_IMMUTABLE', 'El enlace del catálogo es estable. Conservá su identificador.', 409);
        const profile = await requireCommerceAccess(client, context, 'commerce:settings');
        if (command.publicEnabled && !profile.sales_whatsapp) fail('SALES_CONTACT_REQUIRED', 'Configurá el WhatsApp de ventas antes de habilitar el catálogo.', 422);
        const saved = row ? (await client.query('UPDATE commerce_catalogs SET public_enabled=$2,revision=revision+1,updated_by=$3,updated_at=NOW() WHERE owner_phone=$1 RETURNING *', [context.businessId, command.publicEnabled, context.actorId])).rows[0]
          : (await client.query('INSERT INTO commerce_catalogs(owner_phone,id,slug,public_enabled,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *', [context.businessId, randomUUID(), command.slug, command.publicEnabled, context.actorId])).rows[0];
        return catalogDTO(saved);
      });
    },
    publication: (context, productId) => privateRead(context, async client => {
      await requireProduct(client, context.businessId, uuid(productId));
      return publicationDTO((await client.query('SELECT * FROM commercial_publications WHERE owner_phone=$1 AND commercial_product_id=$2', [context.businessId, productId])).rows[0]);
    }),
    publish: (context, productId, input) => {
      productId = uuid(productId); const data = record(input, ['operationId', 'expectedRevision', 'expectedProductRevision', 'status', 'reason']);
      const command = { expectedRevision: integer(data.expectedRevision), expectedProductRevision: integer(data.expectedProductRevision, 1), status: data.status, reason: text(data.reason, 500, 'publication reason') };
      if (!['hidden', 'published'].includes(command.status)) fail('INVALID_COMMAND', 'Estado de publicación inválido.', 400);
      return mutate(context, { operationId: uuid(data.operationId), type: 'product.publish', entityId: productId, command }, async client => {
        const product = await requireProduct(client, context.businessId, productId, { lock: true });
        if (Number(product.revision) !== command.expectedProductRevision) fail('REVISION_CONFLICT', 'La ficha cambió. Revisala antes de publicar.', 409);
        const previous = (await client.query('SELECT * FROM commercial_publications WHERE owner_phone=$1 AND commercial_product_id=$2 FOR UPDATE', [context.businessId, productId])).rows[0]; assertRevision(previous, command.expectedRevision);
        if (command.status === 'published') {
          const detail = await readProductDetail(client, context.businessId, productId);
          if (product.status !== 'ready' || !detail.readiness.canPrepare) fail('PRODUCT_NOT_READY', 'Prepará y revisá la ficha antes de publicarla.', 422);
          if (!storage.configured) fail('MEDIA_NOT_CONFIGURED', 'Configurá el almacenamiento privado antes de publicar.', 503);
          if (!(await client.query('SELECT 1 FROM commerce_catalogs WHERE owner_phone=$1', [context.businessId])).rowCount) fail('CATALOG_NOT_CONFIGURED', 'Configurá el catálogo antes de publicar fichas.', 422);
        }
        const saved = (await client.query(`INSERT INTO commercial_publications(owner_phone,commercial_product_id,status,reason,updated_by,published_at)
          VALUES($1,$2,$3,$4,$5,CASE WHEN $3='published' THEN NOW() ELSE NULL END)
          ON CONFLICT(owner_phone,commercial_product_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,
          revision=commercial_publications.revision+1,published_at=CASE WHEN EXCLUDED.status='published' THEN NOW() ELSE commercial_publications.published_at END,updated_at=NOW() RETURNING *`,
        [context.businessId, productId, command.status, command.reason, context.actorId])).rows[0]; return publicationDTO(saved);
      });
    },
    brand: shop => publicRead(shop, async (_client, row) => publicBrand(row)),
    inquiry: (shop, input) => {
      const data = record(input, ['items', 'previousFingerprint']);
      const items = denseArray(data.items, 20, 'inquiry items').map(raw => {
        const item = record(raw, ['productSlug', 'size', 'quantity']);
        const quantity = integer(item.quantity, 1); if (quantity > 10) fail('INQUIRY_QUANTITY_INVALID', 'Hasta diez unidades por talle en una consulta.', 400);
        return { productSlug: slug(item.productSlug), size: text(item.size, 40, 'size'), quantity };
      });
      if (!items.length || new Set(items.map(item => JSON.stringify([item.productSlug, item.size.toLocaleLowerCase('es')]))).size !== items.length) fail('INQUIRY_ITEMS_INVALID', 'Elegí camisetas sin repetir el mismo talle.', 400);
      const previous = data.previousFingerprint == null ? null : text(data.previousFingerprint, 64, 'previous fingerprint');
      if (previous && !/^[a-f0-9]{64}$/.test(previous)) fail('INVALID_COMMAND', 'Huella de consulta inválida.', 400);
      return publicRead(shop, async (client, catalog) => {
        const lines = [];
        for (const item of items) {
          let product;
          try { product = await publicProduct(client, catalog, item.productSlug); }
          catch (error) { if (error.status !== 404) throw error; }
          const variant = product?.variants.find(variant => variant.active && variant.size.normalize('NFC').trim().toLocaleLowerCase('es') === item.size.toLocaleLowerCase('es'));
          if (!product || !variant) { lines.push({ ...item, title: 'Producto o talle no disponible', available: false, unitPrice: null, lineTotal: null, path: null }); continue; }
          const total = (BigInt(variant.price.amountMinor) * BigInt(item.quantity)).toString();
          lines.push({ ...item, size: variant.size, title: product.title, available: variant.stockAvailable >= item.quantity,
            unitPrice: variant.price, lineTotal: { ...variant.price, amountMinor: total }, path: `/c/${shop}/p/${product.slug}` });
        }
        const currencies = new Set(lines.filter(line => line.unitPrice).map(line => line.unitPrice.currency));
        const canContact = lines.every(line => line.available) && currencies.size === 1;
        const total = canContact ? { ...lines[0].unitPrice, amountMinor: lines.reduce((sum, line) => sum + BigInt(line.lineTotal.amountMinor), 0n).toString() } : null;
        const brand = publicBrand(catalog), fingerprint = operationRequestDigest({ catalog: brand, lines, total });
        const format = amount => formatMoneyAmount(amount.amountMinor, amount.currency, amount.fractionDigits);
        const contactText = canContact ? `Hola, quiero consultar estas camisetas de ${brand.brandName}:\n${lines.map(line => `• ${line.quantity} × ${line.title.slice(0, 80)} · talle ${line.size.slice(0, 20)} · ${format(line.unitPrice)} c/u`).join('\n')}\nTotal orientativo: ${format(total)}.\nA confirmar con el comercio. Esta consulta no reserva stock ni realiza un pago.` : null;
        return { catalog: brand, lines, total, canContact, fingerprint, changed: Boolean(previous && previous !== fingerprint),
          quotedAt: new Date().toISOString(), contactUrl: contactText ? `https://wa.me/${brand.salesWhatsapp}?text=${encodeURIComponent(contactText)}` : null };
      });
    },
    detail: (shop, productSlug) => publicRead(shop, async (client, catalog) => ({ catalog: publicBrand(catalog), product: publicProductProjection(await publicProduct(client, catalog, productSlug), shop) })),
    list: (shop, query = {}) => publicRead(shop, async (client, catalog) => {
      const data = record(query, ['q', 'team', 'season', 'version', 'sleeve', 'kit', 'cursor', 'limit']);
      const limit = data.limit === undefined ? 24 : Number(data.limit); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 48) fail('INVALID_COMMAND', 'Límite de catálogo inválido.', 400);
      const values = [catalog.owner_phone], conditions = ["p.owner_phone=$1", "p.status='ready'", "s.status='published'"];
      for (const [key, column] of Object.entries({ team: 'team_key', season: 'season', version: 'version_key', sleeve: 'sleeve_key', kit: 'kit_key' })) if (data[key]) { values.push(text(data[key], 100, key)); conditions.push(`p.${column}=$${values.length}`); }
      if (data.q) { values.push(`%${text(data.q, 120, 'query').replace(/[\\%_]/g, '\\$&')}%`); conditions.push(`(p.title ILIKE $${values.length} OR p.team_name ILIKE $${values.length})`); }
      if (data.cursor) { values.push(slug(data.cursor)); conditions.push(`p.slug>$${values.length}`); }
      values.push(limit + 1);
      const rows = (await client.query(`SELECT p.id,p.slug FROM commercial_products p JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
        WHERE ${conditions.join(' AND ')} ORDER BY p.slug LIMIT $${values.length}`, values)).rows;
      const batch = rows.slice(0, limit), items = [];
      for (const row of batch) { const detail = await readProductDetail(client, catalog.owner_phone, row.id); if (detail.readiness.canPrepare) items.push(publicProductProjection(detail, shop)); }
      return { catalog: publicBrand(catalog), items, nextCursor: rows.length > limit ? batch.at(-1).slug : null };
    }),
    image: async (shop, productSlug, imageId, variant = 'master') => {
      uuid(imageId); if (!['master', 'thumbnail'].includes(variant)) notFound();
      const selected = await publicRead(shop, async (client, catalog) => {
        const product = await publicProduct(client, catalog, productSlug);
        if (!product.images.some(image => image.id === imageId && image.status === 'ready')) notFound();
        const row = (await client.query('SELECT master_key,thumbnail_key,master_sha256 FROM commercial_product_images WHERE owner_phone=$1 AND commercial_product_id=$2 AND id=$3', [catalog.owner_phone, product.id, imageId])).rows[0];
        return { key: variant === 'thumbnail' ? row.thumbnail_key : row.master_key, hash: variant === 'master' ? row.master_sha256 : null };
      });
      if (!storage.configured) fail('MEDIA_NOT_CONFIGURED', 'La fotografía no está disponible.', 503);
      const bytes = await storage.get(selected.key); if (selected.hash && sha256(bytes) !== selected.hash) fail('MEDIA_INTEGRITY_ERROR', 'La fotografía no está disponible.', 503); return bytes;
    },
  };
}
