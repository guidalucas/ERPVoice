import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture();
// postgresDatabase loads dotenv with override=true at import time. Bind the
// isolated connection only after import, before creating its lazy pool.
const db = await import('../server/postgresDatabase.js');
const fixtureConnection = new URL(fixture.connection);
assert.equal(fixtureConnection.hostname, '127.0.0.1');
assert.match(fixtureConnection.pathname, /^\/fullmatch_fixture_[a-f0-9]+$/);
for (const key of ['SUPABASE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_CONNECTION_STRING']) process.env[key] = fixture.connection;
process.env.POSTGRES_SSL = 'false';
process.env.STOCKY_SCHEMA_MODE = 'verify';
process.env.PUBLIC_APP_URL = new URL(fixture.url).origin;
assert.equal(db.stockyDatabaseRuntime.getPool().options.connectionString, fixture.connection);
const sql = new Client({ connectionString: fixture.connection });
let browser;
const api = async (id, token = fixture.token) => {
  const response = await fetch(`${fixture.apiUrl}/api/operation-drafts/${encodeURIComponent(id)}/detail`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, value: await response.json() };
};
const domainState = async () => ({
  products: (await sql.query('SELECT id,stock_available,inventory_revision FROM products WHERE owner_phone=$1 ORDER BY id', [fixture.owner])).rows,
  operations: (await sql.query('SELECT operation_id,result_json FROM universal_operations WHERE owner_phone=$1 ORDER BY operation_id', [fixture.owner])).rows,
});
try {
  await sql.connect();
  const skus = [];
  for (let index = 1; index <= 9; index++) skus.push(await db.createProductRecord({ name: `Remera ${index}`, unit: 'unit', price: 15000, priceCurrency: 'ARS', stockAvailable: 1 }, fixture.owner, { operationId: randomUUID() }));
  const sourceText = skus.map(sku => `Ingresaron dos unidades de ${sku.name}.`).join(' ');
  const actions = skus.map((sku, index) => ({ itemId: `stock-${index}`, type: 'stock.receive', target: { kind: 'existing', skuId: sku.id }, quantity: { value: 2, unit: 'unit' } }));
  const scope = { ownerPhone: fixture.owner, senderPhone: fixture.owner };
  const prepared = await db.processMetaUniversalMessage({ ...scope, messageId: randomUUID(), sourceText }, { ordinary: true,
    complete: async () => ({ ok: true, json: { contractVersion: 1, kind: 'proposal', actions, evidence: actions.map(({ itemId }) => ({ itemId, quote: sourceText })) } }) });
  assert.equal(prepared.status, 'awaiting_confirmation', JSON.stringify(prepared));
  assert.doesNotMatch(prepared.replyText, /Ver detalle completo:/);
  assert.equal((await api(prepared.draftId)).status, 409);
  const confirmation = { ...scope, messageId: randomUUID(), sourceText: 'confirmar' };
  const confirmed = await db.processMetaUniversalMessage(confirmation, { ordinary: true });
  assert.equal(confirmed.status, 'applied', JSON.stringify(confirmed));
  const link = new URL(confirmed.replyText.split('Ver detalle completo:\n')[1]);
  assert.equal(link.origin, new URL(fixture.url).origin); assert.equal(link.searchParams.get('operation'), prepared.draftId);
  assert.ok(confirmed.replyText.length <= 1200);
  assert.ok(confirmed.replyText.split('\n').filter(line => line.startsWith('• ')).length < 9);
  const stored = (await sql.query('SELECT result_json FROM universal_meta_commands WHERE owner_phone=$1 AND message_id=$2', [fixture.owner, confirmation.messageId])).rows[0].result_json;
  const outbox = (await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', [confirmation.messageId])).rows[0];
  assert.equal(stored.replyText, confirmed.replyText); assert.equal(outbox.reply_text, confirmed.replyText);
  assert.deepEqual(await db.processMetaUniversalMessage(confirmation, { ordinary: true, complete: async () => assert.fail('Replay must not reinterpret') }), confirmed);
  const beforeReads = await domainState();
  assert.equal((await api(prepared.draftId, null)).status, 401);
  assert.equal((await api(prepared.draftId, fixture.freshOwners[0].token)).status, 404);
  assert.equal((await api(prepared.draftId, fixture.member.token)).status, 404);
  assert.equal((await api(randomUUID())).status, 404);
  const { status, value: detail } = await api(prepared.draftId);
  assert.equal(status, 200); assert.equal(detail.changes.length, 9); assert.equal(detail.review.length, 9);
  assert.ok(detail.changes.some(line => line.includes('Remera 9'))); assert.equal(detail.text, sourceText);
  // Applied links remain readable after the short confirmation window has passed.
  await sql.query("UPDATE universal_drafts SET expires_at=NOW()-INTERVAL '1 day' WHERE owner_phone=$1 AND draft_id=$2", [fixture.owner, prepared.draftId]);
  assert.deepEqual((await api(prepared.draftId)).value, detail);
  assert.deepEqual(await domainState(), beforeReads);
  console.log('PASS: confirmed WhatsApp reply persists a dynamic link; replay is stable; full authenticated detail is isolated by business and sender and survives draft expiry');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [], methods = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) methods.push(request.method()); });
  // Keep every API request local even if a developer's build config points elsewhere.
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: fixture.apiUrl + url.pathname + url.search }) });
  });
  await page.route(`${link.origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/')) return route.fallback();
    const root = path.resolve('dist'), file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep)) return route.abort();
    try { await route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(link.href);
  await page.getByRole('button', { name: 'Iniciar sesión con WhatsApp', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('operation'), prepared.draftId);
  await page.evaluate(({ token, owner }) => { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); }, { token: fixture.token, owner: fixture.owner });
  const output = path.resolve('.fullmatch-runtime/operation-detail'); await fs.mkdir(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.reload();
    await page.getByRole('heading', { name: 'Detalle de la operación', exact: true }).waitFor();
    await page.getByText(detail.changes[8], { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: /Ingreso de existencias/ }).count(), 9);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.getByRole('button', { name: /Confirmar operación/ }).count(), 0);
    await page.screenshot({ path: path.join(output, `${width}.png`), fullPage: true });
  }
  assert.ok(methods.every(method => method === 'GET')); assert.deepEqual(errors, []);
  // A temporary read error can be retried without applying the operation again.
  let failOnce = true;
  await page.route('**/api/operation-drafts/*/detail', async route => {
    if (!failOnce) return route.fallback(); failOnce = false;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Servicio temporalmente no disponible.' }) });
  });
  await page.reload(); await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click(); await page.getByText(detail.changes[8], { exact: true }).waitFor();
  await page.unroute('**/api/operation-drafts/*/detail');
  await page.evaluate(({ token, owner }) => { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); }, fixture.member);
  await page.reload(); await page.getByRole('alert').getByText(/No encontré esta operación para tu cuenta/).waitFor();
  assert.equal(await page.getByText(detail.changes[8], { exact: true }).count(), 0);
  assert.deepEqual(await domainState(), beforeReads);
  console.log('PASS: real HTTP and desktop/mobile page show all 9 changes; login keeps the link; retry and another sender cannot repeat or expose the operation');
} finally {
  await browser?.close(); await sql.end().catch(() => {}); await db.closeDatabase(); await fixture.stop();
}
