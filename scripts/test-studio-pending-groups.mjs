import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

// Real API + disposable localhost database; never reads or modifies a real store.
const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const output = path.resolve('.fullmatch-runtime/pending-groups');
const argentina = 'PRUEBA agrupación Camiseta Argentina titular 2026 versión jugador';
const chelsea = 'PRUEBA agrupación Camiseta Chelsea tercera equipación versión jugador';
const oversized = 'PRUEBA agrupación Lote de 101 talles';
const api = async (route, user = fixture, command, status = 200) => {
  const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${route}`, {
    headers: { Authorization: `Bearer ${user.token}`, ...(command && { 'Content-Type': 'application/json' }) },
    ...(command && { method: 'POST', body: JSON.stringify(command) }),
  });
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
};
let browser;
try {
  await sql.connect(); await fs.mkdir(output, { recursive: true });
  const insert = (id, name, size, owner = fixture.owner, unit = 'unit', model = null) => sql.query(`INSERT INTO products
    (id,owner_phone,name,size,stock_available,price,price_currency,inventory_unit,product_model)
    VALUES($1,$2,$3,$4,2,65000,'ARS',$5,$6)`, [id, owner, name, size, unit, model]);
  // Interleaved IDs would split the product if the API still paginated individual SKUs.
  for (const [index, size] of ['S','M','XL','XXL','4XL','3XL'].entries()) await insert(`pending-${index === 0 ? '000' : 500 + index}`, argentina, size);
  await insert('pending-001', chelsea, 'S'); await insert('pending-900', chelsea, 'XL');
  for (let i = 0; i < 51; i++) await insert(`pending-extra-${String(i).padStart(3, '0')}`, `PRUEBA agrupación Producto ${i}`, 'M');
  for (let i = 0; i < 101; i++) await insert(`pending-big-${String(i).padStart(3, '0')}`, oversized, String(i));
  await insert('pending-foreign', argentina, 'L', fixture.freshOwners[0].owner);
  await insert('pending-unit-a', 'Presentación aislada', '', fixture.owner, 'unit', 'Modelo A');
  await insert('pending-unit-b', 'Presentación aislada', '', fixture.owner, 'pack', 'Modelo A');
  await insert('pending-model-c', 'Presentación aislada', '', fixture.owner, 'unit', 'Modelo B');
  const before = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  let cursor, ids = [], pages = 0;
  do {
    const page = await api(`/inventory-candidates?${new URLSearchParams({ q: 'PRUEBA agrupación', grouped: 'true', limit: '1', ...(cursor ? { cursor } : {}) })}`);
    assert.ok(page.items.length); assert.equal(new Set(page.items.map(item => item.name)).size, 1);
    if (page.items[0].name === argentina) assert.equal(page.items.length, 6);
    if (page.items[0].name === chelsea) assert.equal(page.items.length, 2);
    if (page.items[0].name === oversized) assert.equal(page.items.length, 101);
    ids.push(...page.items.map(item => item.skuId)); cursor = page.nextCursor; pages++;
    assert.ok(pages <= 54, 'Cursor must progress');
  } while (cursor);
  assert.equal(pages, 54); assert.equal(ids.length, 160); assert.equal(new Set(ids).size, 160);
  assert.ok(!ids.includes('pending-foreign'));
  const legacy = await api('/inventory-candidates?limit=1'); assert.equal(legacy.items.length, 1); assert.ok(legacy.nextCursor);
  const units = await api('/inventory-candidates?q=Presentaci%C3%B3n%20aislada&grouped=true&limit=1');
  assert.equal(units.items.length, 1); assert.ok(units.nextCursor, 'Different units/models remain separate products');
  console.log('PASS API: complete groups across pages, tenant isolation, units/models, legacy pagination');

  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner);
    localStorage.setItem('stocky-theme', 'dark');
  }, fixture);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url); await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
  const pending = async () => {
    await page.getByRole('button', { name: /02.*Pendientes/ }).click();
    await page.locator('.pending-product').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.pending-product-list')?.getAttribute('aria-busy') === 'false');
  };
  const group = name => page.locator('.pending-product').filter({ has: page.getByText(name, { exact: true }) });
  const parent = name => group(name).locator('.pending-product-select input');
  const selection = text => page.getByText(`${text} variantes seleccionadas (máximo 100)`, { exact: true }).waitFor();
  await pending();
  assert.equal(await page.locator('.pending-product').count(), 50);
  assert.equal(await page.locator('.pending-variant:visible').count(), 0);
  await parent(argentina).check(); await selection(6);
  await group(argentina).getByRole('button').click();
  assert.equal(await group(argentina).locator('.pending-variant input:checked').count(), 6);
  assert.deepEqual(await group(argentina).locator('.size-tag').allTextContents(), ['S','M','XL','XXL','3XL','4XL']);
  await group(argentina).getByRole('checkbox', { name: `Seleccionar ${argentina} M`, exact: true }).uncheck();
  await selection(5); assert.equal(await parent(argentina).evaluate(input => input.indeterminate), true);
  await parent(argentina).check(); await selection(6);
  await group(argentina).getByRole('button').click(); await selection(6);
  await parent(argentina).uncheck(); await selection(0);
  await parent(oversized).click(); await page.getByRole('alert').filter({ hasText: 'hasta 100' }).waitFor(); await selection(0);
  await parent(argentina).check(); await parent(chelsea).check(); await selection(8);
  await page.getByRole('button', { name: 'Cargar más', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.pending-product').length > 50);
  await selection(8); assert.equal(await page.locator('.pending-product').count(), 58);
  // Keyboard can expand/collapse without changing the selection.
  await group(argentina).getByRole('button').focus(); await page.keyboard.press('Enter'); await selection(8);
  assert.equal(await group(argentina).getByRole('button').getAttribute('aria-expanded'), 'true');
  for (const mode of ['dark', 'light']) {
    if (mode === 'light') await page.getByRole('button', { name: 'Cambiar a modo claro', exact: true }).click();
    for (const width of [1440,390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, `pending-${mode}-${width}.png`), fullPage: false });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('Buscar variantes pendientes').fill(argentina);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.pending-product').length === 1); await selection(0);
  await parent(argentina).check(); await page.getByRole('button', { name: 'Crear ficha y vincular', exact: true }).click();
  await page.getByText('6 SKU seleccionados se vincularán al crear la ficha.', { exact: false }).waitFor();
  await pending(); await parent(argentina).check();
  await page.getByRole('button', { name: 'Vincular a una ficha existente', exact: true }).click();
  await page.locator('.target-product').first().click();
  await page.getByRole('heading', { name: 'SKU y presentaciones vinculadas' }).waitFor();
  assert.ok(await page.locator('.variant-row input:checked').count() >= 6);
  assert.deepEqual(errors, []);
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, before);
  console.log('PASS UI: group/individual selection, mixed state, limit, load more, keyboard, mobile, both themes, create/link review; inventory unchanged');

  const { items: [chelseaSmall] } = await api(`/inventory-candidates?${new URLSearchParams({ q: chelsea, limit: '1' })}`);
  const { result: existing } = await api('/products', fixture, {
    operationId: randomUUID(), product: { title: 'Chelsea con nombre comercial' },
    skuLinks: [{ skuId: chelseaSmall.skuId, expectedRevision: chelseaSmall.revision, expectedFingerprint: chelseaSmall.identityFingerprint }],
  }, 201);
  await pending();
  await page.getByLabel('Buscar variantes pendientes').fill(argentina);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.pending-product').length === 1);
  await page.getByRole('button', { name: 'Sincronizar con Stocky', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '56 fichas creadas · 61 variantes vinculadas. 2 grupos requieren revisión manual.' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.pending-product').length === 2);
  const detail = (await api(`/products?${new URLSearchParams({ q: argentina })}`)).items[0];
  assert.equal(detail.status, 'draft');
  assert.equal(detail.images.length, 0);
  assert.deepEqual(detail.variants.map(variant => variant.size).sort(), ['S','M','XL','XXL','4XL','3XL'].sort());
  assert.ok(detail.variants.every(variant => variant.identityReviewed && variant.stockAvailable === 2));
  assert.deepEqual((await api(`/products/${existing.id}`)).variants.map(variant => variant.skuId), [chelseaSmall.skuId]);
  assert.equal((await sql.query('SELECT count(*)::int AS total FROM commercial_publications')).rows[0].total, fixture.products.length);
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, before);
  await page.getByRole('button', { name: 'Ver fichas sin fotos', exact: true }).click();
  await page.getByLabel('Buscar productos').fill(argentina);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.locator('.product-card').filter({ hasText: argentina }).click();
  await page.getByRole('heading', { name: 'Fotografías del producto', exact: true }).waitFor();
  await page.getByLabel('Subir fotografías').waitFor({ state: 'attached' });

  const longName = 'A'.repeat(89) + ' ' + 'B'.repeat(50);
  await insert('pending-concurrent', longName, 'M');
  const syncRoute = '/inventory-candidates/sync';
  const attempts = [{ operationId: randomUUID() }, { operationId: randomUUID() }];
  const receipts = await Promise.all(attempts.map(command => api(syncRoute, fixture, command)));
  assert.deepEqual(receipts.map(receipt => receipt.result.created).sort(), [0, 1]);
  assert.deepEqual(await api(syncRoute, fixture, attempts[0]), receipts[0]);
  assert.deepEqual((await api(syncRoute, fixture, { operationId: randomUUID() })).result, { created: 0, linkedSkus: 0, needsReview: 2 });
  const longTitle = (await api(`/products?${new URLSearchParams({ q: longName.slice(0, 89) })}`)).items[0].title;
  assert.equal(longTitle, longName.slice(0, 120));
  await api(syncRoute, fixture.member, { operationId: randomUUID() }, 403);
  assert.deepEqual(errors, []);
  console.log('PASS sync: all pages despite search, complete drafts, manual exceptions, photo shortcut, tenant and public state, concurrent requests and receipt replay');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
