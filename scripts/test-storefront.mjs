import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const shop = 'fullmatch-demo', base = `/api/catalog/v1/${shop}`, output = path.resolve('.fullmatch-runtime/storefront');
let browser, studioPage;
const read = async (route, options) => {
  const response = await fetch(fixture.apiUrl + route, options);
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const list = query => read(base + '/products' + (query ? '?' + new URLSearchParams(query) : ''));
try {
  await sql.connect(); await fs.mkdir(output, { recursive: true });
  const stored = (await sql.query('SELECT id,slug FROM commercial_products WHERE owner_phone=$1 ORDER BY title', [fixture.owner])).rows;
  const original = stored[0];
  await sql.query("UPDATE commercial_products SET created_at=$3::timestamptz WHERE owner_phone=$1 AND id=$2", [fixture.owner, original.id, '2020-01-01T00:00:00Z']);
  const oldSku = (await sql.query('SELECT sku_id FROM commercial_product_skus WHERE owner_phone=$1 AND commercial_product_id=$2', [fixture.owner, original.id])).rows.map(row => row.sku_id);
  await sql.query('UPDATE products SET name=$3 WHERE owner_phone=$1 AND id=ANY($2::text[])', [fixture.owner, oldSku, 'Camiseta Argentina suplente 2026 versión nacional']);
  await sql.query('UPDATE commercial_products SET title_source=$3,team_key=NULL,team_name=NULL,team_kind=NULL,version_key=NULL WHERE owner_phone=$1 AND id=$2', [fixture.owner, original.id, 'inventory']);
  const renamed = await read(base + '/products/' + original.slug);
  assert.match(renamed.product.slug, /^camiseta-argentina-suplente-2026-version-nacional-/);
  assert.notEqual(renamed.product.slug, original.slug);
  const redirect = await fetch(fixture.apiUrl + `/c/${shop}/p/` + original.slug, { redirect: 'manual' });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), renamed.product.path);
  assert.deepEqual(await read(base + '/products/' + renamed.product.slug), renamed);
  // A former shared title still resolves by its stable suffix after another edit.
  const pastName = 'nombre-anterior-' + renamed.product.slug.split('-').at(-1);
  assert.equal((await read(base + '/products/' + pastName)).product.slug, renamed.product.slug);
  assert.equal((await fetch(fixture.apiUrl + renamed.product.photos[0].thumbnailUrl)).status, 200);
  assert.equal((await list({ version: 'national' })).items.length, 1);
  // Old carts and clean links both resolve exactly the same SKU and price.
  for (const productSlug of [original.slug, renamed.product.slug]) {
    const quote = await read(base + '/inquiry-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ productSlug, size: 'M', quantity: 1 }] }) });
    assert.equal(quote.canContact, true); assert.equal(quote.lines[0].title, renamed.product.title);
  }
  const repeated = await fetch(fixture.apiUrl + base + '/inquiry-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [original.slug, renamed.product.slug].map(productSlug => ({ productSlug, size: 'M', quantity: 1 })) }) });
  assert.equal(repeated.status, 400);
  console.log('PASS current-title canonical URLs, historical redirects, photographs, saved carts and duplicate variant rejection across aliases');

  await sql.query('UPDATE products SET stock_available=0,price=1 WHERE owner_phone=$1 AND id=$2', [fixture.owner, fixture.products[0].skuIds[1]]);
  for (const sort of ['price-asc', 'price-desc', 'newest']) {
    const full = (await list({ sort, limit: '48' })).items;
    const paged = []; let cursor;
    do { const page = await list({ sort, limit: '1', ...(cursor ? { cursor } : {}) }); paged.push(...page.items); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(paged.map(item => item.slug), full.map(item => item.slug));
    assert.equal(new Set(paged.map(item => item.slug)).size, 3);
    if (sort.startsWith('price')) {
      const prices = full.map(item => BigInt(item.priceRange.minAmountMinor));
      for (let i = 1; i < prices.length; i++) assert.ok(sort === 'price-asc' ? prices[i] >= prices[i - 1] : prices[i] <= prices[i - 1]);
    } else assert.equal(full.at(-1).slug, renamed.product.slug);
  }
  assert.equal((await fetch(fixture.apiUrl + base + '/products?sort=unsafe')).status, 400);
  const asc = await list({ sort: 'price-asc', limit: '1' });
  assert.equal((await fetch(fixture.apiUrl + base + '/products?' + new URLSearchParams({ sort: 'newest', cursor: asc.nextCursor }))).status, 400);
  // Equal sort keys still have a deterministic tie-breaker across pages.
  await sql.query('UPDATE products SET price=65000 WHERE owner_phone=$1', [fixture.owner]);
  const equal = []; let cursor;
  do { const page = await list({ sort: 'price-desc', limit: '1', ...(cursor ? { cursor } : {}) }); equal.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(new Set(equal.map(item => item.slug)).size, 3);
  console.log('PASS live prices/newest ordering, deterministic pagination with ties, invalid sorts and mismatched cursor rejection');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  context.setDefaultTimeout(15000);
  await context.addInitScript(({ token, owner }) => { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); }, fixture);
  const studio = await context.newPage(), errors = []; studioPage = studio;
  studio.on('pageerror', error => errors.push(error.message));
  await studio.goto(fixture.url + '#/settings');
  await studio.getByLabel('Dirección y retiro', { exact: true }).fill('Alvear 818 · Concordia, Entre Ríos');
  await studio.getByLabel('Medios de pago', { exact: true }).fill('Todos los medios de pago');
  await studio.getByLabel('Instagram · usuario', { exact: true }).fill('@fmcasacas');
  await studio.getByLabel('Envíos', { exact: true }).fill('Consultanos costo y plazo para tu localidad.');
  await studio.getByLabel('WhatsApp de ventas · código de país y número', { exact: true }).fill('+54 9 345 4326660');
  const featured = studio.getByLabel('Destacados · hasta 24 publicaciones', { exact: true });
  await featured.locator(`option[value="${original.slug}"]`).waitFor({ state: 'attached' });
  await featured.selectOption(original.slug);
  await studio.getByLabel('Promociones · hasta 24 publicaciones', { exact: true }).selectOption(stored[1].slug);
  await studio.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
  await studio.getByText('Configuración guardada.', { exact: true }).waitFor();
  await studio.reload();
  assert.equal(await studio.getByLabel('Dirección y retiro', { exact: true }).inputValue(), 'Alvear 818 · Concordia, Entre Ríos');
  assert.equal(await studio.getByLabel('WhatsApp de ventas · código de país y número', { exact: true }).inputValue(), '5493454326660');
  const home = await list();
  assert.equal(home.catalog.appearance.storeInfo.instagram, 'fmcasacas');
  assert.equal(home.collections.featured[0].slug, renamed.product.slug);
  assert.equal(home.collections.promotions.length, 1);
  assert.equal(home.collections.newest.at(-1).slug, renamed.product.slug);
  assert.equal((await list({ collection: 'featured' })).items[0].slug, renamed.product.slug);
  await studio.screenshot({ path: path.join(output, 'studio-mobile.png'), fullPage: true });
  console.log('PASS editable Studio contact/address/payments/shipping/Instagram and merchandising saved across reloads');

  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.apiUrl + '/c/' + shop);
    assert.equal(await page.locator('.header-chat').getAttribute('href'), 'https://wa.me/5493454326660?text=Hola%2C%20quiero%20hacer%20un%20pedido.');
    assert.equal(await page.getByRole('link', { name: 'Hablemos por WhatsApp', exact: true }).getAttribute('href'), await page.locator('.header-chat').getAttribute('href'));
    assert.equal(await page.locator('.storefront-shelf').count(), 3);
    await page.getByRole('link', { name: 'Encontranos en Instagram · @fmcasacas', exact: true }).waitFor();
    assert.match(await page.locator('#como-comprar').innerText(), /Comprá con confianza/);
    assert.equal(await page.locator('summary').filter({ hasText: 'Guía de talles' }).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `catalog-${width}.png`), fullPage: true });
    await page.locator('select[name=sort]').selectOption('price-asc');
    await page.waitForURL(/sort=price-asc/); await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
    assert.equal(await page.locator('.catalog-card').count(), 3);
    await page.locator('.catalog-filter-options summary').click();
    assert.match(await page.locator('select[name=variant]').innerText(), /Todos los talles/);
    await page.locator('select[name=version]').selectOption('national');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page.waitForURL(/version=national/); await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
    assert.equal(await page.locator('select[name=sort]').inputValue(), 'price-asc');
    assert.equal(await page.locator('.catalog-card').count(), 1);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS mobile/desktop WhatsApp destinations, real collection shelves, size guidance, sorting with combined filters and no horizontal overflow');
  await context.close();
} catch (error) {
  if (studioPage && !studioPage.isClosed()) {
    await studioPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    console.error('Studio notices', JSON.stringify(await studioPage.locator('.notice').allTextContents().catch(() => [])));
  }
  throw error;
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
