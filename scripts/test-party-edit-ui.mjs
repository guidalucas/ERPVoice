import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const clients = [{ id: 'client-edit', name: 'Cliente inicial', notas: null, debt: 9, accountRevision: 7, metadataRevision: 0 }];
const proveedores = [{ id: 'supplier-edit', name: 'Proveedor inicial', notas: null, metadataRevision: 0 }];
const attempts = [], receipts = new Map(), pageErrors = [];
let mode = 'ok', failRefresh = false, release, stateReads = 0;
const snapshot = () => ({ products: [], clients, proveedores, pedidos: [], transactions: [] });
page.on('pageerror', error => pageErrors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'local-party-edit-ui');
  localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
});
await page.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Edición UI', businessCategory: 'general', needsOnboarding: false, hasOwnBusiness: true });
  if (path === '/api/state') {
    stateReads++;
    if (failRefresh) { failRefresh = false; return json({ error: 'Falló la actualización.' }, 503); }
    return json(snapshot());
  }
  if (/^\/api\/(clients|proveedores)\/[^/]+$/.test(path) && request.method() === 'PUT') {
    const input = request.postDataJSON(); attempts.push({ path, input });
    assert.deepEqual(Object.keys(input).sort(), ['expectedRevision', 'name', 'notas', 'operationId']);
    assert.equal(typeof input.operationId, 'string'); assert.ok(input.operationId.length);
    assert.ok(Number.isSafeInteger(input.expectedRevision));
    if (receipts.has(input.operationId)) {
      const prior = receipts.get(input.operationId); assert.deepEqual({ path, input }, prior.request); return json(prior.result);
    }
    const records = path.startsWith('/api/clients/') ? clients : proveedores;
    const record = records.find(entry => entry.id === path.split('/').at(-1));
    if (mode === 'hold') await new Promise(resolve => { release = resolve; });
    if (!record || input.expectedRevision !== record.metadataRevision) return json({ error: 'El registro cambió. Revisá los datos actuales.', code: 'PARTY_REVISION_MISMATCH' }, 409);
    Object.assign(record, { name: input.name, notas: input.notas, metadataRevision: record.metadataRevision + 1 });
    const result = structuredClone(record); receipts.set(input.operationId, { request: { path, input }, result });
    const currentMode = mode; mode = 'ok';
    if (currentMode === 'lost') {
      record.name = 'Cambio posterior'; record.metadataRevision++;
      return json({ error: 'Edición aplicada con respuesta incierta.' }, 503);
    }
    if (currentMode === 'removed') {
      records.splice(records.indexOf(record), 1);
      return json({ error: 'Edición aplicada con respuesta incierta.' }, 503);
    }
    if (currentMode === 'refresh') failRefresh = true;
    return json(result);
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
const edit = () => page.getByRole('button', { name: 'Editar', exact: true });
const save = () => page.getByRole('button', { name: 'Guardar', exact: true });
const retry = () => page.getByRole('button', { name: 'Reintentar edición', exact: true });
const editName = () => page.getByLabel('Nombre de edición', { exact: true });
const editNotes = () => page.getByLabel('Notas de edición', { exact: true });
const hydrate = async () => {
  const before = stateReads, deadline = Date.now() + 12000;
  while (stateReads === before && Date.now() < deadline) await page.waitForTimeout(30);
  assert.ok(stateReads > before); await page.waitForTimeout(100);
};
try {
  await page.goto('http://127.0.0.1:5173');
  for (const [tab, records, plural] of [['Clientes', clients, 'clientes'], ['Proveedores', proveedores, 'proveedores']]) {
    await nav(tab); const record = records[0];
    await edit().click(); await editName().fill('  Nombre capturado  '); await editNotes().fill('  Notas capturadas  ');
    const start = attempts.length, revision = record.metadataRevision; mode = 'lost';
    await save().click(); await page.getByText('Edición aplicada con respuesta incierta.', { exact: true }).waitFor();
    await page.getByText('Cambio posterior', { exact: true }).waitFor({ timeout: 12000 });
    assert.equal(await editName().inputValue(), '  Nombre capturado  ');
    await retry().click(); await retry().waitFor({ state: 'hidden' });
    assert.deepEqual(attempts[start], attempts[start + 1]); assert.equal(attempts[start].input.expectedRevision, revision);
    assert.equal(attempts[start].input.name, 'Nombre capturado'); assert.equal(attempts[start].input.notas, 'Notas capturadas');
    assert.equal(record.name, 'Cambio posterior'); assert.equal(record.metadataRevision, revision + 2);
    if (tab === 'Clientes') { assert.equal(record.debt, 9); assert.equal(record.accountRevision, 7); }

    await edit().click(); await editNotes().fill('Refresh fallido'); mode = 'refresh'; const refreshStart = attempts.length;
    await save().click(); await page.getByText('Falló la actualización.', { exact: true }).waitFor(); await hydrate();
    await retry().click(); await retry().waitFor({ state: 'hidden' });
    assert.deepEqual(attempts[refreshStart], attempts[refreshStart + 1]);

    // Opening freezes the revision, even if a newer snapshot arrives before the first save.
    await edit().click(); await editName().fill('No sobrescribir'); const staleRevision = record.metadataRevision;
    record.name = 'Editado en otra sesión'; record.metadataRevision++; await hydrate(); const conflictStart = attempts.length;
    await save().click(); await page.getByText('El registro cambió. Revisá los datos actuales.', { exact: true }).waitFor();
    assert.equal(attempts[conflictStart].input.expectedRevision, staleRevision); assert.equal(record.name, 'Editado en otra sesión');
    await retry().click(); await page.getByText('El registro cambió. Revisá los datos actuales.', { exact: true }).waitFor();
    assert.deepEqual(attempts[conflictStart], attempts[conflictStart + 1]);
    await editNotes().fill('Cambio de borrador'); assert.equal(await save().isDisabled(), true);
    await page.getByRole('button', { name: `Revisar ${plural} actuales`, exact: true }).click();
    await edit().click(); assert.equal(await editName().inputValue(), 'Editado en otra sesión');
    await editNotes().fill('Revisado'); mode = 'hold'; const holdStart = attempts.length;
    await save().evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => document.querySelector('input[aria-label="Nombre de edición"]')?.disabled);
    assert.equal(await page.getByRole('button', { name: 'Cancelar', exact: true }).isDisabled(), true);
    const deadline = Date.now() + 5000; while (!release && Date.now() < deadline) await page.waitForTimeout(20);
    assert.ok(release); assert.equal(attempts.length, holdStart + 1); mode = 'ok'; release(); release = undefined;
    await save().waitFor({ state: 'hidden' });
    assert.equal(attempts[holdStart].input.expectedRevision, record.metadataRevision - 1);
    assert.notEqual(attempts[holdStart].input.operationId, attempts[conflictStart].input.operationId);

    await edit().click(); await editNotes().fill('Antes de eliminar'); mode = 'removed'; const removedStart = attempts.length;
    await save().click(); await retry().waitFor(); await edit().waitFor({ state: 'hidden', timeout: 12000 });
    await retry().click(); await retry().waitFor({ state: 'hidden' });
    assert.deepEqual(attempts[removedStart], attempts[removedStart + 1]); assert.equal(records.length, 0);
  }
  assert.deepEqual(pageErrors, []);
  console.log('Party edit UI passed: frozen opening revisions and normalized UUID/body, immutable replay after newer metadata/deletion, failed refresh, stale conflict review, draft-edit reset, reachable missing-card retry and synchronous double-send lock.');
} finally { await browser.close(); }
