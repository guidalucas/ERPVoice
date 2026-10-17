import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const clients = [], proveedores = [], pedidos = [], attempts = [], receipts = new Map(), pageErrors = [];
let mode = 'ok', failRefresh = false, release, stateReads = 0;
const snapshot = () => ({ products: [], clients, proveedores, pedidos, transactions: [] });
const party = (id, name, metadataRevision = 0) => ({ id, name, notas: `Nota ${id}`, metadataRevision, accountRevision: 3, debt: 0 });
page.on('pageerror', error => pageErrors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'local-party-delete-merge-ui');
  localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
});
await page.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Delete merge UI', businessCategory: 'general', needsOnboarding: false, hasOwnBusiness: true });
  if (path === '/api/state') {
    stateReads++; if (failRefresh) { failRefresh = false; return json({ error: 'Falló la actualización.' }, 503); }
    return json(snapshot());
  }
  if (/^\/api\/(clients|proveedores)\/[^/]+$/.test(path) && (request.method() === 'DELETE' || path.endsWith('/merge'))) {
    const input = request.postDataJSON(), isClient = path.startsWith('/api/clients/'), isMerge = path.endsWith('/merge');
    attempts.push({ path, input }); assert.ok(input.operationId); assert.equal(typeof input.operationId, 'string');
    if (receipts.has(input.operationId)) {
      const prior = receipts.get(input.operationId); assert.deepEqual({ path, input }, prior.request);
      return json(isMerge ? { ...snapshot(), operationResult: prior.result } : prior.result);
    }
    if (mode === 'hold') await new Promise(resolve => { release = resolve; });
    const records = isClient ? clients : proveedores;
    if (mode === 'conflict') return json({ error: 'La revisión cambió.', code: 'PARTY_REVISION_MISMATCH' }, 409);
    let result;
    if (isMerge) {
      const expectedKeys = isClient ? ['expectedKeepMetadataRevision', 'expectedKeepRevision', 'expectedMergeMetadataRevision', 'expectedMergeRevision', 'keepId', 'mergeId', 'operationId'] : ['expectedKeepRevision', 'expectedMergeRevision', 'keepId', 'mergeId', 'operationId', 'reason'];
      assert.deepEqual(Object.keys(input).sort(), expectedKeys.sort());
      const keep = records.find(record => record.id === input.keepId), source = records.find(record => record.id === input.mergeId);
      assert.ok(keep && source);
      assert.equal(input.expectedKeepRevision, isClient ? keep.accountRevision : keep.metadataRevision);
      assert.equal(input.expectedMergeRevision, isClient ? source.accountRevision : source.metadataRevision);
      if (isClient) {
        assert.equal(input.expectedKeepMetadataRevision, keep.metadataRevision); assert.equal(input.expectedMergeMetadataRevision, source.metadataRevision);
        keep.debt += source.debt; keep.accountRevision++;
      } else assert.match(input.reason, /Fusión explícita/);
      keep.metadataRevision++; keep.notas += `\n${source.notas}`;
      for (const order of pedidos) if (order[isClient ? 'clienteId' : 'proveedorId'] === source.id) order[isClient ? 'clienteId' : 'proveedorId'] = keep.id;
      records.splice(records.indexOf(source), 1); result = { removedId: source.id, party: structuredClone(keep) };
    } else {
      assert.deepEqual(Object.keys(input).sort(), (isClient ? ['operationId', 'expectedRevision', 'expectedAccountRevision', 'reason'] : ['operationId', 'expectedRevision', 'reason']).sort());
      const record = records.find(entry => entry.id === path.split('/').at(-1)); assert.ok(record);
      if (record.guard) return json({ error: record.guard, code: isClient ? 'CLIENT_HAS_BALANCE' : 'SUPPLIER_HAS_ORDERS' }, 409);
      if (input.expectedRevision !== record.metadataRevision || (isClient && input.expectedAccountRevision !== record.accountRevision)) return json({ error: 'La revisión cambió.', code: 'PARTY_REVISION_MISMATCH' }, 409);
      assert.match(input.reason, /Eliminación explícita/);
      records.splice(records.indexOf(record), 1);
      if (!isClient) for (const order of pedidos) if (order.proveedorId === record.id) order.proveedorId = null;
      result = { removedId: record.id, metadataRevision: record.metadataRevision + 1 };
    }
    receipts.set(input.operationId, { request: { path, input }, result }); const appliedMode = mode; mode = 'ok';
    if (appliedMode === 'lost') return json({ error: 'Cambio aplicado con respuesta incierta.' }, 503);
    if (appliedMode === 'refresh') failRefresh = true;
    return json(isMerge ? { ...snapshot(), operationResult: result } : result);
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
const retryDelete = () => page.getByRole('button', { name: 'Reintentar eliminación', exact: true });
const retryMerge = () => page.getByRole('button', { name: 'Reintentar fusión', exact: true });
const deleteButton = () => page.getByRole('button', { name: 'Eliminar', exact: true });
const hydrate = async () => {
  const before = stateReads, deadline = Date.now() + 12000;
  while (stateReads === before && Date.now() < deadline) await page.waitForTimeout(30);
  assert.ok(stateReads > before); await page.waitForTimeout(100);
};
const holdReady = async () => {
  const deadline = Date.now() + 5000; while (!release && Date.now() < deadline) await page.waitForTimeout(20); assert.ok(release);
};
try {
  await page.goto('http://127.0.0.1:5173');
  for (const [tab, records, plural, singular, label] of [['Clientes', clients, 'clientes', 'cliente', 'Cliente'], ['Proveedores', proveedores, 'proveedores', 'proveedor', 'Proveedor']]) {
    await nav(tab);
    if (tab === 'Proveedores') await page.getByText('Eliminar un proveedor desvincula sus pedidos, sin eliminarlos.', { exact: true }).waitFor();
    for (const failure of ['lost', 'refresh']) {
      const record = party(`${singular}-${failure}`, `${label} ${failure}`, 4); records.push(record);
      if (tab === 'Proveedores') pedidos.push({ id: 'order-delete', clienteId: 'other-client', proveedorId: record.id, producto: 'Pedido desvinculado', qty: 1, estado: 'pendiente', fechaPedido: new Date().toISOString() });
      await page.getByText(record.name, { exact: true }).waitFor({ timeout: 12000 }); const start = attempts.length; mode = failure;
      await deleteButton().click(); await page.getByText(failure === 'lost' ? 'Cambio aplicado con respuesta incierta.' : 'Falló la actualización.', { exact: true }).waitFor();
      await deleteButton().waitFor({ state: 'hidden', timeout: 12000 }); await retryDelete().click(); await retryDelete().waitFor({ state: 'hidden' });
      assert.deepEqual(attempts[start], attempts[start + 1]); assert.equal(attempts[start].input.expectedRevision, 4); assert.equal(records.length, 0);
      if (tab === 'Clientes') assert.equal(attempts[start].input.expectedAccountRevision, 3);
      else assert.equal(pedidos.at(-1).proveedorId, null);
    }
    const guarded = party(`${singular}-guard`, `${label} protegido`, 2); guarded.guard = tab === 'Clientes' ? 'El cliente tiene saldo.' : 'El proveedor tiene pedidos protegidos.'; records.push(guarded);
    await page.getByText(guarded.name, { exact: true }).waitFor({ timeout: 12000 }); const guardStart = attempts.length;
    await deleteButton().click(); await page.getByText(guarded.guard, { exact: true }).waitFor();
    delete guarded.guard; guarded.metadataRevision++; guarded.accountRevision++; await hydrate();
    await retryDelete().click(); await page.getByText('La revisión cambió.', { exact: true }).waitFor();
    assert.deepEqual(attempts[guardStart], attempts[guardStart + 1]); assert.equal(records.length, 1);
    await page.getByRole('button', { name: 'Revisar eliminación', exact: true }).click(); mode = 'hold'; const holdStart = attempts.length;
    await deleteButton().evaluate(button => { button.click(); button.click(); }); await holdReady();
    assert.equal(attempts.length, holdStart + 1); assert.equal(await deleteButton().isDisabled(), true);
    assert.equal(attempts[holdStart].input.expectedRevision, 3); assert.notEqual(attempts[holdStart].input.operationId, attempts[guardStart].input.operationId);
    mode = 'ok'; release(); release = undefined; await deleteButton().waitFor({ state: 'hidden' });

    const keep = party(`${singular}-keep`, `${label} conservado`, 5), source = party(`${singular}-source`, `${label} fusionado`, 8);
    if (tab === 'Clientes') { keep.debt = 4; source.debt = 6; }
    records.push(keep, source); pedidos.push({ id: `${singular}-order`, clienteId: source.id, proveedorId: source.id, producto: 'Pedido movido', qty: 1, estado: 'descartado', fechaPedido: new Date().toISOString() });
    await page.getByRole('heading', { name: 'Fusionar duplicados', exact: true }).waitFor({ timeout: 12000 });
    await page.getByRole('button', { name: /Fusionar duplicados/ }).click();
    if (tab === 'Proveedores') await page.getByText('Opcional · todos los pedidos del segundo pasan al que conservás y se unen las notas.', { exact: true }).waitFor();
    await page.getByLabel(`${label} que se conserva`).selectOption(keep.id); await page.getByLabel(`${label} que se fusiona`).selectOption(source.id);
    const mergeStart = attempts.length; mode = 'lost'; await page.getByRole('button', { name: 'Fusionar', exact: true }).click(); await retryMerge().waitFor();
    await page.getByRole('heading', { name: 'Fusionar duplicados', exact: true }).waitFor({ state: 'hidden', timeout: 12000 });
    keep.name = `${label} posterior`; keep.metadataRevision++; if (tab === 'Clientes') keep.accountRevision++;
    await retryMerge().click(); await retryMerge().waitFor({ state: 'hidden' });
    assert.deepEqual(attempts[mergeStart], attempts[mergeStart + 1]); assert.equal(records.length, 1);
    await page.getByText(keep.name, { exact: true }).waitFor(); assert.equal(pedidos.at(-1)[tab === 'Clientes' ? 'clienteId' : 'proveedorId'], keep.id);
    assert.equal(keep.notas, `Nota ${keep.id}\nNota ${source.id}`); if (tab === 'Clientes') assert.equal(keep.debt, 10);

    const second = party(`${singular}-second`, `${label} segundo`, 12); records.push(second);
    await page.getByRole('heading', { name: 'Fusionar duplicados', exact: true }).waitFor({ timeout: 12000 });
    await page.getByLabel(`${label} que se conserva`).selectOption(keep.id); await page.getByLabel(`${label} que se fusiona`).selectOption(second.id);
    mode = 'conflict'; const conflictStart = attempts.length; await page.getByRole('button', { name: 'Fusionar', exact: true }).click(); await page.getByText('La revisión cambió.', { exact: true }).waitFor();
    keep.metadataRevision++; second.metadataRevision++; if (tab === 'Clientes') { keep.accountRevision++; second.accountRevision++; }
    await hydrate(); await retryMerge().click(); await page.getByText('La revisión cambió.', { exact: true }).waitFor();
    assert.deepEqual(attempts[conflictStart], attempts[conflictStart + 1]);
    await page.getByRole('button', { name: `Revisar ${plural} actuales`, exact: true }).click();
    await page.getByLabel(`${label} que se conserva`).selectOption(keep.id); await page.getByLabel(`${label} que se fusiona`).selectOption(second.id);
    mode = 'hold'; const mergeHoldStart = attempts.length; await page.getByRole('button', { name: 'Fusionar', exact: true }).evaluate(button => { button.click(); button.click(); }); await holdReady();
    assert.equal(attempts.length, mergeHoldStart + 1); assert.equal(await page.getByLabel(`${label} que se conserva`).isDisabled(), true);
    assert.notEqual(attempts[mergeHoldStart].input.operationId, attempts[conflictStart].input.operationId);
    mode = 'ok'; release(); release = undefined; await page.getByRole('heading', { name: 'Fusionar duplicados', exact: true }).waitFor({ state: 'hidden' });
  }
  assert.deepEqual(pageErrors, []);
  console.log('Party delete/merge UI passed: exact body/revision replay after committed503, failed-refresh deletion with missing cards, account/order guards, stale conflict review, frozen client/supplier merge after source disappears, fresh snapshots, order movement/unlink and synchronous locks.');
} finally { await browser.close(); }
