import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { Client } from 'pg';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const output = path.resolve('.fullmatch-runtime/browser'); await fs.mkdir(output, { recursive: true });
const fixture = await startCommerceFixture(); let browser;
let checks = 0;
const check = async (label, callback) => { await callback(); checks++; console.log(`PASS Studio browser: ${label}`); };
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  await context.addInitScript(({ token, owner, origin }) => { if (location.origin === origin) { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); } }, { token: fixture.token, owner: fixture.owner, origin: new URL(fixture.url).origin });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) requests.push(url.pathname); });
  await page.goto(fixture.url); await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
  await check('real session, scoped list and loaded commercial photos', async () => {
    await page.getByRole('heading', { name: 'Barcelona titular 2025', exact: true }).waitFor();
    await page.locator('.card-photo img').first().waitFor();
    assert.equal(await page.locator('.product-card').count(), 3);
    assert.ok(!requests.includes('/api/state'));
    await page.screenshot({ path: path.join(output, 'studio-desktop.png'), fullPage: true });
  });
  await check('existing product exports a real 1080 by 1920 PNG and JPG', async () => {
    await page.getByRole('heading', { name: 'Barcelona titular 2025', exact: true }).click();
    await page.getByRole('button', { name: 'Generar historia ↗' }).click();
    await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
    const download = page.getByRole('button', { name: 'Descargar PNG ↓' }); await download.waitFor(); await page.waitForFunction(() => !document.querySelector('.export-actions button')?.hasAttribute('disabled'));
    await page.screenshot({ path: path.join(output, 'story-desktop.png'), fullPage: true });
    const pending = page.waitForEvent('download'); await download.click(); const file = await pending;
    const image = await fs.readFile(await file.path()); const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920); assert.equal(metadata.format, 'png');
    await file.saveAs(path.join(output, 'story-export.png'));
    await page.getByLabel('Formato de descarga').selectOption('jpeg'); await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.export-actions button')?.hasAttribute('disabled'));
    const jpgPending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar JPG ↓' }).click();
    const jpg = await jpgPending; const jpgMetadata = await sharp(await fs.readFile(await jpg.path())).metadata();
    assert.equal(jpgMetadata.format, 'jpeg'); assert.equal(jpgMetadata.width, 1080); assert.equal(jpgMetadata.height, 1920);
  });
  await check('responsive mobile list, editor and story have no horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'story-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '← Volver a la ficha' }).click();
    await page.getByRole('button', { name: '← Volver a productos' }).click();
    await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.card-photo img').length === 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'studio-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: /02.*Pendientes|Pendientes/ }).click();
    await page.getByRole('heading', { name: 'Pendientes de catalogar' }).waitFor();
    assert.ok((await page.locator('.variant-row').first().textContent()).includes('Boca'));
  });
  await check('lost creation response recovers its immutable receipt without a second product', async () => {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.getByRole('button', { name: /Productos/ }).first().click();
    await page.getByRole('button', { name: '＋ Nueva ficha comercial' }).click();
    await page.getByLabel('Título comercial', { exact: true }).fill('Ficha recuperada navegador');
    let intercepted = false;
    await page.route('**/api/commerce/v1/products', async route => {
      if (!intercepted && route.request().method() === 'POST') { intercepted = true; const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Crear ficha', exact: true }).click();
    await page.getByText('No pude confirmar la operación.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Recuperar intentos', exact: true }).click();
    assert.equal(await page.locator('.recovery-row').count(), 1);
    await page.getByRole('button', { name: 'Consultar recibo', exact: true }).click();
    await page.getByText('No hay intentos comerciales pendientes en este navegador.').waitFor();
    await page.getByRole('button', { name: /Productos/ }).first().click();
    await page.getByRole('heading', { name: 'Ficha recuperada navegador', exact: true }).waitFor();
    assert.equal(await page.locator('.product-card').count(), 4); assert.equal(intercepted, true);
  });
  await check('complete new product flow links a pending SKU, uploads a photo and exports without retyping prices', async () => {
    await page.getByRole('heading', { name: 'Ficha recuperada navegador', exact: true }).click();
    await page.getByLabel('Título comercial', { exact: true }).fill('Boca Juniors titular 2025');
    await page.locator('.specific-fields > summary').click();
    await page.getByLabel('Equipo', { exact: true }).fill('Boca Juniors');
    await page.getByLabel('Identificador del equipo', { exact: true }).fill('boca-juniors');
    await page.getByLabel('Tipo de equipo', { exact: true }).selectOption('club');
    await page.getByLabel('Temporada', { exact: true }).fill('2025');
    await page.getByLabel('Equipación', { exact: true }).selectOption('home');
    await page.getByLabel('Versión', { exact: true }).selectOption('fan');
    await page.getByLabel('Manga', { exact: true }).selectOption('short');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await page.getByText('Ficha guardada.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '02 SKU vinculados', exact: true }).click();
    await page.locator('.variant-row').filter({ hasText: 'Boca Juniors' }).locator('input').check();
    await page.getByRole('button', { name: 'Guardar vínculos', exact: true }).click();
    await page.getByText('Vínculos revisados y guardados.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '03 Fotografías', exact: true }).click();
    const photo = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#133d8c' } }).png().toBuffer();
    await page.getByLabel('Subir fotografía', { exact: true }).setInputFiles({ name: 'fixture-boca.png', mimeType: 'image/png', buffer: photo });
    await page.getByText('Foto procesada y guardada.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Preparar ficha', exact: true }).click();
    await page.getByText('Ficha preparada para generar contenido.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Generar historia ↗' }).click();
    await page.getByLabel('Plantilla', { exact: true }).selectOption('arrival');
    await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.export-actions button')?.hasAttribute('disabled'));
    const downloadPending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar PNG ↓' }).click();
    const exported = await downloadPending, metadata = await sharp(await fs.readFile(await exported.path())).metadata();
    assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920);
    assert.ok(!requests.includes('/api/state'));
  });
  const publicContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } }), publicPage = await publicContext.newPage();
  const publicRequests = []; publicPage.on('request', request => publicRequests.push(new URL(request.url()).pathname));
  publicPage.on('pageerror', error => errors.push(error.message));
  const shopUrl = `${fixture.apiUrl}/c/fullmatch-demo`;
  let productUrl, productPhoto;
  await check('anonymous SSR catalog has real photos, filters, stable product URLs and SEO', async () => {
    const response = await publicPage.goto(shopUrl); assert.equal(response.status(), 200);
    await publicPage.getByRole('heading', { name: 'La colección', exact: true }).waitFor();
    assert.equal(await publicPage.locator('.catalog-card').count(), 3);
    await publicPage.waitForFunction(() => [...document.querySelectorAll('.catalog-card-photo img')].every(image => image.complete && image.naturalWidth > 0));
    await publicPage.screenshot({ path: path.join(output, 'catalog-desktop.png'), fullPage: true });
    await publicPage.getByRole('searchbox', { name: 'Buscar productos', exact: true }).fill('Argentina');
    await Promise.all([publicPage.waitForURL(/q=Argentina/), publicPage.getByRole('button', { name: 'Buscar', exact: true }).click()]);
    assert.equal(await publicPage.locator('.catalog-card').count(), 1);
    await publicPage.getByRole('heading', { name: 'Argentina titular 2025', exact: true }).click();
    await publicPage.getByRole('heading', { name: 'Argentina titular 2025', exact: true, level: 1 }).waitFor();
    productUrl = publicPage.url(); productPhoto = await publicPage.locator('.main-photo img').getAttribute('src');
    assert.ok(productUrl.includes('/c/fullmatch-demo/p/argentina-'));
    assert.equal(await publicPage.locator('link[rel=canonical]').getAttribute('href'), productUrl);
    const schema = JSON.parse(await publicPage.locator('script[type="application/ld+json"]').textContent());
    assert.equal(schema['@type'], 'Product'); assert.equal(schema.offers.price, '70000.00'); assert.equal(schema.offers.priceCurrency, 'ARS');
    assert.ok((await publicPage.getByRole('link', { name: 'Consultar por WhatsApp ↗', exact: true }).getAttribute('href')).startsWith('https://wa.me/'));
    await publicPage.waitForFunction(() => document.querySelector('.main-photo img').naturalWidth > 0);
    await publicPage.screenshot({ path: path.join(output, 'catalog-product-desktop.png'), fullPage: true });
    assert.ok(!publicRequests.includes('/api/state')); assert.ok(!publicRequests.some(route => route.startsWith('/api/auth/')));
  });
  await check('anonymous mobile product and catalog remain usable without horizontal overflow', async () => {
    await publicPage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await publicPage.screenshot({ path: path.join(output, 'catalog-product-mobile.png'), fullPage: true });
    await publicPage.goto(shopUrl); await publicPage.waitForFunction(() => [...document.querySelectorAll('.catalog-card-photo img')].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await publicPage.screenshot({ path: path.join(output, 'catalog-mobile.png'), fullPage: true });
  });
  await check('Studio publication controls immediately revoke anonymous product HTML and photo URLs', async () => {
    const argentina = fixture.products.find(product => product.title.startsWith('Argentina'));
    await page.goto(`${fixture.url}#/products/${argentina.id}`);
    await page.getByRole('button', { name: 'Ocultar del catálogo', exact: true }).click();
    await page.getByText('Oculta para clientes', { exact: true }).waitFor();
    assert.equal((await publicPage.goto(productUrl)).status(), 404);
    assert.equal((await publicContext.request.get(`${fixture.apiUrl}${productPhoto}`)).status(), 404);
    await page.getByRole('button', { name: 'Publicar en catálogo', exact: true }).click();
    await page.getByRole('button', { name: 'Ocultar del catálogo', exact: true }).waitFor();
    assert.equal((await publicPage.goto(productUrl)).status(), 200);
  });
  await check('catalog master switch is explicit and leaves per-product publications independent', async () => {
    await page.getByRole('button', { name: /Configuración/ }).first().click();
    const toggle = page.getByRole('checkbox', { name: 'Habilitar acceso público al catálogo', exact: true });
    await page.waitForFunction(() => { const input = document.querySelector('.catalog-settings input[type=checkbox]'); return input && !input.disabled && input.checked; });
    await toggle.uncheck();
    const disabledResponse = page.waitForResponse(response => response.url().endsWith('/api/commerce/v1/catalog') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Guardar catálogo', exact: true }).click();
    const disabled = await disabledResponse; assert.equal((await disabled.json()).result.publicEnabled, false);
    await page.getByText('Configuración del catálogo guardada.', { exact: true }).waitFor();
    assert.equal((await publicPage.goto(shopUrl)).status(), 404);
    await toggle.check();
    const enabledResponse = page.waitForResponse(response => response.url().endsWith('/api/commerce/v1/catalog') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Guardar catálogo', exact: true }).click();
    const enabled = await enabledResponse; assert.equal((await enabled.json()).result.publicEnabled, true);
    await page.getByText('Configuración del catálogo guardada.', { exact: true }).waitFor();
    assert.equal((await publicPage.goto(productUrl)).status(), 200);
  });
  await check('promotional story exports exact derived money without changing the source price', async () => {
    await page.getByRole('button', { name: /Productos/ }).first().click();
    await page.getByRole('heading', { name: 'Argentina titular 2025', exact: true }).click();
    await page.getByRole('button', { name: 'Generar historia ↗' }).click();
    await page.getByLabel('Plantilla', { exact: true }).selectOption('promo');
    await page.getByLabel('Descuento promocional (%)', { exact: true }).fill('15');
    const prepareResponse = page.waitForResponse(response => /\/products\/[^/]+\/story-snapshots$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
    const snapshot = (await (await prepareResponse).json()).result;
    assert.equal(snapshot.content.price.minAmountMinor, '7000000'); assert.equal(snapshot.content.promotion.minAmountMinor, '5950000');
    await page.waitForFunction(() => !document.querySelector('.export-actions button')?.hasAttribute('disabled'));
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar PNG ↓' }).click(); const exported = await pending;
    await exported.saveAs(path.join(output, 'promotion-story.png')); assert.equal((await sharp(await fs.readFile(await exported.path())).metadata()).width, 1080);
    const publicData = await publicContext.request.get(`${fixture.apiUrl}/api/catalog/v1/fullmatch-demo/products`);
    const argentina = (await publicData.json()).items.find(product => product.teamKey === 'argentina'); assert.equal(argentina.priceRange.minAmountMinor, '7000000');
  });
  await check('content library distinguishes prepared snapshots from requested downloads', async () => {
    await page.getByRole('button', { name: /Biblioteca/ }).first().click();
    await page.getByRole('heading', { name: 'Biblioteca de historias', exact: true }).waitFor();
    await page.locator('.library-card').first().waitFor();
    assert.ok(await page.locator('.library-card').count() >= 4);
    assert.ok(await page.getByText('Descarga solicitada', { exact: true }).count() > 0);
    assert.ok(!(await page.locator('.library-card').allTextContents()).some(text => text.includes('Publicado en Instagram')));
    await page.screenshot({ path: path.join(output, 'library-desktop.png'), fullPage: true });
  });
  let batchBefore;
  const batchValue = () => page.evaluate(() => { const key = Object.keys(localStorage).find(key => key.startsWith('fullmatch.batch.')); return JSON.parse(localStorage.getItem(key)); });
  await check('batch uses one canvas, resumes exact snapshot IDs and exports a valid ZIP of real JPGs', async () => {
    await page.getByRole('button', { name: /Productos/ }).first().click();
    await page.getByRole('checkbox', { name: 'Seleccionar Argentina titular 2025', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Seleccionar Barcelona titular 2025', exact: true }).check();
    await page.getByRole('button', { name: 'Generar historias por lote (2) ↗', exact: true }).click();
    await page.getByRole('heading', { name: 'Historias por lote', exact: true }).waitFor();
    assert.equal(await page.locator('.batch-render-canvas').count(), 1);
    await page.getByRole('button', { name: 'Generar lote', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.batch-download button')?.hasAttribute('disabled'));
    batchBefore = await batchValue(); assert.ok(batchBefore.items.every(item => item.status === 'generated' && item.snapshotId));
    await page.reload(); await page.getByRole('heading', { name: 'Historias por lote', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reconstruir y validar lote', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.batch-download button')?.hasAttribute('disabled'));
    const resumed = await batchValue(); assert.deepEqual(resumed.items.map(item => item.snapshotId), batchBefore.items.map(item => item.snapshotId));
    assert.deepEqual(resumed.items.map(item => item.operationId), batchBefore.items.map(item => item.operationId));
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar lote ZIP ↓', exact: true }).click(); const downloaded = await pending;
    await downloaded.saveAs(path.join(output, 'batch-export.zip'));
    const files = unzipSync(new Uint8Array(await fs.readFile(await downloaded.path()))); assert.equal(Object.keys(files).length, 2);
    for (const [name, bytes] of Object.entries(files)) { assert.ok(name.endsWith('.jpg')); const metadata = await sharp(bytes).metadata(); assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920); }
    await page.screenshot({ path: path.join(output, 'batch-desktop.png'), fullPage: true });
  });
  await check('changed inventory after generation blocks the whole ZIP before download', async () => {
    const sql = new Client({ connectionString: fixture.connection }); await sql.connect();
    const argentina = fixture.products.find(product => product.title.startsWith('Argentina')), skuId = argentina.skuIds[0]; let downloads = 0;
    const listener = () => downloads++; page.on('download', listener);
    try {
      await sql.query('UPDATE products SET stock_available=0 WHERE owner_phone=$1 AND id=$2', [fixture.owner, skuId]);
      await page.getByRole('button', { name: 'Descargar lote ZIP ↓', exact: true }).click();
      await page.getByText('Cambiaron los datos o venció la historia.', { exact: false }).waitFor();
      assert.equal(downloads, 0); assert.equal(await page.getByRole('button', { name: 'Descargar lote ZIP ↓', exact: true }).isEnabled(), false);
    } finally { page.off('download', listener); await sql.query('UPDATE products SET stock_available=1 WHERE owner_phone=$1 AND id=$2', [fixture.owner, skuId]); await sql.end(); }
  });
  await check('batch progress and library remain usable on mobile without horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'batch-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: /Biblioteca/ }).first().click();
    await page.locator('.library-card').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Retomar lote guardado ↗', exact: true }).click();
    await page.getByRole('heading', { name: 'Historias por lote', exact: true }).waitFor();
    assert.equal((await batchValue()).batchId, batchBefore.batchId);
  });
  const inquiryUrl = `${shopUrl}/consulta`;
  await check('anonymous inquiry cart persists a selected size and gets exact current totals on reload', async () => {
    await publicPage.setViewportSize({ width: 1440, height: 1050 }); await publicPage.goto(productUrl);
    await publicPage.getByRole('combobox', { name: 'Talle para tu consulta', exact: true }).selectOption('M');
    await publicPage.getByRole('button', { name: 'Agregar a mi consulta ＋', exact: true }).click();
    await publicPage.getByText('Agregada a tu consulta.', { exact: false }).waitFor();
    await publicPage.getByRole('link', { name: /^Mi consulta/ }).click();
    await publicPage.getByRole('heading', { name: 'Mi consulta', exact: true }).waitFor();
    await publicPage.waitForFunction(() => document.getElementById('inquiry-total')?.textContent === 'ARS $ 70.000');
    assert.equal(await publicPage.locator('.inquiry-line').count(), 1); assert.equal(await publicPage.locator('[data-cart-count]').textContent(), '1');
    await publicPage.reload(); await publicPage.waitForFunction(() => document.getElementById('inquiry-total')?.textContent === 'ARS $ 70.000');
    assert.equal(await publicPage.locator('.inquiry-line').count(), 1);
    await publicPage.screenshot({ path: path.join(output, 'inquiry-desktop.png'), fullPage: true });
  });
  await check('changed inquiry price requires review before locally intercepted WhatsApp handoff', async () => {
    const sql = new Client({ connectionString: fixture.connection }); await sql.connect();
    const argentina = fixture.products.find(product => product.title.startsWith('Argentina')), skuId = argentina.skuIds[0]; let destination = null;
    await publicPage.route('https://wa.me/**', async route => { destination = route.request().url(); await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Consulta interceptada localmente</title><p>No se contactó un destino externo.</p>' }); });
    try {
      await sql.query('UPDATE products SET price=80000 WHERE owner_phone=$1 AND id=$2', [fixture.owner, skuId]);
      await publicPage.getByRole('button', { name: 'Consultar por WhatsApp ↗', exact: true }).click();
      await publicPage.getByText('Cambiaron los datos de tu consulta.', { exact: false }).waitFor();
      assert.equal(publicPage.url(), inquiryUrl); assert.equal(destination, null); assert.equal(await publicPage.locator('#inquiry-total').textContent(), 'ARS $ 80.000');
      await Promise.all([publicPage.waitForURL('https://wa.me/**'), publicPage.getByRole('button', { name: 'Consultar por WhatsApp ↗', exact: true }).click()]);
      assert.ok(destination); assert.ok(decodeURIComponent(destination).includes('ARS $ 80.000')); assert.ok(decodeURIComponent(destination).includes('no reserva stock'));
    } finally { await sql.query('UPDATE products SET price=70000 WHERE owner_phone=$1 AND id=$2', [fixture.owner, skuId]); await sql.end(); }
  });
  await check('unavailable inquiry lines block contact and stay local, responsive and isolated by catalog', async () => {
    const sql = new Client({ connectionString: fixture.connection }); await sql.connect();
    const argentina = fixture.products.find(product => product.title.startsWith('Argentina')), skuId = argentina.skuIds[0];
    try {
      await publicPage.goto(inquiryUrl); await publicPage.waitForFunction(() => document.getElementById('inquiry-total')?.textContent === 'ARS $ 70.000');
      await publicPage.evaluate(() => localStorage.setItem('fullmatch.inquiry.other-demo', JSON.stringify([{ productSlug: 'other-product', size: 'XL', quantity: 7 }])));
      await sql.query('UPDATE products SET stock_available=0 WHERE owner_phone=$1 AND id=$2', [fixture.owner, skuId]);
      await publicPage.getByRole('button', { name: 'Actualizar precios y disponibilidad', exact: true }).click();
      await publicPage.getByText('Revisá la presentación o la cantidad disponible.', { exact: true }).waitFor();
      assert.equal(await publicPage.getByRole('button', { name: 'Consultar por WhatsApp ↗', exact: true }).isEnabled(), false);
      assert.equal(await publicPage.locator('[data-cart-count]').textContent(), '1');
      await publicPage.setViewportSize({ width: 390, height: 844 });
      assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await publicPage.screenshot({ path: path.join(output, 'inquiry-mobile.png'), fullPage: true });
      await publicPage.getByRole('button', { name: 'Retirar', exact: true }).click();
      await publicPage.getByRole('heading', { name: 'Tu consulta está esperando un producto.', exact: true }).waitFor();
      assert.equal(await publicPage.locator('[data-cart-count]').textContent(), '0');
      assert.equal(await publicPage.evaluate(() => JSON.parse(localStorage.getItem('fullmatch.inquiry.other-demo'))[0].quantity), 7);
    } finally { await sql.query('UPDATE products SET stock_available=1 WHERE owner_phone=$1 AND id=$2', [fixture.owner, skuId]); await sql.end(); }
  });
  assert.deepEqual(errors, []);
  console.log(`Studio browser acceptance: ${checks} checks passed.`);
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { if (browser) await browser.close(); await fixture.stop(); }
