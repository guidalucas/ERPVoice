import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const clients = [], proveedores = [], pedidos = [], attempts = [], receipts = new Map(), pageErrors = [];
const product = { id: 'sku-party', name: 'Producto UI', unit: 'unit', stockAvailable: 1, stockReserved: 0, price: 1, revision: 0 };
let failRefresh = false, release;
const modes = { '/api/clients': 'ok', '/api/proveedores': 'ok', '/api/pedidos': 'ok' };
const snapshot = () => ({ products: [product], clients, proveedores, pedidos, transactions: [] });
page.on('pageerror', error => pageErrors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'local-party-ui');
  localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
});
await page.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Parties UI', businessCategory: 'general', needsOnboarding: false, hasOwnBusiness: true });
  if (path === '/api/state') {
    if (failRefresh) { failRefresh = false; return json({ error: 'Falló la actualización.' }, 503); }
    return json(snapshot());
  }
  if (Object.hasOwn(modes, path) && request.method() === 'POST') {
    const input = request.postDataJSON(); attempts.push({ path, input });
    assert.equal(typeof input.operationId, 'string'); assert.ok(input.operationId.length);
    if (receipts.has(input.operationId)) {
      const prior = receipts.get(input.operationId); assert.deepEqual({ path, input }, prior.request); return json(prior.result);
    }
    const mode = modes[path]; modes[path] = 'ok';
    if (mode === 'hold') await new Promise(resolve => { release = resolve; });
    if (mode === 'reject') return json({ error: 'Revisá los datos.' }, 409);
    const records = path === '/api/clients' ? clients : path === '/api/proveedores' ? proveedores : pedidos;
    const result = { ...input, id: `${path.split('/').at(-1)}-${records.length + 1}`, debt: 0, revision: 0, fechaPedido: new Date().toISOString() };
    records.push(result); receipts.set(input.operationId, { request: { path, input }, result });
    if (mode === 'lost') return json({ error: 'Creado con respuesta incierta.' }, 503);
    if (mode === 'refresh') failRefresh = true;
    return json(result, 201);
  }
  return json({});
});
await page.route('http://127.0.0.1:5173/**', async route => {
  const path = new URL(route.request().url()).pathname; if (path.startsWith('/api/')) return route.fallback();
  const root = resolve('dist'), file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(`${root}${sep}`)) return route.abort();
  try { return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); }
  catch { return route.fulfill({ status: 404, body: '' }); }
});
const nav = name => page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name, exact: true }).click();
const add = () => page.getByRole('button', { name: 'Agregar', exact: true });
const createOrder = () => page.getByRole('button', { name: 'Crear pedido', exact: true });
try {
  await page.goto('http://127.0.0.1:5173');
  for (const [tab, singular, path, records] of [['Clientes', 'cliente', '/api/clients', clients], ['Proveedores', 'proveedor', '/api/proveedores', proveedores]]) {
    await nav(tab);
    for (const mode of ['lost', 'refresh']) {
      await page.getByRole('button', { name: `Nuevo ${singular}`, exact: true }).first().click();
      await page.getByPlaceholder('Nombre', { exact: true }).fill(`  ${singular} ${mode}  `);
      await page.getByPlaceholder('Notas (opcional)', { exact: true }).fill('  nota capturada  ');
      const start = attempts.length, count = records.length; modes[path] = mode;
      await add().click();
      await page.getByRole('alert').getByText(mode === 'lost' ? 'Creado con respuesta incierta.' : 'Falló la actualización.', { exact: true }).waitFor();
      assert.equal(records.length, count + 1);
      // Hydration exposes the committed entity without removing the creation attempt or retry button.
      await page.getByText(`${singular} ${mode}`, { exact: true }).waitFor({ timeout: 12000 });
      await add().click(); await add().waitFor({ state: 'hidden' });
      assert.deepEqual(attempts[start], attempts[start + 1]); assert.equal(records.length, count + 1);
      assert.equal(attempts[start].input.name, `${singular} ${mode}`); assert.equal(attempts[start].input.notas, 'nota capturada');
    }
    await page.getByRole('button', { name: `Nuevo ${singular}`, exact: true }).click();
    await page.getByPlaceholder('Nombre', { exact: true }).fill('Original'); modes[path] = 'reject';
    const start = attempts.length; await add().click(); await page.getByText('Revisá los datos.', { exact: true }).waitFor();
    await page.getByPlaceholder('Notas (opcional)', { exact: true }).fill('Editada'); modes[path] = 'hold';
    await add().evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => document.querySelector('input[placeholder="Nombre"]')?.disabled);
    assert.equal(await page.getByRole('button', { name: 'Cerrar', exact: true }).isDisabled(), true);
    const deadline = Date.now() + 5000; while (!release && Date.now() < deadline) await page.waitForTimeout(20);
    assert.ok(release); assert.equal(attempts.length, start + 2); assert.notEqual(attempts[start].input.operationId, attempts[start + 1].input.operationId);
    release(); release = undefined; await add().waitFor({ state: 'hidden' });
  }
  await nav('Pedidos'); await page.getByRole('button', { name: '+ Nuevo pedido', exact: true }).first().click();
  await page.getByLabel('O nuevo cliente').fill('  Cliente anidado  ');
  await page.getByLabel('O nuevo proveedor').fill('  Proveedor anidado  ');
  await page.getByLabel(/^Producto/).selectOption(product.id);
  modes['/api/clients'] = 'lost'; const start = attempts.length;
  await createOrder().click(); await page.getByText('Creado con respuesta incierta.', { exact: true }).waitFor();
  await page.getByLabel('Cliente existente').locator('option', { hasText: 'Cliente anidado' }).waitFor({ state: 'attached', timeout: 12000 });
  // An unrelated order edit must retain the pending client attempt.
  await page.getByLabel('Cantidad', { exact: true }).fill('2'); modes['/api/proveedores'] = 'refresh';
  await createOrder().click(); await page.getByText('Falló la actualización.', { exact: true }).waitFor();
  assert.deepEqual(attempts[start], attempts[start + 1]);
  await page.getByLabel('Proveedor (opcional)').locator('option', { hasText: 'Proveedor anidado' }).waitFor({ state: 'attached', timeout: 12000 });
  modes['/api/pedidos'] = 'lost'; await createOrder().click();
  await page.getByText('Creado con respuesta incierta.', { exact: true }).waitFor();
  assert.deepEqual(attempts[start + 2], attempts[start + 3]);
  await createOrder().click(); await createOrder().waitFor({ state: 'hidden' });
  assert.deepEqual(attempts[start + 4], attempts[start + 5]);
  assert.equal(clients.filter(c => c.name === 'Cliente anidado').length, 1);
  assert.equal(proveedores.filter(p => p.name === 'Proveedor anidado').length, 1);
  assert.equal(pedidos.length, 1); assert.equal(pedidos[0].qty, 2); assert.deepEqual(pageErrors, []);
  console.log('Party creation UI passed: frozen UUID/body after committed503 and failed refresh, retry after hydration, edit reset, double-send lock, independent nested attempts and unchanged order retry.');
} finally { await browser.close(); }
