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
data.set(key, JSON.stringify({ version: 1, proposal }));
assert.deepEqual(storage.restorePendingProposal(key), proposal);
data.set(key, '{'); assert.equal(storage.restorePendingProposal(key), null); assert.equal(data.get(key), '{');
data.set(key, JSON.stringify({ version: 1, proposal }));
globalThis.sessionStorage.setItem = () => { throw new Error('quota'); };
assert.equal(storage.archivePendingProposal(key, proposal), false); assert.ok(data.has(key));
globalThis.sessionStorage.setItem = (key, value) => data.set(key, value);
assert.equal(storage.archivePendingProposal(key, proposal), true); assert.equal(data.has(key), false);
assert.equal(JSON.parse(data.get(key + ':archive:' + proposal.operationId)).snapshot.proposal.operationId, proposal.operationId);

delete globalThis.sessionStorage;

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const origin = 'http://127.0.0.1:5173';
let actor = '5491100000000';
let tenant = '5491100000001';
const attempts = [];
const universalRequests = [], legacyParses = [];
let finalWrites = 0;
let stateReads = 0;
let failReads = false;
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
  if (path === '/api/state') { stateReads++; return failReads ? json({error:'read failed'},503) : json(snapshot); }
  if (path === '/api/voice/parse') { legacyParses.push(path); return json({ error: 'Legacy parse retired.' }, 410); }
  if (path === '/api/operation-drafts') {
    const input = request.postDataJSON(); universalRequests.push(input);
    return json({ draftId: 'query-' + universalRequests.length, version: 1, status: 'answered', text: input.text, digest: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', answer: { text: 'Consulta respondida.', items: [] } });
  }
  if (path === '/api/state/apply') { finalWrites++; return json({ error: 'Retired' }, 410); }
  if (path === '/api/operations/recovery') {
    const input = request.postDataJSON(); attempts.push(input);
    if (mode === 'fail') return json({ error: 'Transient fixture failure' }, 503);
    if (mode === 'invalid') return json({ status: 'unexpected', operationId: input.operationId });
    if (mode === 'missing_receipt') return json({ status:'applied',operationId:input.operationId });
    if (mode === 'malformed_receipt') return json({ status:'applied',operationId:input.operationId,operationResult:{status:'pending',operationId:'panel:'+input.operationId} });
    if (mode === 'wrong_receipt') return json({ status:'applied',operationId:input.operationId,operationResult:{status:'applied',operationId:'panel:another-operation'} });
    if (mode === 'mismatch') return json({ status: 'not_applied', operationId: 'another-operation' });
    if (mode === 'delay') await new Promise(resolve => { releaseApply = resolve; });
    return json(mode==='not_applied' ? {status:'not_applied',operationId:input.operationId} : {status:'applied',operationId:input.operationId,operationResult:{status:'applied',operationId:'panel:'+input.operationId}});
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
const check = () => page.getByRole('button', { name: 'Consultar estado', exact: true });
const handoff = () => page.getByRole('button', { name: 'Preparar revisión universal', exact: true });
const savedDraft = () => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), storage.pendingProposalKey(tenant, actor));
const openChat = async () => page.getByRole('button', { name: 'Abrir simulador WhatsApp' }).click();
const reload = async () => { await page.reload(); await openChat(); };
// Recovery compatibility starts with a proposal created by an older client.
let seedIndex = 0;
const seedLegacy = async (text = proposal.sourceText) => {
  await page.evaluate(({ key, proposal }) => sessionStorage.setItem(key, JSON.stringify({ version: 1, proposal })), {
    key: storage.pendingProposalKey(tenant, actor), proposal: { ...proposal, sourceText: text, operationId: 'legacy-fixture-' + (++seedIndex) },
  });
  await reload(); await check().waitFor();
};

try {
  await page.goto(origin); await openChat(); await seedLegacy();
  const first = await savedDraft();
  await check().click(); await page.getByText('Transient fixture failure', {exact:true}).waitFor();
  assert.equal(attempts.length, 1); assert.equal(finalWrites, 0);
  await reload(); assert.equal((await savedDraft()).proposal.operationId, first.proposal.operationId);
  mode = 'success'; failReads = true;
  await check().click(); await page.getByText(/La operación anterior ya fue aplicada/).waitFor();
  await page.getByRole('button',{name:'Actualizar datos',exact:true}).waitFor();
  assert.equal(await handoff().count(), 0); assert.ok(await savedDraft());
  failReads = false; const priorAttempts = attempts.length, priorReads = stateReads;
  await page.getByRole('button',{name:'Actualizar datos',exact:true}).click();
  await page.getByRole('button',{name:'Actualizar datos',exact:true}).waitFor({state:'hidden'});
  assert.equal(attempts.length, priorAttempts); assert.ok(stateReads > priorReads); assert.equal(finalWrites,0);
  await reload(); assert.ok(await savedDraft()); assert.equal(await handoff().count(),0); assert.equal(await page.getByRole('button',{name:'Archivar operación verificada',exact:true}).count(),0);

  for (const invalid of ['invalid','mismatch','missing_receipt','malformed_receipt','wrong_receipt']) {
    mode=invalid; await check().click(); await page.getByText('No pudimos verificar el estado de la operación anterior.',{exact:true}).waitFor();
    assert.ok(await savedDraft()); assert.equal(await handoff().count(),0);
  }
  actor='5491100000002'; await reload(); assert.equal(await check().count(),0);
  actor='5491100000000'; tenant='5491100000003'; await reload(); assert.equal(await check().count(),0);
  tenant='5491100000001'; await reload(); await check().waitFor();

  mode='success'; await check().click();
  const archiveApplied=page.getByRole('button',{name:'Archivar operación verificada',exact:true}); await archiveApplied.waitFor();
  await archiveApplied.click(); assert.equal(await savedDraft(),null);
  assert.equal(await page.getByRole('dialog').count(),0); assert.equal(finalWrites,0);
  const appliedArchive=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),storage.pendingProposalKey(tenant,actor)+':archive:'+encodeURIComponent(first.proposal.operationId));
  assert.equal(appliedArchive.reason,'verified-applied');
  await seedLegacy();
  const handoffProposal=await savedDraft();
  // Existing universal review must survive the explicit legacy handoff.
  const universalKey='universal-draft:'+JSON.stringify([tenant,actor]);
  const existing={text:'Otra revisión conservada'};
  await page.evaluate(({key,value})=>localStorage.setItem(key,JSON.stringify(value)),{key:universalKey,value:existing});
  mode='not_applied'; await check().click(); await handoff().waitFor();
  await page.evaluate(()=> { window.restoreStorage=Storage.prototype.setItem; Storage.prototype.setItem=function(key,value){ if(key.startsWith('universal-chat-input:')) throw new DOMException('Quota','QuotaExceededError'); return window.restoreStorage.call(this,key,value); }; });
  await handoff().click(); await page.getByText('No pudimos guardar el texto en el chat. Conservamos la propuesta anterior.',{exact:true}).waitFor();
  assert.ok(await savedDraft()); assert.equal(await page.getByRole('dialog').count(),0);
  await page.evaluate(()=> { Storage.prototype.setItem=window.restoreStorage; });
  await page.evaluate(()=> { window.restoreStorage=Storage.prototype.setItem; Storage.prototype.setItem=function(key,value){ if(key.includes(':archive:')) throw new DOMException('Quota','QuotaExceededError'); return window.restoreStorage.call(this,key,value); }; });
  await handoff().click(); await page.getByText(/No pudimos archivar la propuesta anterior/).waitFor();
  assert.ok(await savedDraft()); assert.equal(await page.getByPlaceholder('Escribí un mensaje...').inputValue(),proposal.sourceText);
  await page.evaluate(()=> { Storage.prototype.setItem=window.restoreStorage; });
  await handoff().click(); const dialog=page.getByRole('dialog',{name:'Revisar operación',exact:true}); await dialog.waitFor();
  assert.equal(await savedDraft(),null); assert.equal(await dialog.getByLabel('Solicitud',{exact:true}).inputValue(),existing.text);
  assert.equal(await page.getByPlaceholder('Escribí un mensaje...').inputValue(),proposal.sourceText);
  const archived=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),storage.pendingProposalKey(tenant,actor)+':archive:'+encodeURIComponent(handoffProposal.proposal.operationId));
  assert.equal(archived.snapshot.proposal.operationId,handoffProposal.proposal.operationId);
  assert.equal(universalRequests.length,0); assert.deepEqual(legacyParses,[]); assert.equal(finalWrites,0);
  await dialog.getByRole('button',{name:'Cerrar revisión',exact:true}).click();
  await reload(); assert.equal(await check().count(),0);
  // Status checks are safe across late responses and identity changes.
  await seedLegacy('Otra empresa'); mode='delay'; await check().click();
  for(let i=0;!releaseApply && i<200;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(releaseApply); actor='5491100000002'; await reload(); releaseApply(); await page.waitForTimeout(100);
  assert.equal(await check().count(),0); actor='5491100000000'; await reload(); assert.ok(await savedDraft());
  console.log('PASS panel legacy recovery: read-only 503/reload, applied refresh retries, fail-closed responses, explicit universal handoff, existing review preservation, scoped archive/quota and actor isolation.');
} finally { releaseApply?.(); await browser.close(); }
