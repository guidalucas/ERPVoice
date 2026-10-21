import { randomUUID } from 'node:crypto';
import { inventoryRowToProduct } from '../inventoryPostgres.js';
import { inventoryProductFingerprint } from '../inventoryOperations.js';
import { inventoryPriceToMoney } from '../inventoryMoneyPolicy.js';
import { normalizeCommercialProduct, commercialIdentityKey, commercialSlug } from './productIdentity.js';
import { record, uuid, integer, denseArray, text } from './validation.js';
import { readProfile, readMoneyPolicy, requireProduct, readProductDetail, rowToCommercialProduct, insertProduct, updateProduct } from './productRepository.js';
import { executeCommerceCommand, requireCommerceAccess } from './operationRepository.js';
import { inspectCommerceSchema } from './schemaInspection.js';
import { fail } from './errors.js';

const requireRevision = (row, expected) => { if (Number(row.revision) !== integer(expected, 1)) fail('REVISION_CONFLICT', 'La ficha cambió. Revisá tu borrador antes de guardar.', 409, { currentRevision: Number(row.revision) }); };
function linksRequest(value = []) {
  const links = denseArray(value, 100, 'SKU links').map(item => {
    const link = record(item, ['skuId', 'expectedRevision', 'expectedFingerprint']);
    return { skuId: text(link.skuId, 180, 'SKU id'), expectedRevision: integer(link.expectedRevision), expectedFingerprint: text(link.expectedFingerprint, 128, 'SKU fingerprint') };
  });
  if (new Set(links.map(link => link.skuId)).size !== links.length) fail('INVALID_COMMAND', 'No repitas variantes.', 400);
  return links;
}
async function replaceLinks(client, context, id, links) {
  const rows = (await client.query('SELECT * FROM products WHERE owner_phone=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE', [context.businessId, links.map(link => link.skuId)])).rows;
  if (rows.length !== links.length) fail('RESOURCE_NOT_FOUND', 'No encontré una de las variantes.', 404);
  for (const link of links) {
    const product = inventoryRowToProduct(rows.find(row => row.id === link.skuId));
    if (product.status !== 'active') fail('SKU_INACTIVE', 'La variante fue dada de baja.', 409);
    if (product.revision !== link.expectedRevision || inventoryProductFingerprint(product) !== link.expectedFingerprint) fail('REVISION_CONFLICT', 'La variante cambió. Revisá la selección.', 409);
  }
  await client.query('DELETE FROM commercial_product_skus WHERE owner_phone=$1 AND commercial_product_id=$2', [context.businessId, id]);
  for (const [index, link] of links.entries()) await client.query(`INSERT INTO commercial_product_skus
    (owner_phone,commercial_product_id,sku_id,identity_fingerprint_at_link,sort_order,linked_by) VALUES($1,$2,$3,$4,$5,$6)`,
  [context.businessId, id, link.skuId, link.expectedFingerprint, index, context.actorId]);
}

