import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const products = [{
  id: 'product-1',
  name: 'Camiseta Argentina',
  productType: 'Camiseta',
  productModel: 'Argentina',
  size: 'S',
  stockAvailable: 1,
  stockReserved: 0,
  price: 65000,
}];
const created = [];
const createdModels = [];
const modelUpdates = [];
const selectionPreviews = [];
const movementAttempts = [];
const movements = [];
const bulkDeletions = [];

await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'local-ui-test');
  localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
});

await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  if (path === '/api/auth/me') {
    return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Prueba local', businessCategory: 'indumentaria', needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
  }
  if (path === '/api/state') {
    return json({ products, clients: [], proveedores: [], pedidos: [], transactions: [] });
  }
  if (path === '/api/state/apply' && request.method() === 'POST') {
    const input = request.postDataJSON();
    movementAttempts.push(input);
    if (movementAttempts.length === 1) return json({ error: 'No se pudo registrar el movimiento. Reintentá.' }, 503);
    for (const action of input.actions) {
      const product = products.find((item) => item.name === action.productName && item.size === action.size);
      if (!product) return json({ error: 'No se encontró el talle.' }, 404);
      product.stockAvailable += action.type === 'add_stock' ? action.qty : -action.qty;
    }
    movements.push(input);
    return json({ products, clients: [], proveedores: [], pedidos: [], transactions: [] });
  }
  if (path === '/api/products' && request.method() === 'POST') {
    const input = request.postDataJSON();
    created.push(input);
    const product = { id: `product-${products.length + 1}`, ...input };
    products.push(product);
    return json(product, 201);
  }
  if (path === '/api/products/model' && request.method() === 'POST') {
    const input = request.postDataJSON();
    createdModels.push(input);
    const newProducts = input.variants.map((variant, index) => ({
      id: `model-product-${products.length + index + 1}`,
      name: `${input.productType} ${input.productModel}`,
      productType: input.productType,
      productModel: input.productModel,
      size: variant.size,
      stockAvailable: variant.stockAvailable,
      stockReserved: 0,
      price: variant.price,
    }));
    products.push(...newProducts);
    return json(newProducts, 201);
  }
  if (path === '/api/inventory/selections' && request.method() === 'POST') {
    const input = request.postDataJSON();
    const preview = { selectionId: `selection-${selectionPreviews.length + 1}`, digest: 'local-preview-digest',
      status: 'pending', expiresAt: '2030-01-01T00:00:00.000Z', mutation: input.mutation,
      members: products.filter((product) => input.selector.skuIds.includes(product.id)).map((product) => ({
        skuId: product.id, name: product.name, size: product.size ?? null, revision: 0,
        stockAvailable: product.stockAvailable, stockReserved: product.stockReserved, price: product.price, priceCurrency: 'XXX',
      })) };
    selectionPreviews.push(preview);
    return json(preview);
  }
  if (path === '/api/products/model' && request.method() === 'PUT') {
    const input = request.postDataJSON();
    modelUpdates.push(input);
    const preview = selectionPreviews.find((entry) => entry.selectionId === input.selectionId && entry.digest === input.digest);
    if (!preview) return json({ error: 'Selección no revisada.' }, 409);
    const matching = products.filter((product) => preview.members.some((member) => member.skuId === product.id));
    for (const product of matching) Object.assign(product, preview.mutation.changes);
    return json(matching);
  }
  if (path === '/api/products/batch' && request.method() === 'DELETE') {
    const input = request.postDataJSON();
    const preview = selectionPreviews.find((entry) => entry.selectionId === input.selectionId && entry.digest === input.digest && entry.mutation.type === 'sku.deactivate');
    if (!preview) return json({ error: 'Selección de baja no revisada.' }, 409);
    const ids = preview.members.map((member) => member.skuId);
    bulkDeletions.push(ids);
    if (ids.some((id) => !products.some((product) => product.id === id))) return json({ error: 'El inventario cambió.' }, 409);
    for (const id of ids) products.splice(products.findIndex((product) => product.id === id), 1);
    return json({ deleted: ids.length });
  }
  return json({});
});

