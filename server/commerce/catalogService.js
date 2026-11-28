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
import { variantLabel } from './presentation.js';
import { publicCatalogSelect, readPublicProducts, readPublicProductSnapshot } from './publicProductRepository.js';
import { createMediaCache } from '../catalog/mediaCache.js';
import sharp from 'sharp';
import { measureCatalogPhase } from '../catalog/timing.js';
import { productTitleSql } from './productTitle.js';
import { catalogIdentity } from './catalogIdentity.js';
import { salesWhatsapp } from './salesWhatsapp.js';
import { publicProductSlug, productSlugPrefix } from './productIdentity.js';
import { normalizeCatalogSize, sortCatalogSizes } from '../../src/shared/catalogSizes.js';

const catalogDTO = row => row ? { slug: row.slug, publicEnabled: row.public_enabled, revision: Number(row.revision), path: `/c/${row.slug}` } : null;
const publicationDTO = row => ({ status: row?.status ?? 'hidden', revision: Number(row?.revision ?? 0), publishedAt: row?.published_at?.toISOString() ?? null });
const notFound = () => fail('RESOURCE_NOT_FOUND', 'No encontré ese catálogo o producto.', 404);
const slug = value => { if (typeof value !== 'string' || value.length < 3 || value.length > 120 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) notFound(); return value; };
const assertRevision = (row, revision) => { if (Number(row?.revision ?? 0) !== revision) fail('REVISION_CONFLICT', 'La publicación cambió. Actualizá los datos antes de guardar.', 409); };
const photoUrl = (shop, product, image, thumbnail = false) => `/api/catalog/v1/${shop}/products/${product}/images/${image}${thumbnail ? '?variant=thumbnail' : ''}`;

/** Deliberate allowlist; never spread a private product/profile in a public DTO. */
export function publicProductProjection(product, shop) {
  const identity = catalogIdentity(product, product.variants);
  product = { ...product, slug: publicProductSlug(product) };
  return { slug: product.slug, title: product.title, description: product.description, teamKey: identity.teamKey, teamName: identity.teamName,
    teamKind: product.teamKind, season: product.season, kitKey: product.kitKey, versionKey: identity.versionKey, sleeveKey: product.sleeveKey,
    priceRange: product.priceRange, available: product.availability === 'in_stock',
    category: identity.categories.join(' · '),
    variantLabel: publicVariantTitle(product),
    sizes: product.variants.filter(item => item.active).map(item => ({ size: item.label, unit: item.unit, specifications: item.specifications, available: item.stockAvailable > 0, price: item.price })),
    photos: product.images.filter(image => image.status === 'ready').map(image => ({ id: image.id, alt: image.altText,
      url: photoUrl(shop, product.slug, image.id), thumbnailUrl: photoUrl(shop, product.slug, image.id, true),
      thumbnailWebpUrl: `${photoUrl(shop, product.slug, image.id, true)}&format=webp`,
      detailUrl: `${photoUrl(shop, product.slug, image.id)}?variant=detail&format=webp`, cover: image.id === product.coverImageId })),
    path: `/c/${shop}/p/${product.slug}` };
}

const publicVariantTitle = product => {
  const active = product.variants.filter(item => item.active);
  return active.length && active.every(item => item.size?.trim()) ? 'Talle' : 'Presentación';
};