/** Private use only. No bootstrap, public projection or inventory mutation. */
export function createCommerceProductService(runtime) {
  let ready;
  const ensureReady = async () => {
    ready ??= runtime.withClient(async client => {
      if (!(await inspectCommerceSchema(client)).ready) fail('COMMERCE_SCHEMA_NOT_READY', 'La preparación comercial está pendiente.', 503);
    }).catch(error => { ready = undefined; throw error; });
    await ready;
  };
  const read = async (context, callback) => {
    await ensureReady();
    return runtime.transaction(async client => { await requireCommerceAccess(client, context, 'commerce:read'); return callback(client); }, { readOnly: true, repeatableRead: true });
  };
  const mutate = async (context, meta, apply) => {
    await ensureReady();
    try { return await executeCommerceCommand(runtime, context, meta, apply); }
    catch (error) {
      if (error.code === '23505') fail(error.constraint?.includes('identity') ? 'COMMERCIAL_IDENTITY_EXISTS'
        : error.constraint?.includes('skus') ? 'SKU_ALREADY_LINKED' : 'DUPLICATE_ENTITY', 'La ficha o variante ya está vinculada.', 409);
      throw error;
    }
  };
  return {
    detail: (context, id) => read(context, client => readProductDetail(client, context.businessId, uuid(id))),
    profile: context => read(context, async client => {
      const profile = await readProfile(client, context.businessId);
      return { brandName: profile.brand_name, salesWhatsapp: profile.sales_whatsapp, brandPreset: profile.brand_preset,
        revision: Number(profile.revision), moneyPolicy: await readMoneyPolicy(client, context.businessId) };
    }),
    create: async (context, input) => {
      const data = record(input, ['operationId', 'product', 'skuLinks']);
      const command = { operationId: uuid(data.operationId), product: normalizeCommercialProduct(data.product), skuLinks: linksRequest(data.skuLinks) };
      return mutate(context, { operationId: command.operationId, type: 'product.create', command }, async client => {
        const id = randomUUID(), product = { ...command.product, identityKey: commercialIdentityKey(command.product) };
        await insertProduct(client, context.businessId, context.actorId, id, commercialSlug(product.title, id), product);
        await replaceLinks(client, context, id, command.skuLinks);
        return readProductDetail(client, context.businessId, id);
      });
    },
    update: async (context, id, input) => {
      id = uuid(id);
      const data = record(input, ['operationId', 'expectedRevision', 'changes']);
      const changes = record(data.changes, ['title', 'description', 'teamKey', 'teamName', 'teamKind', 'season', 'kitKey', 'versionKey', 'sleeveKey']);
      for (const [key, value] of Object.entries(changes)) {
        if (value !== null && typeof value !== 'string') fail('INVALID_COMMAND', `El campo ${key} debe ser texto.`, 400);
      }
      const command = { operationId: uuid(data.operationId), expectedRevision: integer(data.expectedRevision, 1), changes };
      return mutate(context, { operationId: command.operationId, type: 'product.update', entityId: id, command }, async client => {
        const row = await requireProduct(client, context.businessId, id, { lock: true }); requireRevision(row, command.expectedRevision);
        if (row.status === 'archived') fail('PRODUCT_ARCHIVED', 'Restaurá la ficha antes de editarla.', 409);
        const current = rowToCommercialProduct(row);
        const fields = Object.fromEntries(['title', 'description', 'teamKey', 'teamName', 'teamKind', 'season', 'kitKey', 'versionKey', 'sleeveKey'].map(key => [key, current[key]]));
        const product = normalizeCommercialProduct({ ...fields, ...command.changes }); product.identityKey = commercialIdentityKey(product);
        await updateProduct(client, context.businessId, context.actorId, id, product, { invalidate: product.identityKey !== current.identityKey });
        return readProductDetail(client, context.businessId, id);
      });
    },
    link: async (context, id, input) => {
      id = uuid(id);
      const data = record(input, ['operationId', 'expectedRevision', 'skuLinks']);
      const command = { operationId: uuid(data.operationId), expectedRevision: integer(data.expectedRevision, 1), skuLinks: linksRequest(data.skuLinks) };
      return mutate(context, { operationId: command.operationId, type: 'product.link', entityId: id, command }, async client => {
        const row = await requireProduct(client, context.businessId, id, { lock: true }); requireRevision(row, command.expectedRevision);
        if (row.status === 'archived') fail('PRODUCT_ARCHIVED', 'Restaurá la ficha antes de modificar variantes.', 409);
        await replaceLinks(client, context, id, command.skuLinks);
        await client.query("UPDATE commercial_products SET status='draft',revision=revision+1,updated_at=NOW(),updated_by=$3 WHERE owner_phone=$1 AND id=$2", [context.businessId, id, context.actorId]);
        return readProductDetail(client, context.businessId, id);
      });
    },
    setStatus: async (context, id, input) => {
      id = uuid(id);
      const data = record(input, ['operationId', 'expectedRevision', 'status', 'reason']);
      const command = { operationId: uuid(data.operationId), expectedRevision: integer(data.expectedRevision, 1),
        status: text(data.status, 10, 'status'), reason: text(data.reason, 500, 'reason') };
      if (!['draft', 'ready', 'archived'].includes(command.status)) fail('INVALID_COMMAND', 'Estado no permitido.', 400);
      return mutate(context, { operationId: command.operationId, type: 'product.status', entityId: id, command }, async client => {
        const row = await requireProduct(client, context.businessId, id, { lock: true }); requireRevision(row, command.expectedRevision);
        if (row.status === 'archived' && command.status !== 'draft') fail('INVALID_TRANSITION', 'Restaurá a borrador primero.', 409);
        const detail = await readProductDetail(client, context.businessId, id);
        if (command.status === 'ready' && !detail.readiness.canPrepare) fail('PRODUCT_NOT_READY', 'Completá los datos antes de preparar la ficha.', 422, { blockers: detail.readiness.blockers });
        await client.query(`UPDATE commercial_products SET status=$3,archived_at=CASE WHEN $3='archived' THEN NOW() ELSE NULL END,
          revision=revision+1,updated_by=$4,updated_at=NOW() WHERE owner_phone=$1 AND id=$2`, [context.businessId, id, command.status, context.actorId]);
        return readProductDetail(client, context.businessId, id);
      });
    },
    recover: (context, operationId) => read(context, async client => {
      const row = (await client.query('SELECT result_json FROM commercial_operations WHERE owner_phone=$1 AND operation_id=$2', [context.businessId, uuid(operationId)])).rows[0];
      if (!row) fail('RESOURCE_NOT_FOUND', 'No encontré el recibo.', 404); return row.result_json;
    }),
    list: (context, query = {}) => read(context, async client => {
      const data = record(query, ['q', 'status', 'team', 'season', 'version', 'sleeve', 'cursor', 'limit']);
      const limit = data.limit === undefined ? 24 : typeof data.limit === 'string' && /^\d+$/.test(data.limit) ? integer(Number(data.limit), 1) : integer(data.limit, 1);
      if (limit > 50) fail('INVALID_COMMAND', 'Hasta 50 fichas por página.', 400);
      const filters = [context.businessId], conditions = ['owner_phone=$1'];
      for (const [key, column] of Object.entries({ status: 'status', team: 'team_key', season: 'season', version: 'version_key', sleeve: 'sleeve_key' })) if (data[key]) {
        filters.push(text(data[key], 80, key)); conditions.push(`${column}=$${filters.length}`);
      }
      if (data.q) { filters.push(`%${text(data.q, 120, 'query').replace(/[\\%_]/g, '\\$&')}%`); conditions.push(`(title ILIKE $${filters.length} OR team_name ILIKE $${filters.length})`); }
      if (data.cursor) {
        let cursor; try { cursor = JSON.parse(Buffer.from(text(data.cursor, 600, 'cursor'), 'base64url').toString()); } catch { fail('INVALID_COMMAND', 'Cursor inválido.', 400); }
        record(cursor, ['at', 'id']); uuid(cursor.id);
        if (typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at))) fail('INVALID_COMMAND', 'Cursor inválido.', 400);
        filters.push(cursor.at, cursor.id); conditions.push(`(updated_at,id)<($${filters.length - 1}::timestamptz,$${filters.length}::uuid)`);
      }
      filters.push(limit + 1);
      const rows = (await client.query(`SELECT id,updated_at FROM commercial_products WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC,id DESC LIMIT $${filters.length}`, filters)).rows;
      const visible = rows.slice(0, limit), last = visible.at(-1);
      return { items: await Promise.all(visible.map(row => readProductDetail(client, context.businessId, row.id))),
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ at: last.updated_at.toISOString(), id: last.id })).toString('base64url') : null };
    }),
    candidates: (context, query = {}) => read(context, async client => {
      const data = record(query, ['q', 'cursor', 'limit']);
      const limit = data.limit === undefined ? 50 : Number(data.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_COMMAND', 'Límite inválido.', 400);
      const q = text(data.q ?? '', 120, 'query', { empty: true }).replace(/[\\%_]/g, '\\$&');
      const rows = (await client.query(`SELECT p.* FROM products p WHERE p.owner_phone=$1 AND p.inventory_status='active'
        AND NOT EXISTS(SELECT 1 FROM commercial_product_skus l WHERE l.owner_phone=p.owner_phone AND l.sku_id=p.id)
        AND ($2='' OR p.name ILIKE $3 OR p.product_model ILIKE $3) AND ($4::text IS NULL OR p.id>$4)
        ORDER BY p.id LIMIT $5`, [context.businessId, q, `%${q}%`, data.cursor ? text(data.cursor, 180, 'cursor') : null, limit + 1])).rows;
      const policy = await readMoneyPolicy(client, context.businessId);
      return { items: rows.slice(0, limit).map(row => {
        const product = inventoryRowToProduct(row); let money = null;
        try { money = inventoryPriceToMoney(product.price, product.priceCurrency, policy); } catch { /* explicit unconfirmed money */ }
        return { skuId: product.id, name: product.name, size: product.size, productType: product.productType, productModel: product.productModel,
          revision: product.revision, identityFingerprint: inventoryProductFingerprint(product), stockAvailable: product.stockAvailable,
          stockReserved: product.stockReserved, price: money };
      }), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    }),
    summary: context => read(context, async client => ({
      products: (await client.query('SELECT status,count(*)::int AS count FROM commercial_products WHERE owner_phone=$1 GROUP BY status', [context.businessId])).rows,
      unlinkedSkus: (await client.query(`SELECT count(*)::int AS count FROM products p WHERE p.owner_phone=$1 AND inventory_status='active'
        AND NOT EXISTS(SELECT 1 FROM commercial_product_skus l WHERE l.owner_phone=p.owner_phone AND l.sku_id=p.id)`, [context.businessId])).rows[0].count,
    })),
    updateProfile: async (context, input) => {
      const data = record(input, ['operationId', 'expectedRevision', 'brandName', 'salesWhatsapp']);
      const command = { operationId: uuid(data.operationId), expectedRevision: integer(data.expectedRevision, 1),
        brandName: text(data.brandName, 80, 'brand name'), salesWhatsapp: data.salesWhatsapp === null ? null : text(data.salesWhatsapp, 15, 'sales WhatsApp') };
      if (command.salesWhatsapp !== null && !/^\d{8,15}$/.test(command.salesWhatsapp)) fail('INVALID_COMMAND', 'WhatsApp comercial inválido.', 400);
      return mutate(context, { operationId: command.operationId, type: 'profile.update', command, permission: 'commerce:settings' }, async client => {
        const row = (await client.query('SELECT revision FROM commerce_profiles WHERE owner_phone=$1 FOR UPDATE', [context.businessId])).rows[0];
        requireRevision(row, command.expectedRevision);
        const profile = (await client.query(`UPDATE commerce_profiles SET brand_name=$2,sales_whatsapp=$3,revision=revision+1,updated_at=NOW()
          WHERE owner_phone=$1 RETURNING *`, [context.businessId, command.brandName, command.salesWhatsapp])).rows[0];
        return { brandName: profile.brand_name, salesWhatsapp: profile.sales_whatsapp, brandPreset: profile.brand_preset,
          revision: Number(profile.revision), moneyPolicy: await readMoneyPolicy(client, context.businessId) };
      });
    },
  };
}
