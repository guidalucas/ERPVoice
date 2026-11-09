import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { createCatalogService, publicProductProjection } from '../server/commerce/catalogService.js';
import { readProductDetail } from '../server/commerce/productRepository.js';
import { createMediaCache } from '../server/catalog/mediaCache.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const runtime = createDatabaseRuntime({ connectionString: fixture.connection });
let browser, queries = 0;
const measured = { ...runtime, transaction: (callback, options) => runtime.transaction(client => callback({ query: (...args) => { queries++; return client.query(...args); } }), options) };
const service = createCatalogService(measured);
const shop = 'fullmatch-demo', base = `${fixture.apiUrl}/api/catalog/v1/${shop}`;
try {
  await sql.connect(); await service.brand(shop); queries = 0;
  const listing = await service.list(shop); assert.equal(queries, 4);
  for (const item of listing.items) {
    const id = fixture.products.find(product => product.title === item.title).id;
    assert.deepEqual(item, publicProductProjection(await readProductDetail(sql, fixture.owner, id), shop));
  }
  const product = listing.items.find(item => item.title.startsWith('Barcelona'));
  const original = fixture.products.find(item => item.title === product.title);
  // Build a full 24-product page without any remote connection or production writes.
  for (let index = 0; index < 21; index++) {
    const id = randomUUID(), sku = `performance-${randomUUID()}`;
    await sql.query(`INSERT INTO products SELECT (jsonb_populate_record(NULL::products,to_jsonb(p)||jsonb_build_object('id',$3::text))).* FROM products p WHERE owner_phone=$1 AND id=$2`, [fixture.owner, original.skuIds[0], sku]);
    await sql.query(`INSERT INTO commercial_products SELECT (jsonb_populate_record(NULL::commercial_products,to_jsonb(p)||jsonb_build_object('id',$3::text,'slug',$4::text,'identity_key',md5($3::text)||md5($3::text),'cover_image_id',NULL))).* FROM commercial_products p WHERE owner_phone=$1 AND id=$2`, [fixture.owner, original.id, id, `performance-${index}`]);
    await sql.query(`INSERT INTO commercial_product_skus(owner_phone,commercial_product_id,sku_id,identity_fingerprint_at_link,linked_by) SELECT owner_phone,$3,$4,identity_fingerprint_at_link,linked_by FROM commercial_product_skus WHERE owner_phone=$1 AND commercial_product_id=$2 AND sku_id=$5`, [fixture.owner, original.id, id, sku, original.skuIds[0]]);
    await sql.query(`INSERT INTO commercial_publications(owner_phone,commercial_product_id,status,updated_by,reason,published_at) VALUES($1,$2,'published',$1,'Isolated performance fixture',NOW())`, [fixture.owner, id]);
  }
  queries = 0; assert.equal((await service.list(shop)).items.length, 24); assert.equal(queries, 4);
  queries = 0; await service.detail(shop, product.slug); assert.equal(queries, 3);
  const paginated = await service.list(shop, { limit: '1' });
  assert.equal(paginated.items.length, 1); assert.ok(paginated.nextCursor);
  assert.notEqual((await service.list(shop, { limit: '1', cursor: paginated.nextCursor })).items[0].slug, paginated.items[0].slug);
  assert.equal((await service.list(shop, { q: '%' })).items.length, 0);
  assert.equal((await service.list(shop, { team: 'argentina', version: 'player', category: 'Camiseta' })).items.length, 1);
  assert.equal((await service.detail(shop, 'performance-0')).product.photos.length, 0);
  console.log('PASS bounded queries: 4 SELECTs for both 3 and 24 products; detail 3; DTO/readiness parity');

  const image = product.photos[0], detailUrl = fixture.apiUrl + image.detailUrl;
  const first = await fetch(detailUrl), bytes = Buffer.from(await first.arrayBuffer()), etag = first.headers.get('etag');
  assert.equal(first.status, 200); assert.equal(first.headers.get('content-type'), 'image/webp');
  assert.equal(first.headers.get('cache-control'), 'private, no-cache'); assert.ok(etag);
  const meta = await sharp(bytes).metadata(); assert.ok(meta.width <= 960 && meta.height <= 1200);
  const cached = await fetch(detailUrl, { headers: { 'If-None-Match': etag } }); assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
  assert.match(cached.headers.get('server-timing'), /db;dur=[\d.]+;desc="3 queries"/);
  assert.doesNotMatch(cached.headers.get('server-timing'), /storage|encode/);
  await sql.query('UPDATE products SET stock_available=0,price=81000 WHERE owner_phone=$1 AND id=ANY($2::text[])', [fixture.owner, original.skuIds]);
  const live = await service.detail(shop, product.slug); assert.equal(live.product.available, false); assert.equal(live.product.priceRange.minAmountMinor, '8100000');
  await sql.query("UPDATE commercial_publications SET status='hidden' WHERE owner_phone=$1 AND commercial_product_id=$2", [fixture.owner, original.id]);
  assert.equal((await fetch(detailUrl, { headers: { 'If-None-Match': etag } })).status, 404);
  await sql.query("UPDATE commercial_publications SET status='published' WHERE owner_phone=$1 AND commercial_product_id=$2", [fixture.owner, original.id]);
  await sql.query("UPDATE products SET price_currency='XXX' WHERE owner_phone=$1 AND id=$2", [fixture.owner, original.skuIds[0]]);
  assert.equal((await fetch(detailUrl, { headers: { 'If-None-Match': etag } })).status, 404);
  await sql.query("UPDATE products SET stock_available=2,price_currency='ARS' WHERE owner_phone=$1 AND id=ANY($2::text[])", [fixture.owner, original.skuIds]);
  console.log('PASS live stock/prices, WebP bounds, empty 304 and hidden/invalid products revoke cached media');

  const other = fixture.freshOwners[0].owner;
  await sql.query("INSERT INTO commerce_profiles(owner_phone,id,brand_name,enabled,created_by,sales_whatsapp) VALUES($1,$2,'Other tenant',true,$1,$1)", [other, randomUUID()]);
  await sql.query("INSERT INTO commerce_catalogs(owner_phone,id,slug,public_enabled,created_by,updated_by) VALUES($1,$2,'other-tenant',true,$1,$1)", [other, randomUUID()]);
  assert.equal((await service.list('other-tenant')).items.length, 0);
  assert.equal((await fetch(`${fixture.apiUrl}/api/catalog/v1/other-tenant/products/${product.slug}/images/${image.id}`, { headers: { 'If-None-Match': etag } })).status, 404);
  console.log('PASS tenant isolation, including conditional media requests');

  let loads = 0;
  const cache = createMediaCache({ maxBytes: 4, maxEntries: 1 });
  await Promise.all([cache('a', async () => { loads++; return Buffer.from('abc'); }), cache('a', async () => { loads++; return Buffer.from('bad'); })]);
  assert.equal(loads, 1);
  await cache('b', async () => Buffer.from('def'));
  await cache('a', async () => { loads++; return Buffer.from('abc'); }); assert.equal(loads, 2);
  await assert.rejects(cache('error', async () => { throw new Error('storage failed'); }));
  assert.equal((await cache('error', async () => Buffer.from('ok'))).toString(), 'ok');
  const expired = createMediaCache({ ttlMs: -1 }); let expiredReads = 0;
  for (let index = 0; index < 2; index++) await expired('a', async () => { expiredReads++; return Buffer.from('a'); });
  assert.equal(expiredReads, 2);
  const serial = createMediaCache({ maxConcurrent: 1, maxPending: 2 });
  let unblock; const held = serial('held', () => new Promise(resolve => { unblock = resolve; }));
  await Promise.resolve();
  let secondStarted = false;
  const queued = serial('queued', async () => { secondStarted = true; return Buffer.from('b'); });
  await assert.rejects(serial('overflow', async () => Buffer.from('c')), { code: 'MEDIA_CACHE_BUSY' });
  assert.equal(secondStarted, false); unblock(Buffer.from('a')); await Promise.all([held, queued]); assert.equal(secondStarted, true);
  const compressed = await fetch(`${fixture.apiUrl}/catalog-assets/catalog.js`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip'); assert.match(compressed.headers.get('vary'), /Accept-Encoding/);
  assert.match(await compressed.text(), /catalog:navigated/);
  console.log('PASS image cache coalesces, evicts within byte limits and retries failures');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${fixture.apiUrl}/c/${shop}?team=barcelona#coleccion`);
    await page.evaluate(() => { window.navigationSentinel = true; });
    await page.locator('.catalog-card').first().scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => scrollY);
    await page.locator(`.catalog-card > a[href="${product.path}"]`).click();
    await page.locator('.public-product-heading').waitFor();
    assert.equal(await page.evaluate(() => window.navigationSentinel), true);
    await sql.query("UPDATE commerce_profiles SET brand_name='Updated brand',revision=revision+1,appearance=jsonb_set(appearance,'{primaryColor}','\"#123456\"') WHERE owner_phone=$1", [fixture.owner]);
    await page.locator('a.back').click();
    await page.locator('.catalog-card').first().waitFor();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
    assert.equal(new URL(page.url()).searchParams.get('team'), 'barcelona');
    assert.match(await page.locator('.shop-brand').textContent(), /Updated brand/);
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--navy').trim().toLowerCase() === '#123456');
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scroll) < 5);
    const pending = page.waitForResponse(response => response.url().includes('/c/fullmatch-demo?') && response.request().resourceType() === 'fetch');
    await page.locator('.catalog-filters input[name=q]').fill('No matching product');
    await page.locator('.catalog-filters button[type=submit]').first().click(); await pending;
    await page.getByText('No encontramos productos para esta búsqueda.').waitFor();
    await page.goBack(); await page.locator('.catalog-card').first().waitFor();
    assert.equal(await page.evaluate(() => window.navigationSentinel), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const page = await noJs.newPage(); await page.goto(`${fixture.apiUrl}/c/${shop}`);
  await page.locator('.catalog-card > a').first().click(); await page.locator('.public-product-heading').waitFor();
  await noJs.close();
  console.log('PASS desktop/mobile soft navigation, filters, search, scroll, history and SSR without JavaScript');
} finally {
  if (browser) await browser.close();
  await sql.end(); await runtime.close(); await fixture.stop();
}
