import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { migrateInventoryTitles } from '../server/commerce/inventoryTitlesMigration.js';
import fs from 'node:fs/promises';
import { buildInventoryTitlesSql } from './generate-commerce-inventory-titles-sql.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
let browser;
const request = async (path, method = 'GET', body, authenticated = true) => {
  const response = await fetch(fixture.apiUrl + path, { method, headers: {
    ...(authenticated ? { Authorization: `Bearer ${fixture.token}` } : {}), 'Content-Type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  assert.ok(response.ok, `${response.status} ${JSON.stringify(data)}`);
  return data;
};
const commerce = (path, method, body) => request('/api/commerce/v1' + path, method, body);
try {
  await sql.connect();
  const inventoryBefore = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  // Recreate an existing installation before the additive title migration.
  await sql.query('ALTER TABLE commercial_products DROP COLUMN title_source');
  await sql.query('DELETE FROM commerce_schema_migrations WHERE version=9');
  const migrationSql = await buildInventoryTitlesSql();
  assert.equal((await fs.readFile(new URL('../docs/fullmatch/SUPABASE_INVENTORY_TITLES.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'), migrationSql);
  await sql.query(migrationSql);
  assert.equal((await sql.query('SELECT version FROM commerce_schema_migrations WHERE version=9')).rowCount, 1);
  await sql.query(migrationSql);
  assert.equal((await migrateInventoryTitles(sql)).changed, false);
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, inventoryBefore);
  const { id, skuIds } = fixture.products[0], skuId = skuIds[0];
  const original = await commerce(`/products/${id}`);
  assert.equal(original.titleSource, 'inventory');
  assert.equal(original.title, inventoryBefore.find(row => row.id === skuId).name);
  const linksBefore = (await sql.query('SELECT * FROM commercial_product_skus ORDER BY commercial_product_id,sku_id')).rows;
  const publicationBefore = await commerce(`/products/${id}/publication`);
  const publicPath = `/api/catalog/v1/fullmatch-demo/products/${original.slug}`;
  const publicRead = () => request(publicPath, 'GET', undefined, false);
  const photoPath = (await publicRead()).product.photos[0].url;

  // Reproduce a previously edited product with the old fingerprint still saved.
  await sql.query('UPDATE products SET name=$3,stock_available=6,inventory_revision=inventory_revision+1 WHERE owner_phone=$1 AND id=$2', [fixture.owner, skuId, 'Nombre recuperado Stocky']);
  assert.equal((await commerce(`/products/${id}`)).readiness.canPrepare, true);
  assert.equal((await publicRead()).product.title, 'Nombre recuperado Stocky');
  assert.equal((await fetch(fixture.apiUrl + photoPath)).status, 200);
  console.log('PASS: repeatable migration preserves inventory and restores already stale published links without resaving');

  const editStocky = async (name, stockAvailable = 9) => {
    const detail = await commerce(`/products/${id}`), variant = detail.variants.find(item => item.skuId === skuId);
    return request(`/api/products/${skuId}`, 'PUT', { operationId: randomUUID(), expectedRevision: variant.revision,
      expectedFingerprint: variant.identityFingerprint, name, stockAvailable, price: 78000, priceCurrency: 'ARS' });
  };
  await editStocky('Nombre actualizado desde Stocky');
  const updated = await commerce(`/products/${id}`);
  assert.equal(updated.title, 'Nombre actualizado desde Stocky');
  assert.equal(updated.availableQuantity, 10);
  assert.equal(updated.status, 'ready');
  const publicProduct = (await publicRead()).product;
  assert.equal(publicProduct.title, updated.title);
  assert.equal(publicProduct.sizes.find(item => item.size === updated.variants[0].size).price.amountMinor, '7800000');
  for (const path of ['/api/commerce/v1/products', '/api/catalog/v1/fullmatch-demo/products']) {
    const data = await request(`${path}?q=${encodeURIComponent(updated.title)}`, 'GET', undefined, path.includes('commerce'));
    assert.equal(data.items.length, 1); assert.equal(data.items[0].title, updated.title);
  }
  const html = await fetch(`${fixture.apiUrl}/c/fullmatch-demo/p/${original.slug}`);
  assert.equal(html.status, 200); assert.ok((await html.text()).includes(updated.title));
  assert.deepEqual(await commerce(`/products/${id}/publication`), publicationBefore);
  assert.deepEqual((await sql.query('SELECT * FROM commercial_product_skus ORDER BY commercial_product_id,sku_id')).rows, linksBefore);
  assert.deepEqual(updated.images, original.images); assert.equal(updated.slug, original.slug);
  console.log('PASS: real Stocky edit updates Studio, public detail/list/search/HTML and price without changing publication, links, photos or URL');

  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  }, fixture);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${fixture.url}#/products/${id}`);
  const title = page.getByLabel('Título comercial', { exact: true });
  await page.getByRole('heading', { name: updated.title, exact: true, level: 1 }).waitFor();
  assert.equal(await title.inputValue(), updated.title);
  await editStocky('Nombre nuevo al volver a Studio', 0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: 'Nombre nuevo al volver a Studio', exact: true, level: 1 }).waitFor();
  assert.equal(await title.inputValue(), 'Nombre nuevo al volver a Studio');
  await title.fill('Título personalizado del catálogo');
  const saveEditor = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/products/${id}`) && response.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Guardar cambios', exact: true }).click(),
    ]);
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => document.querySelector('.editor-main fieldset')?.disabled === false);
    await page.getByText('Ficha guardada.', { exact: true }).waitFor();
  };
  await saveEditor();
  await sql.query(migrationSql);
  await editStocky('Stocky sigue cambiando', 3);
  assert.equal((await publicRead()).product.title, 'Título personalizado del catálogo');
  assert.equal((await commerce(`/products/${id}`)).titleSource, 'custom');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/products/${id}/availability`)),
    page.evaluate(() => window.dispatchEvent(new Event('focus'))),
  ]);
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Título personalizado del catálogo');
  await page.getByText('Nombre en Stocky: Stocky sigue cambiando', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Usar nombre de Stocky', exact: true }).click();
  assert.equal(await title.inputValue(), 'Stocky sigue cambiando');
  await saveEditor();
  await editStocky('Nombre automático restablecido');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: 'Nombre automático restablecido', exact: true, level: 1 }).waitFor();
  assert.equal(await title.inputValue(), 'Nombre automático restablecido');
  assert.equal((await publicRead()).product.title, 'Nombre automático restablecido');
  assert.equal((await commerce(`/products/${id}`)).titleSource, 'inventory');
  await page.getByLabel('Descripción · opcional', { exact: true }).fill('Borrador que se debe conservar');
  await editStocky('Cambio mientras hay borrador');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: 'Cambio mientras hay borrador', exact: true, level: 1 }).waitFor();
  assert.equal(await page.getByLabel('Descripción · opcional', { exact: true }).inputValue(), 'Borrador que se debe conservar');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: mobile editor refreshes live names, preserves custom titles and unsaved drafts, and can restore automatic Stocky names');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