export function createCatalogService(runtime, storage = createMediaStorage()) {
  // Object keys and checksums identify immutable bytes. Publication is checked on every read.
  const cachedMedia = createMediaCache({ ttlMs: 60 * 60 * 1000 });
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
    const row = (await client.query(publicCatalogSelect, [shop])).rows[0];
    if (!row) notFound(); return row;
  };
  const publicRead = async (shop, callback) => { await ensure(); return runtime.transaction(async client => callback(client, await requireCatalog(client, shop)), { readOnly: true, repeatableRead: true }); };
  const productSnapshot = async (shop, productSlug, options) => {
    slug(shop);
    slug(productSlug);
    await ensure();
    const snapshot = await runtime.withClient(client => readPublicProductSnapshot(client, shop, productSlug, options));
    if (!snapshot?.product.readiness.canPrepare) notFound();
    return snapshot;
  };
  const publicProduct = async (client, catalog, productSlug) => {
    slug(productSlug);
    const row = (await client.query(`SELECT p.* FROM commercial_products p JOIN commercial_publications s
      ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id WHERE p.owner_phone=$1
      AND (p.slug=$2 OR ($3::text IS NOT NULL AND left(replace(p.id::text,'-',''),10)=$3)) AND p.status='ready' AND s.status='published'
      ORDER BY (p.slug=$2) DESC LIMIT 1`, [catalog.owner_phone, productSlug, productSlugPrefix(productSlug)])).rows[0];
    if (!row) notFound(); const [detail] = await readPublicProducts(client, catalog.owner_phone, [row]);
    if (!detail.readiness.canPrepare) notFound(); return detail;
  };
  const publicBrand = row => ({ slug: row.slug, brandName: row.brand_name, brandPreset: row.brand_preset, salesWhatsapp: salesWhatsapp(row.sales_whatsapp, row.owner_phone),
    appearance: appearanceOf(row), appearanceRevision: Number(row.revision), path: `/c/${row.slug}` });
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
          if (!detail.readiness.canPrepare) fail('PRODUCT_NOT_READY', 'Revisá el nombre, las variantes y sus precios antes de publicar.', 422, { blockers: detail.readiness.blockers });
          if (!(await client.query('SELECT 1 FROM commerce_catalogs WHERE owner_phone=$1', [context.businessId])).rowCount) fail('CATALOG_NOT_CONFIGURED', 'Configurá el catálogo antes de publicar fichas.', 422);
          if (product.status !== 'ready') {
            if ((!detail.identityKey || !detail.teamName || !detail.teamKind) && !(await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=5')).rowCount)
              fail('UNIVERSAL_SCHEMA_NOT_READY', 'El servicio comercial necesita la actualización multirrubro para publicar esta ficha.', 503);
            await client.query("UPDATE commercial_products SET status='ready',revision=revision+1,updated_at=NOW(),updated_by=$3 WHERE owner_phone=$1 AND id=$2", [context.businessId, productId, context.actorId]);
          }
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
        const quantity = integer(item.quantity, 1); if (quantity > 10) fail('INQUIRY_QUANTITY_INVALID', 'Hasta diez unidades por variante en un pedido.', 400);
        return { productSlug: slug(item.productSlug), size: text(item.size, 200, 'size'), quantity };
      });
      if (!items.length || new Set(items.map(item => JSON.stringify([item.productSlug, item.size.toLocaleLowerCase('es')]))).size !== items.length) fail('INQUIRY_ITEMS_INVALID', 'Elegí productos sin repetir la misma presentación.', 400);
      const previous = data.previousFingerprint == null ? null : text(data.previousFingerprint, 64, 'previous fingerprint');
      if (previous && !/^[a-f0-9]{64}$/.test(previous)) fail('INVALID_COMMAND', 'Huella de pedido inválida.', 400);
      return publicRead(shop, async (client, catalog) => {
        const lines = [], seenVariants = new Set();
        for (const item of items) {
          let product;
          try { product = await publicProduct(client, catalog, item.productSlug); }
          catch (error) { if (error.status !== 404) throw error; }
          const variant = product?.variants.find(variant => variant.active && variantLabel(variant).normalize('NFC').trim().toLocaleLowerCase('es') === item.size.toLocaleLowerCase('es'));
          if (!product || !variant) { lines.push({ ...item, title: 'Producto o variante no disponible', variantLabel: 'Variante', photo: null, available: false, unitPrice: null, lineTotal: null, path: null }); continue; }
          const identity = JSON.stringify([product.id, variant.skuId]);
          if (seenVariants.has(identity)) fail('INQUIRY_ITEMS_INVALID', 'La misma variante aparece con dos enlaces distintos. Retirá una de las líneas del pedido.', 400);
          seenVariants.add(identity);
          const image = product.images.find(image => image.status === 'ready' && image.id === product.coverImageId) ?? product.images.find(image => image.status === 'ready');
          const total = (BigInt(variant.price.amountMinor) * BigInt(item.quantity)).toString();
          lines.push({ ...item, size: variantLabel(variant), title: product.title, variantLabel: publicVariantTitle(product),
            photo: image ? { thumbnailUrl: photoUrl(shop, product.slug, image.id, true), alt: image.altText || product.title } : null, available: variant.stockAvailable >= item.quantity,
            unitPrice: variant.price, lineTotal: { ...variant.price, amountMinor: total }, path: `/c/${shop}/p/${product.slug}` });
        }
        const currencies = new Set(lines.filter(line => line.unitPrice).map(line => line.unitPrice.currency));
        const canContact = Boolean(salesWhatsapp(catalog.sales_whatsapp, catalog.owner_phone)) && lines.every(line => line.available) && currencies.size === 1;
        const total = canContact ? { ...lines[0].unitPrice, amountMinor: lines.reduce((sum, line) => sum + BigInt(line.lineTotal.amountMinor), 0n).toString() } : null;
        const brand = publicBrand(catalog), fingerprint = operationRequestDigest({ catalog: brand, lines, total });
        const format = amount => formatMoneyAmount(amount.amountMinor, amount.currency, amount.fractionDigits);
        const contactText = canContact ? `Hola, quiero hacer este pedido en ${brand.brandName}:\n${lines.map(line => `• ${line.quantity} × ${line.title.slice(0, 80)} · ${line.variantLabel}: ${line.size.slice(0, 80)} · ${format(line.unitPrice)} c/u`).join('\n')}\nTotal de productos: ${format(total)}.\nQuedo a la espera de la confirmación de disponibilidad, envío y pago. Este pedido no reserva stock ni realiza un pago.` : null;
        return { catalog: brand, lines, total, canContact, fingerprint, changed: Boolean(previous && previous !== fingerprint),
          quotedAt: new Date().toISOString(), contactUrl: contactText ? `https://wa.me/${brand.salesWhatsapp}?text=${encodeURIComponent(contactText)}` : null };
      });
    },
    detail: async (shop, productSlug) => {
      const { catalog, product } = await productSnapshot(shop, productSlug);
      return { catalog: publicBrand(catalog), product: publicProductProjection(product, shop) };
    },
    list: (shop, query = {}) => publicRead(shop, async (client, catalog) => {
      const data = record(query, ['q', 'category', 'variant', 'team', 'season', 'version', 'sleeve', 'kit', 'cursor', 'limit', 'sort', 'collection']);
      const sort = data.sort || 'catalog';
      if (!['catalog', 'newest', 'price-asc', 'price-desc'].includes(sort)) fail('INVALID_COMMAND', 'Orden de catálogo inválido.', 400);
      if (data.collection && !['featured', 'promotions'].includes(data.collection)) fail('INVALID_COMMAND', 'Colección inválida.', 400);
      const limit = data.limit === undefined ? 24 : Number(data.limit); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 48) fail('INVALID_COMMAND', 'Límite de catálogo inválido.', 400);
      // Read all published identities before pagination/search. Many existing fichas
      // have only generic fields, so resolve the same live SKU names as detail reads.
      const facetRows = (await client.query(`SELECT p.id,p.title,p.team_key,p.team_name,p.version_key,
        i.name,i.product_type,i.size FROM commercial_products p
        JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
        JOIN commercial_product_skus l ON l.owner_phone=p.owner_phone AND l.commercial_product_id=p.id
        JOIN products i ON i.owner_phone=l.owner_phone AND i.id=l.sku_id
        WHERE p.owner_phone=$1 AND p.status='ready' AND s.status='published' AND i.inventory_status='active'
        ORDER BY p.id,l.sort_order,i.id`, [catalog.owner_phone])).rows;
      const groups = new Map();
      for (const row of facetRows) {
        if (!groups.has(row.id)) groups.set(row.id, { row, skus: [] });
        groups.get(row.id).skus.push({ name: row.name, productType: row.product_type, size: row.size, active: true });
      }
      const identities = [...groups.values()].map(({ row, skus }) => ({ id: row.id, skus,
        ...catalogIdentity({ title: row.title, teamKey: row.team_key, teamName: row.team_name, versionKey: row.version_key }, skus) }));
      const unique = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
      const facets = { categories: unique(identities.flatMap(item => item.categories)),
        variantLabel: identities.length && identities.every(item => item.skus.every(sku => sku.size?.trim())) ? 'Talle' : 'Presentación',
        variants: sortCatalogSizes(identities.flatMap(item => item.skus.map(variantLabel))), versions: unique(identities.flatMap(item => item.versionKeys)),
        teams: [...new Map(identities.filter(item => item.teamKey).map(item => [item.teamKey, { key: item.teamKey, name: item.teamName || item.teamKey }])).values()]
          .sort((a, b) => a.name.localeCompare(b.name, 'es')) };
      const values = [catalog.owner_phone], conditions = ["p.owner_phone=$1", "p.status='ready'", "s.status='published'"];
      if (data.collection) {
        const appearance = appearanceOf(catalog);
        values.push(appearance[data.collection === 'featured' ? 'featuredSlugs' : 'promotionSlugs'] ?? []);
        conditions.push(`p.slug=ANY($${values.length}::text[])`);
      }
      for (const [key, field] of Object.entries({ team: 'teamKey', version: 'versionKey', category: 'categories' })) if (data[key]) {
        const selected = text(data[key], key === 'category' ? 200 : 100, key);
        values.push(identities.filter(item => key === 'category' ? item.categories.includes(selected) : key === 'version' ? item.versionKeys.includes(selected) : item[field] === selected).map(item => item.id));
        conditions.push(`p.id=ANY($${values.length}::uuid[])`);
      }
      if (data.variant) {
        const selected = normalizeCatalogSize(text(data.variant, 200, 'variant'));
        values.push(identities.filter(item => item.skus.some(sku => normalizeCatalogSize(variantLabel(sku)) === selected)).map(item => item.id));
        conditions.push(`p.id=ANY($${values.length}::uuid[])`);
      }
      for (const [key, column] of Object.entries({ season: 'season', sleeve: 'sleeve_key', kit: 'kit_key' })) if (data[key]) { values.push(text(data[key], 100, key)); conditions.push(`p.${column}=$${values.length}`); }
      if (data.q) { values.push(`%${text(data.q, 120, 'query').replace(/[\\%_]/g, '\\$&')}%`); conditions.push(`((${productTitleSql()}) ILIKE $${values.length} OR p.team_name ILIKE $${values.length})`); }
      const sortField = sort === 'newest' ? 'p.created_at' : 'prices.sort_price';
      const operator = sort === 'price-asc' ? '>' : '<';
      if (data.cursor) {
        if (sort === 'catalog') { values.push(slug(data.cursor)); conditions.push(`p.slug>$${values.length}`); }
        else {
          let cursor;
          try { cursor = JSON.parse(Buffer.from(text(data.cursor, 600, 'cursor'), 'base64url').toString()); } catch { fail('INVALID_COMMAND', 'Cursor inválido.', 400); }
          record(cursor, ['sort', 'value', 'slug']);
          if (cursor.sort !== sort || typeof cursor.value !== 'string' || (sort === 'newest' ? !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.value) || !Number.isFinite(Date.parse(cursor.value)) : !/^\d{1,18}(?:\.\d{1,6})?$/.test(cursor.value))) fail('INVALID_COMMAND', 'Cursor inválido.', 400);
          values.push(cursor.value, slug(cursor.slug));
          conditions.push(`(${sortField},p.slug)${operator}($${values.length - 1}::${sort === 'newest' ? 'timestamptz' : 'numeric'},$${values.length}::text)`);
        }
      }
      values.push(limit + 1);
      const byPrice = sort.startsWith('price-');
      const rows = (await client.query(`SELECT p.*${sort === 'newest' ? `,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_value` : byPrice ? ',prices.sort_price::text AS sort_value' : ''}
        FROM commercial_products p JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
        ${byPrice ? `JOIN LATERAL (SELECT COALESCE(min(i.price::numeric) FILTER (WHERE i.stock_available>0),min(i.price::numeric)) AS sort_price
          FROM commercial_product_skus l JOIN products i ON i.owner_phone=l.owner_phone AND i.id=l.sku_id
          WHERE l.owner_phone=p.owner_phone AND l.commercial_product_id=p.id AND i.inventory_status='active') prices ON prices.sort_price IS NOT NULL` : ''}
        WHERE ${conditions.join(' AND ')} ORDER BY ${sort === 'catalog' ? 'p.slug' : `${sortField} ${sort === 'price-asc' ? 'ASC' : 'DESC'},p.slug ${sort === 'price-asc' ? 'ASC' : 'DESC'}`} LIMIT $${values.length}`, values)).rows;
      const batch = rows.slice(0, limit), items = [];
      for (const detail of await readPublicProducts(client, catalog.owner_phone, batch)) if (detail.readiness.canPrepare) items.push(publicProductProjection(detail, shop));
      const last = batch.at(-1);
      const collections = {};
      // Small shelves are independent of the first alphabetical catalog page.
      // Only the unfiltered storefront reads these small shelves. Invalid live
      // identities are refilled in batches after the initial two reads.
      if (!Object.entries(data).some(([key, value]) => value && !(key === 'sort' && value === 'catalog'))) {
        const appearance = appearanceOf(catalog);
        const newestEligibility = `EXISTS(SELECT 1 FROM commercial_product_skus l JOIN products i ON i.owner_phone=l.owner_phone AND i.id=l.sku_id
          WHERE l.owner_phone=p.owner_phone AND l.commercial_product_id=p.id AND i.inventory_status='active')
          AND EXISTS(SELECT 1 FROM commercial_product_images image WHERE image.owner_phone=p.owner_phone AND image.commercial_product_id=p.id AND image.status='ready')`;
        const shelfRows = (await client.query(`SELECT p.*,shelf.key AS shelf FROM
          (VALUES ('newest',ARRAY[]::text[]),('featured',$2::text[]),('promotions',$3::text[])) AS shelf(key,slugs)
          CROSS JOIN LATERAL (SELECT p.*,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS shelf_cursor_at
            FROM commercial_products p JOIN commercial_publications s
            ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
            WHERE p.owner_phone=$1 AND p.status='ready' AND s.status='published' AND (shelf.key='newest' OR p.slug=ANY(shelf.slugs))
            AND (shelf.key<>'newest' OR (${newestEligibility}))
            ORDER BY p.created_at DESC,p.slug DESC LIMIT CASE WHEN shelf.key='newest' THEN 8 ELSE 24 END
          ) p ORDER BY shelf.key,p.created_at DESC,p.slug DESC`,
        [catalog.owner_phone, appearance.featuredSlugs ?? [], appearance.promotionSlugs ?? []])).rows;
        const shelfProducts = await readPublicProducts(client, catalog.owner_phone, [...new Map(shelfRows.map(row => [row.id, row])).values()]);
        const productsById = new Map(shelfProducts.filter(product => product.readiness.canPrepare).map(product => [product.id, publicProductProjection(product, shop)]));
        for (const row of shelfRows) if (productsById.has(row.id) && (collections[row.shelf]?.length ?? 0) < 8) (collections[row.shelf] ??= []).push(productsById.get(row.id));
        // Live SKU edits may invalidate a published ficha. Fill the shelf after
        // readiness checks, seeking in small batches instead of leaving holes.
        let newestBatch = shelfRows.filter(row => row.shelf === 'newest');
        while (newestBatch.length === 8 && (collections.newest?.length ?? 0) < 8) {
          const cursor = newestBatch.at(-1);
          newestBatch = (await client.query(`SELECT p.*,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS shelf_cursor_at
            FROM commercial_products p JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
            WHERE p.owner_phone=$1 AND p.status='ready' AND s.status='published' AND ${newestEligibility}
            AND (p.created_at,p.slug)<($2::timestamptz,$3::text) ORDER BY p.created_at DESC,p.slug DESC LIMIT 8`,
          [catalog.owner_phone, cursor.shelf_cursor_at, cursor.slug])).rows;
          for (const product of await readPublicProducts(client, catalog.owner_phone, newestBatch))
            if (product.readiness.canPrepare && (collections.newest?.length ?? 0) < 8) (collections.newest ??= []).push(publicProductProjection(product, shop));
        }
      }
      return { catalog: publicBrand(catalog), items, facets, collections, nextCursor: rows.length > limit ? sort === 'catalog' ? last.slug
        : Buffer.from(JSON.stringify({ sort, value: last.sort_value, slug: last.slug })).toString('base64url') : null };
    }),
    image: async (shop, productSlug, imageId, variant = 'master', format = 'jpeg', ifNoneMatch = null) => {
      uuid(imageId); if (!['master', 'thumbnail', 'detail'].includes(variant) || !['jpeg', 'webp'].includes(format)) notFound();
      const { catalog, product } = await productSnapshot(shop, productSlug, { mediaKeys: true });
      const image = product.images.find(image => image.id === imageId && image.status === 'ready');
      if (!image) notFound();
      const key = variant === 'thumbnail' ? image.thumbnailKey : image.masterKey;
      const hash = image.masterSha256;
      if (!storage.configured) fail('MEDIA_NOT_CONFIGURED', 'La fotografía no está disponible.', 503);
      const detailWebp = variant === 'detail' && format === 'webp';
      const representation = JSON.stringify([catalog.owner_phone, key, hash, variant, format, detailWebp ? 2 : 1]);
      const etag = `W/"${sha256(Buffer.from(representation))}"`;
      // Authorize against live publication/readiness BEFORE honoring any cache validator.
      if (typeof ifNoneMatch === 'string' && (ifNoneMatch.trim() === '*' || ifNoneMatch.split(',').some(value => value.trim().replace(/^W\//, '') === etag.replace(/^W\//, '')))) return { etag, notModified: true };
      const bytes = await cachedMedia(representation, async () => {
        const source = await measureCatalogPhase('storage', () => storage.get(key));
        if (variant !== 'thumbnail' && sha256(source) !== hash) fail('MEDIA_INTEGRITY_ERROR', 'La fotografía no está disponible.', 503);
        let pipeline = sharp(source);
        if (variant === 'detail') pipeline = pipeline.resize({ width: 960, height: 1200, fit: 'inside', withoutEnlargement: true });
        if (format === 'webp') return measureCatalogPhase('encode', () => pipeline.webp({ quality: 80, effort: detailWebp ? 2 : 4 }).toBuffer());
        return variant === 'detail' ? measureCatalogPhase('encode', () => pipeline.jpeg({ quality: 82 }).toBuffer()) : source;
      });
      // Preserve the service's legacy Buffer return value for internal callers.
      return Object.assign(bytes, { etag, mimeType: format === 'webp' ? 'image/webp' : 'image/jpeg' });
    },
  };
}
