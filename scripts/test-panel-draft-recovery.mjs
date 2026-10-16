import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

// Exercise the real storage module, including policy/quota errors and malformed data.
const source = await readFile('src/services/pendingProposalStorage.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const storage = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const proposal = { schemaVersion: 1, operationId: 'recovery-operation', sourceText: 'Ingresaron 3 camisetas', intent: 'add_stock', confidence: 1, requiresConfirmation: true, actions: [{ type: 'add_stock', productName: 'Camiseta Argentina', size: 'S', qty: 3 }] };
const data = new Map();
globalThis.sessionStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
const key = storage.pendingProposalKey('tenant', 'actor');
assert.equal(storage.persistPendingProposal(key, proposal), true);
assert.deepEqual(storage.restorePendingProposal(key), proposal);
storage.clearStoredProposal(key, 'older-operation');
assert.deepEqual(storage.restorePendingProposal(key), proposal);
for (const invalid of ['{', JSON.stringify({ version: 2, proposal }), JSON.stringify({ version: 1, proposal: { ...proposal, operationId: undefined } }), JSON.stringify({ version: 1, proposal: { ...proposal, actions: [{ type: 'sell', qty: '3' }] } }), JSON.stringify({ version: 1, proposal: { ...proposal, actions: [{ type: 'add_stock', productName: 'Camiseta', qty: 1.5 }] } })]) {
  data.set(key, invalid);
  assert.equal(storage.restorePendingProposal(key), null);
  assert.equal(data.has(key), false);
}
globalThis.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('blocked'); } };
assert.equal(storage.restorePendingProposal(key), null);
assert.equal(storage.persistPendingProposal(key, proposal), false);
assert.doesNotThrow(() => storage.clearStoredProposal(key));
delete globalThis.sessionStorage;

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const origin = 'http://127.0.0.1:5173';
let actor = '5491100000000';
let tenant = '5491100000001';
const attempts = [];
const committed = new Set();
let finalWrites = 0;
let mode = 'fail';
let releaseApply;
const snapshot = { products: [{ id: 'product-1', name: 'Camiseta Argentina', size: 'S', stockAvailable: 1, stockReserved: 0, price: 10 }], clients: [], proveedores: [], pedidos: [], transactions: [] };
await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token', 'draft-recovery-test');
  // Intentionally unrelated to tenant: trusted /auth/me must select the storage scope.
  localStorage.setItem('erpvoice.auth.phoneNumber', 'wrong-global-phone');
});
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/me') return json({ phoneNumber: actor, tenantPhone: tenant, role: 'member', businessName: 'Recovery fixture', businessCategory: 'indumentaria', needsOnboarding: false });
  if (path === '/api/state') return json(snapshot);
  if (path === '/api/voice/parse') {
    const text = request.postDataJSON().text;
    if (text === 'consultar stock') return json({ ...proposal, intent: 'query_stock', sourceText: text, actions: [{ type: 'query_stock', productName: 'Camiseta Argentina' }] });
    if (text === 'incompleto') return json({ ...proposal, missingFields: ['cantidad'] });
    if (text === 'sin acciones') return json({ ...proposal, actions: [] });
    return json({ ...proposal, operationId: undefined, sourceText: text });
  }
  if (path === '/api/state/apply') {
    const input = request.postDataJSON();
    const saved = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), storage.pendingProposalKey(tenant, actor));
    assert.equal(saved.proposal.operationId, input.operationId, 'proposal is persisted before the API executes');
    attempts.push(input);
    if (mode === 'fail') return json({ error: 'Transient fixture failure' }, 503);
    if (mode === 'invalid') return json({ products: [] });
    if (mode === 'delay') await new Promise((resolve) => { releaseApply = resolve; });
    if (!committed.has(input.operationId)) {
      committed.add(input.operationId);
      finalWrites += 1;
      snapshot.products[0].stockAvailable += input.actions[0].qty;
    }
    return json(snapshot);
  }
  return json({});
});
await page.route(`${origin}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.startsWith('/api/')) return route.fallback();
  const file = resolve('dist', `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(`${resolve('dist')}/`) && !file.startsWith(`${resolve('dist')}\\`)) return route.abort();
  try {
    return route.fulfill({ status: 200, body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
  } catch { return route.fulfill({ status: 404, body: '' }); }
});
const confirm = () => page.getByRole('button', { name: 'Confirmar', exact: true });
const savedDraft = () => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), storage.pendingProposalKey(tenant, actor));
const openChat = async () => page.getByRole('button', { name: 'Abrir simulador WhatsApp' }).click();
const reload = async () => { await page.reload(); await openChat(); };
const send = async (text = proposal.sourceText) => {
  const botMessages = page.getByText('Detecté una acción. Revisala y confirmá si está correcta.', { exact: true });
  const previousCount = await botMessages.count();
  await page.getByPlaceholder('Escribí un mensaje...').fill(text);
  await page.getByRole('button', { name: 'Enviar mensaje' }).click();
  await botMessages.nth(previousCount).waitFor();
  await confirm().waitFor();
};
try {
  await page.goto(origin);
  await openChat();
  await send();
  const first = await savedDraft();
  assert.ok(first.proposal.operationId);
  await confirm().click();
  await page.getByText(/Transient fixture failure/).waitFor();
  assert.equal(attempts.length, 1);
  assert.equal(finalWrites, 0);
  await reload();
  await confirm().waitFor();
  assert.equal((await savedDraft()).proposal.operationId, first.proposal.operationId);
  mode = 'success';
  await confirm().click();
  await confirm().waitFor({ state: 'hidden' });
  assert.equal(attempts[1].operationId, attempts[0].operationId);
  assert.equal(finalWrites, 1);
  assert.equal(snapshot.products[0].stockAvailable, 4);
  assert.equal(await savedDraft(), null);
  await reload();
  assert.equal(await confirm().count(), 0);

  await send('Otra propuesta para cancelar');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await savedDraft(), null);
  await reload();
  assert.equal(await confirm().count(), 0);

  await send('Propuesta aislada por actor y empresa');
  const scopedId = (await savedDraft()).proposal.operationId;
  for (const [input, response] of [['consultar stock', null], ['incompleto', /Me faltan estos datos/], ['sin acciones', /No encontré acciones claras/]]) {
    await page.getByPlaceholder('Escribí un mensaje...').fill(input);
    const parsed = page.waitForResponse((response) => response.url().endsWith('/api/voice/parse'));
    await page.getByRole('button', { name: 'Enviar mensaje' }).click();
    await parsed;
    if (response) await page.getByText(response).waitFor();
    await page.getByPlaceholder('Escribí un mensaje...').waitFor();
    assert.equal((await savedDraft()).proposal.operationId, scopedId);
    assert.equal(await confirm().isVisible(), true);
  }
  await reload();
  await confirm().waitFor();
  assert.equal((await savedDraft()).proposal.operationId, scopedId);
  actor = '5491100000002';
  await reload();
  assert.equal(await confirm().count(), 0);
  actor = '5491100000000';
  tenant = '5491100000003';
  await reload();
  assert.equal(await confirm().count(), 0);
  tenant = '5491100000001';
  await reload();
  await confirm().waitFor();
  assert.equal((await savedDraft()).proposal.operationId, scopedId);

  mode = 'invalid';
  await confirm().click();
  await page.getByText(/No se pudo verificar la confirmación/).waitFor();
  assert.equal((await savedDraft()).proposal.operationId, scopedId);
  mode = 'delay';
  await confirm().click();
  for (let count = 0; !releaseApply && count < 500; count += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseApply, 'delayed apply request reached fixture');
  await send('Nuevo borrador mientras confirma el anterior');
  const replacementId = (await savedDraft()).proposal.operationId;
  assert.notEqual(replacementId, scopedId);
  releaseApply();
  await page.getByText('Transacción confirmada y aplicada al estado global.').waitFor();
  assert.equal((await savedDraft()).proposal.operationId, replacementId);
  await reload();
  await confirm().waitFor();
  assert.equal((await savedDraft()).proposal.operationId, replacementId);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

  await page.evaluate(() => {
    window.restoreStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('Quota', 'QuotaExceededError'); };
  });
  await send('Borrador con almacenamiento lleno');
  const before = attempts.length;
  await confirm().click();
  await page.getByText(/No se pudo guardar la propuesta/).waitFor();
  assert.equal(attempts.length, before, 'storage failure prevents an unrecoverable API write');
  assert.equal(await confirm().isVisible(), true);
  await page.evaluate(() => { Storage.prototype.setItem = window.restoreStorage; });
  mode = 'success';
  await confirm().click();
  await confirm().waitFor({ state: 'hidden' });
  assert.equal(attempts.length, before + 1, 'confirmation can retry once storage is available again');
  console.log('PASS panel draft recovery: same operation after 503/reload, one write, cancel, tenant/actor isolation, invalid snapshot retention, concurrent replacement, quota safety; storage validation/policy failures.');
} finally {
  releaseApply?.();
  await browser.close();
}
