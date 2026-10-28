import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { createCatalogService } from '../server/commerce/catalogService.js';

const fixture = await startCommerceFixture();
const runtime = createDatabaseRuntime({ connectionString: fixture.connection });
let browser;
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${path}`, { method,
    headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value)); return value;
};
try {
  const candidates = await api('/inventory-candidates?limit=100');
  const sku = candidates.items.find(item => item.name.includes('Boca'));
  assert.ok(sku);
  const inventoryBefore = await runtime.withClient(async client => (await client.query('SELECT * FROM products ORDER BY id')).rows);
  let product = (await api('/products', 'POST', { operationId: randomUUID(), product: { title: 'Producto sin foto' },
    skuLinks: [{ skuId: sku.skuId, expectedRevision: sku.revision, expectedFingerprint: sku.identityFingerprint }] })).result;
  assert.equal(product.status, 'draft');
  assert.equal(product.description, ''); assert.equal(product.images.length, 0);
  assert.equal(product.readiness.canPrepare, true);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  }, { token: fixture.token, owner: fixture.owner });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${fixture.url}#/products/${product.id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const publish = page.getByRole('button', { name: 'Publicar en catálogo', exact: true });
  await publish.waitFor(); await publish.click();
  await page.getByRole('button', { name: 'Ocultar del catálogo', exact: true }).waitFor();
  product = await api(`/products/${product.id}`);
  assert.equal(product.status, 'ready');
  assert.equal(product.images.length, 0);
  const publicPath = `${fixture.apiUrl}/api/catalog/v1/fullmatch-demo/products/${product.slug}`;
  let response = await fetch(publicPath);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).product.photos, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS: publish a draft directly from mobile Studio with only a name and inventory variant');

  // Publication also works if no photograph storage has been configured.
  let publication = await api(`/products/${product.id}/publication`);
  publication = (await api(`/products/${product.id}/publication`, 'PUT', { operationId: randomUUID(), expectedRevision: publication.revision,
    expectedProductRevision: product.revision, status: 'hidden', reason: 'Temporary fixture' })).result;
  product = (await api(`/products/${product.id}/status`, 'POST', { operationId: randomUUID(), expectedRevision: product.revision, status: 'draft', reason: 'Temporary fixture' })).result;
  const catalog = createCatalogService(runtime, { configured: false });
  const command = { operationId: randomUUID(), expectedRevision: publication.revision, expectedProductRevision: product.revision, status: 'published', reason: 'Temporary fixture without storage' };
  const owner = { businessId: fixture.owner, actorId: fixture.owner, role: 'owner' };
  await catalog.publish(owner, product.id, command);
  product = await api(`/products/${product.id}`);
  const revision = product.revision;
  await catalog.publish(owner, product.id, command);
  assert.equal((await api(`/products/${product.id}`)).revision, revision);
  assert.equal((await fetch(publicPath)).status, 200);
  console.log('PASS: publication needs no media storage and retries preserve the product revision');

  await page.reload();
  await page.getByRole('button', { name: '03 Fotografías', exact: true }).click();
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#267850' } }).png().toBuffer();
  await page.getByLabel('Subir fotografía', { exact: true }).setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
  await page.getByText('Foto procesada y guardada.', { exact: true }).waitFor();
  response = await fetch(publicPath);
  assert.equal(response.status, 200); assert.equal((await response.json()).product.photos.length, 1);
  const inventoryAfter = await runtime.withClient(async client => (await client.query('SELECT * FROM products ORDER BY id')).rows);
  assert.deepEqual(inventoryAfter, inventoryBefore);
  assert.deepEqual(errors, []);
  console.log('PASS: add a photo later while the product stays public and inventory remains unchanged');
} finally {
  await browser?.close(); await runtime.close(); await fixture.stop();
}