await page.route('http://127.0.0.1:5173/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith('/api/')) return route.fallback();
  const file = resolve('dist', `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(resolve('dist'))) return route.abort();
  try {
    const body = await readFile(file);
    const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ status: 200, body, contentType });
  } catch {
    return route.fulfill({ status: 404, body: '' });
  }
});

try {
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario' }).click();
  await page.getByRole('button', { name: 'Ver talles de Camiseta Argentina' }).waitFor();
  await page.getByRole('button', { name: 'Ver talles de Camiseta Argentina' }).click();
  await page.getByRole('button', { name: 'Editar talle S de Camiseta Argentina' }).waitFor();
  await page.getByRole('button', { name: 'Agregar talle a Camiseta Argentina' }).click();

  const dialog = page.getByRole('dialog', { name: 'Agregar talle' });
  assert.equal(await dialog.getByLabel('Tipo de prenda').count(), 0);
  await dialog.getByText('Modelo: Camiseta Argentina').waitFor();
  assert.equal(await dialog.getByLabel('Precio').inputValue(), '65000');
  assert.equal(await dialog.getByLabel('Stock Disponible').inputValue(), '0');

  await dialog.getByLabel('Talle', { exact: true }).fill('s');
  await dialog.getByRole('button', { name: 'Agregar talle' }).click();
  await dialog.getByRole('alert').getByText(/ya existe/).waitFor();
  assert.equal(created.length, 0);

  await dialog.getByLabel('Talle', { exact: true }).fill('M');
  await dialog.getByLabel('Stock Disponible').fill('4');
  await dialog.getByRole('button', { name: 'Agregar talle' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Editar talle M de Camiseta Argentina' }).waitFor();

  assert.equal(created.length, 1);
  assert.deepEqual({
    name: created[0].name,
    productType: created[0].productType,
    productModel: created[0].productModel,
    size: created[0].size,
    stockAvailable: created[0].stockAvailable,
    price: created[0].price,
  }, {
    name: 'Camiseta Argentina',
    productType: 'Camiseta',
    productModel: 'Argentina',
    size: 'M',
    stockAvailable: 4,
    price: 65000,
  });
  await page.getByRole('button', { name: 'Editar modelo Camiseta Argentina' }).click();
  const modelDialog = page.getByRole('dialog', { name: 'Editar modelo Camiseta Argentina' });
  await modelDialog.getByLabel('Modelo').fill('Argentina Selección');
  await modelDialog.getByLabel('Motivo del cambio').fill('Corregir nombre del modelo');
  await modelDialog.getByRole('button', { name: 'Revisar cambios' }).click();
  assert.equal(modelUpdates.length, 0);
  await modelDialog.getByRole('button', { name: 'Confirmar cambios' }).click();
  await modelDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Editar talle M de Camiseta Argentina Selección' }).waitFor();
  assert.equal(modelUpdates.length, 1);
  assert.equal(selectionPreviews[0].members.length, 2);
  assert.deepEqual(modelUpdates[0], { selectionId: selectionPreviews[0].selectionId, digest: selectionPreviews[0].digest });

  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inicio' }).click();
  await page.getByRole('button', { name: 'Registrar ingreso' }).click();
  await page.getByRole('button', { name: /Camiseta Argentina Selección M/ }).click();
  await page.getByLabel('Cantidad').fill('3');
  await page.getByRole('button', { name: '+ Confirmar ingreso' }).click();
  await page.getByText('Podés corregir y volver a confirmar.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reintentar ingreso' }).isVisible(), true);
  assert.equal(movementAttempts.length, 1);
  assert.equal(movements.length, 0);
  const selectedM = products.find((product) => product.size === 'M');
  assert.equal(selectedM.stockAvailable, 4);

  await page.getByRole('button', { name: 'Reintentar ingreso' }).click();
  await page.getByRole('button', { name: '+ Confirmar ingreso' }).waitFor({ state: 'hidden' });
  assert.equal(movementAttempts.length, 2);
  assert.equal(movements.length, 1);
  assert.equal(selectedM.stockAvailable, 7);
  assert.equal(movementAttempts[0].operationId, movementAttempts[1].operationId);
  assert.ok(movementAttempts[0].operationId);
  for (const attempt of movementAttempts) {
    assert.equal(attempt.actions.length, 1);
    assert.equal(attempt.actions[0].type, 'add_stock');
    assert.equal(attempt.actions[0].productId, selectedM.id);
    assert.equal(attempt.actions[0].qty, 3);
    assert.equal(attempt.actions[0].unit, 'unit');
    assert.equal(attempt.actions[0].priceCurrency, 'XXX');
  }

  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario' }).click();
  await page.getByText('M: 7').waitFor();
  await page.getByRole('button', { name: '+ Nuevo modelo' }).click();
  const newModelDialog = page.getByRole('dialog', { name: 'Nuevo modelo' });
  await newModelDialog.getByLabel('Tipo de prenda').fill('Camiseta');
  await newModelDialog.getByLabel('Modelo').fill('Uruguay Titular');
  const firstVariant = newModelDialog.getByRole('group', { name: 'talle 1' });
  await firstVariant.getByLabel('Talle', { exact: true }).fill('S');
  await firstVariant.getByLabel('Stock disponible').fill('2');
  await firstVariant.getByLabel('Precio').fill('70000');
  await newModelDialog.getByRole('button', { name: '+ Agregar otro talle' }).click();
  const secondVariant = newModelDialog.getByRole('group', { name: 'talle 2' });
  assert.equal(await secondVariant.getByLabel('Precio').inputValue(), '70000');
  await secondVariant.getByLabel('Talle', { exact: true }).fill('s');
  await newModelDialog.getByRole('button', { name: 'Crear modelo' }).click();
  await newModelDialog.getByRole('alert').getByText(/repetido/).waitFor();
  assert.equal(createdModels.length, 0);
  await secondVariant.getByLabel('Talle', { exact: true }).fill('M');
  await secondVariant.getByLabel('Stock disponible').fill('5');
  await newModelDialog.getByRole('button', { name: 'Crear modelo' }).click();
  await newModelDialog.waitFor({ state: 'hidden' });
  assert.equal(createdModels.length, 1);
  assert.deepEqual(createdModels[0].variants, [
    { size: 'S', stockAvailable: 2, price: 70000 },
    { size: 'M', stockAvailable: 5, price: 70000 },
  ]);
  await page.getByRole('button', { name: 'Ocultar talles de Camiseta Uruguay Titular' }).waitFor();
  if (process.env.INVENTORY_SCREENSHOT_PATH) {
    await page.waitForTimeout(350);
    await page.screenshot({ path: process.env.INVENTORY_SCREENSHOT_PATH, fullPage: true });
    await page.getByRole('button', { name: 'Ver talles de Camiseta Argentina Selección' }).click();
    await page.screenshot({ path: process.env.INVENTORY_SCREENSHOT_PATH.replace(/\.png$/i, '-details.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('button', { name: 'Agregar talle a Camiseta Argentina' }).isVisible(), true);
  if (process.env.INVENTORY_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.INVENTORY_SCREENSHOT_PATH.replace(/\.png$/i, '-mobile.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  if (await page.getByRole('button', { name: 'Ver talles de Camiseta Argentina Selección' }).count()) {
    await page.getByRole('button', { name: 'Ver talles de Camiseta Argentina Selección' }).click();
  }
  await page.getByRole('checkbox', { name: 'Seleccionar modelo Camiseta Uruguay Titular' }).check();
  await page.getByRole('checkbox', { name: 'Seleccionar talle M de Camiseta Argentina Selección' }).check();
  await page.getByRole('toolbar', { name: 'Acciones de selección' }).getByText('3 talles seleccionados').waitFor();
  await page.getByRole('button', { name: 'Desactivar seleccionados' }).click();
  const bulkDialog = page.getByRole('dialog', { name: 'Desactivar productos' });
  await bulkDialog.getByText(/3 SKU seleccionados/).waitFor();
  await bulkDialog.getByLabel('Motivo de la desactivación').fill('Retiro del catálogo');
  await bulkDialog.getByRole('button', { name: 'Revisar desactivación' }).click();
  assert.equal(bulkDeletions.length, 0);
  await bulkDialog.getByRole('button', { name: 'Confirmar desactivación' }).click();
  await bulkDialog.waitFor({ state: 'hidden' });
  assert.equal(bulkDeletions.length, 1);
  assert.equal(bulkDeletions[0].length, 3);
  assert.equal(products.length, 1);
  console.log('Inventario local: múltiples talles creados, grilla y selección múltiple verificadas.');
} finally {
  await browser.close();
}
