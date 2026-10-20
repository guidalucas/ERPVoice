import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Exercise the production bundle with API responses controlled at the browser boundary.
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const products = ['S', 'M', 'L'].map((size, index) => ({
  id: `sku-${size}`, identityFingerprint: `fingerprint-${size}`,
  revision: 7 + index,
  name: 'Producto Compartido', productType: 'Producto', productModel: 'Compartido', size,
  stockAvailable: index ? 10 : 3, stockReserved: 2, price: 98765,
  unit: 'unit', priceCurrency: index === 0 ? 'USD' : index === 1 ? 'UYU' : 'XXX',
}));
const attempts = [];
const transactions = [];
let failRefresh = false;
let invalidReceipt = false;
const receipts = new Map();
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
  if (path === '/api/state') {
    if (failRefresh) { failRefresh = false; return json({ error: 'Fallo temporal de actualización.' }, 503); }
    return json(state());
  }
  if (path === '/api/state/apply') throw new Error('Retired manual endpoint was called');
  if (path === '/api/operations' && request.method() === 'POST') {
    const input = request.postDataJSON();
    attempts.push(input);
    if (attempts.length === 2) return json({ error: 'La sesión venció al recuperar el recibo.' }, 401);
    if (receipts.has(input.operationId)) return json(receipts.get(input.operationId));
    const action = input.actions[0];
    const product = products.find((item) => item.id === action.target.skuId);
    assert.ok(product);
    assert.equal(input.contractVersion, 1);
    assert.equal(input.businessId, '5491100000000');
    assert.equal(action.type, 'stock.sell');
    assert.equal(action.target.kind, 'existing');
    assert.equal(action.target.expectedFingerprint, product.identityFingerprint);
    assert.equal(action.target.expectedRevision, product.revision);
    assert.equal(action.quantity.unit, product.unit);
    assert.equal(Object.hasOwn(action, 'price'), false);
    if (action.salePrice) assert.equal(action.salePrice.currency, product.priceCurrency);
    assert.ok(action.quantity.value <= product.stockAvailable);
    product.stockAvailable -= action.quantity.value;
    product.revision++;
    transactions.push({ id: `sale-${transactions.length}`, timestamp: new Date().toISOString(), sourceText: input.source.text, summary: 'Venta registrada', actions: [{ type: 'sell', productId: product.id, productName: product.name, size: product.size, unit: product.unit, qty: action.quantity.value, priceCurrency: action.salePrice?.currency ?? product.priceCurrency, ...(action.salePrice ? { price: action.salePrice.amount } : {}), salePriceKnown: Object.hasOwn(action, 'salePrice') }] });
    const receipt = { contractVersion: 1, operationId: input.operationId, businessId: input.businessId, status: 'applied', domain: 'inventory',
      domainResult: { contractVersion: 1, operationId: 'universal-child:sales-fixture', businessId: input.businessId, status: 'applied',
        items: [{ itemId: action.itemId, type: action.type, skuId: product.id, quantity: action.quantity,
          stockAvailable: product.stockAvailable, stockReserved: product.stockReserved,
          price: action.salePrice?.amount ?? null, currency: action.salePrice?.currency ?? null,
          totalAmount: action.salePrice ? action.salePrice.amount * action.quantity.value : null }] } };
    receipts.set(input.operationId, receipt);
    if (attempts.length === 1) return json({ error: 'Fallo temporal después de aplicar la venta.' }, 503);
    if (invalidReceipt) { invalidReceipt = false; return json({}); }
    return json(receipt);
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
  assert.equal(await dialog.getByLabel('Cantidad', { exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Cancelar', exact: true }).isDisabled(), true);
  assert.equal(products[1].stockAvailable, 8);
  await page.reload();
  await page.getByRole('button', { name: 'Registrar venta', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Registrar venta', exact: true });
  await dialog.getByRole('status').getByText(/Movimiento recuperado: Venta manual: -2 Producto Compartido M/).waitFor();
  assert.equal(await dialog.getByLabel('Cantidad', { exact: true }).inputValue(), '2');
  assert.equal(await dialog.getByLabel('Cantidad', { exact: true }).isDisabled(), true);
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/operations' && response.status() === 401),
    dialog.getByRole('button', { name: 'Reintentar venta' }).click(),
  ]);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(products[1].stockAvailable, 8);
  assert.equal(transactions.length, 1);
  // A rejected recovery must preserve the earlier uncertain attempt across session recovery.
  await page.reload();
  await page.getByRole('button', { name: 'Registrar venta', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Registrar venta', exact: true });
  await dialog.getByRole('status').getByText(/Movimiento recuperado/).waitFor();
  assert.equal(await dialog.getByLabel('Cantidad', { exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Reintentar venta' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[2], attempts[0]);
  assert.equal(transactions.length, 1);
  assert.ok(attempts[0].operationId);
  assert.equal(attempts[0].operationId, attempts[1].operationId);
  assert.deepEqual(attempts[0].actions, attempts[1].actions);
  assert.deepEqual(attempts[0].actions[0].target, { kind: 'existing', skuId: 'sku-M', expectedRevision: 8, expectedFingerprint: 'fingerprint-M' });
  assert.equal(Object.hasOwn(attempts[0].actions[0], 'salePrice'), false);
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
    if (price === '0') invalidReceipt = true;
    await dialog.getByRole('button', { name: '− Confirmar venta' }).click();
    if (price === '0') {
      await dialog.getByText(/No pudimos verificar el recibo/).waitFor();
      const malformedAttempt = attempts.at(-1);
      assert.equal(await dialog.getByLabel('Cantidad', { exact: true }).isDisabled(), true);
      // Catalog drift cannot replace the frozen concurrency guards during recovery.
      products[1].revision += 3;
      products[1].identityFingerprint = 'fingerprint-M-after-drift';
      products[1].price = 55555;
      await page.reload();
      await page.getByRole('button', { name: 'Registrar venta', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Registrar venta', exact: true });
      await dialog.getByRole('status').getByText(/Movimiento recuperado/).waitFor();
      failRefresh = true;
      await dialog.getByRole('button', { name: 'Reintentar venta' }).click();
      await dialog.getByText(/El movimiento ya fue registrado/).waitFor();
      assert.deepEqual(attempts.at(-1), malformedAttempt);
      const writesBeforeRefresh = attempts.length;
      assert.equal(await dialog.getByLabel('Precio de venta unitario (opcional)').isDisabled(), true);
      await page.reload();
      await page.getByRole('button', { name: 'Registrar venta', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Registrar venta', exact: true });
      await dialog.getByRole('button', { name: 'Actualizar datos' }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(attempts.length, writesBeforeRefresh);
    }
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(attempts.at(-1).actions[0].salePrice, { amount: Number(price), currency: products.find(product => product.size === size).priceCurrency });
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
  assert.equal(attempts.length, 8);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('manual-inventory-attempt:')).length), 0);
  await nav.getByRole('button', { name: 'Inicio', exact: true }).click();
  // A storage quota error blocks HTTP until an exact recoverable intent can be saved.
  dialog = await openSale();
  await page.evaluate(() => {
    window.restoreManualStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('manual-inventory-attempt:')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return window.restoreManualStorage.call(this, key, value);
    };
  });
  await dialog.getByRole('button', { name: '− Confirmar venta' }).click();
  await dialog.getByText(/No pudimos guardar la referencia recuperable/).waitFor();
  assert.equal(attempts.length, 8);
  await page.evaluate(() => { Storage.prototype.setItem = window.restoreManualStorage; });
  // Reload discards the unsent in-memory attempt. Foreign tenant/actor/mode keys stay isolated.
  const localKey = 'manual-inventory-attempt:' + JSON.stringify(['5491100000000', '5491100000000', 'venta']);
  const sample = { version: 1, acknowledged: false, operation: { operationId: 'foreign-attempt', source: { channel: 'manual', text: 'Foreign attempt' }, actions: [{ itemId: 'movement', type: 'stock.sell', target: { kind: 'existing', skuId: 'sku-M', expectedRevision: 8, expectedFingerprint: 'foreign' }, quantity: { value: 1, unit: 'unit' } }] } };
  await page.evaluate(({ sample }) => {
    for (const scope of [['foreign-tenant', '5491100000000', 'venta'], ['5491100000000', 'foreign-actor', 'venta'], ['5491100000000', '5491100000000', 'ingreso']]) {
      localStorage.setItem('manual-inventory-attempt:' + JSON.stringify(scope), JSON.stringify(sample));
    }
  }, { sample });
  await page.reload();
  dialog = await openSale();
  assert.equal(await dialog.getByRole('status').count(), 0);
  assert.equal(await dialog.getByLabel('Cantidad', { exact: true }).isEnabled(), true);
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.evaluate(key => localStorage.setItem(key, '{"version":1,"operation":{}}'), localKey);
  await page.reload();
  await page.getByRole('button', { name: 'Registrar venta', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Registrar venta', exact: true });
  await dialog.getByText(/La referencia guardada del movimiento no es válida/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Reintentar venta' }).isEnabled(), false);
  assert.equal(attempts.length, 8);
  await page.evaluate(key => localStorage.removeItem(key), localKey);
  await page.reload();
  await nav.getByRole('button', { name: 'Inicio', exact: true }).click();
  // A stale or incomplete snapshot must never silently omit concurrency guards.
  delete products[1].revision;
  await page.reload();
  dialog = await openSale();
  await dialog.getByRole('alert').getByText(/Faltan datos de revisión/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '− Confirmar venta' }).isEnabled(), false);
  assert.equal(attempts.length, 8);
  console.log('Ventas UI: SKU explícito sin variantes, stock, precio opcional/0/conocido, recibo desconocido y reintento con mismo ID verificados en dist.');
} finally {
  await browser.close();
}
