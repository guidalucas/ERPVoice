import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const shop = 'fullmatch-demo', listingPath = `/c/${shop}`, apiPath = `/api/catalog/v1/${shop}/products`;
const bot = { 'User-Agent': 'WhatsApp/2.26' };
let browser;
const listing = async query => { const response = await fetch(fixture.apiUrl + apiPath + '?' + new URLSearchParams(query ?? {})); assert.equal(response.status, 200); return response.json(); };
const html = async path => { const response = await fetch(fixture.apiUrl + path, { headers: bot }); assert.equal(response.status, 200); return response.text(); };
const socialImage = body => body.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
try {
  await sql.connect();
  const coverId = randomUUID(), logoId = randomUUID();
  for (const [id, kind, mime, bytes] of [
    [coverId, 'cover', 'image/jpeg', await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#123456' } }).jpeg().toBuffer()],
    [logoId, 'logo', 'image/png', await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer()],
  ]) await sql.query('INSERT INTO commerce_brand_assets(owner_phone,id,kind,mime_type,content) VALUES($1,$2,$3,$4,$5)', [fixture.owner, id, kind, mime, bytes]);
  await sql.query('UPDATE commerce_profiles SET appearance=appearance||$2::jsonb WHERE owner_phone=$1', [fixture.owner, JSON.stringify({ coverId, logoId })]);
  const products = fixture.products;
  const assignments = [[products[0].skuIds[0], '2XL'], [products[0].skuIds[1], 'M'], [products[1].skuIds[0], 'XL'], [products[2].skuIds[0], 'XXL'], [products[2].skuIds[1], '3XL']];
  for (const [sku, size] of assignments) await sql.query('UPDATE products SET size=$3 WHERE owner_phone=$1 AND id=$2', [fixture.owner, sku, size]);
  const snapshot = async () => (await sql.query('SELECT * FROM products WHERE owner_phone=$1 ORDER BY id', [fixture.owner])).rows;
  const before = await snapshot();
  const all = await listing();
  assert.deepEqual(all.facets.variants, ['M', 'XL', 'XXL', '3XL']);
  const expected = (await listing({ variant: 'XXL' })).items.map(product => product.slug);
  assert.equal(expected.length, 2);
  for (const variant of ['2XL', 'XXL', '2 xl', 'xxl']) assert.deepEqual((await listing({ variant })).items.map(product => product.slug), expected);
  const combined = await listing({ variant: 'XXL', team: 'barcelona', version: 'player' });
  assert.equal(combined.items.length, 1); assert.ok(combined.items[0].sizes.some(size => size.size === '2XL'));
  const one = await listing({ variant: '2XL', limit: '1' });
  assert.ok(one.nextCursor);
  const two = await listing({ variant: 'XXL', limit: '1', cursor: one.nextCursor });
  assert.equal(two.items.length, 1); assert.notEqual(two.items[0].slug, one.items[0].slug);
  console.log('PASS ordered deduplicated size facets, XXL/2XL matching, combined filters and pagination while raw SKU labels stay intact');

  const coverUrl = fixture.apiUrl + `/api/catalog/v1/${shop}/brand-assets/${coverId}`;
  for (const path of [listingPath, listingPath + '?q=no-matching-product', listingPath + '/pedido', listingPath + '/ayuda']) assert.equal(socialImage(await html(path)), coverUrl);
  const image = await fetch(coverUrl, { headers: bot });
  assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/jpeg/);
  const dimensions = await sharp(Buffer.from(await image.arrayBuffer())).metadata(); assert.equal(dimensions.width, 1200); assert.equal(dimensions.height, 630);
  const own = all.items[0];
  assert.equal(socialImage(await html(own.path)), fixture.apiUrl + own.photos[0].url);
  await sql.query('UPDATE commerce_profiles SET appearance=jsonb_set(appearance,\'{coverId}\',\'null\'::jsonb) WHERE owner_phone=$1', [fixture.owner]);
  assert.equal(socialImage(await html(listingPath + '?q=no-matching-product')), fixture.apiUrl + `/api/catalog/v1/${shop}/brand-assets/${logoId}`);
  console.log('PASS crawler-readable absolute OG image URLs, cover/logo fallback on empty and secondary pages, accessible image bytes and product photo priority');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(fixture.apiUrl + listingPath + '?variant=2XL');
    assert.equal(await page.locator('select[name=variant]').inputValue(), 'XXL');
    assert.deepEqual(await page.locator('select[name=variant] option').evaluateAll(options => options.map(option => option.value)), ['', 'M', 'XL', 'XXL', '3XL']);
    assert.equal(await page.locator('.catalog-card').count(), 2);
    await page.locator('select[name=variant]').selectOption('XXL');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page.waitForURL(/variant=XXL/); await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
    assert.equal(await page.locator('.catalog-card').count(), 2);
    await page.close();
  }
  assert.deepEqual(await snapshot(), before);
  console.log('PASS canonical selection for old 2XL URLs on mobile/desktop and no inventory writes from public reads');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
