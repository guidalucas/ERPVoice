import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Exercise the production bundle with API responses controlled at the browser boundary.
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const products = ['S', 'M', 'L'].map((size, index) => ({
  id: `sku-${size}`, identityFingerprint: `fingerprint-${size}`,
  name: 'Producto Compartido', productType: 'Producto', productModel: 'Compartido', size,
  stockAvailable: index ? 10 : 3, stockReserved: 2, price: 98765,
  unit: 'unit', priceCurrency: index === 0 ? 'USD' : index === 1 ? 'UYU' : 'XXX',
}));
const attempts = [];
const transactions = [];
const state = () => ({ products, transactions, clients: [], proveedores: [], pedidos: [] });
await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'local-sales-test');
  localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
});
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Ventas locales', businessCategory: 'general', needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
  if (path === '/api/state') return json(state());
  if (path === '/api/state/apply' && request.method() === 'POST') {
    const input = request.postDataJSON();
    attempts.push(input);
    if (attempts.length === 1) return json({ error: 'Fallo temporal de venta.' }, 503);
    const action = input.actions[0];
    const product = products.find((item) => item.id === action.productId);
    assert.ok(product);
    assert.equal(action.type, 'sell');
    assert.equal(action.expectedFingerprint, product.identityFingerprint);
    assert.equal(action.size, product.size);
    assert.equal(action.unit, product.unit);
    assert.equal(action.priceCurrency, product.priceCurrency);
    assert.ok(action.qty <= product.stockAvailable);
    product.stockAvailable -= action.qty;
    transactions.push({ id: `sale-${transactions.length}`, timestamp: new Date().toISOString(), sourceText: input.sourceText, summary: 'Venta registrada', actions: [{ ...action, salePriceKnown: Object.hasOwn(action, 'price') }] });
    return json(state());
  }
  return json({});
});
await page.route('http://127.0.0.1:5173/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith('/api/')) return route.fallback();
  const file = resolve('dist', `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(resolve('dist'))) return route.abort();
  try {
    return route.fulfill({ status: 200, body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
  } catch { return route.fulfill({ status: 404, body: '' }); }
});

try {
  await page.goto('http://127.0.0.1:5173');
  const nav = page.getByRole('navigation', { name: 'Navegación del panel' });
  await nav.getByRole('button', { name: 'Inicio', exact: true }).click();
  const openSale = async (size = 'M') => {
    await page.getByRole('button', { name: 'Registrar venta', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Registrar venta', exact: true });
    await dialog.getByRole('button', { name: new RegExp(`Producto Compartido ${size}`) }).click();
    assert.equal(await dialog.getByLabel('Precio de venta unitario (opcional)').inputValue(), '');
    return dialog;
  };
  let dialog = await openSale();
  await dialog.getByLabel('Cantidad', { exact: true }).fill('11');
  assert.equal(await dialog.getByRole('button', { name: '− Confirmar venta' }).isEnabled(), false);
  await dialog.getByText('La cantidad supera el stock disponible (10).').waitFor();
  assert.equal(attempts.length, 0);
  await dialog.getByLabel('Cantidad', { exact: true }).fill('2');
  for (const invalid of ['-1', '1.5', '9007199254740992']) {
    await dialog.getByLabel('Precio de venta unitario (opcional)').fill(invalid);
    assert.equal(await dialog.getByRole('button', { name: '− Confirmar venta' }).isEnabled(), false);
  }
  await dialog.getByLabel('Precio de venta unitario (opcional)').fill('');
  await dialog.getByRole('button', { name: '− Confirmar venta' }).click();
  await dialog.getByRole('button', { name: 'Reintentar venta' }).waitFor();
  assert.equal(attempts.length, 1);
  assert.equal(products[1].stockAvailable, 10);
  await dialog.getByRole('button', { name: 'Reintentar venta' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].operationId);
  assert.equal(attempts[0].operationId, attempts[1].operationId);
  assert.deepEqual(attempts[0].actions, attempts[1].actions);
  assert.equal(attempts[0].actions[0].productId, 'sku-M');
  assert.equal(Object.hasOwn(attempts[0].actions[0], 'price'), false);
  assert.equal(products[0].stockAvailable, 3);
  assert.equal(products[1].stockAvailable, 8);
  assert.equal(products[1].stockReserved, 2);

  await nav.getByRole('button', { name: 'Ventas', exact: true }).click();
  await page.getByText('Importe desconocido · Sin precio registrado', { exact: true }).waitFor();
  const panel = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Ventas detalladas' }) });
  assert.equal(await panel.getByText(/98\.765/).count(), 0);
  await panel.getByText('1 venta sin precio registrado', { exact: true }).waitFor();

  for (const [size, price] of [['M', '0'], ['M', '123'], ['S', '7'], ['L', '5']]) {
    await nav.getByRole('button', { name: 'Inicio', exact: true }).click();
    dialog = await openSale(size);
    await dialog.getByLabel('Precio de venta unitario (opcional)').fill(price);
    await dialog.getByRole('button', { name: '− Confirmar venta' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(attempts.at(-1).actions[0].price, Number(price));
    assert.notEqual(attempts.at(-1).operationId, attempts[0].operationId);
  }
  // Older receipts remain visible as separate estimates, never mixed with marked sales.
  transactions.push({ id: 'legacy', timestamp: new Date().toISOString(), sourceText: 'Venta histórica', summary: 'Venta histórica', actions: [{ type: 'sell', productName: products[0].name, qty: 1, price: 2, priceCurrency: 'USD' }] });
  await page.reload();
  const summary = page.getByRole('button').filter({ has: page.getByText('Ventas de la semana', { exact: true }) });
  await summary.getByText('UYU 123', { exact: true }).waitFor();
  await summary.getByText('USD 7', { exact: true }).waitFor();
  await summary.getByText('Moneda sin especificar 5', { exact: true }).waitFor();
  await summary.getByText('USD 2 · histórico (estimado)', { exact: true }).waitFor();
  await summary.getByText(/Importe parcial: 1 sin precio registrado/).waitFor();
  assert.equal(await summary.getByText(/135/).count(), 0);
  await nav.getByRole('button', { name: 'Ventas', exact: true }).click();
  await panel.getByText('UYU 0', { exact: true }).waitFor();
  await panel.getByText('×1 · UYU 0', { exact: true }).waitFor();
  await panel.getByText('UYU 123', { exact: true }).first().waitFor();
  await panel.getByText('USD 7', { exact: true }).first().waitFor();
  await panel.getByText('Moneda sin especificar 5', { exact: true }).first().waitFor();
  await panel.getByText('USD 2 · histórico (estimado)', { exact: true }).waitFor();
  await panel.getByText('Registro histórico · importe estimado', { exact: true }).waitFor();
  await panel.getByText('Importes parciales por moneda', { exact: true }).waitFor();
  await panel.getByText('Importe desconocido · Sin precio registrado', { exact: true }).waitFor();
  assert.equal(await panel.getByText(/135/).count(), 0);
  assert.equal(attempts.length, 6);
  console.log('Ventas UI: SKU explícito sin variantes, stock, precio opcional/0/conocido, recibo desconocido y reintento con mismo ID verificados en dist.');
} finally {
  await browser.close();
}
