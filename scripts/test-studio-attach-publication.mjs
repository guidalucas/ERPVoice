import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

// All writes target an isolated, disposable local store.
const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
let browser;
const api = async (route, method = 'GET', body, status) => {
  const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${route}`, { method,
    headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (status) assert.equal(response.status, status, JSON.stringify(result)); else assert.ok(response.ok, JSON.stringify(result));
  return result;
};
const linkOf = item => ({ skuId: item.skuId, expectedRevision: item.revision, expectedFingerprint: item.identityFingerprint });
try {
  await sql.connect();
  for (const [id, name, size, currency] of [
    ['attach-s', 'Remera básica blanca', 'S', 'ARS'],
    ['attach-l', 'Remera algodón blanco modelo verano', 'L', 'ARS'],
    ['attach-duplicate', 'Otro nombre para talle S', 'S', 'ARS'],
    ['attach-unconfirmed', 'Remera sin moneda confirmada', 'XL', 'XXX'],
    ['attach-photo', 'Modelo adicional con otro nombre', 'XL', 'ARS'],
  ]) await sql.query(`INSERT INTO products(id,owner_phone,name,size,stock_available,price,price_currency)
    VALUES($1,$2,$3,$4,2,65000,$5)`, [id, fixture.owner, name, size, currency]);
  const inventoryBefore = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  const candidates = (await api('/inventory-candidates?limit=100')).items;
  let product = (await api('/products', 'POST', { operationId: randomUUID(), product: { title: 'Remera blanca publicada', description: 'Descripción original de la publicación.' },
    skuLinks: [linkOf(candidates.find(item => item.skuId === 'attach-s'))] })).result;
  await api(`/products/${product.id}/publication`, 'PUT', { operationId: randomUUID(), expectedRevision: 0, expectedProductRevision: product.revision,
    status: 'published', reason: 'Isolated attachment test' });
  product = await api(`/products/${product.id}`);
  const draft = (await api('/products', 'POST', { operationId: randomUUID(), product: { title: 'Borrador de prueba' } })).result;
  const publicationBefore = await api(`/products/${product.id}/publication`);
  const countBefore = (await sql.query('SELECT count(*) FROM commercial_products')).rows[0].count;
  const publicProduct = async item => {
    const response = await fetch(`${fixture.apiUrl}/api/catalog/v1/fullmatch-demo/products/${item.slug}`);
    assert.equal(response.status, 200); return (await response.json()).product;
  };
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  }, fixture);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url); await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
  await page.getByRole('button', { name: /02.*Pendientes/ }).click();
  const group = page.locator('.pending-product').filter({ has: page.getByText('Remera algodón blanco modelo verano', { exact: true }) });
  await group.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Crear ficha y vincular', exact: true }).click();
  const attach = page.getByRole('button', { name: 'Adjuntar a un producto publicado', exact: true });
  await attach.click();
  await page.locator('.target-product').filter({ hasText: product.title }).waitFor();
  assert.equal(await page.locator('.target-product').filter({ hasText: draft.title }).count(), 0);
  await page.getByLabel('Publicación de destino').selectOption('');
  await page.getByRole('button', { name: 'Buscar ficha', exact: true }).click();
  await page.locator('.target-product').filter({ hasText: draft.title }).waitFor();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await page.getByLabel('Título comercial', { exact: true }).inputValue(), 'Remera algodón blanco modelo verano');
  await attach.click();
  await page.getByLabel('Buscar ficha existente').fill('blanca publicada');
  await page.getByRole('button', { name: 'Buscar ficha', exact: true }).click();
  const target = page.locator('.target-product').filter({ hasText: product.title });
  await target.waitFor();
  const output = path.resolve('.fullmatch-runtime/attach-publication'); await fs.mkdir(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `choose-${width}.png`), fullPage: true });
  }
  await target.click();
  await page.getByRole('heading', { name: 'SKU y presentaciones vinculadas' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.variant-row input:checked').length === 2 && !document.querySelector('.variant-list')?.closest('fieldset')?.disabled);
  assert.deepEqual((await api(`/products/${product.id}`)).variants.map(item => item.size), ['S'], 'Choosing a target must not write anything');
  const request = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith(`/products/${product.id}/sku-links`));
  await page.getByRole('button', { name: 'Guardar vínculos', exact: true }).click();
  const savedCommand = (await request).postDataJSON();
  await page.getByText('Vínculos guardados. El producto sigue preparado y conserva su publicación.', { exact: true }).waitFor();
  product = await api(`/products/${product.id}`);
  assert.deepEqual(product.variants.map(item => item.size), ['S', 'L']);
  assert.equal(product.status, 'ready'); assert.equal(product.description, 'Descripción original de la publicación.');
  assert.deepEqual(await api(`/products/${product.id}/publication`), publicationBefore);
  assert.deepEqual((await publicProduct(product)).sizes.map(item => item.size), ['S', 'L']);
  assert.equal((await sql.query('SELECT count(*) FROM commercial_products')).rows[0].count, countBefore);
  await api(`/products/${product.id}/sku-links`, 'PUT', savedCommand);
  assert.equal((await api(`/products/${product.id}`)).revision, product.revision, 'Retry must not apply twice');
  console.log('PASS UI: create L with a different name, cancel/search/select published S, review and save on mobile; same publication, no duplicate product');

  const links = product.variants.map(linkOf);
  for (const skuId of ['attach-duplicate', 'attach-unconfirmed']) {
    const failure = await api(`/products/${product.id}/sku-links`, 'PUT', { operationId: randomUUID(), expectedRevision: product.revision,
      skuLinks: [...links, linkOf(candidates.find(item => item.skuId === skuId))] }, 422);
    assert.equal(failure.error.code, 'PRODUCT_NOT_READY');
    const current = await api(`/products/${product.id}`);
    assert.equal(current.revision, product.revision); assert.deepEqual(current.variants, product.variants);
    await publicProduct(product);
  }
  await api(`/products/${product.id}/sku-links`, 'PUT', { operationId: randomUUID(), expectedRevision: product.revision - 1, skuLinks: links }, 409);
  const photoProduct = await api(`/products/${fixture.products[0].id}`);
  const photoSaved = (await api(`/products/${photoProduct.id}/sku-links`, 'PUT', { operationId: randomUUID(), expectedRevision: photoProduct.revision,
    skuLinks: [...photoProduct.variants.map(linkOf), linkOf(candidates.find(item => item.skuId === 'attach-photo'))] })).result;
  assert.equal(photoSaved.status, 'ready'); assert.equal(photoSaved.slug, photoProduct.slug);
  assert.equal(photoSaved.coverImageId, photoProduct.coverImageId); assert.deepEqual(photoSaved.images, photoProduct.images);
  assert.equal((await publicProduct(photoSaved)).photos.length, photoProduct.images.length);
  const draftLinked = (await api(`/products/${draft.id}/sku-links`, 'PUT', { operationId: randomUUID(), expectedRevision: draft.revision,
    skuLinks: [linkOf(candidates.find(item => item.skuId === 'attach-duplicate'))] })).result;
  assert.equal(draftLinked.status, 'draft');
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, inventoryBefore);
  assert.deepEqual(errors, []);
  console.log('PASS API: valid additions preserve public URL/photos/cover; duplicate sizes and unconfirmed money roll back; revision/idempotency checks; drafts stay draft; inventory unchanged');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
