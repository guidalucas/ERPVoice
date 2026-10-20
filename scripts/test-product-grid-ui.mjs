import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { chromium } from 'playwright';

// Render the built app with a disposable API; no real inventory is changed.
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const errors = [];
const products = [
  ['arg-s', 'Camiseta', 'Argentina suplente 2026 versión jugador', 'S', 1, 0, 65000],
  ['arg-m', 'Camiseta', 'Argentina suplente 2026 versión jugador', 'M', 8, 2, 65000],
  ['uru-m', 'Camiseta', 'Uruguay titular 2026', 'M', 0, 0, 70000],
  ['uru-l', 'Camiseta', 'Uruguay titular 2026', 'L', 5, 0, 70000],
  ['short-s', 'Short', 'Entrenamiento', 'S', 4, 1, 30000],
  ['short-xl', 'Short', 'Entrenamiento', 'XL', 6, 0, 32000],
  ['loose', 'Accesorio', 'Gorra', null, 3, 0, 10000],
].map(([id, productType, productModel, size, stockAvailable, stockReserved, price]) => ({ id, productType, productModel, size, name: [productType, productModel, size].filter(Boolean).join(' '), stockAvailable, stockReserved, price, revision: 1, identityFingerprint: 'fingerprint-' + id, unit: 'unit', priceCurrency: 'ARS' }));

