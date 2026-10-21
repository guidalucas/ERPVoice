import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { migrateCatalog, inspectCatalogSchema } from '../server/commerce/catalogMigration.js';
import { issueJwt } from '../server/auth.js';

export async function runCatalogHttpChecks({ sql, check, request, req, product, sku, owner, other, member }) {
  let count = 0, current = product, publication, config;
  const shop = 'http-fullmatch-fixture', base = `/api/catalog/v1/${shop}`;
  const run = async (name, callback) => { await check(`catalog HTTP: ${name}`, callback); count++; };
  const get = route => request(route, { method: 'GET', auth: false });
  const auth = phone => ({ Authorization: `Bearer ${issueJwt({ phoneNumber: phone })}` });
  const publishBody = { operationId: randomUUID(), expectedRevision: 0, expectedProductRevision: current.revision, status: 'published', reason: 'Only temporary HTTP catalog fixture' };
  const configureBody = { operationId: randomUUID(), expectedRevision: 0, slug: shop, publicEnabled: true };
  const photoPath = () => `${base}/products/${current.slug}/images/${current.coverImageId}`;
  await run('explicit second migration is repeatable, scoped and leaves inventory unchanged', async () => {
    const fingerprint = async () => (await sql.query("SELECT md5(string_agg(to_jsonb(p)::text,'' ORDER BY id)) AS hash FROM products p")).rows[0].hash;
    const before = await fingerprint(); assert.equal((await migrateCatalog(sql)).changed, true); assert.equal((await migrateCatalog(sql)).changed, false);
    assert.equal((await inspectCatalogSchema(sql)).ready, true); assert.equal(await fingerprint(), before);
    await assert.rejects(() => sql.query("INSERT INTO commercial_publications(owner_phone,commercial_product_id,status,reason,updated_by) VALUES($1,$2,'hidden','Cross scope attempt',$1)", [other, current.id]), { code: '23503' });
  });
  await run('nothing becomes public from private preparation or catalog creation alone', async () => {
    assert.equal((await get(base)).status, 404); assert.equal((await get(photoPath())).status, 404);
    const configured = await req('/catalog', { method: 'PUT', body: configureBody }); assert.equal(configured.status, 200, configured.text); config = configured.json.result;
    assert.equal((await get(`${base}/products`)).json.items.length, 0); assert.equal((await get(`${base}/products/${current.slug}`)).status, 404);
    assert.equal((await req(`/products/${current.id}/publication`, { headers: auth(member) })).status, 403);
    assert.equal((await req(`/products/${current.id}/publication`, { headers: auth(other) })).status, 404);
    const foreign = await req(`/products/${current.id}/publication`, { method: 'PUT', headers: auth(other), body: publishBody }); assert.equal(foreign.status, 404);
  });
  await run('explicit publication yields an allowlisted public projection and real private-derived photo', async () => {
    const response = await req(`/products/${current.id}/publication`, { method: 'PUT', body: publishBody }); assert.equal(response.status, 200, response.text); publication = response.json.result;
    const result = await get(`${base}/products/${current.slug}`); assert.equal(result.status, 200, result.text);
    const publicProduct = result.json.product;
    assert.deepEqual(Object.keys(publicProduct).sort(), ['slug', 'title', 'description', 'teamKey', 'teamName', 'teamKind', 'season', 'kitKey', 'versionKey', 'sleeveKey', 'priceRange', 'available', 'sizes', 'photos', 'path'].sort());
    assert.equal(publicProduct.available, true); assert.equal(publicProduct.priceRange.minAmountMinor, '3100000'); assert.equal(publicProduct.sizes[0].size, 'S');
    for (const field of ['owner_phone', 'ownerPhone', 'stockAvailable', 'stockReserved', 'skuId', 'identityFingerprint', 'revision', 'master_key', 'clients', 'transactions', 'pedidos']) assert.ok(!result.text.includes(`"${field}"`), field);
    assert.ok(!result.text.includes(owner)); assert.ok(!result.text.includes(sku.id));
    const photo = await get(photoPath()); assert.equal(photo.status, 200, photo.text); assert.equal((await sharp(photo.buffer).metadata()).format, 'jpeg');
    assert.equal(photo.headers['cache-control'], 'no-store'); assert.equal(result.headers['set-cookie'], undefined);
    assert.equal((await get(`${base}/products/${current.slug}/images/${randomUUID()}`)).status, 404);
  });
  await run('hide/disable revoke JSON, HTML and images immediately; receipt replay does not republish', async () => {
    const hide = await req(`/products/${current.id}/publication`, { method: 'PUT', body: { ...publishBody, operationId: randomUUID(), expectedRevision: publication.revision, status: 'hidden' } });
    assert.equal(hide.status, 200, hide.text); publication = hide.json.result;
    for (const route of [`${base}/products/${current.slug}`, photoPath(), `/c/${shop}/p/${current.slug}`]) assert.equal((await get(route)).status, 404, route);
    assert.equal((await req(`/products/${current.id}/publication`, { method: 'PUT', body: publishBody })).json.result.status, 'published');
    assert.equal((await get(photoPath())).status, 404);
    publication = (await req(`/products/${current.id}/publication`, { method: 'PUT', body: { ...publishBody, operationId: randomUUID(), expectedRevision: publication.revision } })).json.result;
    const disabled = await req('/catalog', { method: 'PUT', body: { ...configureBody, operationId: randomUUID(), expectedRevision: config.revision, publicEnabled: false } });
    assert.equal(disabled.status, 200, disabled.text); config = disabled.json.result;
    assert.equal((await get(base)).status, 404); assert.equal((await get(photoPath())).status, 404);
    assert.equal((await req('/catalog', { method: 'PUT', body: configureBody })).json.result.publicEnabled, true); assert.equal((await get(base)).status, 404);
    const enabled = await req('/catalog', { method: 'PUT', body: { ...configureBody, operationId: randomUUID(), expectedRevision: config.revision } });
    assert.equal(enabled.status, 200, enabled.text); config = enabled.json.result;
    assert.equal((await get(photoPath())).status, 200);
  });
  await run('stock is live; invalid money and changed identity suppress public records and media', async () => {
    await sql.query('UPDATE products SET stock_available=0 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    const sold = await get(`${base}/products/${current.slug}`); assert.equal(sold.status, 200); assert.equal(sold.json.product.available, false); assert.equal(sold.json.product.sizes[0].available, false);
    await sql.query('UPDATE products SET stock_available=2,stock_reserved=1 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    assert.equal((await get(`${base}/products/${current.slug}`)).json.product.available, true);
    await sql.query("UPDATE products SET price_currency='XXX' WHERE owner_phone=$1 AND id=$2", [owner, sku.id]);
    assert.equal((await get(`${base}/products/${current.slug}`)).status, 404); assert.equal((await get(photoPath())).status, 404); assert.equal((await get(`${base}/products`)).json.items.length, 0);
    await sql.query("UPDATE products SET price_currency='ARS',size='XXL' WHERE owner_phone=$1 AND id=$2", [owner, sku.id]);
    assert.equal((await get(photoPath())).status, 404);
    await sql.query("UPDATE products SET size='S' WHERE owner_phone=$1 AND id=$2", [owner, sku.id]);
    assert.equal((await get(photoPath())).status, 200);
    await sql.query('UPDATE commerce_profiles SET enabled=false WHERE owner_phone=$1', [owner]); assert.equal((await get(base)).status, 404);
    await sql.query('UPDATE commerce_profiles SET enabled=true WHERE owner_phone=$1', [owner]);
    const contact = (await sql.query('SELECT sales_whatsapp FROM commerce_profiles WHERE owner_phone=$1', [owner])).rows[0].sales_whatsapp;
    await sql.query('UPDATE commerce_profiles SET sales_whatsapp=NULL WHERE owner_phone=$1', [owner]); assert.equal((await get(base)).status, 404);
    await sql.query('UPDATE commerce_profiles SET sales_whatsapp=$2 WHERE owner_phone=$1', [owner, contact]);
  });
  await run('SSR is escaped, has SEO metadata and never returns private operational state', async () => {
    assert.equal((await get(`/c/${shop}?utm_source=instagram&fbclid=fixture-tracking`)).status, 200);
    const malicious = 'Camiseta <img src=x onerror=alert(1)> & colección';
    const updated = await req(`/products/${current.id}`, { method: 'PATCH', body: { operationId: randomUUID(), expectedRevision: current.revision, changes: { title: malicious, description: '</script><script>alert(1)</script>' } } });
    assert.equal(updated.status, 200, updated.text); current = updated.json.result;
    const page = await get(`/c/${shop}/p/${current.slug}`); assert.equal(page.status, 200, page.text);
    assert.ok(page.text.includes('&lt;img src=x onerror=alert(1)&gt;')); assert.ok(!page.text.includes('<img src=x')); assert.ok(!page.text.includes('</script><script>alert(1)'));
    assert.ok(page.text.includes('rel="canonical"')); assert.ok(page.text.includes('application/ld+json')); assert.ok(page.text.includes('\\u003c/script\\u003e'));
    assert.ok(page.headers['content-security-policy'].includes("default-src 'none'")); assert.ok(!page.text.includes('/api/state'));
    const search = await get(`/c/${shop}?q=${encodeURIComponent('"><script>alert(1)</script>')}`); assert.equal(search.status, 200); assert.ok(!search.text.includes('<script>alert(1)</script>'));
    const restored = await req(`/products/${current.id}`, { method: 'PATCH', body: { operationId: randomUUID(), expectedRevision: current.revision, changes: { title: product.title, description: product.description } } });
    assert.equal(restored.status, 200, restored.text); current = restored.json.result;
  });
  await run('bounded literal search, stable slugs and publication conflicts are explicit', async () => {
    assert.equal((await get(`${base}/products?limit=49`)).status, 400); assert.equal((await get(`${base}/products?q=%25`)).json.items.length, 0);
    const results = await get(`${base}/products?team=story-fixture&version=player&limit=1`); assert.equal(results.status, 200); assert.equal(results.json.items[0].slug, product.slug);
    const stale = await req(`/products/${current.id}/publication`, { method: 'PUT', body: { ...publishBody, operationId: randomUUID(), expectedProductRevision: current.revision, expectedRevision: 0 } }); assert.equal(stale.status, 409);
    const rename = await req('/catalog', { method: 'PUT', body: { ...configureBody, operationId: randomUUID(), expectedRevision: config.revision, slug: 'another-link' } }); assert.equal(rename.status, 409);
  });
  await run('archived prepared products disappear without mutating their publication record', async () => {
    const archive = await req(`/products/${current.id}/status`, { method: 'POST', body: { operationId: randomUUID(), expectedRevision: current.revision, status: 'archived', reason: 'Fixture archive/public boundary' } });
    assert.equal(archive.status, 200, archive.text); current = archive.json.result; assert.equal((await get(photoPath())).status, 404);
    assert.equal((await req(`/products/${current.id}/publication`)).json.status, 'published');
    for (const status of ['draft', 'ready']) { const changed = await req(`/products/${current.id}/status`, { method: 'POST', body: { operationId: randomUUID(), expectedRevision: current.revision, status, reason: 'Fixture restore preparation' } }); assert.equal(changed.status, 200, changed.text); current = changed.json.result; }
    assert.equal((await get(photoPath())).status, 200);
  });
  return { count, product: current };
}
