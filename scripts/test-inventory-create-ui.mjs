import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import ts from 'typescript';

// Compile an in-memory contract fixture against the public API types.
const fixturePath = resolve('src/inventory-attribute-contract.test.ts');
const fixture = `import type { InventoryAttribute, Product } from './domain/types';
import type { ProductInput, ProductModelInput } from './services/productService';
const attributes = {
  color: { state: 'known', type: 'text', value: 'rojo' },
  peso: { state: 'known', type: 'number', value: 2, unit: 'kg' },
  lavable: { state: 'known', type: 'boolean', value: true },
  material: { state: 'unknown', type: 'text' },
  medida: { state: 'not_applicable', type: 'number' },
  vigente: { state: 'missing', type: 'boolean' },
} satisfies Record<string, InventoryAttribute>;
const product: Product = { id: 'typed', name: 'Typed', attributes, stockAvailable: 0, stockReserved: 0, price: 0 };
const input: ProductInput = { name: product.name, attributes };
const model: ProductModelInput = { productType: 'Tipo', productModel: 'Modelo', attributes, variants: [] };
// @ts-expect-error Known attributes require a value.
const absent: InventoryAttribute = { state: 'known', type: 'text' };
// @ts-expect-error The value must match the declared attribute type.
const wrong: InventoryAttribute = { state: 'known', type: 'number', value: '2' };
// @ts-expect-error Non-known attributes cannot carry a value.
const unknown: InventoryAttribute = { state: 'unknown', type: 'text', value: 'rojo' };
void [input, model, absent, wrong, unknown];`;
const config = ts.readConfigFile(resolve('tsconfig.app.json'), ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const host = ts.createCompilerHost(parsedConfig.options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => resolve(fileName) === fixturePath
  ? ts.createSourceFile(fileName, fixture, languageVersion, true)
  : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
const program = ts.createProgram([...parsedConfig.fileNames, fixturePath], parsedConfig.options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (name) => name, getNewLine: () => '\n' }));

