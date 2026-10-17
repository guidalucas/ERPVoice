import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Built assets and a local fake API only: no providers or production services.
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const product = {
  id: 'adjust-product', name: 'Camiseta Argentina', productType: 'Camiseta', productModel: 'Argentina',
  size: 'S', stockAvailable: 5, stockReserved: 2, price: 65000, revision: 0, identityFingerprint: 'snapshot-fingerprint',
};
const attempts = [];
const applied = new Map();
let ambiguousFailure = true;
let failNextRefresh = false;
let refreshFailures = 0;
const snapshot = () => ({ products: [{ ...product }], clients: [], proveedores: [], pedidos: [], transactions: [] });

await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'local-adjustments-test');
  localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
});
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Prueba local', businessCategory: 'indumentaria', needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
  if (path === '/api/state') {
    if (failNextRefresh) {
      failNextRefresh = false;
      refreshFailures += 1;
      return json({ error: 'No se pudo actualizar la vista. Reintentá.' }, 503);
    }
    return json(snapshot());
  }
  if (path === `/api/products/${product.id}` && request.method() === 'PUT') {
    const input = request.postDataJSON();
    attempts.push(input);
    if (applied.has(input.operationId)) {
      assert.deepEqual(input, applied.get(input.operationId));
      return json(product);
    }
    if (input.expectedRevision !== product.revision) return json({ error: 'Conflicto de revisión.' }, 409);
    assert.equal(input.expectedFingerprint, 'snapshot-fingerprint');
    assert.ok(input.reason.trim());
    assert.ok(input.operationId);
    const { operationId, expectedRevision, expectedFingerprint, reason, ...changes } = input;
    Object.assign(product, changes, { revision: product.revision + 1 });
    applied.set(operationId, input);
    if (ambiguousFailure) {
      ambiguousFailure = false;
      failNextRefresh = true;
      return json({ error: 'Resultado incierto. Reintentá.' }, 503);
    }
    return json(product);
  }
  return json({});
});
await page.route('http://127.0.0.1:5173/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith('/api/')) return route.fallback();
  const root = resolve('dist');
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(`${root}${sep}`)) return route.abort();
  try {
    return route.fulfill({ status: 200, body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
  } catch { return route.fulfill({ status: 404, body: '' }); }
});

const openInventory = async () => {
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario' }).click();
  await page.getByRole('button', { name: 'Ver talles de Camiseta Argentina' }).click();
};
const openEdit = async () => {
  await page.getByRole('button', { name: 'Editar talle S de Camiseta Argentina' }).click();
  return page.getByRole('dialog', { name: 'Editar talle', exact: true });
};

try {
  await openInventory();
  let dialog = await openEdit();
  await dialog.getByLabel('Stock Disponible').fill('0');
  await dialog.getByLabel('Stock Reservado').fill('0');
  await dialog.getByLabel('Precio', { exact: true }).fill('0');
  await dialog.getByLabel('Motivo del ajuste').fill('Conteo físico');
  const save = () => dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await save();
  await dialog.getByRole('alert').getByText('Resultado incierto. Reintentá.').waitFor();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].expectedRevision, 0);
  assert.equal(attempts[0].stockAvailable, 0);
  assert.equal(attempts[0].stockReserved, 0);
  assert.equal(attempts[0].price, 0);
  assert.equal('name' in attempts[0], false);
  await save();
  await dialog.getByRole('alert').getByText('No se pudo actualizar la vista. Reintentá.').waitFor();
  assert.equal(refreshFailures, 1);
  await save();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts[1], attempts[2]);
  assert.equal(product.revision, 1);

  dialog = await openEdit();
  // Another writer changes the server after opening; the form keeps its original snapshot.
  product.revision = 2;
  product.stockAvailable = 9;
  await dialog.getByLabel('Stock Disponible').fill('4');
  await dialog.getByLabel('Motivo del ajuste').fill('Corrección pendiente');
  await save();
  await dialog.getByRole('alert').getByText(/Actualizá la página y volvé a abrir/).waitFor();
  assert.equal(await dialog.getByLabel('Stock Disponible').inputValue(), '4');
  assert.equal(await dialog.getByLabel('Motivo del ajuste').inputValue(), 'Corrección pendiente');
  assert.equal(attempts[3].expectedRevision, 1);
  await save();
  await dialog.getByRole('alert').waitFor();
  assert.deepEqual(attempts[3], attempts[4]);
  await dialog.getByLabel('Stock Disponible').fill('6');
  await save();
  await dialog.getByRole('alert').getByText(/Tu borrador se conserva/).waitFor();
  assert.equal(attempts[5].expectedRevision, 1);
  assert.notEqual(attempts[5].operationId, attempts[4].operationId);
  assert.equal(product.stockAvailable, 9);
  assert.equal(await dialog.getByLabel('Stock Disponible').inputValue(), '6');

  await openInventory();
  dialog = await openEdit();
  await dialog.getByLabel('Motivo del ajuste').fill('Revisión del conteo');
  await save();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(attempts[6].expectedRevision, 2);

  delete product.revision;
  await openInventory();
  dialog = await openEdit();
  await dialog.getByLabel('Motivo del ajuste').fill('Sin revisión');
  await save();
  await dialog.getByRole('alert').getByText(/Falta la revisión del producto/).waitFor();
  assert.equal(attempts.length, 7, 'Missing revision must never be replaced with zero.');
  console.log('Inventory adjustments UI passed: stable retries, failed refresh, stale draft, changed draft, zero balances, missing revision.');
} finally {
  await browser.close();
}
