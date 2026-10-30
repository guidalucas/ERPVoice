import assert from 'node:assert/strict';
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
const api = async (route, user = fixture) => {
  const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${route}`, { headers: { Authorization: `Bearer ${user.token}` } });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
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
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
