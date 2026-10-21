import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
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
    await page.getByLabel('Equipo', { exact: true }).fill('Boca Juniors');
    await page.getByLabel('Identificador del equipo', { exact: true }).fill('boca-juniors');
    await page.getByLabel('Tipo de equipo', { exact: true }).selectOption('club');
    await page.getByLabel('Temporada', { exact: true }).fill('2025');
    await page.getByLabel('Equipación', { exact: true }).selectOption('home');
    await page.getByLabel('Versión', { exact: true }).selectOption('fan');
    await page.getByLabel('Manga', { exact: true }).selectOption('short');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await page.getByText('Ficha guardada.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '02 Talles vinculados', exact: true }).click();
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
  assert.deepEqual(errors, []);
  console.log(`Studio browser acceptance: ${checks} checks passed.`);
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { if (browser) await browser.close(); await fixture.stop(); }
