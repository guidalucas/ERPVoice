import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getJwtSecret, issueJwt } from '../server/auth.js';

/** Exercise the real HTTP boundary against the harness's disposable local PostgreSQL. */
export async function runInventoryHttpChecks({ db, sql, check }) {
  assert.equal(typeof db.getStateSnapshotStrict, 'function');
  const aliases = ['SUPABASE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_CONNECTION_STRING'];
  const connection = aliases.map((key) => process.env[key]).find(Boolean);
  assert.ok(connection, 'HTTP checks require the temporary PostgreSQL connection');
  assert.ok(['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(connection).hostname), 'HTTP checks only accept loopback PostgreSQL');
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const secret = getJwtSecret();
  const appSecret = crypto.randomBytes(32).toString('hex');
  const verifyToken = 'inventory-http-verification';
  const deployment = '0123456789abcdef0123456789abcdef01234567';
  const env = { ...process.env, PORT: String(port), META_WEBHOOK_PORT: String(port), AUTH_JWT_SECRET: secret,
    META_APP_SECRET: appSecret, META_VERIFY_TOKEN: verifyToken, RENDER_GIT_COMMIT: deployment,
    POSTGRES_SSL: 'false', AUTH_DEV_BYPASS: 'false', NODE_ENV: 'test',
    GEMINI_API_KEY: '', GROQ_API_KEY: '', VITE_VOICE_MODEL_API_KEY: '', META_ACCESS_TOKEN: '' };
  for (const key of aliases) env[key] = connection;
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const childCwd = await fs.mkdtemp(path.join(temporaryRoot, 'erpvoice-http-checks-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    cwd: childCwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let startupError;
  child.on('error', (error) => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-8000); });
  const owner = '59899000505';
  const token = issueJwt({ phoneNumber: owner });
  let completed = 0;
  const run = async (label, fn) => { await check(`inventory HTTP: ${label}`, fn); completed++; };
  // Native HTTP intentionally avoids any provider fetch mocks installed by the harness.
  const request = (route, { body, raw, auth = true, headers = {}, method = 'POST' } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, signal: AbortSignal.timeout(4000),
      headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { /* challenge and status responses are plain text */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  const plan = (operationId, actions) => ({ contractVersion: 1, businessId: owner, operationId, actions });
  const fresh = { itemId: 'item-1', type: 'stock.receive', target: { kind: 'new', sku: { name: 'HTTP recepción Ñ', unit: 'unit' } },
    quantity: { value: 3, unit: 'unit' }, price: { amount: 450, currency: 'UYU', policy: 'initialize' } };
  const ledger = async (operationId) => (await sql.query('SELECT sku_id,delta_available,delta_reserved,unit FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2', [owner, operationId])).rows;
  const stock = async (skuId) => (await sql.query('SELECT stock_available,stock_reserved,price,price_currency FROM products WHERE owner_phone=$1 AND id=$2', [owner, skuId])).rows;
  let skuId;
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      assert.equal(child.exitCode, null, 'HTTP child exited during startup');
      try { ready = (await request('/api/health', { method: 'GET', auth: false })).status === 200; } catch { /* server is still starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'HTTP child did not start within 15 seconds');
    await run('health exposes deployment, operation contract and webhook readiness', async () => {
      const response = await request('/api/health', { method: 'GET', auth: false });
      assert.equal(response.status, 200); assert.equal(response.json.ok, true);
      assert.equal(response.json.deployment, deployment); assert.equal(response.json.operationContractVersion, 1); assert.equal(response.json.metaWebhookReady, true);
    });
    await run('Meta verification and exact UTF-8 raw-body signatures', async () => {
      const challenge = await request(`/api/meta-webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=123456`, { method: 'GET', auth: false });
      assert.equal(challenge.status, 200); assert.equal(challenge.text, '123456');
      const raw = '{ "object": "ignored", "label": "recepción Ñ" }';
      const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(Buffer.from(raw, 'utf8')).digest('hex')}`;
      assert.equal((await request('/api/meta-webhook', { raw, auth: false })).status, 401);
      assert.equal((await request('/api/meta-webhook', { raw: raw + ' ', auth: false, headers: { 'X-Hub-Signature-256': signature } })).status, 401);
      assert.equal((await request('/api/meta-webhook', { raw, auth: false, headers: { 'X-Hub-Signature-256': signature } })).status, 200);
    });
    await run('inventory authorization and contract validation', async () => {
      assert.equal((await request('/api/inventory/operations', { body: plan('http-no-auth', [fresh]), auth: false })).status, 401);
      const foreign = await request('/api/inventory/operations', { body: { ...plan('http-foreign', [fresh]), businessId: '59899000606' } });
      assert.equal(foreign.status, 403); assert.equal(foreign.json.code, 'BUSINESS_SCOPE_MISMATCH');
      const invalid = await request('/api/inventory/operations', { body: { ...plan('http-invalid', [fresh]), contractVersion: 99 } });
      assert.equal(invalid.status, 400); assert.equal(invalid.json.code, 'INVALID_OPERATION_PLAN');
      assert.equal((await ledger('http-foreign')).length, 0); assert.equal((await ledger('http-invalid')).length, 0);
    });
    await run('canonical receive persists exact stock and replay creates no duplicate', async () => {
      const body = plan('http-receive', [fresh]);
      const response = await request('/api/inventory/operations', { body });
      assert.equal(response.status, 200); assert.equal(response.json.status, 'applied');
      skuId = response.json.items[0].skuId;
      assert.ok(skuId); assert.equal(response.json.items[0].quantity.value, 3);
      assert.deepEqual(await stock(skuId), [{ stock_available: '3', stock_reserved: '0', price: '450', price_currency: 'UYU' }]);
      const retry = await request('/api/inventory/operations', { body });
      assert.equal(retry.status, 200); assert.deepEqual(retry.json, response.json);
      assert.deepEqual(await ledger('http-receive'), [{ sku_id: skuId, delta_available: '3', delta_reserved: '0', unit: 'unit' }]);
      assert.equal((await sql.query('SELECT operation_id FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, 'http-receive'])).rowCount, 1);
      assert.equal(Number((await stock(skuId))[0].stock_available), 3);
    });
    await run('state apply intake returns exact state and stable retry', async () => {
      const body = { operationId: 'http-panel', sourceText: 'Ingresaron dos HTTP panel', actions: [{ type: 'add_stock', productName: 'HTTP panel', qty: 2, price: 120 }] };
      const response = await request('/api/state/apply', { body });
      assert.equal(response.status, 200);
      const product = response.json.products.find((item) => item.name === 'HTTP panel');
      assert.ok(product); assert.equal(product.stockAvailable, 2); assert.equal(product.stockReserved, 0); assert.equal(product.price, 120);
      const retry = await request('/api/state/apply', { body });
      assert.equal(retry.status, 200); assert.deepEqual(retry.json, response.json);
      assert.deepEqual(await ledger('panel:http-panel'), [{ sku_id: product.id, delta_available: '2', delta_reserved: '0', unit: 'unit' }]);
      assert.equal((await sql.query('SELECT id FROM transactions WHERE owner_phone=$1 AND batch_id=$2', [owner, `${owner}:panel:http-panel`])).rowCount, 1);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.find((item) => item.id === product.id).stockAvailable, 2);
      const changed = await request('/api/state/apply', { body: { ...body, actions: [{ ...body.actions[0], qty: 3 }] } });
      assert.equal(changed.status, 409); assert.equal(changed.json.code, 'IDEMPOTENCY_CONFLICT');
      const { operationId: _operationId, ...withoutId } = body;
      const missing = await request('/api/state/apply', { body: withoutId });
      assert.equal(missing.status, 409); assert.equal(missing.json.code, 'OPERATION_ID_REQUIRED');
      assert.equal((await db.getStateSnapshotStrict(owner)).products.find((item) => item.id === product.id).stockAvailable, 2);
      assert.equal((await ledger('panel:http-panel')).length, 1);
    });
    await run('price conflict is 409 and leaves stock and ledger unchanged', async () => {
      const before = await stock(skuId);
      const action = { ...fresh, target: { kind: 'existing', skuId }, price: { amount: 451, currency: 'UYU', policy: 'initialize' } };
      const response = await request('/api/inventory/operations', { body: plan('http-price-conflict', [action]) });
      assert.equal(response.status, 409); assert.equal(response.json.code, 'PRICE_CONFLICT');
      assert.deepEqual(await stock(skuId), before); assert.equal((await ledger('http-price-conflict')).length, 0);
    });
    await run('mixed inventory and unmigrated operation reject atomically', async () => {
      const before = await db.getStateSnapshotStrict(owner);
      const response = await request('/api/state/apply', { body: { operationId: 'http-mixed', sourceText: 'mixed', actions: [
        { type: 'add_stock', productName: 'HTTP mixed must not exist', qty: 4 }, { type: 'update_product', productName: fresh.target.sku.name, price: 1 },
      ] } });
      assert.equal(response.status, 409); assert.equal(response.json.code, 'UNSUPPORTED_MIXED_OPERATION');
      assert.deepEqual(await db.getStateSnapshotStrict(owner), before); assert.equal((await ledger('panel:http-mixed')).length, 0);
    });
    await run('canonical sale and panel reservation share receipt effects and reject insufficient stock', async () => {
      const seeded = await request('/api/inventory/operations', { body: plan('http-consume-seed', [{ ...fresh,
        target: { kind: 'new', sku: { name: 'Venta HTTP precisa' } }, quantity: { value: 2, unit: 'unit' } }]) });
      const id = seeded.json.items[0].skuId;
      const sale = { itemId: 'sale', type: 'stock.sell', target: { kind: 'existing', skuId: id }, quantity: { value: 1, unit: 'unit' } };
      const sold = await request('/api/inventory/operations', { body: plan('http-sell', [sale]) });
      assert.equal(sold.status, 200); assert.equal(sold.json.items[0].price, null);
      assert.deepEqual((await request('/api/inventory/operations', { body: plan('http-sell', [sale]) })).json, sold.json);
      assert.equal(sold.json.items[0].stockAvailable, 1); assert.equal(sold.json.items[0].catalogPrice, 450);
      const product = (await db.getStateSnapshotStrict(owner)).products.find((row) => row.id === id);
      const body = { operationId: 'http-reserve', sourceText: 'Reservar SKU confirmado', actions: [{ type: 'reserve_stock',
        productId: id, productName: 'Etiqueta no autoritativa', expectedFingerprint: product.identityFingerprint, qty: 1, unit: 'unit' }] };
      const reserved = await request('/api/state/apply', { body });
      assert.equal(reserved.status, 200); assert.match(reserved.json.replyText, /Reserva registrada/);
      assert.match(reserved.json.replyText, /Venta HTTP precisa/); assert.doesNotMatch(reserved.json.replyText, /Etiqueta no autoritativa/);
      assert.equal(reserved.json.products.find((row) => row.id === id).stockReserved, 1);
      assert.deepEqual((await request('/api/state/apply', { body })).json.operationResult, reserved.json.operationResult);
      assert.equal((await ledger('http-sell')).length, 1); assert.equal((await ledger('panel:http-reserve')).length, 1);
      const denied = await request('/api/inventory/operations', { body: plan('http-insufficient', [sale]) });
      assert.equal(denied.status, 409); assert.equal(denied.json.code, 'INSUFFICIENT_STOCK');
      assert.equal((await ledger('http-insufficient')).length, 0);
      assert.deepEqual(await stock(id), [{ stock_available: '0', stock_reserved: '1', price: '450', price_currency: 'UYU' }]);
    });
    await run('signed WhatsApp insufficient sale completes rejection and cannot execute after replenishment', async () => {
      const product = await db.createProductRecord({ name: 'Taladro Delta', stockAvailable: 2, price: 900 }, owner);
      const messageId = 'http-meta-insufficient-terminal';
      const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{
        id: messageId, from: owner, type: 'text', text: { body: 'Vendí 50 Taladro Delta' },
      }] } }] }] };
      const raw = JSON.stringify(body);
      const headers = { 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', appSecret).update(Buffer.from(raw)).digest('hex')}` };
      assert.equal((await request('/api/meta-webhook', { raw, headers, auth: false })).status, 200);
      const deadline = Date.now() + 5000;
      let claim;
      while (Date.now() < deadline) {
        claim = (await sql.query('SELECT status FROM meta_message_claims WHERE message_id=$1', [messageId])).rows[0];
        if (claim?.status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal(claim?.status, 'completed');
      const event = (await sql.query('SELECT error,actions_json,reply_text,processed FROM meta_events WHERE id=$1', [messageId])).rows[0];
      assert.equal(event.error, 'INSUFFICIENT_STOCK'); assert.deepEqual(event.actions_json, []); assert.equal(event.processed, true);
      assert.match(event.reply_text, /insuficiente/);
      assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', [messageId])).rows[0].reply_text, event.reply_text);
      await sql.query('UPDATE products SET stock_available=100 WHERE owner_phone=$1 AND id=$2', [owner, product.id]);
      assert.equal((await request('/api/meta-webhook', { raw, headers, auth: false })).status, 200);
      assert.equal(Number((await stock(product.id))[0].stock_available), 100);
      assert.equal((await ledger(`whatsapp:${messageId}`)).length, 0);
      assert.equal(await db.claimMetaMessage({ messageId, ownerPhone: owner, senderPhone: owner, rawBody: body }), false);
    });
    return completed;
  } catch (error) {
    let safeLogs = logs;
    for (const value of [connection, secret, appSecret, token]) safeLogs = safeLogs.split(value).join('[redacted]');
    safeLogs = safeLogs.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted database URL]');
    throw new Error(`${error.message}\nHTTP child output (bounded):\n${safeLogs}`, { cause: error });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    // Resolve and validate the exact disposable directory before recursive removal on Windows.
    const cleanupTarget = await fs.realpath(childCwd);
    assert.equal(path.dirname(cleanupTarget).toLowerCase(), temporaryRoot.toLowerCase());
    assert.ok(path.basename(cleanupTarget).startsWith('erpvoice-http-checks-'));
    await fs.rm(cleanupTarget, { recursive: true, force: true });
  }
}
