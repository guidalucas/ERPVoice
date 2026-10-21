import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { issueJwt } from '../server/auth.js';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { runCommerceMediaFaultChecks } from './commerce-media-fault-checks.js';
import { runCatalogHttpChecks } from './catalog-http-checks.js';

/** Real HTTP + real temporary PostgreSQL, through Stocky's authentication middleware. */
export async function runCommerceHttpChecks({ db, sql, check, request }) {
  const owner = '59899100003', other = '59899100004', member = '59899100005';
  const auth = value => ({ Authorization: `Bearer ${issueJwt({ phoneNumber: value })}` });
  const req = (route, options = {}) => request(`/api/commerce/v1${route}`, { method: 'GET', ...options, headers: { ...auth(owner), ...options.headers } });
  const post = (route, body, options = {}) => req(route, { method: 'POST', body, ...options });
  const productInput = { title: 'Barcelona titular', teamKey: 'barcelona', teamName: 'Barcelona', teamKind: 'club',
    season: '2025', kitKey: 'home', versionKey: 'player', sleeveKey: 'short' };
  const sku = await db.createProductRecord({ name: 'Camiseta Barcelona fixture HTTP', size: 'M', stockAvailable: 3, stockReserved: 1,
    price: 65000, priceCurrency: 'ARS' }, owner, { operationId: 'commerce-http-sku' });
  const second = await db.createProductRecord({ name: 'Camiseta Barcelona fixture HTTP', size: 'L', stockAvailable: 2,
    price: 65000, priceCurrency: 'ARS' }, owner, { operationId: 'commerce-http-second' });
  const foreign = await db.createProductRecord({ name: 'Foreign commercial SKU', size: 'XL', stockAvailable: 8,
    price: 99999, priceCurrency: 'ARS' }, other, { operationId: 'commerce-http-foreign' });
  const link = product => ({ skuId: product.id, expectedRevision: product.revision, expectedFingerprint: product.identityFingerprint });
  for (const business of [owner, other]) await sql.query(`INSERT INTO commerce_profiles(owner_phone,id,brand_name,enabled,created_by)
    VALUES($1,$2,'HTTP FullMatch fixture',true,$1)`, [business, randomUUID()]);
  await sql.query(`INSERT INTO inventory_money_policies(owner_phone,currency,storage_unit,fraction_digits,confirmed_by,confirmed_at)
    VALUES($1,'ARS','major_integer',2,$1,NOW())`, [owner]);
  await sql.query("INSERT INTO business_members(tenant_phone,member_phone,role) VALUES($1,$2,'member')", [owner, member]);
  let count = 0;
  const run = async (name, callback) => { await check(`commerce HTTP: ${name}`, callback); count++; };
  let created, updated;
  const createBody = { operationId: randomUUID(), product: productInput, skuLinks: [link(sku)] };
  await run('browser preflight supports private edits only for explicitly allowed origins', async () => {
    for (const origin of ['http://localhost:5175', 'https://studio.fixture.invalid']) {
      const response = await req('/products/fixture', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PATCH' } });
      assert.equal(response.status, 204); assert.equal(response.headers['access-control-allow-origin'], origin);
      assert.ok(response.headers['access-control-allow-methods'].split(',').includes('PATCH'));
    }
    const denied = await req('/products', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid' } });
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  });
  await run('real authentication, owner-only permissions and disabled-business boundary', async () => {
    assert.equal((await request('/api/commerce/v1/products', { method: 'GET', auth: false })).status, 401);
    assert.equal((await req('/products', { headers: auth(member) })).status, 403);
    assert.equal((await req('/products', { headers: auth('59899100009') })).status, 403);
  });
  await run('pending SKU projection is scoped and contains no operational snapshot', async () => {
    const response = await req('/inventory-candidates'); assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.items.map(item => item.skuId).sort(), [sku.id, second.id].sort());
    assert.equal(response.json.items[0].price.amountMinor, '6500000');
    for (const field of ['clients', 'pedidos', 'transactions', 'ownerPhone', 'owner_phone']) assert.ok(!response.text.includes(`"${field}"`));
  });
  await run('concurrent identical creation has one row and one immutable receipt', async () => {
    const [one, two] = await Promise.all([post('/products', createBody), post('/products', createBody)]);
    assert.equal(one.status, 201, one.text); assert.equal(two.status, 201, two.text); assert.deepEqual(one.json, two.json);
    created = one.json.result; assert.equal(created.variants[0].stockAvailable, 3); assert.equal(created.availableQuantity, 3);
    assert.equal(created.readiness.canPrepare, false); assert.ok(created.readiness.blockers.includes('COVER_REQUIRED'));
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM commercial_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, createBody.operationId])).rows[0].n, 1);
  });
  await run('SKU links are unique and cross-tenant references fail without partial drafts', async () => {
    const before = (await req('/products')).json.items.length;
    const wrong = await post('/products', { operationId: randomUUID(), product: { title: 'Foreign attempt' }, skuLinks: [link(foreign)] });
    assert.equal(wrong.status, 404, wrong.text);
    assert.equal((await req('/products')).json.items.length, before);
    const duplicate = await post('/products', { operationId: randomUUID(), product: { title: 'Double-link attempt' }, skuLinks: [link(sku)] });
    assert.equal(duplicate.status, 409, duplicate.text); assert.equal(duplicate.json.error.code, 'SKU_ALREADY_LINKED');
  });
  await run('commercial editing uses revisions and never accepts inventory authority or prices', async () => {
    const body = { operationId: randomUUID(), expectedRevision: created.revision, changes: { title: 'Barcelona ficha comercial revisada' } };
    const response = await req(`/products/${created.id}`, { method: 'PATCH', body }); assert.equal(response.status, 200, response.text);
    updated = response.json.result; assert.equal(updated.revision, created.revision + 1);
    const stale = await req(`/products/${created.id}`, { method: 'PATCH', body: { ...body, operationId: randomUUID() } });
    assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'REVISION_CONFLICT');
    const bad = await req(`/products/${created.id}`, { method: 'PATCH', body: { operationId: randomUUID(), expectedRevision: updated.revision, changes: { price: 1 } } });
    assert.equal(bad.status, 400);
    const balances = (await sql.query('SELECT stock_available,stock_reserved,price FROM products WHERE owner_phone=$1 AND id=$2', [owner, sku.id])).rows[0];
    assert.deepEqual(balances, { stock_available: '3', stock_reserved: '1', price: '65000' });
    assert.deepEqual((await post('/products', createBody)).json.result, created);
  });
  await run('operation recovery remains scoped; IDs cannot overwrite another payload', async () => {
    assert.deepEqual((await req(`/operations/${createBody.operationId}`)).json.result, created);
    assert.equal((await req(`/operations/${createBody.operationId}`, { headers: auth(other) })).status, 404);
    assert.equal((await req(`/products/${created.id}`, { headers: auth(other) })).status, 404);
    const conflict = await post('/products', { ...createBody, product: { ...productInput, title: 'Changed request' } });
    assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
  });
  await run('link replacement validates SKU revision and removes candidates atomically', async () => {
    const bad = { operationId: randomUUID(), expectedRevision: updated.revision, skuLinks: [link(sku), { ...link(second), expectedRevision: 999 }] };
    const rejected = await req(`/products/${created.id}/sku-links`, { method: 'PUT', body: bad }); assert.equal(rejected.status, 409);
    const response = await req(`/products/${created.id}/sku-links`, { method: 'PUT', body: { ...bad, operationId: randomUUID(), skuLinks: [link(sku), link(second)] } });
    assert.equal(response.status, 200, response.text); updated = response.json.result; assert.equal(updated.variants.length, 2);
    assert.equal((await req('/inventory-candidates')).json.items.length, 0);
  });
  await run('preparation blocks missing photos; archive/restore do not change stock', async () => {
    const make = status => ({ operationId: randomUUID(), expectedRevision: updated.revision, status, reason: 'HTTP fixture reviewed state' });
    const rejected = await post(`/products/${created.id}/status`, make('ready')); assert.equal(rejected.status, 422, rejected.text);
    assert.equal(rejected.json.error.code, 'PRODUCT_NOT_READY');
    const archived = await post(`/products/${created.id}/status`, make('archived')); assert.equal(archived.status, 200, archived.text); updated = archived.json.result;
    const restored = await post(`/products/${created.id}/status`, make('draft')); assert.equal(restored.status, 200, restored.text); updated = restored.json.result;
    assert.equal(updated.status, 'draft'); assert.equal(updated.variants[0].stockAvailable, 3);
  });
  await run('profile updates reject money mutation and preserve scoped summaries', async () => {
    const profile = await req('/profile'); assert.equal(profile.status, 200, profile.text);
    const updatedProfile = await req('/profile', { method: 'PUT', body: { operationId: randomUUID(), expectedRevision: profile.json.revision,
      brandName: 'FullMatch fixture revised', salesWhatsapp: '59899000999' } }); assert.equal(updatedProfile.status, 200, updatedProfile.text);
    assert.equal(updatedProfile.json.result.moneyPolicy.currency, 'ARS');
    const money = await req('/profile', { method: 'PUT', body: { operationId: randomUUID(), expectedRevision: 2, brandName: 'X', salesWhatsapp: null, currency: 'USD' } });
    assert.equal(money.status, 400);
    const summary = await req('/summary'); assert.equal(summary.status, 200); assert.equal(summary.json.unlinkedSkus, 0);
  });
  await run('cursor validation, bounded pagination and literal search have predictable behavior', async () => {
    assert.equal((await req('/products?limit=51')).status, 400);
    assert.equal((await req('/products?cursor=not-json')).status, 400);
    assert.equal((await req('/products?q=%25')).json.items.length, 0);
    assert.equal((await req('/products?q=Barcelona&limit=1')).json.items[0].id, created.id);
  });
  await run('concurrent edits with the same revision have one winner and preserve the stable slug', async () => {
    const before = updated;
    const change = title => req(`/products/${created.id}`, { method: 'PATCH', body: {
      operationId: randomUUID(), expectedRevision: before.revision, changes: { title },
    } });
    const responses = await Promise.all([change('Barcelona concurrent A'), change('Barcelona concurrent B')]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    updated = responses.find(response => response.status === 200).json.result;
    assert.equal(updated.slug, before.slug); assert.equal(updated.revision, before.revision + 1);
  });
  await run('live SKU identity changes invalidate preparation while stock and price remain authoritative', async () => {
    // Simulated ready metadata only; this does not claim image upload/processing has been implemented.
    const imageId = randomUUID();
    await sql.query(`INSERT INTO commercial_product_images(owner_phone,commercial_product_id,id,status,source_sha256,
      source_size_bytes,master_key,thumbnail_key,master_sha256,mime_type,width,height,stored_size_bytes,upload_expires_at,created_by)
      VALUES($1,$2,$3,'ready',$4,100,'fixture/master','fixture/thumb',$4,'image/jpeg',100,100,80,NOW()+INTERVAL '1 hour',$1)`,
    [owner, created.id, imageId, 'a'.repeat(64)]);
    await sql.query('UPDATE commercial_products SET cover_image_id=$3 WHERE owner_phone=$1 AND id=$2', [owner, created.id, imageId]);
    let detail = (await req(`/products/${created.id}`)).json;
    assert.equal(detail.readiness.canPrepare, true);
    const prepared = await post(`/products/${created.id}/status`, { operationId: randomUUID(), expectedRevision: detail.revision,
      status: 'ready', reason: 'Synthetic cover fixture' });
    assert.equal(prepared.status, 200, prepared.text);
    assert.equal(prepared.json.result.readiness.canGenerateStory, true);
    await sql.query('UPDATE products SET stock_available=7,price=70000 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    detail = (await req(`/products/${created.id}`)).json;
    assert.equal(detail.availableQuantity, 9); assert.equal(detail.variants.find(item => item.skuId === sku.id).price.amountMinor, '7000000');
    assert.equal(detail.readiness.canGenerateStory, true);
    await sql.query("UPDATE products SET size='XL',inventory_revision=inventory_revision+1 WHERE owner_phone=$1 AND id=$2", [owner, sku.id]);
    detail = (await req(`/products/${created.id}`)).json;
    assert.equal(detail.readiness.canGenerateStory, false); assert.ok(detail.readiness.blockers.includes('SKU_IDENTITY_CHANGED'));
    assert.equal(detail.availableQuantity, 2);
    assert.ok(!JSON.stringify(detail).includes('fixture/master'));
  });
  let photoProduct, imageId, imageBytes;
  const imageHash = bytes => createHash('sha256').update(bytes).digest('hex');
  const detail = async () => (await req(`/products/${photoProduct.id}`)).json;
  const initialize = async bytes => post(`/products/${photoProduct.id}/images`, { operationId: randomUUID(), expectedRevision: photoProduct.revision,
    sourceSha256: imageHash(bytes), sourceSizeBytes: bytes.length, altText: 'Foto real de prueba' });
  const upload = (id, bytes) => req(`/products/${photoProduct.id}/images/${id}/content`, { method: 'PUT', raw: bytes, headers: { 'Content-Type': 'image/png' } });
  await run('real image decode, private storage, recovery and byte integrity', async () => {
    photoProduct = (await post('/products', { operationId: randomUUID(), product: { title: 'Galería de prueba' }, skuLinks: [] })).json.result;
    imageBytes = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#ff6a00' } }).png().toBuffer();
    const initialized = await initialize(imageBytes); assert.equal(initialized.status, 201, initialized.text);
    imageId = initialized.json.result.imageId; photoProduct = initialized.json.result.product;
    const mismatch = await upload(imageId, Buffer.from('wrong bytes')); assert.equal(mismatch.status, 409);
    const ready = await upload(imageId, imageBytes); assert.equal(ready.status, 200, ready.text); photoProduct = ready.json;
    assert.equal(photoProduct.coverImageId, imageId); assert.equal(photoProduct.images[0].status, 'ready');
    const replay = await upload(imageId, imageBytes); assert.equal(replay.status, 200); assert.equal(replay.json.revision, photoProduct.revision);
    const content = await req(`/products/${photoProduct.id}/images/${imageId}/content`); assert.equal(content.status, 200, content.text);
    const metadata = await sharp(content.buffer).metadata(); assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 600); assert.equal(metadata.height, 900);
    assert.equal(metadata.exif, undefined); assert.equal(content.headers['cache-control'], 'private, no-store');
    assert.equal((await req(`/products/${photoProduct.id}/images/${imageId}/content`, { headers: auth(other) })).status, 404);
    assert.equal((await request(`/api/commerce/v1/products/${photoProduct.id}/images/${imageId}/content`, { method: 'GET', auth: false })).status, 401);
    assert.ok(!JSON.stringify(photoProduct).includes('master_key'));
  });
  await run('corrupt and oversized images fail explicitly and can be retired', async () => {
    const corrupt = Buffer.from('not an image'); const initialized = await initialize(corrupt);
    assert.equal(initialized.status, 201, initialized.text); photoProduct = initialized.json.result.product;
    const id = initialized.json.result.imageId;
    const invalid = await upload(id, corrupt); assert.equal(invalid.status, 422, invalid.text);
    photoProduct = await detail(); const image = photoProduct.images.find(item => item.id === id); assert.equal(image.status, 'failed');
    const retired = await req(`/products/${photoProduct.id}/images/${id}`, { method: 'PATCH', body: {
      operationId: randomUUID(), expectedRevision: photoProduct.revision, expectedImageRevision: image.revision, altText: image.altText,
      focalX: 0.5, focalY: 0.5, retire: true } });
    assert.equal(retired.status, 200, retired.text); photoProduct = retired.json.result; assert.equal(photoProduct.images.length, 1);
    const huge = await upload(imageId, Buffer.alloc(12 * 1024 * 1024 + 1)); assert.equal(huge.status, 413);
    const foreignGallery = await req(`/products/${created.id}/gallery`, { method: 'PUT', body: {
      operationId: randomUUID(), expectedRevision: (await req(`/products/${created.id}`)).json.revision, imageIds: [imageId], coverImageId: imageId } });
    assert.equal(foreignGallery.status, 409);
  });
  let storySku, preparedSnapshot;
  const prepareStory = (settings = {}) => post(`/products/${photoProduct.id}/story-snapshots`, { operationId: randomUUID(), expectedProductRevision: photoProduct.revision,
    settings: { templateId: 'available', templateVersion: 1, imageId, expectedImageRevision: photoProduct.images.find(item => item.id === imageId).revision,
      skuIds: [storySku.id], showPrice: true, fit: 'contain', zoom: 1, focalX: 0.5, focalY: 0.5, caption: '', cta: 'PEDILA POR WHATSAPP', ...settings } });
  const validateStory = id => post(`/story-snapshots/${id}/validate`, {});
  await run('immutable story snapshot uses real prepared photos and current Stocky prices', async () => {
    storySku = await db.createProductRecord({ name: 'Story fixture camisa', size: 'S', stockAvailable: 2, stockReserved: 1, price: 30000, priceCurrency: 'ARS' }, owner, { operationId: 'commerce-story-fixture' });
    const identity = await req(`/products/${photoProduct.id}`, { method: 'PATCH', body: { operationId: randomUUID(), expectedRevision: photoProduct.revision,
      changes: { ...productInput, teamKey: 'story-fixture', teamName: 'Story fixture', title: 'Historia con foto real' } } });
    assert.equal(identity.status, 200, identity.text); photoProduct = identity.json.result;
    const linked = await req(`/products/${photoProduct.id}/sku-links`, { method: 'PUT', body: { operationId: randomUUID(), expectedRevision: photoProduct.revision, skuLinks: [link(storySku)] } });
    assert.equal(linked.status, 200, linked.text); photoProduct = linked.json.result;
    const ready = await post(`/products/${photoProduct.id}/status`, { operationId: randomUUID(), expectedRevision: photoProduct.revision, status: 'ready', reason: 'Real media story fixture' });
    assert.equal(ready.status, 200, ready.text); photoProduct = ready.json.result;
    const response = await prepareStory(); assert.equal(response.status, 201, response.text); preparedSnapshot = response.json.result;
    assert.equal(preparedSnapshot.content.availableQuantity, 2); assert.equal(preparedSnapshot.content.price.minAmountMinor, '3000000');
    assert.equal(preparedSnapshot.width, 1080); assert.equal(preparedSnapshot.height, 1920);
    assert.equal((await validateStory(preparedSnapshot.snapshotId)).json.valid, true);
    assert.deepEqual((await req(`/story-snapshots/${preparedSnapshot.snapshotId}`)).json, preparedSnapshot);
    assert.equal((await req(`/story-snapshots/${preparedSnapshot.snapshotId}`, { headers: auth(other) })).status, 404);
  });
  await run('semantic revalidation catches price/stock changes without relying on revisions', async () => {
    await sql.query('UPDATE products SET inventory_revision=inventory_revision+1 WHERE owner_phone=$1 AND id=$2', [owner, storySku.id]);
    assert.equal((await validateStory(preparedSnapshot.snapshotId)).json.valid, true);
    await sql.query('UPDATE products SET price=31000 WHERE owner_phone=$1 AND id=$2', [owner, storySku.id]);
    assert.equal((await validateStory(preparedSnapshot.snapshotId)).json.valid, false);
    assert.equal((await req(`/story-snapshots/${preparedSnapshot.snapshotId}`)).json.content.price.minAmountMinor, '3000000');
    const refreshed = await prepareStory(); assert.equal(refreshed.status, 201, refreshed.text);
    await sql.query('UPDATE products SET stock_available=0 WHERE owner_phone=$1 AND id=$2', [owner, storySku.id]);
    assert.equal((await validateStory(refreshed.json.result.snapshotId)).json.valid, false);
    assert.equal((await prepareStory()).status, 422);
    await sql.query('UPDATE products SET stock_available=2 WHERE owner_phone=$1 AND id=$2', [owner, storySku.id]);
  });
  await run('last-unit assertions are truthful and snapshot preparation is idempotent', async () => {
    assert.equal((await prepareStory({ templateId: 'last_unit' })).status, 422);
    await sql.query('UPDATE products SET stock_available=1 WHERE owner_phone=$1 AND id=$2', [owner, storySku.id]);
    const last = await prepareStory({ templateId: 'last_unit' }); assert.equal(last.status, 201, last.text); assert.equal(last.json.result.content.assertion, 'last_total');
    const operation = (await sql.query('SELECT request_json FROM commercial_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, last.json.operationId])).rows[0].request_json;
    const replay = await post(`/products/${photoProduct.id}/story-snapshots`, { operationId: last.json.operationId, ...operation });
    assert.equal(replay.status, 201, replay.text); assert.deepEqual(replay.json, last.json);
    await sql.query('UPDATE products SET stock_available=2 WHERE owner_phone=$1 AND id=$2', [owner, storySku.id]);
    assert.equal((await validateStory(last.json.result.snapshotId)).json.valid, false);
  });
  const catalogChecks = await runCatalogHttpChecks({ sql, check, request, req, product: photoProduct, sku: storySku, owner, other, member });
  photoProduct = catalogChecks.product;
  await run('gallery revision, focus, logical retirement and deleted content boundaries', async () => {
    const galleryBody = { operationId: randomUUID(), expectedRevision: photoProduct.revision, imageIds: [imageId], coverImageId: imageId };
    const gallery = await req(`/products/${photoProduct.id}/gallery`, { method: 'PUT', body: galleryBody });
    assert.equal(gallery.status, 200, gallery.text); photoProduct = gallery.json.result;
    assert.deepEqual((await req(`/products/${photoProduct.id}/gallery`, { method: 'PUT', body: galleryBody })).json, gallery.json);
    const image = photoProduct.images[0];
    const body = { operationId: randomUUID(), expectedRevision: photoProduct.revision, expectedImageRevision: image.revision,
      altText: 'Portada revisada', focalX: 0.25, focalY: 0.75, retire: false };
    const changed = await req(`/products/${photoProduct.id}/images/${imageId}`, { method: 'PATCH', body });
    assert.equal(changed.status, 200, changed.text); photoProduct = changed.json.result; assert.equal(photoProduct.images[0].focalX, 0.25);
    const deleted = await req(`/products/${photoProduct.id}/images/${imageId}`, { method: 'PATCH', body: { ...body, operationId: randomUUID(),
      expectedRevision: photoProduct.revision, expectedImageRevision: photoProduct.images[0].revision, retire: true } });
    assert.equal(deleted.status, 200, deleted.text); assert.equal(deleted.json.result.coverImageId, null); assert.equal(deleted.json.result.images.length, 0);
    assert.equal((await req(`/products/${photoProduct.id}/images/${imageId}/content`)).status, 404);
    assert.equal((await upload(imageId, imageBytes)).status, 404);
  });
  await runCommerceMediaFaultChecks({ db, sql, check, owner });
  return count + 4 + catalogChecks.count;
}
