import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
async function fixture({ closed = false, unit = 'unit', changedSchema = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [], puts = [], receipts = new Map();
  let mode = 'ok', failRead = false;
  const product = { id: 'private-sku-id', name: 'Convertidor', revision: 4, identityFingerprint: 'private-fingerprint', unit: 'unit', stockAvailable: 7, stockReserved: 2, price: 19, priceCurrency: 'USD', attributes: { legacy: { type: 'number', state: 'unknown', unit: 'mm' } } };
  const family = { familyId: 'private-family-id', version: 2, schema: { name: 'Componentes', unit: 'unit', allowAdditionalAttributes: true, attributes: { material: { type: 'text', required: true, allowedStates: ['known'] }, voltage: { type: 'number', required: true, allowedStates: ['known'], unit: 'v', values: [0, 12] }, certified: { type: 'boolean', required: true, allowedStates: ['known'] }, length: { type: 'number', required: false, allowedStates: ['known', 'unknown'], unit: 'mm' } } } };
  family.schema.allowAdditionalAttributes = !closed; family.schema.unit = unit;
  if (changedSchema) { product.attributes.length = { type: 'number', state: 'known', value: 100, unit: 'mm' }; product.attributes.material = { type: 'number', state: 'known', value: 0 }; family.schema.attributes.length.unit = 'cm'; }
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('erpvoice.auth.token', 'assignment-ui'); localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000'); });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Assignment UI', businessCategory: 'general', needsOnboarding: false, hasOwnBusiness: true });
    if (path === '/api/state') { if (failRead) { failRead = false; return json({ error: 'Falló la lectura posterior' }, 503); } return json({ products: [product], clients: [], proveedores: [], pedidos: [], transactions: [] }); }
    if (path === '/api/inventory/families') return json({ families: [family] });
    if (path === `/api/products/${product.id}` && req.method() === 'PUT') {
      const body = req.postDataJSON(); puts.push(body);
      assert.deepEqual(Object.keys(body).sort(), ['attributes', 'expectedFingerprint', 'expectedRevision', 'family', 'operationId', 'reason']);
      const stored = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('product-family-assignment:'))?.[1]);
      assert.equal(JSON.parse(stored).attempt.adjustment.operationId, body.operationId, 'attempt must be durable before HTTP');
      if (mode === 'conflict') { mode = 'ok'; product.revision++; return json({ error: 'La revisión cambió' }, 409); }
      if (!receipts.has(body.operationId)) {
        assert.equal(body.expectedRevision, product.revision); assert.equal(body.expectedFingerprint, product.identityFingerprint);
        const attributes = structuredClone(body.attributes);
        for (const attr of Object.values(attributes)) if (attr.type === 'text' && attr.state === 'known') attr.value = attr.value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
        Object.assign(product, { attributes, family: structuredClone(body.family), revision: product.revision + 1 });
        receipts.set(body.operationId, { body, result: structuredClone(product) });
      } else assert.deepEqual(body, receipts.get(body.operationId).body);
      if (mode === 'uncertain') { mode = 'ok'; return json({ error: 'Resultado incierto' }, 503); }
      if (mode === 'read-failure') { mode = 'ok'; failRead = true; }
      return json({ ...receipts.get(body.operationId).result, productType: null, productModel: null, size: null });
    }
    return json({});
  });
  await page.route('http://127.0.0.1:5173/**', async route => {
    const path = new URL(route.request().url()).pathname; if (path.startsWith('/api/')) return route.fallback();
    const root = resolve('dist'), file = resolve(root, `.${path === '/' ? '/index.html' : path}`); if (!file.startsWith(`${root}${sep}`)) return route.abort();
    try { return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const dialog = page.getByRole('dialog', { name: 'Familia de SKU existente', exact: true });
  async function open() { await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario', exact: true }).click(); await page.getByRole('button', { name: 'Familia de SKU existente', exact: true }).click(); await dialog.waitFor(); await dialog.getByLabel('SKU existente', { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Releer estado y familias', exact: true }).waitFor({ state: 'visible' }); }
  const consent = () => dialog.getByRole('checkbox', { name: 'Revisé el antes y después y autorizo cambiar la familia y atributos de este SKU.', exact: true });
  const submit = () => dialog.getByRole('button', { name: 'Confirmar familia del SKU', exact: true });
  async function fill() { await dialog.getByLabel('SKU existente', { exact: true }).selectOption(product.id); await dialog.getByLabel('Familia y versión', { exact: true }).selectOption(`${family.familyId}@2`); await dialog.getByLabel('Valor de material', { exact: true }).fill('  ACERO   Inoxidable  '); await dialog.getByLabel('Valor de voltage', { exact: true }).selectOption('0'); await dialog.getByLabel('Valor de certified', { exact: true }).selectOption('false'); await dialog.getByLabel('Estado de length', { exact: true }).selectOption('unknown'); await dialog.getByLabel('Motivo obligatorio', { exact: true }).fill('Clasificación revisada'); }
  await page.goto('http://127.0.0.1:5173'); await open();
  return { page, dialog, product, family, puts, errors, open, fill, consent, submit, setMode: value => { mode = value; } };
}
try {
  {
    const f = await fixture(); await f.fill();
    const review = f.dialog.getByRole('region', { name: 'Revisión antes y después' });
    assert.match(await review.innerText(), /Componentes · versión 2/); assert.match(await review.innerText(), /acero inoxidable/); assert.match(await review.innerText(), /0 v/); assert.match(await review.innerText(), /No \(false\)/); assert.match(await review.innerText(), /Desconocido mm/); assert.doesNotMatch(await review.innerText(), /private-/);
    await f.consent().check(); await f.dialog.getByLabel('Motivo obligatorio', { exact: true }).fill('Nueva revisión'); assert.equal(await f.consent().isChecked(), false);
    await f.consent().check(); await f.submit().dblclick(); await f.dialog.getByRole('status').waitFor(); assert.equal(f.puts.length, 1); assert.equal(f.puts[0].attributes.material.value, 'acero inoxidable'); assert.equal(f.puts[0].attributes.voltage.value, 0); assert.equal(f.puts[0].attributes.certified.value, false); assert.deepEqual(f.puts[0].attributes.legacy, { state: 'unknown', type: 'number', unit: 'mm' }); assert.deepEqual(f.errors, []);
    await f.dialog.getByRole('button', { name: 'Preparar otro cambio', exact: true }).click(); await f.fill(); await f.consent().check(); await f.submit().click(); await f.dialog.getByRole('status').waitFor(); assert.equal(f.puts.length, 2); assert.equal(f.puts[1].expectedRevision, 5); assert.notEqual(f.puts[0].operationId, f.puts[1].operationId); await f.page.close();
  }
  {
    const f = await fixture(); await f.fill(); f.setMode('uncertain'); await f.consent().check(); await f.submit().click(); await f.dialog.getByText('Resultado incierto', { exact: true }).waitFor();
    await f.page.reload(); await f.open(); assert.equal(await f.consent().isChecked(), false); await f.consent().check(); await f.dialog.getByRole('button', { name: 'Reintentar la misma operación', exact: true }).click(); await f.dialog.getByRole('status').waitFor(); assert.equal(f.puts.length, 2); assert.deepEqual(f.puts[0], f.puts[1]); await f.page.close();
  }
  {
    const f = await fixture(); await f.fill(); f.setMode('conflict'); await f.consent().check(); await f.submit().click(); await f.dialog.getByText('La revisión cambió', { exact: true }).waitFor(); assert.equal(await f.consent().isEnabled(), false);
    await f.dialog.getByRole('button', { name: 'Releer estado y familias', exact: true }).click(); await f.consent().check(); await f.submit().click(); await f.dialog.getByRole('status').waitFor(); assert.equal(f.puts.length, 2); assert.notEqual(f.puts[0].operationId, f.puts[1].operationId); assert.equal(f.puts[1].expectedRevision, 5); await f.page.close();
  }
  {
    const f = await fixture(); await f.fill(); f.setMode('read-failure'); await f.consent().check(); await f.submit().click(); await f.dialog.getByRole('status').waitFor(); await f.dialog.getByText(/Cambio aplicado. Falló la lectura posterior/).waitFor(); await f.dialog.getByRole('button', { name: 'Releer estado y familias', exact: true }).click(); assert.equal(f.puts.length, 1); await f.page.close();
  }
  {
    const f = await fixture({ closed: true }); await f.fill(); assert.equal(await f.consent().isEnabled(), false); await f.dialog.getByRole('checkbox', { name: 'Quitar explícitamente legacy', exact: true }).check(); await f.consent().check(); await f.submit().click(); await f.dialog.getByRole('status').waitFor(); assert.equal(Object.hasOwn(f.puts[0].attributes, 'legacy'), false); await f.page.close();
  }
  {
    const f = await fixture({ unit: 'box' }); await f.fill(); assert.equal(await f.consent().isEnabled(), false); assert.equal(f.puts.length, 0); await f.page.close();
  }
  {
    const f = await fixture({ changedSchema: true }); await f.dialog.getByLabel('SKU existente', { exact: true }).selectOption(f.product.id); await f.dialog.getByLabel('Familia y versión', { exact: true }).selectOption(`${f.family.familyId}@2`);
    assert.equal(await f.dialog.getByLabel('Valor de length', { exact: true }).inputValue(), ''); assert.equal(await f.dialog.getByLabel('Valor de material', { exact: true }).inputValue(), ''); assert.equal(await f.consent().isEnabled(), false); assert.equal(f.puts.length, 0); await f.page.close();
  }
  {
    const f = await fixture(); await f.fill(); f.setMode('uncertain'); await f.consent().check(); await f.submit().click(); await f.dialog.getByText('Resultado incierto', { exact: true }).waitFor();
    await f.page.evaluate(() => { const key = Object.keys(localStorage).find(k => k.startsWith('product-family-assignment:')); const saved = JSON.parse(localStorage.getItem(key)); saved.attempt.adjustment.stockAvailable = 0; localStorage.setItem(key, JSON.stringify(saved)); });
    await f.page.reload(); await f.open(); await f.dialog.getByText(/El borrador guardado está corrupto/).waitFor(); assert.equal(await f.consent().isEnabled(), false); assert.equal(f.puts.length, 1); await f.page.close();
  }
  console.log('Product family assignment UI checks passed.');
} finally { await browser.close(); }

