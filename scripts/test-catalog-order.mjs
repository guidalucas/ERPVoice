import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { Client } from 'pg';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const output = path.resolve('.fullmatch-runtime/catalog-order');
await fs.mkdir(output, { recursive: true });
const fixture = await startCommerceFixture();
let browser, sql;
try {
  sql = new Client({ connectionString: fixture.connection }); await sql.connect();
  const product = fixture.products.find(product => product.title.startsWith('Barcelona'));
  const api = async (route, method = 'GET', body, type = 'application/json') => {
    const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${route}`, { method, headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': type }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const detail = await api(`/products/${product.id}`);
  const bytes = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#87b5cd' } }).png().toBuffer();
  const upload = await api(`/products/${product.id}/images`, 'POST', { operationId: randomUUID(), expectedRevision: detail.revision, sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceSizeBytes: bytes.length, altText: 'Segunda foto de prueba' });
  await api(`/products/${product.id}/images/${upload.result.imageId}/content`, 'PUT', bytes, 'image/png');
  const listing = await (await fetch(`${fixture.apiUrl}/api/catalog/v1/fullmatch-demo/products`)).json();
  const published = listing.items.find(item => item.title === product.title);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const assertPhoto = async (index, surface = '.main-photo') => {
    await page.waitForFunction(({ surface, index }) => { const img = document.querySelector(`${surface} img`); return img?.complete && img.naturalWidth > 0 && document.querySelector('[data-gallery-status]').textContent === `Foto ${index} de 2`; }, { surface, index });
    assert.equal(new URL(await page.locator(`${surface} img`).getAttribute('src'), fixture.apiUrl).pathname, published.photos[index - 1].url);
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(fixture.apiUrl + published.path);
    await assertPhoto(1);
    await page.locator('.main-photo').getByRole('button', { name: 'Fotografía siguiente' }).click(); await assertPhoto(2);
    await page.locator('.main-photo').getByRole('button', { name: 'Fotografía siguiente' }).click(); await assertPhoto(1);
    await page.locator('.main-photo').getByRole('button', { name: 'Fotografía anterior' }).click(); await assertPhoto(2);
    await page.getByRole('link', { name: 'Ampliar fotografía' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Fotografía siguiente' }).click(); await assertPhoto(1, '.photo-dialog');
    await page.keyboard.press('ArrowLeft'); await assertPhoto(2, '.photo-dialog');
    await page.screenshot({ path: path.join(output, `zoom-${width}.png`), fullPage: true });
    await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), false);
    assert.equal(new URL(await page.locator('[data-gallery-zoom]').getAttribute('href'), fixture.apiUrl).pathname, published.photos[1].url);
    await page.getByRole('link', { name: 'Ver fotografía 1', exact: true }).click(); await assertPhoto(1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `product-${width}.png`), fullPage: true });
  }
  console.log('PASS gallery: previous/next, wraparound, thumbnails, zoom and keyboard on desktop/mobile');
  await page.getByRole('combobox', { name: 'Talle para tu pedido' }).selectOption('M');
  assert.equal(await page.locator('option[value=""]').textContent(), 'Elegir talle');
  const direct = new URL(await page.getByRole('link', { name: 'Pedir por WhatsApp ↗' }).getAttribute('href'));
  assert.match(direct.searchParams.get('text'), /Talle: M\. Cantidad: 1/);
  await page.getByRole('button', { name: 'Agregar a mi pedido ＋' }).click();
  await page.getByRole('link', { name: /^Mi pedido/ }).click();
  assert.equal(new URL(page.url()).pathname, '/c/fullmatch-demo/pedido');
  await page.waitForFunction(() => document.getElementById('inquiry-contact')?.disabled === false);
  await page.waitForFunction(() => document.querySelector('.inquiry-line-photo img')?.naturalWidth > 0);
  assert.equal(await page.locator('.inquiry-line-photo img').getAttribute('src'), published.photos[0].thumbnailUrl);
  assert.match(await page.locator('.inquiry-line-detail').textContent(), /Talle M/);
  for (const width of [1440, 375, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `order-${width}.png`), fullPage: true });
  }
  await page.reload(); await page.waitForFunction(() => document.getElementById('inquiry-contact')?.disabled === false);
  assert.equal(await page.locator('.inquiry-line').count(), 1);
  assert.equal(await page.locator('[data-cart-count]').textContent(), '1');
  // Existing saved carts and links continue to work after the visible terminology change.
  await page.goto(`${fixture.apiUrl}/c/fullmatch-demo/consulta`);
  await page.getByRole('heading', { name: 'Mi pedido', exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('inquiry-contact')?.disabled === false);
  console.log('PASS order: cover thumbnail, size labels, persistence, legacy links and responsive layout');
  let destination;
  await page.route('https://wa.me/**', async route => { destination = new URL(route.request().url()); await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Pedido interceptado localmente</p>' }); });
  await sql.query('UPDATE products SET price=80000 WHERE owner_phone=$1 AND id=$2', [fixture.owner, product.skuIds[0]]);
  await page.getByRole('button', { name: 'Finalizar pedido ↗' }).click();
  await page.getByText('Cambiaron los datos de tu pedido.', { exact: false }).waitFor();
  assert.equal(destination, undefined); assert.equal(await page.locator('#inquiry-total').textContent(), 'ARS $ 80.000');
  await Promise.all([page.waitForURL('https://wa.me/**'), page.getByRole('button', { name: 'Finalizar pedido ↗' }).click()]);
  const text = destination.searchParams.get('text');
  assert.match(text, /quiero hacer este pedido/); assert.ok(text.includes(product.title)); assert.match(text, /1 ×/); assert.match(text, /Talle: M/); assert.match(text, /ARS \$ 80\.000/); assert.doesNotMatch(text, /consulta/i);
  await page.goto(`${fixture.apiUrl}/c/fullmatch-demo/pedido`);
  await page.waitForFunction(() => document.getElementById('inquiry-contact')?.disabled === false);
  await sql.query('UPDATE products SET stock_available=0 WHERE owner_phone=$1 AND id=$2', [fixture.owner, product.skuIds[0]]);
  await page.getByRole('button', { name: 'Actualizar precios y disponibilidad' }).click();
  await page.getByText('Revisá el talle o la cantidad disponible.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Finalizar pedido ↗' }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS WhatsApp: prefilled order, current prices, change confirmation and stock validation (no external message sent)');
} finally {
  if (browser) await browser.close();
  if (sql) await sql.end();
  await fixture.stop();
}