async function fixture(category = 'indumentaria') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const writes = [];
  await page.addInitScript(() => {
    localStorage.setItem('erpvoice.auth.token', 'product-grid-fixture');
    localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
    localStorage.setItem('erpvoice.theme', 'dark');
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Inventario de prueba', businessCategory: category, needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
    if (path === '/api/state') return json({ products, clients: [], proveedores: [], pedidos: [], transactions: [] });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    return json({});
  });
  await page.route('http://127.0.0.1:5173/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) return route.fallback();
    const file = resolve('dist', '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(resolve('dist'))) return route.abort();
    try { return route.fulfill({ status: 200, body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario', exact: true }).click();
  const grid = page.getByRole('table', { name: 'Grilla de productos', exact: true });
  await grid.waitFor();
  return { page, grid, writes };
}

const screenshot = async (page, name) => {
  if (!process.env.PRODUCT_GRID_SCREENSHOT_DIR) return;
  const path = resolve(process.env.PRODUCT_GRID_SCREENSHOT_DIR, name + '.png');
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
};

try {
  const { page, grid, writes } = await fixture();
  for (const name of ['Modelo / producto', 'Talles', 'Disponible', 'Precio', 'Acciones']) {
    assert.equal(await grid.getByRole('columnheader', { name, exact: true }).isVisible(), true, 'Missing visible heading: ' + name);
  }
  assert.equal(await page.getByLabel('Agrupar por').inputValue(), 'model');
  const filters = page.getByLabel('Filtros de inventario');
  const filterBox = await filters.boundingBox(), gridBox = await grid.boundingBox();
  assert.ok(gridBox.y > filterBox.y + filterBox.height + 15, 'Filters need space before the grid');
  await screenshot(page, 'products-models');

  // An exact variant filter changes model totals and bulk selection membership.
  await grid.getByRole('button', { name: 'Filtrar talle S', exact: true }).first().click();
  await page.getByText('2 de 7 productos', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Filtrar por talle', { exact: true }).inputValue(), 's');
  assert.equal(await page.getByRole('button', { name: 'Editar talle M de Camiseta Argentina suplente 2026 versión jugador' }).count(), 0);
  const argentina = page.getByRole('checkbox', { name: 'Seleccionar modelo Camiseta Argentina suplente 2026 versión jugador', exact: true });
  await argentina.check();
  await page.getByRole('toolbar', { name: 'Acciones de selección' }).getByText('1 talle seleccionado', { exact: true }).waitFor();
  assert.equal(await grid.locator('tbody > tr').filter({ has: page.getByRole('button', { name: 'Ocultar talles de Camiseta Argentina suplente 2026 versión jugador' }) }).locator('td[data-column="stock"] strong').innerText(), '1');
  await page.getByRole('button', { name: 'Limpiar selección', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Seleccionar todos los visibles', exact: true }).check();
  await page.getByRole('toolbar', { name: 'Acciones de selección' }).getByText('2 talles seleccionados', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Limpiar selección', exact: true }).click();
  await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();

  // Grouping is independent from filtering and includes products without a variant.
  await page.getByLabel('Agrupar por').selectOption('size');
  for (const name of ['Talle: S', 'Talle: M', 'Talle: L', 'Talle: XL', 'Talle: Sin definir']) {
    await grid.locator('.data-grid-group').getByText(name, { exact: true }).waitFor();
  }
  await screenshot(page, 'products-grouped-by-size');
  await page.getByLabel('Filtrar por talle', { exact: true }).selectOption('__undefined__');
  await page.getByText('1 de 7 productos', { exact: true }).waitFor();
  await grid.getByRole('button', { name: 'Editar producto Accesorio Gorra', exact: true }).waitFor();
  await page.getByLabel('Filtrar por talle', { exact: true }).selectOption('m');
  await page.getByLabel('Filtrar por tipo de prenda').selectOption('short');
  await grid.getByText('No hay productos que coincidan con los filtros.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Seleccionar todos los visibles', exact: true }).isDisabled(), true);
  await page.getByLabel('Filtrar por tipo de prenda').selectOption('camiseta');
  await page.getByRole('group', { name: 'Filtrar stock' }).getByRole('button', { name: 'Stock bajo', exact: true }).click();
  await page.getByText('1 de 7 productos', { exact: true }).waitFor();
  assert.equal(await grid.locator('.data-grid-group').count(), 1);
  assert.equal(await grid.getByRole('button', { name: 'Editar producto Camiseta Uruguay titular 2026 M', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
  await page.getByLabel('Agrupar por').selectOption('productType');
  await grid.locator('.data-grid-group').getByText('Accesorio', { exact: true }).waitFor();
  assert.equal(await grid.locator('.data-grid-group').count(), 3);
  await page.getByLabel('Agrupar por').selectOption('none');
  await grid.locator('.data-grid-group').first().waitFor({ state: 'hidden' });
  assert.equal(await grid.locator('.data-grid-group').count(), 0);

  // Column resize, order, and visibility survive a reload.
  await grid.locator('th[data-column="price"] .data-grid-heading').dragTo(grid.locator('th[data-column="stock"] .data-grid-heading'));
  await page.waitForFunction(() => {
    const order = [...document.querySelectorAll('.data-grid-table > thead > tr > th[data-column]')].map((node) => node.dataset.column);
    return order.indexOf('price') < order.indexOf('stock');
  });
  const separator = page.getByRole('separator', { name: 'Ancho de Precio', exact: true });
  const start = await separator.boundingBox();
  const oldWidth = Number(await separator.getAttribute('aria-valuenow'));
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down(); await page.mouse.move(start.x + start.width / 2 + 65, start.y + start.height / 2); await page.mouse.up();
  assert.ok(Number(await separator.getAttribute('aria-valuenow')) >= oldWidth + 50, 'Pointer resizing must change column width');
  await separator.focus(); await page.keyboard.press('ArrowRight');
  const storedWidth = Number(await separator.getAttribute('aria-valuenow'));
  await page.locator('.data-grid-settings summary').click();
  await page.getByRole('button', { name: 'Mover Precio a la izquierda', exact: true }).click();
  await page.getByRole('button', { name: 'Mover Precio a la izquierda', exact: true }).click();
  await page.locator('.data-grid-settings-panel').getByRole('checkbox', { name: 'Talle', exact: true }).uncheck();
  await page.locator('.data-grid-settings summary').click();
  const order = await grid.locator('thead > tr > th[data-column]').evaluateAll((nodes) => nodes.map((node) => node.dataset.column));
  assert.ok(order.indexOf('price') < order.indexOf('stock'));
  assert.equal(await grid.getByRole('columnheader', { name: 'Talle', exact: true }).count(), 0);
  await page.reload();
  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario', exact: true }).click();
  await grid.waitFor();
  assert.equal(await grid.getByRole('columnheader', { name: 'Talles', exact: true }).count(), 0);
  assert.equal(Number(await page.getByRole('separator', { name: 'Ancho de Precio', exact: true }).getAttribute('aria-valuenow')), storedWidth);
  assert.deepEqual(await grid.locator('thead > tr > th[data-column]').evaluateAll((nodes) => nodes.map((node) => node.dataset.column)), order);
  await page.locator('.data-grid-settings summary').click();
  await page.getByRole('button', { name: 'Restablecer columnas y anchos', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await grid.getByRole('columnheader', { name: 'Talles', exact: true }).isVisible(), true);

  // Narrow screens keep the page contained and the column menu reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.data-grid-settings summary').click();
  const settings = await page.locator('.data-grid-settings-panel').boundingBox();
  assert.ok(settings.x >= 0 && settings.x + settings.width <= 390, 'Column menu must fit the mobile viewport');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Only the grid may scroll horizontally');
  await screenshot(page, 'products-mobile');
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); });
  await screenshot(page, 'products-light');
  assert.equal(writes.length, 0, 'Filtering, grouping and column preferences must never write inventory');
  await page.close();

  const flat = await fixture('general');
  assert.equal(await flat.grid.getByRole('columnheader', { name: 'Producto', exact: true }).isVisible(), true);
  assert.equal(await flat.page.getByLabel('Filtrar por talle').count(), 0);
  await flat.page.getByLabel('Agrupar por').selectOption('productType');
  await flat.grid.locator('.data-grid-group').getByText('Accesorio', { exact: true }).waitFor();
  assert.equal(await flat.grid.locator('.data-grid-group').count(), 3);
  await flat.page.close();
  assert.deepEqual(errors, []);
  console.log('Product grid: headings, filter spacing, exact size/type/stock filters, grouping, filtered selection, resize, persisted columns, mobile and flat view passed.');
} finally { await browser.close(); }
