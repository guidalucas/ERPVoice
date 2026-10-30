import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture();
assert.equal(new URL(fixture.connection).hostname, '127.0.0.1');
assert.match(new URL(fixture.connection).pathname, /^\/fullmatch_fixture_[a-f0-9]+$/);
const sql = new Client({ connectionString: fixture.connection });
let browser;
const api = async (route, method = 'GET', body, status = 200, token = fixture.token) => {
  const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
};
const linkOf = sku => ({ skuId: sku.skuId, expectedRevision: sku.revision, expectedFingerprint: sku.identityFingerprint });
const inventory = id => sql.query('SELECT * FROM products WHERE owner_phone=$1 AND id=$2', [fixture.owner, id]).then(result => result.rows[0]);
try {
  await sql.connect();
  const emptyId = 'rubro-empty', firstId = 'rubro-first', secondId = 'rubro-second';
  for (const [id, name, type, model, size] of [[emptyId, 'PRUEBA rubro sin atributos', null, null, ''], [firstId, 'PRUEBA rubro remera', 'Remera', 'Básica', 'S'], [secondId, 'PRUEBA rubro remera', 'Remera', 'Básica', 'M']]) {
    await sql.query("INSERT INTO products(id,owner_phone,name,product_type,product_model,size,stock_available,stock_reserved,price,price_currency,inventory_unit) VALUES($1,$2,$3,$4,$5,$6,5,1,15000,'ARS','unit')", [id, fixture.owner, name, type, model, size]);
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ token, owner }) => { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); }, { token: fixture.token, owner: fixture.owner });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(60000);
  const pending = async name => {
    await page.goto(fixture.url); await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
    await page.getByRole('button', { name: /Pendientes/ }).click();
    const group = page.locator('.pending-product').filter({ hasText: name }); await group.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Crear ficha y vincular', exact: true }).click();
    await page.getByRole('region', { name: 'Atributos del rubro', exact: true }).waitFor();
  };
  await pending('PRUEBA rubro sin atributos');
  for (const label of ['Tipo de prenda', 'Modelo', 'Talle']) {
    const input = page.getByLabel(`${label} · opcional`, { exact: true });
    assert.equal(await input.inputValue(), ''); assert.equal(await input.getAttribute('required'), null); assert.equal(await input.isEnabled(), true);
  }
  assert.equal(await page.getByLabel('Tipo de equipo', { exact: true }).count(), 0);
  const untouched = await inventory(emptyId);
  await page.getByRole('button', { name: 'Crear ficha', exact: true }).click(); await page.waitForURL(/#\/products\/[a-f0-9-]{36}$/);
  const emptyProductId = new URL(page.url()).hash.split('/').at(-1);
  assert.deepEqual(await inventory(emptyId), untouched);
  console.log('PASS: indumentaria shows its configured optional labels before creation; all three can be left blank without changing the SKU');

  await page.getByLabel('Tipo de prenda · opcional', { exact: true }).fill('Jean');
  await page.getByLabel('Modelo · opcional', { exact: true }).fill('Recto');
  await page.getByLabel('Talle · opcional', { exact: true }).fill('42');
  await page.reload();
  await page.getByText('Recuperé tu borrador de este navegador. Revisalo antes de guardar.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Modelo · opcional', { exact: true }).inputValue(), 'Recto');
  const output = path.resolve('.fullmatch-runtime/rubro-attributes'); await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click(); await page.getByText('Ficha guardada.', { exact: true }).waitFor();
  const updated = await inventory(emptyId);
  assert.equal(updated.product_type, 'Jean'); assert.equal(updated.product_model, 'Recto'); assert.equal(updated.size, '42');
  for (const key of ['stock_available', 'stock_reserved', 'price', 'price_currency', 'name', 'attributes_json', 'family_id', 'family_version']) assert.deepEqual(updated[key], untouched[key]);
  let product = await api(`/products/${emptyProductId}`);
  assert.equal(product.variants[0].productModel, 'Recto'); assert.equal(product.variants[0].identityReviewed, true); assert.equal(product.readiness.canPrepare, true);
  await page.reload(); await page.getByRole('button', { name: 'Guardar cambios', exact: true }).waitFor(); assert.equal(await page.getByLabel('Talle · opcional', { exact: true }).inputValue(), '42');
  console.log('PASS: optional metadata survives browser draft recovery, saves atomically to Stocky, refreshes its link fingerprint and preserves stock, price and other attributes');

  await page.setViewportSize({ width: 1440, height: 1000 }); await pending('PRUEBA rubro remera');
  const groups = page.getByRole('region', { name: 'Atributos del rubro', exact: true }).getByRole('group');
  assert.equal(await groups.count(), 2);
  for (let index = 0; index < 2; index++) {
    assert.equal(await groups.nth(index).getByLabel('Tipo de prenda · opcional', { exact: true }).inputValue(), 'Remera');
    await groups.nth(index).getByLabel('Modelo · opcional', { exact: true }).fill('Lisa');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  const creationRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/commerce/v1/products');
  await page.getByRole('button', { name: 'Crear ficha', exact: true }).click(); const creation = (await creationRequest).postDataJSON();
  await page.waitForURL(/#\/products\/[a-f0-9-]{36}$/); const multiId = new URL(page.url()).hash.split('/').at(-1);
  product = await api(`/products/${multiId}`); assert.equal(product.variants.length, 2); assert.ok(product.variants.every(variant => variant.productModel === 'Lisa' && variant.identityReviewed));
  assert.equal((await api('/products', 'POST', creation, 201)).result.id, multiId);
  const originalRow = await inventory(firstId);
  console.log('PASS: multiple linked sizes keep separate fields and use the configured labels; create with metadata and retry produce one product');

  const variant = product.variants.find(item => item.skuId === firstId);
  const update = { operationId: randomUUID(), expectedRevision: product.revision, changes: { title: 'No debe guardarse' }, skuMetadataChanges: [{ ...linkOf(variant), expectedRevision: 0, changes: { productModel: 'Obsoleto' } }] };
  await api(`/products/${multiId}`, 'PATCH', update, 409); assert.deepEqual(await inventory(firstId), originalRow); assert.equal((await api(`/products/${multiId}`)).title, product.title);
  await api(`/products/${multiId}`, 'PATCH', { ...update, operationId: randomUUID(), skuMetadataChanges: [{ ...linkOf(variant), skuId: emptyId, changes: { productModel: 'Fuera de ficha' } }] }, 400);
  // The final link conflicts after metadata was applied: the entire transaction must roll back.
  const duplicate = { operationId: randomUUID(), product: { title: 'Conflicto de vínculo' }, skuLinks: [linkOf(variant)], skuMetadataChanges: [{ ...linkOf(variant), changes: { productModel: 'Debe revertirse' } }] };
  await api('/products', 'POST', duplicate, 409); assert.deepEqual(await inventory(firstId), originalRow);
  assert.equal((await sql.query('SELECT COUNT(*)::int AS count FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [fixture.owner, `commerce-metadata:${duplicate.operationId}`])).rows[0].count, 0);
  await api(`/products/${multiId}`, 'PATCH', { operationId: randomUUID(), expectedRevision: product.revision, changes: {}, skuMetadataChanges: [{ ...linkOf(variant), changes: { productModel: 'Prohibido' } }] }, 403, fixture.member.token);
  for (const [category, typeLabel, modelLabel, variantLabel] of [
    ['indumentaria', 'Tipo de prenda', 'Modelo', 'Talle'],
    ['calzado', 'Tipo de calzado', 'Modelo', 'Número'],
    ['ferreteria', 'Rubro', 'Modelo / Marca', 'Medida'],
    ['electronica', 'Categoría', 'Modelo', 'Variante'],
    ['kiosco', 'Categoría', 'Marca', null],
    ['general', 'Categoría', 'Modelo', null],
  ]) {
    await sql.query('UPDATE auth_users SET business_category=$2 WHERE phone_number=$1', [fixture.owner, category]);
    await page.reload(); await page.getByRole('button', { name: 'Guardar cambios', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.sku-metadata-item').length === 2);
    const section = page.getByRole('region', { name: 'Atributos del rubro', exact: true });
    for (const label of [typeLabel, modelLabel, ...(variantLabel ? [variantLabel] : [])]) {
      const inputs = section.getByLabel(`${label} · opcional`, { exact: true }); assert.equal(await inputs.count(), 2, `${category}: ${label}`);
      for (const input of await inputs.all()) assert.equal(await input.getAttribute('required'), null);
    }
    assert.equal(await section.locator('input').count(), variantLabel ? 6 : 4);
  }
  assert.deepEqual(await inventory(firstId), originalRow);
  assert.deepEqual(errors, []);
  console.log('PASS: stale revisions, another product, another actor and final-link conflicts cannot leak partial metadata or commercial writes');
  console.log('PASS: all six business categories use their configured labels; non-variant categories have no size field; every attribute remains optional');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
