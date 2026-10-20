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
const universalRequests = [], legacyParses = [];
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
  if (path === '/api/voice/parse') { legacyParses.push(path); return json({ error: 'Legacy parse retired.' }, 410); }
  if (path === '/api/operation-drafts') {
    const input = request.postDataJSON(); universalRequests.push(input);
    return json({ draftId: 'query-' + universalRequests.length, version: 1, status: 'answered', text: input.text, digest: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', answer: { text: 'Consulta respondida.', items: [] } });
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
// Recovery compatibility starts with a proposal created by an older client.
let seedIndex = 0;
const seedLegacy = async (text = proposal.sourceText) => {
  await page.evaluate(({ key, proposal }) => sessionStorage.setItem(key, JSON.stringify({ version: 1, proposal })), {
    key: storage.pendingProposalKey(tenant, actor), proposal: { ...proposal, sourceText: text, operationId: 'legacy-fixture-' + (++seedIndex) },
  });
  await reload(); await confirm().waitFor();
};
const sendUniversal = async text => {
  await page.getByPlaceholder('Escribí un mensaje...').fill(text);
  await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Revisar operación', exact: true }); await dialog.waitFor();
  return dialog;
};

try {
  await page.goto(origin);
  await openChat();
  await seedLegacy();
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

  await seedLegacy('Otra propuesta para cancelar');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await savedDraft(), null);
  await reload();
  assert.equal(await confirm().count(), 0);

  await seedLegacy('Propuesta aislada por actor y empresa');
  const scopedId = (await savedDraft()).proposal.operationId;
  for (const input of ['consultar stock', 'incompleto', 'sin acciones']) {
    // An ordinary message goes to universal review and cannot replace legacy state.
    await page.evaluate(() => { for (let i=localStorage.length-1;i>=0;i--) { const key=localStorage.key(i); if (key?.startsWith('universal-draft:')) localStorage.removeItem(key); } });
    const dialog = await sendUniversal(input);
    await dialog.getByRole('button', { name: 'Preparar revisión', exact: true }).click();
    await dialog.getByText('Consulta respondida.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Cerrar revisión', exact: true }).click();
    assert.equal((await savedDraft()).proposal.operationId, scopedId);
    assert.equal(await confirm().isVisible(), true);
  }
  assert.equal(universalRequests.length, 3); assert.deepEqual(legacyParses, []);
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
  const dialog = await sendUniversal('Nuevo mensaje mientras confirma el anterior');
  assert.equal((await savedDraft()).proposal.operationId, scopedId);
  await dialog.getByRole('button', { name: 'Cerrar revisión', exact: true }).click();
  releaseApply();
  await page.getByText('Transacción confirmada y aplicada al estado global.').waitFor();
  assert.equal(await savedDraft(), null);
  await reload(); assert.equal(await confirm().count(), 0);
  assert.equal(await page.getByPlaceholder('Escribí un mensaje...').inputValue(), 'Nuevo mensaje mientras confirma el anterior');
  await seedLegacy('Borrador previo con almacenamiento lleno');

  await page.evaluate(() => {
    window.restoreStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('Quota', 'QuotaExceededError'); };
  });
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
  console.log('PASS panel draft recovery: same operation after 503/reload, one write, cancel, tenant/actor isolation, invalid snapshot retention, concurrent universal input preserving legacy state, quota safety; storage validation/policy failures.');
} finally {
  releaseApply?.();
  await browser.close();
}