// Exercise the actual built React app in Edge with an isolated, idempotent fake API.
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const products = [];
const attempts = [];
const receipts = new Map();
let category = 'general';
let mode = 'ok';
let failNextRefresh = false;
let releaseRequest;
const snapshot = () => ({ products, clients: [], proveedores: [], pedidos: [], transactions: [] });
await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'local-create-test');
  localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
});
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Creación local', businessCategory: category, needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
  if (path === '/api/state') {
    if (failNextRefresh) { failNextRefresh = false; return json({ error: 'Vista no disponible. Reintentá.' }, 503); }
    return json(snapshot());
  }
  if ((path === '/api/products' || path === '/api/products/model') && request.method() === 'POST') {
    const input = request.postDataJSON();
    attempts.push({ path, input });
    assert.match(input.operationId, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
    if (receipts.has(input.operationId)) {
      const receipt = receipts.get(input.operationId);
      assert.deepEqual({ path, input }, receipt.request, 'Retries preserve endpoint, ID and exact body.');
      return json(receipt.result);
    }
    if (mode === 'conflict') return json({ error: 'Ya existe un SKU con esa identidad.' }, 409);
    if (mode === 'hold') await new Promise((resolve) => { releaseRequest = resolve; });
    const variants = path.endsWith('/model') ? input.variants : [input];
    const result = variants.map((variant) => ({ id: `created-${products.length + 1}`, name: input.name || `${input.productType} ${input.productModel}`, productType: input.productType, productModel: input.productModel, size: variant.size ?? null, stockAvailable: variant.stockAvailable, stockReserved: variant.stockReserved ?? 0, price: variant.price, revision: 0, identityFingerprint: 'created-fingerprint', unit: 'unit', priceCurrency: 'XXX' }));
    // Assign distinct IDs for the members of a model batch.
    result.forEach((product, index) => { product.id = `created-${products.length + index + 1}`; });
    products.push(...result);
    const response = path.endsWith('/model') ? result : result[0];
    receipts.set(input.operationId, { request: { path, input }, result: structuredClone(response) });
    if (mode === 'lost') { mode = 'ok'; return json({ error: 'Resultado incierto. Reintentá.' }, 503); }
    if (mode === 'refresh') { mode = 'ok'; failNextRefresh = true; }
    return json(response, 201);
  }
  return json({});
});
await page.route('http://127.0.0.1:5173/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith('/api/')) return route.fallback();
  const root = resolve('dist');
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(`${root}${sep}`)) return route.abort();
  try { return route.fulfill({ status: 200, body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); }
  catch { return route.fulfill({ status: 404, body: '' }); }
});
const openInventory = async () => {
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario' }).click();
};
const openSku = async (name) => {
  await page.getByRole('button', { name: '+ Nuevo producto' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo producto', exact: true });
  await dialog.getByLabel('Nombre para mostrar').fill(name);
  return dialog;
};
try {
  await openInventory();
  let dialog = await openSku('Producto vacío');
  mode = 'lost';
  await dialog.getByRole('button', { name: 'Crear producto' }).click();
  await dialog.getByRole('alert').getByText('Resultado incierto. Reintentá.').waitFor();
  assert.equal(products.length, 1);
  assert.equal(attempts[0].input.stockAvailable, 0);
  assert.equal(attempts[0].input.stockReserved, 0);
  await dialog.getByRole('button', { name: 'Crear producto' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(products.length, 1);

  dialog = await openSku('Borrador inicial');
  mode = 'lost';
  await dialog.getByRole('button', { name: 'Crear producto' }).click();
  await dialog.getByRole('alert').waitFor();
  await dialog.getByLabel('Nombre para mostrar').fill('Borrador modificado');
  await dialog.getByRole('button', { name: 'Crear producto' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.notEqual(attempts[2].input.operationId, attempts[3].input.operationId);
  assert.equal(attempts[3].input.name, 'Borrador modificado');

  dialog = await openSku('Vista pendiente');
  mode = 'refresh';
  const skuRefreshStart = attempts.length;
  await dialog.getByRole('button', { name: 'Crear producto' }).click();
  await dialog.getByRole('alert').getByText('Vista no disponible. Reintentá.').waitFor();
  await page.getByRole('checkbox', { name: 'Seleccionar producto Vista pendiente' }).waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Crear producto' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(attempts[skuRefreshStart], attempts[skuRefreshStart + 1]);
  assert.equal(products.filter((product) => product.name === 'Vista pendiente').length, 1);

  dialog = await openSku('Conflicto conservado');
  mode = 'conflict';
  await dialog.getByRole('button', { name: 'Crear producto' }).click();
  await dialog.getByRole('alert').getByText(/Ya existe un SKU/).waitFor();
  assert.equal(await dialog.getByLabel('Nombre para mostrar').inputValue(), 'Conflicto conservado');
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const cancelledCount = attempts.length;
  dialog = await openSku('Cancelar sin enviar');
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(attempts.length, cancelledCount);

  category = 'indumentaria';
  await openInventory();
  await page.getByRole('button', { name: '+ Nuevo modelo' }).click();
  dialog = page.getByRole('dialog', { name: 'Nuevo modelo', exact: true });
  await dialog.getByLabel('Tipo de prenda').fill('Camiseta');
  await dialog.getByLabel('Modelo', { exact: true }).fill('Creación');
  await dialog.getByLabel('Talle', { exact: true }).fill('S');
  await dialog.getByRole('button', { name: /Agregar otro/ }).click();
  await dialog.getByLabel('Talle', { exact: true }).nth(1).fill('M');
  await dialog.getByLabel('Stock disponible', { exact: true }).nth(1).fill('7');
  mode = 'refresh';
  const modelStart = attempts.length;
  await dialog.getByRole('button', { name: 'Crear modelo', exact: true }).click();
  await dialog.getByRole('alert').getByText('Vista no disponible. Reintentá.').waitFor();
  // Background sync hydrates the applied model; local duplicate checks must permit its retry.
  await page.getByRole('button', { name: 'Agregar talle a Camiseta Creación' }).waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Crear modelo', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(attempts[modelStart], attempts[modelStart + 1]);
  assert.deepEqual(attempts[modelStart].input.variants.map((v) => v.stockAvailable), [0, 7]);
  assert.equal(products.filter((product) => product.productModel === 'Creación').length, 2);

  await page.getByRole('button', { name: 'Agregar talle a Camiseta Creación' }).click();
  dialog = page.getByRole('dialog', { name: 'Agregar talle', exact: true });
  await dialog.getByLabel('Talle', { exact: true }).fill('L');
  mode = 'lost';
  const variantStart = attempts.length;
  await dialog.getByRole('button', { name: 'Agregar talle', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  await page.getByRole('checkbox', { name: 'Seleccionar talle L de Camiseta Creación' }).waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Agregar talle', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(attempts[variantStart], attempts[variantStart + 1]);
  assert.equal(products.filter((product) => product.productModel === 'Creación' && product.size === 'L').length, 1);

  await page.getByRole('button', { name: 'Agregar talle a Camiseta Creación' }).click();
  dialog = page.getByRole('dialog', { name: 'Agregar talle', exact: true });
  await dialog.getByLabel('Talle', { exact: true }).fill('XL');
  mode = 'hold';
  await dialog.getByRole('button', { name: 'Agregar talle', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#product-form fieldset')?.disabled);
  assert.equal(await dialog.getByRole('button', { name: 'Cancelar', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByLabel('Talle', { exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Cerrar modal' }).isDisabled(), true);
  releaseRequest();
  await dialog.waitFor({ state: 'hidden' });
  console.log('Inventory creation UI passed in Edge: zero stock, atomic variants, applied503 stable retry, failed refresh + hydrated duplicate, changed draft, 409, cancel, and in-flight controls.');
} finally { await browser.close(); }
