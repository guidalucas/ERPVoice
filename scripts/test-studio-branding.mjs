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

  await page.setViewportSize({ width: 1440, height: 1050 });
  const preview = page.frameLocator('iframe[title="Vista previa de tu tienda"]');
  assert.equal(await page.locator('input[name="catalog-design"]').count(), 4);
  for (const [preset, columns] of [['classic', 3], ['editorial', 2], ['technical', 3], ['local', 2]]) {
    await page.locator(`input[name="catalog-design"][value="${preset}"]`).check();
    await preview.locator(`body[data-preset="${preset}"]`).waitFor();
    assert.equal(await preview.locator('.catalog-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), columns);
    assert.equal(await preview.locator('.header-search').count(), preset === 'technical' ? 1 : 0);
    assert.equal(await preview.locator('.category-tiles').count(), preset === 'local' ? 1 : 0);
    const browserColumns = await preview.locator('.catalog-browser').evaluate(element => getComputedStyle(element).gridTemplateColumns);
    assert.equal(browserColumns.split(' ').length, preset === 'technical' ? 2 : 1);
    assert.equal(await preview.locator('.catalog-card>a').first().evaluate(element => getComputedStyle(element).display), preset === 'local' ? 'grid' : 'flex');
    await page.locator(`.catalog-design-option:has(input[value="${preset}"])`).screenshot({ path: path.join(output, `template-${preset}.png`) });
    await page.getByLabel('Mostrar recuadro detrás del texto', { exact: true }).uncheck();
    await preview.locator('.catalog-hero.text-on-image').waitFor();
    assert.equal(await preview.locator('.hero-copy').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    const overlayCover = await preview.locator('.catalog-cover').boundingBox(), overlayHero = await preview.locator('.catalog-hero').boundingBox();
    assert.ok(Math.abs(overlayCover.width - overlayHero.width) < 3);
    await preview.locator('.catalog-hero').screenshot({ path: path.join(output, `${preset}-cover-without-text-background.png`) });
    await page.getByRole('button', { name: 'Celular', exact: true }).click();
    await preview.locator(`body[data-preset="${preset}"]`).waitFor();
    assert.equal(await preview.locator('body').evaluate(element => element.scrollWidth <= innerWidth), true);
    assert.equal(await preview.locator('.catalog-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), preset === 'local' ? 1 : 2);
    assert.equal(await preview.locator('.hero-copy').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: 'Escritorio', exact: true }).click();
    await page.getByLabel('Mostrar recuadro detrás del texto', { exact: true }).check();
  }
  await page.locator('.catalog-design-options').screenshot({ path: path.join(output, 'four-template-standards.png') });
  const saveSettings = async () => {
    await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
    await page.getByText('Configuración guardada.', { exact: true }).waitFor();
  };
  // Empty fields are accepted by both native form validation and the API.
  for (const label of ['Frase de marca', 'Título de portada', 'Descripción de portada']) await page.getByLabel(label, { exact: true }).fill('');
  await page.getByLabel('Mostrar botón «Explorar catálogo»').uncheck();
  await saveSettings(); await publicPage.reload();
  assert.equal(await publicPage.locator('.catalog-hero h1,.catalog-hero p,.catalog-hero a').count(), 0);
  assert.equal(await publicPage.locator('.catalog-hero.image-only .catalog-cover').count(), 1);
  await page.getByLabel('Título de portada', { exact: true }).fill('Elegí tu próxima casaca');
  await page.getByLabel('Frase de marca', { exact: true }).fill(appearance.tagline);
  await page.getByLabel('Descripción de portada', { exact: true }).fill(appearance.heroDescription);
  await page.getByLabel('Mostrar botón «Explorar catálogo»').check();
  await page.getByLabel('Solo imagen · ocultar textos y botón').check();
  await saveSettings(); await page.reload(); await publicPage.reload();
  assert.equal(await page.getByLabel('Solo imagen · ocultar textos y botón').isChecked(), true);
  assert.equal(await page.getByLabel('Título de portada', { exact: true }).inputValue(), 'Elegí tu próxima casaca');
  assert.equal(await publicPage.locator('.catalog-hero .hero-copy').count(), 0);
  const coverBounds = await publicPage.locator('.catalog-cover').boundingBox(), heroBounds = await publicPage.locator('.catalog-hero').boundingBox();
  assert.ok(Math.abs(coverBounds.width - heroBounds.width) < 1);
  console.log('PASS branding: visual selectors match public grid layouts, optional copy and image-only settings survive reload');

  await page.getByLabel('Solo imagen · ocultar textos y botón').uncheck();
  await page.getByRole('button', { name: 'Ubicar bloques en el banner', exact: true }).click();
  await preview.locator('.catalog-hero.custom-layout [data-hero-block="title"]').waitFor();
  const setRange = async (label, value) => {
    await page.getByRole('slider', { name: label, exact: true }).fill(String(value));
  };
  await setRange('Posición horizontal', 90); await setRange('Posición vertical', 60); await setRange('Ancho del bloque', 50);
  await preview.locator('[data-hero-block="title"]').focus();
  await preview.locator('[data-hero-block="title"]').press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Posición horizontal"]').value === '89');
  await preview.locator('[data-hero-block="title"]').press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Posición horizontal"]').value === '88');
  assert.equal(await preview.locator('[data-hero-block="title"]').evaluate(element => getComputedStyle(element).zIndex), '4');
  const beforeDrag = await preview.locator('[data-hero-block="title"]').boundingBox();
  await page.mouse.move(beforeDrag.x + 25, beforeDrag.y + 15); await page.mouse.down();
  await page.mouse.move(beforeDrag.x - 45, beforeDrag.y - 20, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => Number(document.querySelector('input[aria-label="Posición horizontal"]').value) < 88);
  await page.getByLabel('Mostrar recuadro detrás del texto', { exact: true }).uncheck();
  await page.getByLabel('Color del texto sobre la imagen', { exact: true }).selectOption('dark');
  await preview.locator('.catalog-hero.text-on-image').waitFor();
  assert.equal(await preview.locator('[data-hero-block="title"]').evaluate(element => getComputedStyle(element).color), 'rgb(23, 37, 54)');
  await page.getByLabel('Color del texto sobre la imagen', { exact: true }).selectOption('light');
  await saveSettings();
  const customized = (await api(fixture, prefix + '/profile')).appearance;
  assert.ok(customized.heroLayout.title.x < 88); assert.equal(customized.heroLayout.title.width, 50);
  assert.equal(customized.heroLayout.description.x, 8);
  assert.equal(customized.heroTextBackground, false); assert.equal(customized.heroTextTone, 'light');
  await page.reload(); await publicPage.setViewportSize({ width: 1440, height: 1050 }); await publicPage.reload();
  assert.equal(await page.getByLabel('Mostrar recuadro detrás del texto', { exact: true }).isChecked(), false);
  assert.equal(await publicPage.locator('.catalog-hero.custom-layout').count(), 1);
  const positions = await publicPage.locator('[data-hero-block="title"]').evaluate(element => ({ position: getComputedStyle(element).position, left: getComputedStyle(element).left }));
  assert.equal(positions.position, 'absolute');
  assert.ok(parseFloat(positions.left) > 0);
  assert.equal(await publicPage.locator('.hero-copy').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await publicPage.locator('[data-hero-block="title"]').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await publicPage.locator('[data-hero-block="title"]').evaluate(element => getComputedStyle(element).color), 'rgb(255, 255, 255)');
  assert.equal(await publicPage.locator('[data-hero-block="button"]').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(204, 34, 119)');
  await page.screenshot({ path: path.join(output, 'design-selector-and-editor.png'), fullPage: true });
  await publicPage.screenshot({ path: path.join(output, 'custom-banner-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Celular', exact: true }).click();
  await preview.locator('[data-hero-block="title"]').waitFor();
  assert.equal(await preview.locator('[data-hero-block="title"]').evaluate(element => getComputedStyle(element).position), 'relative');
  await publicPage.setViewportSize({ width: 390, height: 844 }); await publicPage.reload();
  assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.notEqual(await publicPage.locator('[data-hero-block="title"]').evaluate(element => getComputedStyle(element).position), 'absolute');
  assert.equal(await publicPage.locator('.hero-copy').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  await publicPage.screenshot({ path: path.join(output, 'custom-banner-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Restablecer composición', exact: true }).click();
  await saveSettings(); assert.equal((await api(fixture, prefix + '/profile')).appearance.heroLayout, null);
  console.log('PASS branding: independent block positioning by sliders, keyboard and drag persists, with responsive mobile stacking and reset');

  await page.goto(fixture.url + `#/products/${fixture.products[0].id}`);
  await page.getByRole('button', { name: 'Generar historia ↗' }).click();
  await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.export-actions button')?.hasAttribute('disabled'));
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar PNG ↓' }).click();
  const image = await fs.readFile(await (await download).path());
  await fs.writeFile(path.join(output, 'story.png'), image);
  const metadata = await sharp(image).metadata(); assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920);
  const pixel = async (x, y) => [...await sharp(image).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.deepEqual(await pixel(10, 1900), [18, 52, 86]);
  assert.deepEqual(await pixel(110, 110), [18, 171, 52]);
  const snapshot = (await sql.query("SELECT result_json FROM commercial_operations WHERE operation_type='story.prepare' ORDER BY created_at DESC LIMIT 1")).rows[0].result_json.result;
  assert.equal(snapshot.rendererVersion, 5);
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
