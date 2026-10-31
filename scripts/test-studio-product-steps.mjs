import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from 'playwright/test';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture();
const output = path.resolve('.fullmatch-runtime/product-steps');
let browser;
try {
  await fs.mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token);
    localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  }, { token: fixture.token, owner: fixture.owner });
  const page = await context.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/commerce/')) writes.push(request);
  });
  const button = name => page.getByRole('button', { name, exact: true });
  const nextDetails = () => button('Siguiente: SKU vinculados →');
  const nextLinks = () => button('Siguiente: Fotografías →');
  const currentStep = async number => {
    await expect(page.locator('.editor-progress')).toContainText(`Paso ${number} de 3`);
    await expect(page.locator('.tabs [aria-current="step"]')).toHaveCount(1);
  };
  const read = async id => {
    const response = await fetch(`${fixture.apiUrl}/api/commerce/v1/products/${id}`, { headers: { Authorization: `Bearer ${fixture.token}` } });
    assert.equal(response.status, 200); return response.json();
  };
  await page.goto(fixture.url);
  const catalogShortcut = page.getByRole('link', { name: 'Ir al catálogo ↗', exact: true });
  await expect(catalogShortcut).toBeVisible();
  await expect(catalogShortcut).toHaveAttribute('href', '/c/fullmatch-demo');
  const catalogResponse = await context.request.get(new URL(await catalogShortcut.getAttribute('href'), fixture.url).href);
  assert.equal(catalogResponse.status(), 200);
  await button('＋ Nueva ficha comercial').click();
  await currentStep(1);
  await nextDetails().click();
  await currentStep(1);
  assert.equal(writes.length, 0, 'A missing title must not create a product or advance');
  await page.getByLabel('Título comercial', { exact: true }).fill('Producto guiado');
  const creationRoute = '**/api/commerce/v1/products';
  await page.route(creationRoute, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: { code: 'INVALID_COMMAND', message: 'No se pudo guardar la información de prueba.' } } }) : route.continue());
  await nextDetails().click();
  await expect(page.getByText('No se pudo guardar la información de prueba.', { exact: true })).toBeVisible();
  await currentStep(1);
  await expect(page.getByLabel('Título comercial', { exact: true })).toHaveValue('Producto guiado');
  await page.unroute(creationRoute);
  await nextDetails().click();
  await page.waitForURL(/#\/products\/[a-f0-9-]{36}$/);
  const id = new URL(page.url()).hash.split('/').at(-1);
  await currentStep(2);
  await expect(nextLinks()).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'SKU y presentaciones vinculadas', exact: true })).toBeFocused();
  assert.equal((await read(id)).title, 'Producto guiado');
  console.log('PASS: title validation and save errors keep the first step; successful creation opens and focuses the SKU step');

  const sku = page.locator('.variant-row').filter({ hasText: 'Boca Juniors' }).getByRole('checkbox');
  await sku.check();
  const linksRoute = `**/api/commerce/v1/products/${id}/sku-links`;
  await page.route(linksRoute, route => route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: 'No se pudieron guardar los vínculos de prueba.' } } }));
  await nextLinks().click();
  await expect(page.getByRole('status').filter({ hasText: 'No se pudieron guardar los vínculos de prueba.' })).toBeVisible();
  await currentStep(2); await expect(sku).toBeChecked();
  await page.unroute(linksRoute);
  await nextLinks().click();
  await currentStep(3);
  assert.equal((await read(id)).variants.length, 1);
  await expect(page.getByRole('heading', { name: 'Fotografías del producto', exact: true })).toBeFocused();
  await page.screenshot({ path: path.join(output, 'desktop-photos.png'), fullPage: true });
  console.log('PASS: SKU save errors preserve the selection; continuing saves links before opening photos');

  await page.setViewportSize({ width: 390, height: 844 });
  await button('← Anterior: SKU vinculados').click(); await currentStep(2);
  await expect(sku).toBeChecked();
  await button('← Anterior: Información').click(); await currentStep(1);
  const description = page.getByLabel('Descripción · opcional', { exact: true });
  await description.fill('Descripción conservada al volver.');
  await button('03 Fotografías').click();
  await expect(button('Finalizar ficha')).toBeDisabled();
  await button('01 Información').click();
  await expect(description).toHaveValue('Descripción conservada al volver.');
  await nextDetails().click(); await currentStep(2);
  await nextLinks().click(); await currentStep(3);
  assert.equal((await read(id)).description, 'Descripción conservada al volver.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'mobile-photos.png'), fullPage: true });
  await button('Finalizar ficha').click();
  await expect(page.getByRole('heading', { name: 'Productos comerciales' })).toBeVisible();
  assert.equal((await read(id)).images.length, 0);
  assert.equal(writes.some(request => request.url().includes('/publication')), false, 'Finishing must not implicitly publish');
  console.log('PASS: backward navigation preserves data; unsaved changes block finishing; a product can finish without optional photos or implicit publication');

  await page.getByRole('heading', { name: 'Producto guiado', exact: true }).click();
  await button('03 Fotografías').click(); await currentStep(3);
  const catalogRoute = '**/api/commerce/v1/catalog';
  await page.route(catalogRoute, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), publicEnabled: false } });
  });
  await button('Finalizar y publicar').click();
  await expect(page.getByRole('status').filter({ hasText: 'Habilitá el catálogo en Configuración' })).toBeVisible();
  await currentStep(3);
  assert.equal((await read(id)).status, 'draft');
  await page.unroute(catalogRoute);
  const publicationRoute = `**/api/commerce/v1/products/${id}/publication`;
  await page.route(publicationRoute, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: 'No se pudo publicar la ficha de prueba.' } } }) : route.continue());
  await button('Finalizar y publicar').click();
  await expect(page.getByRole('status').filter({ hasText: 'No se pudo publicar la ficha de prueba.' })).toBeVisible();
  await currentStep(3);
  assert.equal((await read(id)).status, 'draft');
  await page.unroute(publicationRoute);
  await page.screenshot({ path: path.join(output, 'mobile-finish-publish.png'), fullPage: true });
  await button('Finalizar y publicar').click();
  await expect(page.getByText('Ficha finalizada y publicada en el catálogo.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Productos comerciales' })).toBeVisible();
  const published = await read(id);
  assert.equal(published.status, 'ready');
  assert.equal(published.images.length, 0);
  const publicResponse = await fetch(`${fixture.apiUrl}/c/fullmatch-demo/p/${published.slug}`);
  assert.equal(publicResponse.status, 200);
  assert.ok((await publicResponse.text()).includes('Producto guiado'));
  assert.equal(writes.some(request => request.url().endsWith('/catalog')), false, 'Finishing must preserve the catalogue master switch');
  console.log('PASS: the sidebar opens the catalogue; finish-and-publish prepares and publishes atomically without photos, and failures keep the editor open');

  await button('＋ Nueva ficha comercial').click();
  await page.getByLabel('Título comercial', { exact: true }).fill('Guardado sin avanzar');
  await button('Crear ficha').click(); await page.waitForURL(/#\/products\/[a-f0-9-]{36}$/);
  await currentStep(1);
  await description.fill('Edición sin avanzar');
  await button('Guardar cambios').click();
  await expect(page.getByText('Ficha guardada.', { exact: true })).toBeVisible(); await currentStep(1);
  await nextDetails().click(); await currentStep(2);
  await expect(nextLinks()).toBeEnabled();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'mobile-skus.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: the existing save-only actions and direct step navigation remain available on mobile');
} finally { await browser?.close(); await fixture.stop(); }
