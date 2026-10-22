import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

// All mutations below target the existing disposable localhost fixture.
const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const output = path.resolve('.fullmatch-runtime/visual-redesign');
let browser;
const evidence = [], widths = [[375,812],[390,844],[430,932],[768,1024],[1440,900],[1920,1080]];
const api = async (route, method = 'GET', body, contentType = 'application/json') => {
  const response = await fetch(fixture.apiUrl + '/api/commerce/v1' + route, { method, headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': contentType },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
};
async function screenshot(page, name) {
  await page.evaluate(() => scrollTo(0, 0)); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}
async function geometry(page, selector) {
  return page.evaluate(selector => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    top: document.querySelector(selector)?.getBoundingClientRect().top,
    overflow: [...document.querySelectorAll('body *')].filter(element => { const rect = element.getBoundingClientRect(); return rect.width && rect.right > innerWidth + 1; }).slice(0, 10).map(element => ({ tag: element.tagName, className: element.className, width: element.getBoundingClientRect().width })) }), selector);
}
function contrast(foreground, background) {
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
try {
  await sql.connect(); await fs.mkdir(output, { recursive: true });
  const inventoryBefore = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ token, owner, origin }) => { if (location.origin === origin) { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); } }, { ...fixture, origin: new URL(fixture.url).origin });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height }); await page.goto(fixture.url);
    await page.locator('.product-card').first().waitFor(); await page.locator('.card-photo img').first().waitFor();
    await page.waitForLoadState('networkidle');
    const measured = await geometry(page, '.product-card'); await screenshot(page, `studio-products-${width}x${height}`); assert.equal(measured.scrollWidth, width, JSON.stringify(measured));
    assert.ok(measured.top < (width >= 1440 ? 500 : 760), JSON.stringify(measured));
    evidence.push({ surface: 'studio', width, ...measured });
    await page.locator('.product-filter-options summary').click();
    const fields = await page.locator('.filter-fields select,.filter-fields input').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    assert.ok(fields.every(value => value >= 160), JSON.stringify(fields));
    if (width === 390) await screenshot(page, 'studio-mobile-filters-open');
  }
  const create = page.getByRole('button', { name: '＋ Nueva ficha comercial', exact: true });
  await create.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.products-heading .primary')).backgroundColor === 'rgb(68, 52, 186)');
  const actionColors = await create.evaluate(element => { const style = getComputedStyle(element); return [style.color, style.backgroundColor]; });
  assert.ok(contrast(...actionColors) >= 4.5, JSON.stringify(actionColors));
  await create.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await create.evaluate(element => document.activeElement === element), true);
  assert.notEqual(await create.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  await page.getByLabel('Buscar productos', { exact: true }).fill('sin-coincidencias-auditoria');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.getByRole('heading', { name: 'No encontramos fichas con esta búsqueda.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Crear primera ficha' }).count(), 0);
  await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).first().click();
  await page.locator('.product-card').first().waitFor();
  await page.route('**/api/commerce/v1/products?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_ERROR', message: 'Error local simulado' } }) }));
  await page.reload(); await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Crear primera ficha' }).count(), 0);
  await screenshot(page, 'studio-error'); await page.unroute('**/api/commerce/v1/products?**');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixture.url + '#/products/' + fixture.products[0].id);
  await page.getByRole('button', { name: 'Generar historia ↗' }).click();
  const helpColors = await page.locator('.control-help').first().evaluate(element => [getComputedStyle(element).color, getComputedStyle(element.closest('.panel')).backgroundColor]);
  assert.ok(contrast(...helpColors) >= 4.5, JSON.stringify(helpColors));
  await page.locator('.template-browser summary').click();
  await page.getByRole('button', { name: 'Nuevo ingreso Presentá una novedad', exact: true }).click();
  assert.equal(await page.getByLabel('Plantilla', { exact: true }).inputValue(), 'arrival');
  await page.locator('.template-browser summary').click();
  await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
  const download = page.getByRole('button', { name: 'Descargar PNG ↓', exact: true });
  await page.waitForFunction(() => !document.querySelector('.export-actions button').disabled);
  await screenshot(page, 'story-ready-desktop');
  const originalPixels = await page.locator('canvas').evaluate(canvas => canvas.toDataURL());
  await page.getByLabel('Mensaje secundario', { exact: true }).fill('Detalle de prueba');
  assert.equal(await download.isDisabled(), true);
  assert.equal(await page.locator('.canvas-frame.ready').count(), 1);
  assert.equal(await page.locator('canvas').evaluate(canvas => canvas.toDataURL()), originalPixels);
  await page.getByText('Cambios sin aplicar. Regenerá para descargar.', { exact: true }).waitFor();
  await screenshot(page, 'story-pending-desktop');
  await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.export-actions button').disabled);
  const pendingDownload = page.waitForEvent('download'); await download.click();
  const image = await pendingDownload, metadata = await sharp(await fs.readFile(await image.path())).metadata();
  assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920); assert.equal(metadata.format, 'png');
  for (const [width, height] of widths) { await page.setViewportSize({ width, height }); assert.equal((await geometry(page, '.canvas-frame')).scrollWidth, width); if (width === 390) await screenshot(page, 'story-ready-mobile'); }

  await page.goto(fixture.url + '#/settings'); await page.locator('.brand-preview-product img').first().waitFor(); await page.waitForLoadState('networkidle');
  await page.getByLabel('Diseño del catálogo · opcional').selectOption('editorial');
  assert.equal(await page.locator('.brand-preview').getAttribute('data-preset'), 'editorial');
  const previewBounds = await page.locator('.brand-preview-product').evaluateAll(cards => cards.map(card => {
    const image = card.querySelector('img')?.getBoundingClientRect(), media = card.querySelector('div').getBoundingClientRect(), title = card.querySelector('h4').getBoundingClientRect();
    return { imageBottom: image?.bottom ?? media.bottom, mediaBottom: media.bottom, titleTop: title.top };
  }));
  assert.ok(previewBounds.every(item => item.imageBottom <= item.mediaBottom + 1 && item.titleTop >= item.mediaBottom), JSON.stringify(previewBounds));
  await screenshot(page, 'settings-preview-desktop'); await page.getByRole('button', { name: 'Celular', exact: true }).click();
  assert.ok((await page.locator('.brand-preview').boundingBox()).width <= 390);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal((await geometry(page, '.brand-preview')).scrollWidth, 390);
  await screenshot(page, 'settings-preview-mobile');

  const publicPage = await browser.newPage({ viewport: { width: 1440, height: 900 } }); publicPage.on('pageerror', error => errors.push(error.message));
  for (const [width, height] of widths) {
    await publicPage.setViewportSize({ width, height }); await publicPage.goto(fixture.apiUrl + '/c/fullmatch-demo'); await publicPage.waitForLoadState('networkidle');
    const measured = await geometry(publicPage, '.catalog-card'); assert.equal(measured.scrollWidth, width);
    assert.ok(measured.top < (width >= 1440 ? 600 : 780), JSON.stringify(measured));
    await screenshot(publicPage, `catalog-${width}x${height}`); evidence.push({ surface: 'catalog', width, ...measured });
  }
  // Two images, with a real thumbnail interaction and native dialog focus handling.
  let product = await api('/products/' + fixture.products[0].id);
  const bytes = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#dce5ed' } }).png().toBuffer();
  const initialized = (await api(`/products/${product.id}/images`, 'POST', { operationId: randomUUID(), expectedRevision: product.revision, sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceSizeBytes: bytes.length, altText: 'Segunda fotografía de prueba local' })).result;
  product = await api(`/products/${product.id}/images/${initialized.imageId}/content`, 'PUT', bytes, 'image/png');
  await publicPage.goto(fixture.apiUrl + '/c/fullmatch-demo'); await publicPage.locator('.catalog-card a').filter({ hasText: product.title }).click();
  await publicPage.locator('[data-gallery-main]').waitFor(); const productUrl = publicPage.url(), originalSource = await publicPage.locator('[data-gallery-main]').evaluate(image => image.src);
  const tabs = browser.contexts().reduce((count, item) => count + item.pages().length, 0);
  await publicPage.getByRole('link', { name: 'Ver fotografía 2', exact: true }).click();
  assert.equal(publicPage.url(), productUrl); assert.notEqual(await publicPage.locator('[data-gallery-main]').evaluate(image => image.src), originalSource);
  assert.equal(browser.contexts().reduce((count, item) => count + item.pages().length, 0), tabs);
  await publicPage.getByRole('link', { name: 'Ver fotografía 2', exact: true }).press('ArrowLeft');
  assert.equal(await publicPage.locator('[data-gallery-main]').evaluate(image => image.src), originalSource);
  await publicPage.getByRole('link', { name: 'Ampliar fotografía', exact: true }).click();
  assert.equal(await publicPage.locator('dialog[open]').count(), 1); await publicPage.keyboard.press('Escape');
  assert.equal(await publicPage.locator('dialog[open]').count(), 0);
  const select = publicPage.locator('[data-add-inquiry] select'); assert.equal(await select.count(), 1); assert.equal(await publicPage.locator('.catalog-sizes.large').count(), 0);
  await select.selectOption('L'); await publicPage.getByLabel('Cantidad para tu consulta').fill('2');
  assert.ok(decodeURIComponent(await publicPage.locator('[data-direct-inquiry]').getAttribute('href')).replace(/\+/g, ' ').includes('Presentación: L. Cantidad: 2.'));
  await publicPage.getByRole('button', { name: 'Agregar a mi consulta ＋', exact: true }).click();
  assert.equal(await publicPage.locator('[data-cart-count]').innerText(), '2');
  await screenshot(publicPage, 'product-gallery-desktop');
  await publicPage.setViewportSize({ width: 390, height: 844 }); assert.equal((await geometry(publicPage, '.public-product-heading')).scrollWidth, 390);
  assert.ok((await publicPage.locator('.public-product-heading').boundingBox()).y < (await publicPage.locator('.public-gallery').boundingBox()).y);
  await screenshot(publicPage, 'product-gallery-mobile');
  await publicPage.goto(fixture.apiUrl + '/c/fullmatch-demo/p/inexistente');
  assert.equal(await publicPage.getByRole('link', { name: 'Volver al catálogo' }).getAttribute('href'), '/c/fullmatch-demo');
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, inventoryBefore);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS visual redesign: six viewports, usable filters, distinct empty/error states, retained preview with blocked stale export, real PNG, brand preview, in-page gallery/dialog, unique variant selection, unchanged inventory');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
