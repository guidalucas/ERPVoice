import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { Client } from 'pg';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { migrateAppearance } from '../server/commerce/appearanceMigration.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const output = path.resolve('.fullmatch-runtime/branding'); await fs.mkdir(output, { recursive: true });
let browser;
const prefix = '/api/commerce/v1';
const api = async (user, route, method = 'GET', body, expected = 200, type = 'application/json') => {
  const response = await fetch(fixture.apiUrl + route, { method, headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': type },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
};
try {
  await sql.connect(); assert.equal((await migrateAppearance(sql)).changed, false);
  const logo = await sharp({ create: { width: 120, height: 120, channels: 4, background: '#12ab34' } }).png().toBuffer();
  const cover = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: '#456789' } }).jpeg().toBuffer();
  const logoAsset = await api(fixture, prefix + '/brand-assets/logo', 'POST', logo, 201, 'image/png');
  const coverAsset = await api(fixture, prefix + '/brand-assets/cover', 'POST', cover, 201, 'image/jpeg');
  await api(fixture.member, prefix + '/brand-assets/logo', 'POST', logo, 403, 'image/png');
  await api(fixture, prefix + '/brand-assets/logo', 'POST', Buffer.from('<svg/>'), 415, 'image/png');
  const other = fixture.freshOwners[0];
  await api(other, prefix + '/setup', 'POST', { operationId: randomUUID(), expectedProfileRevision: 0, expectedPolicyRevision: 0, brandName: 'Otro negocio',
    currency: 'UYU', confirmedMajorInteger: true, salesWhatsapp: null });
  await api(other, prefix + `/brand-assets/${logoAsset.id}`, 'GET', undefined, 404);
  const profile = await api(fixture, prefix + '/profile');
  const appearance = { ...profile.appearance, logoId: logoAsset.id, coverId: coverAsset.id, primaryColor: '#123456', accentColor: '#CC2277',
    tagline: 'Casacas del Sur', heroTitle: 'Una colección con historia', heroDescription: 'Ediciones elegidas para vos.', collectionTitle: 'Nuestras camisetas' };
  const input = { operationId: randomUUID(), expectedRevision: profile.revision, brandName: 'Casacas del Sur', salesWhatsapp: fixture.owner, appearance };
  const receipt = await api(fixture, prefix + '/profile', 'PUT', input);
  assert.deepEqual(await api(fixture, prefix + '/profile', 'PUT', input), receipt);
  await api(fixture, prefix + '/profile', 'PUT', { ...input, operationId: randomUUID() }, 409);
  await api(fixture, prefix + '/profile', 'PUT', { ...input, operationId: randomUUID(), expectedRevision: receipt.result.revision, appearance: { ...appearance, primaryColor: 'red;body{}' } }, 400);
  const otherProfile = await api(other, prefix + '/profile');
  await api(other, prefix + '/profile', 'PUT', { ...input, operationId: randomUUID(), expectedRevision: otherProfile.revision }, 422);
  assert.deepEqual((await api(fixture, prefix + '/setup')).profile.appearance, appearance);
  assert.equal((await fetch(fixture.apiUrl + `/api/catalog/v1/fullmatch-demo/brand-assets/${logoAsset.id}`)).status, 200);
  console.log('PASS branding: migration replay, owner authorization, asset isolation, input validation, revision conflicts and command replay');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  await context.addInitScript(({ token, owner, origin }) => { if (location.origin === origin) { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); } }, { ...fixture, origin: new URL(fixture.url).origin });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url + '#/settings');
  await page.getByRole('heading', { name: 'Identidad visual' }).waitFor();
  assert.equal(await page.title(), 'Stocky Studio');
  assert.equal(await page.getByLabel('Título de portada', { exact: true }).inputValue(), appearance.heroTitle);
  let rejectFirstUpload = true;
  await page.route('**/api/commerce/v1/brand-assets/logo', async route => {
    if (route.request().method() === 'POST' && rejectFirstUpload) {
      rejectFirstUpload = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'APPEARANCE_SCHEMA_NOT_READY', message: 'La personalización necesita una actualización del servicio comercial.' } }) });
    }
    return route.continue();
  });
  await page.getByLabel('Logo del negocio', { exact: true }).setInputFiles({ name: 'mi-logo.png', mimeType: 'image/png', buffer: logo });
  await page.getByText('mi-logo.png · No se pudo cargar.', { exact: true }).waitFor();
  await page.getByText('La personalización necesita una actualización del servicio comercial.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Logo del negocio', { exact: true }).inputValue(), '');
  const uploadResponse = page.waitForResponse(response => response.url().endsWith('/brand-assets/logo') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Reintentar logo', exact: true }).click();
  assert.equal((await uploadResponse).status(), 201);
  await page.getByText('mi-logo.png · Cargado. Guardá la configuración para aplicarlo.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reintentar logo', exact: true }).count(), 0);
  await page.unroute('**/api/commerce/v1/brand-assets/logo');
  await page.waitForFunction(() => !document.querySelector('.settings fieldset').disabled);
  await page.getByLabel('Título de portada', { exact: true }).fill('Elegí tu próxima casaca');
  await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
  await page.getByText('Configuración guardada.', { exact: true }).waitFor();
  await page.reload(); await page.getByLabel('Título de portada', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Título de portada', { exact: true }).inputValue(), 'Elegí tu próxima casaca');
  await page.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'settings-mobile.png'), fullPage: true });
  console.log('PASS branding: live preview, saved settings after reload and mobile layout');

  const publicPage = await context.newPage();
  await publicPage.goto(fixture.apiUrl + '/c/fullmatch-demo');
  await publicPage.getByRole('heading', { name: 'Elegí tu próxima casaca' }).waitFor();
  assert.equal(await publicPage.locator('.shop-logo').count(), 1);
  assert.equal(await publicPage.locator('.catalog-cover').count(), 1);
  assert.equal(await publicPage.locator('.catalog-hero').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(18, 52, 86)');
  assert.equal(await publicPage.locator('.primary').first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(204, 34, 119)');
  assert.equal(await publicPage.locator('.shop-logo').evaluate(image => image.complete && image.naturalWidth > 0), true);
  await publicPage.screenshot({ path: path.join(output, 'catalog-desktop.png'), fullPage: true });
  await publicPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await publicPage.screenshot({ path: path.join(output, 'catalog-mobile.png'), fullPage: true });
  console.log('PASS branding: public catalog uses saved logo, cover, copy and colors under the existing CSP');

  await page.goto(fixture.url + `#/products/${fixture.products[0].id}`);
  await page.getByRole('button', { name: 'Generar historia ↗' }).click();
  await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.export-actions button')?.hasAttribute('disabled'));
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar PNG ↓' }).click();
  const image = await fs.readFile(await (await download).path());
  await fs.writeFile(path.join(output, 'story.png'), image);
  const metadata = await sharp(image).metadata(); assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920);
  const pixel = async (x, y) => [...await sharp(image).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.deepEqual(await pixel(10, 10), [18, 52, 86]);
  assert.deepEqual(await pixel(150, 100), [18, 171, 52]);
  const snapshot = (await sql.query("SELECT result_json FROM commercial_operations WHERE operation_type='story.prepare' ORDER BY created_at DESC LIMIT 1")).rows[0].result_json.result;
  assert.equal((await api(fixture, prefix + `/story-snapshots/${snapshot.snapshotId}/validate`, 'POST', {})).valid, true);
  const latest = await api(fixture, prefix + '/profile');
  await api(fixture, prefix + '/profile', 'PUT', { operationId: randomUUID(), expectedRevision: latest.revision, brandName: latest.brandName, salesWhatsapp: latest.salesWhatsapp,
    appearance: { ...latest.appearance, accentColor: '#336699', logoId: null, coverId: null } });
  assert.equal((await api(fixture, prefix + `/story-snapshots/${snapshot.snapshotId}/validate`, 'POST', {})).valid, false);
  const oldLogoId = snapshot.content.appearance.logoId;
  assert.equal((await fetch(fixture.apiUrl + `/api/catalog/v1/fullmatch-demo/brand-assets/${oldLogoId}`)).status, 404);
  assert.equal((await fetch(fixture.apiUrl + prefix + `/brand-assets/${oldLogoId}`, { headers: { Authorization: `Bearer ${fixture.token}` } })).status, 200);
  assert.deepEqual(errors, []);
  console.log('PASS branding: real story export includes business logo and colors, and becomes stale after branding changes');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
