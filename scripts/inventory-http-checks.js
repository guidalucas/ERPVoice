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
  let partyFixtureSequence = 0;
  const createFixtureClient = (input, businessId) => db.createClientRecord({ ...input, operationId: 'inventory-http-checks-party-' + ++partyFixtureSequence }, businessId);

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
  let fixtureCreateSequence = 0;
  const createHttpFixtureProduct = (input, businessId) => db.createProductRecord(input, businessId, { operationId: `http-fixture-create-${++fixtureCreateSequence}` });
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
    await run('signed WhatsApp LOGIN authenticates via outbox and never enters inventory processing', async () => {
      const loginToken = 'XY34ZK';
      const sessionSecret = 'wa-login-http-session-secret';
      const secretHash = crypto.createHash('sha256').update(sessionSecret).digest('hex');
      const sender = '59899000999';
      const messageId = 'http-meta-wa-login';
      await db.createWaLoginChallenge({
        loginToken, secretHash, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      const body = { object: 'whatsapp_business_account', entry: [
        { changes: [{ value: { statuses: [{ id: 'status-ignored', status: 'delivered' }] }, field: 'messages' }] },
        { changes: [{ value: { messages: [
          { id: messageId, from: sender, type: 'text', text: { body: `LOGIN ${loginToken}` } },
        ] } }] },
      ] };
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
      const poll = await request('/api/auth/wa-login/poll', {
        body: { loginToken, sessionSecret }, auth: false,
      });
      assert.equal(poll.status, 200); assert.equal(poll.json.status, 'authenticated');
      assert.equal(poll.json.phoneNumber, sender); assert.ok(poll.json.token);
      const outbox = (await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', [messageId])).rows[0];
      assert.match(outbox.reply_text, /volver al panel/i);
      assert.equal((await sql.query('SELECT 1 FROM meta_events WHERE id=$1', [messageId])).rowCount, 0);
      assert.equal((await sql.query('SELECT 1 FROM inventory_movements WHERE operation_id=$1', [`whatsapp:${messageId}`])).rowCount, 0);
      assert.equal(await db.claimMetaMessage({ messageId, ownerPhone: sender, senderPhone: sender, rawBody: body }), false);
      assert.equal((await request('/api/meta-webhook', { raw, headers, auth: false })).status, 200);
      assert.equal((await sql.query('SELECT 1 FROM meta_events WHERE id=$1', [messageId])).rowCount, 0);
    });
    await run('inventory authorization and contract validation', async () => {
      assert.equal((await request('/api/inventory/operations', { body: plan('http-no-auth', [fresh]), auth: false })).status, 401);
      const foreign = await request('/api/inventory/operations', { body: { ...plan('http-foreign', [fresh]), businessId: '59899000606' } });
      assert.equal(foreign.status, 403); assert.equal(foreign.json.code, 'BUSINESS_SCOPE_MISMATCH');
      const invalid = await request('/api/inventory/operations', { body: { ...plan('http-invalid', [fresh]), contractVersion: 99 } });
      assert.equal(invalid.status, 400); assert.equal(invalid.json.code, 'INVALID_OPERATION_PLAN');
      assert.equal((await ledger('http-foreign')).length, 0); assert.equal((await ledger('http-invalid')).length, 0);
    });
    await run('universal endpoint authenticates business scope and rejects malformed, unsupported and reentrant plans', async () => {
      const body = plan('http-universal-contract', [{ itemId: 'party', type: 'client.create', name: 'HTTP Universal Contrato' }]);
      const before = (await sql.query('SELECT * FROM universal_operations WHERE owner_phone=$1 ORDER BY operation_id', [owner])).rows;
      assert.equal((await request('/api/operations', { body, auth: false })).status, 401);
      const foreign = await request('/api/operations', { body: { ...body, businessId: '59899000565' } });
      assert.equal(foreign.status, 403); assert.equal(foreign.json.code, 'BUSINESS_SCOPE_MISMATCH');
      const missing = await request('/api/operations', { body: { ...body, operationId: undefined } });
      assert.equal(missing.status, 400); assert.equal(missing.json.code, 'OPERATION_ID_REQUIRED');
      for (const extra of [{ contractVersion: 2 }, { ownerPhone: 'foreign' }, { actions: [] }, { actions: [{ itemId: 'unknown', type: 'order.unknown' }] }, { actions: [{ itemId: 'merge', type: 'client.merge' }] }]) {
        const invalid = await request('/api/operations', { body: { ...body, ...extra } });
        assert.equal(invalid.status, 400); assert.equal(invalid.json.code, 'INVALID_OPERATION_PLAN');
      }
      const mixed = await request('/api/operations', { body: { ...body, actions: [...body.actions, fresh, { itemId: 'party-again', type: 'client.create', name: 'Reentrada inválida' }] } });
      assert.equal(mixed.status, 400); assert.equal(mixed.json.code, 'UNSUPPORTED_OPERATION_ORDER');
      assert.deepEqual((await sql.query('SELECT * FROM universal_operations WHERE owner_phone=$1 ORDER BY operation_id', [owner])).rows, before);
      assert.equal((await sql.query("SELECT 1 FROM clients WHERE owner_phone=$1 AND name='HTTP Universal Contrato'", [owner])).rowCount, 0);
      const reserved = plan('draft-operation:http-forged-reviewed', [{ itemId: 'deactivate', type: 'sku.deactivate',
        target: { kind: 'existing', skuId: 'http-forged-sku', expectedRevision: 0 }, reason: 'Intento de saltar revisión' }]);
      assert.equal((await request('/api/operations', { body: reserved })).status, 403);
      assert.equal((await request('/api/operations', { body: { ...reserved, internalConversationOperation: true } })).status, 400);
    });
    await run('universal inventory applies once, freezes receipt after later sale and conflicts across domains', async () => {
      const body = plan('http-universal-inventory', [{ ...fresh, target: { kind: 'new', sku: { name: 'HTTP Universal SKU', unit: 'unit' } } }]);
      const [one, two] = await Promise.all([request('/api/operations', { body }), request('/api/operations', { body })]);
      assert.equal(one.status, 200); assert.deepEqual(one.json, two.json); assert.equal(one.json.domain, 'inventory'); assert.equal(one.json.operationId, body.operationId);
      const child = one.json.domainResult, productId = child.items[0].skuId;
      assert.ok(child.operationId.startsWith('universal-child:')); assert.equal((await ledger(child.operationId)).length, 1); assert.equal(Number((await stock(productId))[0].stock_available), 3);
      const stored = (await sql.query('SELECT result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, body.operationId])).rows;
      assert.equal(stored.length, 1); assert.deepEqual(stored[0].result_json, one.json);
      const sale = await request('/api/operations', { body: plan('http-universal-sale', [{ itemId: 'sell', type: 'stock.sell', target: { kind: 'existing', skuId: productId }, quantity: { value: 1, unit: 'unit' } }]) });
      assert.equal(sale.status, 200); assert.equal(Number((await stock(productId))[0].stock_available), 2);
      assert.deepEqual((await request('/api/operations', { body })).json, one.json);
      const collision = await request('/api/operations', { body: plan(body.operationId, [{ itemId: 'party', type: 'client.create', name: 'Conflicto universal dominio' }]) });
      assert.equal(collision.status, 409); assert.equal(collision.json.code, 'IDEMPOTENCY_CONFLICT');
      const unknown = await request('/api/operations', { body: { ...body, operationId: 'http-universal-unknown-field', actions: [{ ...body.actions[0], ownerPhone: 'foreign' }] } });
      assert.equal(unknown.status, 400);
      const stale = await request('/api/operations', { body: plan('http-universal-stale-sku', [{ itemId: 'edit', type: 'sku.update', target: { kind: 'existing', skuId: productId, expectedRevision: 0 }, changes: { price: 0 }, reason: 'Ficha anterior a venta' }]) });
      assert.equal(stale.status, 409); assert.equal(stale.json.code, 'REVISION_MISMATCH');
    });
    await run('universal party and account receipts preserve explicit targets, stale guards and replay after deletion', async () => {
      const body = plan('http-universal-parties', [{ itemId: 'client', type: 'client.create', name: 'HTTP Cliente Universal' }, { itemId: 'supplier', type: 'supplier.create', name: 'HTTP Proveedor Universal' }]);
      const created = await request('/api/operations', { body }); assert.equal(created.status, 200); assert.equal(created.json.domain, 'parties');
      const client = created.json.domainResult.items[0].party;
      const editBody = plan('http-universal-party-edit', [{ itemId: 'edit', type: 'client.update', target: { kind: 'existing', partyId: client.id, expectedRevision: 0 }, changes: { notas: 'Nota universal editada' } }]);
      const edited = await request('/api/operations', { body: editBody }); assert.equal(edited.status, 200); assert.equal(edited.json.domainResult.items[0].party.metadataRevision, 1);
      const stale = await request('/api/operations', { body: { ...editBody, operationId: 'http-universal-party-stale' } });
      assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PARTY_REVISION_MISMATCH');
      const removed = await request('/api/operations', { body: plan('http-universal-party-delete', [{ itemId: 'delete', type: 'client.delete', target: { kind: 'existing', partyId: client.id, expectedRevision: 1, expectedAccountRevision: 0 }, reason: 'Baja universal explícita' }]) });
      assert.equal(removed.status, 200); assert.equal(removed.json.domainResult.items[0].deleted, true);
      assert.deepEqual((await request('/api/operations', { body })).json, created.json);
      assert.deepEqual((await request('/api/operations', { body: editBody })).json, edited.json);
      assert.equal((await sql.query('SELECT 1 FROM clients WHERE id=$1', [client.id])).rowCount, 0);
      const accountClient = await createFixtureClient({ name: 'HTTP Cuenta Universal' }, owner);
      const charge = plan('http-universal-account-charge', [{ itemId: 'money', type: 'account.charge', target: { kind: 'existing', clientId: accountClient.id }, amount: { value: 10, unit: 'legacy-money' }, reason: 'Cargo universal revisado' }]);
      const applied = await request('/api/operations', { body: charge }); assert.equal(applied.status, 200); assert.equal(applied.json.domain, 'accounts'); assert.equal(applied.json.domainResult.items[0].balance, 10);
      const paid = await request('/api/operations', { body: { ...charge, operationId: 'http-universal-account-payment', actions: [{ ...charge.actions[0], type: 'account.payment', amount: { value: 3, unit: 'legacy-money' } }] } });
      assert.equal(paid.status, 200); assert.equal(paid.json.domainResult.items[0].balance, 7);
      assert.deepEqual((await request('/api/operations', { body: charge })).json, applied.json);
      const accountRow = (await sql.query('SELECT debt,account_revision FROM clients WHERE owner_phone=$1 AND id=$2', [owner, accountClient.id])).rows[0];
      assert.equal(Number(accountRow.debt), 7); assert.equal(Number(accountRow.account_revision), 2);
      const staleAccount = await request('/api/operations', { body: { ...charge, operationId: 'http-universal-account-stale', actions: [{ ...charge.actions[0], type: 'account.adjust', target: { ...charge.actions[0].target, expectedRevision: 0 } }] } });
      assert.equal(staleAccount.status, 409); assert.equal(staleAccount.json.code, 'ACCOUNT_REVISION_MISMATCH');
      const conflict = await request('/api/operations', { body: { ...charge, actions: [{ ...charge.actions[0], amount: { value: 11, unit: 'legacy-money' } }] } });
      assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');
    });
    await run('universal mixed HTTP blocks commit ordered receipts once and roll back earlier stock on later account failure', async () => {
      const product = await createHttpFixtureProduct({ name: 'HTTP Composición Stock', stockAvailable: 2, price: 90 }, owner);
      const customer = await createFixtureClient({ name: 'HTTP Composición Cuenta' }, owner);
      const receive = { itemId: 'stock', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 3, unit: 'unit' } };
      const charge = { itemId: 'money', type: 'account.charge', target: { kind: 'existing', clientId: customer.id }, amount: { value: 7, unit: 'legacy-money' }, reason: 'Cargo explícito junto al stock' };
      const body = plan('http-universal-composition', [receive, charge]);
      const [one, two] = await Promise.all([request('/api/operations', { body }), request('/api/operations', { body })]);
      assert.equal(one.status, 200); assert.equal(two.status, 200); assert.deepEqual(one.json, two.json);
      assert.equal(one.json.domain, 'mixed'); assert.equal(one.json.operationId, body.operationId);
      assert.deepEqual(one.json.receipts.map(({ items }) => items[0].type), ['stock.receive', 'account.charge']);
      assert.equal(Number((await stock(product.id))[0].stock_available), 5);
      const accountRow = async () => (await sql.query('SELECT debt,account_revision FROM clients WHERE owner_phone=$1 AND id=$2', [owner, customer.id])).rows[0];
      assert.deepEqual(Object.values(await accountRow()).map(Number), [7, 1]);
      const roots = (await sql.query('SELECT result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, body.operationId])).rows;
      assert.equal(roots.length, 1); assert.deepEqual(roots[0].result_json, one.json);
      for (const [index, table] of ['inventory_operations', 'account_operations'].entries()) {
        const child = one.json.receipts[index]; assert.ok(child.operationId.startsWith('universal-child:'));
        assert.deepEqual((await sql.query(`SELECT result_json FROM ${table} WHERE owner_phone=$1 AND operation_id=$2`, [owner, child.operationId])).rows[0].result_json, child);
        if (index === 0) assert.equal((await sql.query('SELECT 1 FROM transactions WHERE owner_phone=$1 AND batch_id=$2', [owner, `${owner}:${child.operationId}`])).rowCount, 1);
        else {
          const historyId = `account-${crypto.createHash('sha256').update(JSON.stringify([owner, child.operationId, child.items[0].itemId])).digest('hex')}`;
          assert.equal((await sql.query('SELECT 1 FROM transactions WHERE owner_phone=$1 AND id=$2', [owner, historyId])).rowCount, 1);
        }
      }
      assert.equal((await ledger(one.json.receipts[0].operationId)).length, 1);
      assert.equal((await sql.query('SELECT 1 FROM account_movements WHERE owner_phone=$1 AND operation_id=$2', [owner, one.json.receipts[1].operationId])).rowCount, 1);
      const collision = await request('/api/operations', { body: { ...body, actions: [receive, { ...charge, amount: { value: 8, unit: 'legacy-money' } }] } });
      assert.equal(collision.status, 409); assert.equal(collision.json.code, 'IDEMPOTENCY_CONFLICT');
      const paid = await request('/api/operations', { body: plan('http-universal-composition-later-payment', [{ ...charge, type: 'account.payment', amount: { value: 2, unit: 'legacy-money' } }]) });
      assert.equal(paid.status, 200); assert.equal(Number((await accountRow()).debt), 5);
      assert.deepEqual((await request('/api/operations', { body })).json, one.json);
      const persisted = async () => {
        const result = {};
        for (const table of ['products', 'clients', 'universal_operations', 'inventory_operations', 'account_operations', 'inventory_movements', 'account_movements', 'transactions']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows;
        return result;
      };
      const before = await persisted();
      const failed = await request('/api/operations', { body: plan('http-universal-composition-late-failure', [receive, { ...charge, type: 'account.payment', amount: { value: 6, unit: 'legacy-money' } }]) });
      assert.equal(failed.status, 409); assert.equal(failed.json.code, 'PAYMENT_EXCEEDS_DEBT'); assert.deepEqual(await persisted(), before);
    });
    await run('universal orders HTTP creates, updates and deletes with exact stock receipts and frozen concurrent replay', async () => {
      const customer = await createFixtureClient({ name: 'HTTP Pedido Universal Cliente' }, owner);
      const product = await createHttpFixtureProduct({ name: 'HTTP Pedido Universal SKU', stockAvailable: 0, stockReserved: 2 }, owner);
      const action = { itemId: 'order', type: 'order.create', order: { clienteId: customer.id, producto: 'Etiqueta pedido universal HTTP', productId: product.id, qty: 3, estado: 'conseguido' } };
      const body = plan('http-universal-order-create', [action]);
      const [one, two] = await Promise.all([request('/api/operations', { body }), request('/api/operations', { body })]);
      assert.equal(one.status, 200); assert.equal(two.status, 200); assert.deepEqual(one.json, two.json); assert.equal(one.json.domain, 'orders');
      const block = one.json.domainResult, created = block.receipts[0]; assert.equal(created.itemId, 'order');
      assert.equal(created.inventoryResult.items[0].type, 'stock.receive'); assert.deepEqual(created.pedido.stockPosting, { skuId: product.id, quantity: 3, unit: 'unit' });
      assert.deepEqual((await sql.query('SELECT result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, body.operationId])).rows[0].result_json, one.json);
      assert.deepEqual((await sql.query('SELECT result_json FROM order_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, block.operationId])).rows[0].result_json, block);
      assert.equal((await ledger(created.inventoryResult.operationId)).length, 1);
      assert.deepEqual([Number((await stock(product.id))[0].stock_available), Number((await stock(product.id))[0].stock_reserved)], [3, 2]);
      const target = (pedido) => ({ kind: 'existing', pedidoId: pedido.id, expectedRevision: pedido.revision });
      const updated = await request('/api/operations', { body: plan('http-universal-order-update', [{ itemId: 'update', type: 'order.update', target: target(created.pedido), changes: { qty: 5 } }]) });
      assert.equal(updated.status, 200); const changed = updated.json.domainResult.receipts[0].pedido;
      assert.equal(changed.revision, 1); assert.equal(Number((await stock(product.id))[0].stock_available), 5);
      const deletedBody = plan('http-universal-order-delete', [{ itemId: 'delete', type: 'order.delete', target: target(changed) }]);
      const deleted = await request('/api/operations', { body: deletedBody }); assert.equal(deleted.status, 200);
      assert.equal(deleted.json.domainResult.receipts[0].deleted, true); assert.equal(deleted.json.domainResult.receipts[0].inventoryResult.items[0].type, 'stock.withdraw');
      assert.deepEqual([Number((await stock(product.id))[0].stock_available), Number((await stock(product.id))[0].stock_reserved)], [0, 2]);
      assert.equal((await sql.query('SELECT 1 FROM pedidos WHERE owner_phone=$1 AND id=$2', [owner, changed.id])).rowCount, 0);
      assert.deepEqual((await request('/api/operations', { body })).json, one.json);
      assert.deepEqual((await request('/api/operations', { body: deletedBody })).json, deleted.json);
      const before = (await sql.query('SELECT * FROM order_operations WHERE owner_phone=$1 ORDER BY operation_id', [owner])).rows;
      const unbound = await request('/api/operations', { body: plan('http-universal-order-unbound', [{ ...action, order: { ...action.order, productId: null } }]) });
      assert.equal(unbound.status, 409); assert.equal(unbound.json.code, 'SKU_SELECTION_REQUIRED');
      const mixed = await request('/api/operations', { body: plan('http-universal-order-raw-withdraw', [action, { itemId: 'withdraw', type: 'stock.withdraw', target: { kind: 'existing', skuId: product.id }, quantity: { value: 1, unit: 'unit' }, reason: 'Retiro explícito' }]) });
      assert.equal(mixed.status, 403); assert.equal(mixed.json.code, 'FORBIDDEN');
      assert.deepEqual((await sql.query('SELECT * FROM order_operations WHERE owner_phone=$1 ORDER BY operation_id', [owner])).rows, before);
      assert.equal(Number((await stock(product.id))[0].stock_available), 0);
    });
    await run('draft HTTP validates auth/body and reports unavailable interpretation without persisting mutations', async () => {
      const snapshot = async () => {
        const result = {};
        for (const table of ['products', 'clients', 'pedidos', 'universal_operations', 'universal_drafts', 'universal_draft_commands', 'inventory_operations', 'account_operations', 'inventory_movements', 'account_movements', 'transactions']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`, [owner])).rows;
        return result;
      };
      const before = await snapshot(), body = { requestId: 'http-draft-unavailable', text: 'Ingresaron tres unidades del producto existente.' };
      assert.equal((await request('/api/operation-drafts', { body, auth: false })).status, 401);
      const invalid = await request('/api/operation-drafts', { body: { ...body, text: '' } });
      assert.equal(invalid.status, 400); assert.equal(invalid.json.code, 'INVALID_DRAFT_REQUEST');
      const reserved = await request('/api/operation-drafts', { body: { ...body, requestId: 'universal-meta:reserved' } });
      assert.equal(reserved.status, 400); assert.equal(reserved.json.code, 'INVALID_DRAFT_REQUEST');
      const unavailable = await request('/api/operation-drafts', { body });
      assert.equal(unavailable.status, 503); assert.equal(unavailable.json.code, 'INTERPRETATION_UNAVAILABLE'); assert.deepEqual(await snapshot(), before);
    });
    await run('draft HTTP reads exact preview, forbids plan bypass and isolates concurrent confirmation with immutable replay', async () => {
      const product = await createHttpFixtureProduct({ name: 'HTTP Draft SKU', stockAvailable: 2 }, owner), customer = await createFixtureClient({ name: 'HTTP Draft Cuenta' }, owner);
      const text = 'Ingresaron tres unidades y cargá siete a la cuenta.';
      const actions = [{ itemId: 'stock', type: 'stock.receive', target: { kind: 'existing', skuId: product.id }, quantity: { value: 3, unit: 'unit' } },
        { itemId: 'money', type: 'account.charge', target: { kind: 'existing', clientId: customer.id }, amount: { value: 7, unit: 'legacy-money' }, reason: 'Cargo explícito' }];
      const ctx = { businessId: owner, actorId: owner, channel: 'panel', permissions: ['inventory:receive', 'accounts:charge'] };
      const preview = await db.prepareUniversalDraft({ requestId: 'http-draft-ready', text }, ctx, { complete: async () => ({ ok: true, json: { contractVersion: 1, kind: 'proposal', actions, evidence: actions.map(({ itemId }) => ({ itemId, quote: text })) } }) });
      const route = `/api/operation-drafts/${preview.draftId}`, body = { version: preview.version, digest: preview.digest };
      const fetched = await request(route, { method: 'GET' }); assert.equal(fetched.status, 200); assert.deepEqual(fetched.json, preview);
      assert.equal((await request(route, { method: 'GET', auth: false })).status, 401);
      const foreignHeaders = { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000516' })}` };
      for (const [path, method] of [[route, 'GET'], [`${route}/confirm`, 'POST'], [`${route}/cancel`, 'POST']]) {
        const foreign = await request(path, { method, ...(method === 'POST' ? { body } : {}), headers: foreignHeaders }); assert.equal(foreign.status, 404); assert.equal(foreign.json.code, 'DRAFT_NOT_FOUND');
      }
      const bypass = await request('/api/operations', { body: preview.plan }); assert.equal(bypass.status, 403); assert.equal(bypass.json.code, 'FORBIDDEN');
      assert.equal(Number((await stock(product.id))[0].stock_available), 2);
      const [one, two] = await Promise.all([request(`${route}/confirm`, { body }), request(`${route}/confirm`, { body })]);
      assert.equal(one.status, 200); assert.equal(two.status, 200); assert.deepEqual(one.json, two.json); assert.equal(one.json.status, 'applied'); assert.equal(one.json.result.domain, 'mixed');
      assert.deepEqual(one.json.result.receipts.map(({ items }) => items[0].type), ['stock.receive', 'account.charge']);
      assert.equal(Number((await stock(product.id))[0].stock_available), 5); assert.equal(Number((await sql.query('SELECT debt FROM clients WHERE owner_phone=$1 AND id=$2', [owner, customer.id])).rows[0].debt), 7);
      assert.deepEqual((await sql.query('SELECT result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, preview.plan.operationId])).rows[0].result_json, one.json.result);
      const inventoryId = one.json.result.receipts[0].operationId, accountId = one.json.result.receipts[1].operationId;
      assert.equal((await ledger(inventoryId)).length, 1); assert.equal((await sql.query('SELECT 1 FROM account_movements WHERE owner_phone=$1 AND operation_id=$2', [owner, accountId])).rowCount, 1);
      await sql.query('UPDATE products SET price=123,inventory_revision=inventory_revision+1 WHERE owner_phone=$1 AND id=$2', [owner, product.id]);
      const storedDraft = (await sql.query('SELECT preview_json FROM universal_drafts WHERE owner_phone=$1 AND draft_id=$2', [owner, preview.draftId])).rows[0].preview_json;
      assert.deepEqual(storedDraft, one.json); assert.deepEqual((await request(`${route}/confirm`, { body })).json, one.json);
      assert.equal((await ledger(inventoryId)).length, 1); assert.equal((await sql.query('SELECT 1 FROM account_movements WHERE owner_phone=$1 AND operation_id=$2', [owner, accountId])).rowCount, 1);
    });
    await run('draft HTTP rejects stale clarification reply before provider access and cancellation prevents confirmation', async () => {
      const ctx = { businessId: owner, actorId: owner, channel: 'panel', permissions: ['inventory:receive'] };
      const preview = await db.prepareUniversalDraft({ requestId: 'http-draft-clarification', text: 'Recibí mercadería.' }, ctx, { complete: async () => ({ ok: true, json: { contractVersion: 1, kind: 'clarification', question: '¿Cuántas unidades?' } }) });
      const route = `/api/operation-drafts/${preview.draftId}`, body = { version: preview.version, digest: preview.digest };
      const before = (await sql.query('SELECT * FROM universal_draft_commands WHERE owner_phone=$1 ORDER BY request_id', [owner])).rows;
      const stale = await request(`${route}/replies`, { body: { requestId: 'http-draft-stale-reply', text: 'Tres unidades.', version: preview.version + 1 } });
      assert.equal(stale.status, 409); assert.equal(stale.json.code, 'DRAFT_VERSION_MISMATCH');
      assert.deepEqual((await sql.query('SELECT * FROM universal_draft_commands WHERE owner_phone=$1 ORDER BY request_id', [owner])).rows, before);
      const cancelled = await request(`${route}/cancel`, { body }); assert.equal(cancelled.status, 200); assert.equal(cancelled.json.status, 'cancelled');
      assert.deepEqual((await request(`${route}/cancel`, { body })).json, cancelled.json);
      const confirm = await request(`${route}/confirm`, { body }); assert.equal(confirm.status, 409); assert.equal(confirm.json.code, 'DRAFT_NOT_PENDING');
      const reply = await request(`${route}/replies`, { body: { requestId: 'http-draft-after-cancel', text: 'Tres unidades.', version: preview.version } }); assert.equal(reply.status, 409); assert.equal(reply.json.code, 'DRAFT_NOT_PENDING');
      assert.deepEqual((await request(route, { method: 'GET' })).json, cancelled.json);
    });
    await run('universal read answer HTTP replays its frozen facts and cannot become a mutation',async()=>{
      const product=await createHttpFixtureProduct({name:'HTTP Universal Read',stockAvailable:0,stockReserved:2,price:0},owner);
      const body={requestId:'http-universal-read',text:'¿Cuánto inventario tiene este producto?'};
      const ctx={businessId:owner,actorId:owner,channel:'panel',permissions:['inventory:read']};
      const preview=await db.prepareUniversalDraft(body,ctx,{complete:async()=>({ok:true,json:{contractVersion:1,kind:'query',queries:[{itemId:'read',type:'inventory.query',selector:{kind:'ids',ids:[product.id]}}],evidence:[{itemId:'read',quote:body.text}]}})});
      assert.equal(preview.status,'answered');assert.equal(preview.plan,undefined);assert.equal(preview.answer.items[0].rows[0].stockAvailable,0);
      const route=`/api/operation-drafts/${preview.draftId}`;
      await sql.query('UPDATE products SET stock_available=7 WHERE owner_phone=$1 AND id=$2',[owner,product.id]);
      const get=await request(route,{method:'GET'});assert.equal(get.status,200);assert.deepEqual(get.json,preview);
      const replay=await request('/api/operation-drafts',{body});assert.equal(replay.status,200);assert.deepEqual(replay.json,preview);
      for(const suffix of ['confirm','cancel']) {
        const result=await request(`${route}/${suffix}`,{body:{version:preview.version,digest:preview.digest}});
        assert.equal(result.status,409);assert.equal(result.json.code,'DRAFT_NOT_PENDING');
      }
      const foreign=await request(route,{method:'GET',headers:{Authorization:`Bearer ${issueJwt({phoneNumber:'59899000516'})}`}});
      assert.equal(foreign.status,404);assert.equal(foreign.json.code,'DRAFT_NOT_FOUND');
      assert.equal(Number((await stock(product.id))[0].stock_available),7);
      assert.equal((await sql.query('SELECT 1 FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2',[owner,`draft-operation:${preview.draftId}`])).rowCount,0);
    });
    const universalWebhook = async (messageId, text, sender = owner) => {
      const raw=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id:messageId,from:sender,type:'text',text:{body:text}}]}}]}]});
      const headers={'X-Hub-Signature-256':`sha256=${crypto.createHmac('sha256',appSecret).update(Buffer.from(raw)).digest('hex')}`};
      assert.equal((await request('/api/meta-webhook',{raw,headers,auth:false})).status,200);
      const deadline=Date.now()+5000;
      while(Date.now()<deadline) {
        const row=(await sql.query('SELECT result_json FROM universal_meta_commands WHERE owner_phone=$1 AND message_id=$2',[sender,messageId])).rows[0];
        const claim=(await sql.query('SELECT status FROM meta_message_claims WHERE message_id=$1',[messageId])).rows[0];
        if(row && claim?.status==='completed') return row.result_json;
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      assert.fail('Universal Meta command did not complete through the signed webhook');
    };
    const reviewedUniversalCommand = async (requestId, text, actions) => {
      const preview = await db.prepareUniversalDraft({ requestId, text },
        { businessId: owner, actorId: owner, channel: 'panel', permissions: ['inventory:sell', 'orders:update', 'accounts:payment'] },
        { complete: async () => ({ ok: true, json: { contractVersion: 1, kind: 'proposal', actions,
          evidence: actions.map(({ itemId }) => ({ itemId, quote: text })) } }) });
      assert.equal(preview.status, 'awaiting_confirmation');
      return `CONFIRMAR OPERACION ${preview.digest.slice(0, 8)}`;
    };
    // Fixtures committed before the ordinary-message cutover must remain recoverable.
    const legacySelection = (messageId, product, changes) => db.prepareMetaInventorySelection({
      messageId, ownerPhone: owner, senderPhone: owner, sourceText: 'Selección histórica revisada',
      actions: [{ type: changes ? 'update_product' : 'delete_product', productId: product.id, ...changes }],
    });
    await run('signed ordinary WhatsApp without a provider fails terminally without legacy writes', async () => {
      await createHttpFixtureProduct({ name: 'HTTP Ordinary No Provider', stockAvailable: 5, price: 900 }, owner);
      const before = {};
      for (const table of ['products', 'clients', 'pedidos', 'inventory_movements', 'inventory_operations', 'account_operations', 'account_movements', 'universal_operations', 'transactions', 'inventory_selections', 'voice_stock_batches'])
        before[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows;
      for (const [index, text] of ['Vendí 2 HTTP Ordinary No Provider', 'Borrá HTTP Ordinary No Provider', 'HTTP Ordinary No Provider vale 0', '¿Cuánto stock hay?'].entries()) {
        const id = `http-meta-ordinary-unavailable-${index}`;
        const result = await universalWebhook(id, text);
        assert.equal(result.errorCode, 'INTERPRETATION_UNAVAILABLE'); assert.deepEqual(result.actions, []);
        assert.deepEqual(await universalWebhook(id, text), result);
        const event = (await sql.query('SELECT error,processed FROM meta_events WHERE id=$1', [id])).rows[0];
        assert.equal(event.error, result.errorCode); assert.equal(event.processed, true);
        assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', [id])).rows[0].reply_text, result.replyText);
      }
      for (const [table, rows] of Object.entries(before))
        assert.deepEqual((await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows, rows);
    });
    await run('signed ordinary WhatsApp replays a frozen backend query answer without a provider', async () => {
      const product = await createHttpFixtureProduct({ name: 'HTTP Ordinary Query', stockAvailable: 6 }, owner);
      const messageId = 'http-meta-ordinary-query', sourceText = '¿Cuánto stock tiene HTTP Ordinary Query?';
      const result = await db.processMetaUniversalMessage({ messageId, sourceText, ownerPhone: owner, senderPhone: owner },
        { ordinary: true, complete: async () => ({ ok: true, json: { contractVersion: 1, kind: 'query',
          queries: [{ itemId: 'read', type: 'inventory.query', selector: { kind: 'ids', ids: [product.id] } }],
          evidence: [{ itemId: 'read', quote: sourceText }] } }) });
      assert.equal(result.status, 'answered'); assert.equal(result.answer.items[0].rows[0].stockAvailable, 6);
      await sql.query('UPDATE products SET stock_available=8 WHERE owner_phone=$1 AND id=$2', [owner, product.id]);
      assert.deepEqual(await universalWebhook(messageId, sourceText), result);
      assert.deepEqual(await universalWebhook(messageId, sourceText), result);
      assert.equal(Number((await stock(product.id))[0].stock_available), 8);
      assert.equal((await ledger(`whatsapp:${messageId}`)).length, 0);
      assert.equal((await sql.query('SELECT 1 FROM voice_stock_batches WHERE source_message_id=$1', [messageId])).rowCount, 0);
    });
    await run('signed ordinary WhatsApp proposal waits for review and confirms the frozen sale once', async () => {
      const product = await createHttpFixtureProduct({ name: 'HTTP Ordinary Sale', stockAvailable: 5 }, owner);
      const messageId = 'http-meta-ordinary-proposal', sourceText = 'Vendí 2 HTTP Ordinary Sale';
      const actions = [{ itemId: 'sale', type: 'stock.sell', target: { kind: 'existing', skuId: product.id }, quantity: { value: 2, unit: 'unit' } }];
      const preview = await db.processMetaUniversalMessage({ messageId, sourceText, ownerPhone: owner, senderPhone: owner },
        { ordinary: true, complete: async () => ({ ok: true, json: { contractVersion: 1, kind: 'proposal', actions,
          evidence: [{ itemId: 'sale', quote: sourceText }] } }) });
      assert.equal(preview.status, 'awaiting_confirmation'); assert.deepEqual(preview.actions, []);
      assert.deepEqual(await universalWebhook(messageId, sourceText), preview);
      assert.equal(Number((await stock(product.id))[0].stock_available), 5);
      const command = `CONFIRMAR OPERACION ${preview.digest.slice(0, 8)}`;
      const applied = await universalWebhook('http-meta-ordinary-proposal-confirm', command);
      assert.equal(applied.status, 'applied'); assert.equal(applied.actions[0].productId, product.id);
      assert.equal(Number((await stock(product.id))[0].stock_available), 3);
      assert.deepEqual(await universalWebhook('http-meta-ordinary-proposal-confirm', command), applied);
      assert.equal((await ledger(applied.operationResult.domainResult.operationId)).length, 1);
      assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', ['http-meta-ordinary-proposal-confirm'])).rows[0].reply_text, applied.replyText);
      assert.equal((await sql.query('SELECT 1 FROM voice_stock_batches WHERE source_message_id=$1', [messageId])).rowCount, 0);
    });
    await run('signed WhatsApp universal confirmation uses the shared reviewed draft and freezes exact mixed receipts', async () => {
      const product=await createHttpFixtureProduct({name:'HTTP Meta Universal SKU',stockAvailable:2},owner);
      const customer=await createFixtureClient({name:'HTTP Meta Universal Cuenta'},owner);
      const text='Ingresaron tres unidades y cargá siete a la cuenta.';
      const actions=[{itemId:'stock',type:'stock.receive',target:{kind:'existing',skuId:product.id},quantity:{value:3,unit:'unit'}},
        {itemId:'money',type:'account.charge',target:{kind:'existing',clientId:customer.id},amount:{value:7,unit:'legacy-money'},reason:'Cargo explícito'}];
      const preview=await db.prepareUniversalDraft({requestId:'http-meta-universal-ready',text},
        {businessId:owner,actorId:owner,channel:'panel',permissions:['inventory:receive','accounts:charge']},
        {complete:async()=>({ok:true,json:{contractVersion:1,kind:'proposal',actions,evidence:actions.map(({itemId})=>({itemId,quote:text}))}})});
      const command=`CONFIRMAR OPERACION ${preview.digest.slice(0,8)}`;
      const [one,two]=await Promise.all([universalWebhook('http-meta-universal-confirm',command),universalWebhook('http-meta-universal-confirm-two',command)]);
      assert.equal(one.status,'applied');assert.deepEqual(one,two);assert.equal(one.operationResult.domain,'mixed');
      assert.deepEqual(one.actions.map(action=>action.type),['add_stock','add_debt']);
      assert.match(one.replyText,/Ingreso aplicado: 3 unit/);assert.match(one.replyText,/7/);
      assert.equal(Number((await stock(product.id))[0].stock_available),5);
      assert.equal(Number((await sql.query('SELECT debt FROM clients WHERE owner_phone=$1 AND id=$2',[owner,customer.id])).rows[0].debt),7);
      const stored=(await sql.query('SELECT preview_json FROM universal_drafts WHERE owner_phone=$1 AND draft_id=$2',[owner,preview.draftId])).rows[0].preview_json;
      assert.equal(stored.status,'applied');assert.deepEqual(stored.result,one.operationResult);
      assert.equal((await ledger(one.operationResult.receipts[0].operationId)).length,1);
      const event=(await sql.query('SELECT actions_json,processed,reply_text FROM meta_events WHERE id=$1',['http-meta-universal-confirm'])).rows[0];
      assert.equal(event.processed,true);assert.deepEqual(typeof event.actions_json==='string'?JSON.parse(event.actions_json):event.actions_json,one.actions);assert.equal(event.reply_text,one.replyText);
      const outbox=(await sql.query('SELECT recipient,reply_text FROM meta_reply_outbox WHERE event_id=$1',['http-meta-universal-confirm'])).rows[0];
      assert.deepEqual(outbox,{recipient:owner,reply_text:one.replyText});
      assert.deepEqual(await universalWebhook('http-meta-universal-confirm',command),one);
      assert.equal((await ledger(one.operationResult.receipts[0].operationId)).length,1);
    });
    await run('signed WhatsApp universal invalid and unavailable messages are terminal and never fall back to a legacy mutation', async () => {
      const before=(await sql.query('SELECT * FROM products WHERE owner_phone=$1 ORDER BY id',[owner])).rows;
      for(const [messageId,text,errorCode] of [
        ['http-meta-universal-invalid','CONFIRMAR OPERACION invalid','INVALID_DRAFT_REQUEST'],
        ['http-meta-universal-unavailable','REVISAR OPERACION Vendí tres unidades.','INTERPRETATION_UNAVAILABLE'],
      ]) {
        const result=await universalWebhook(messageId,text);assert.equal(result.errorCode,errorCode);assert.deepEqual(result.actions,[]);
        assert.equal((await sql.query('SELECT 1 FROM voice_stock_batches WHERE source_message_id=$1',[messageId])).rowCount,0);
        assert.deepEqual(await universalWebhook(messageId,text),result);
      }
      assert.deepEqual((await sql.query('SELECT * FROM products WHERE owner_phone=$1 ORDER BY id',[owner])).rows,before);
      assert.equal((await sql.query("SELECT relrowsecurity FROM pg_class WHERE relname='universal_meta_commands'")).rows[0].relrowsecurity,true);
    });
    await run('family HTTP publication authenticates, isolates tenants and serializes immutable version receipts', async () => {
      const schema = { name: 'HTTP Componentes', unit: 'unit', attributes: { voltage: { type: 'number', required: true, unit: 'v', values: [12, 24] }, direction: { type: 'text', required: true, values: ['entrada', 'salida'] } }, allowAdditionalAttributes: false };
      const body = { operationId: 'http-family-publication', familyId: 'http-family-auth', expectedVersion: 0, schema };
      assert.equal((await request('/api/inventory/families', { method: 'GET', auth: false })).status, 401);
      assert.equal((await request('/api/inventory/families', { body, auth: false })).status, 401);
      const override = await request('/api/inventory/families', { body: { ...body, businessId: '59899000517' } }); assert.equal(override.status, 400); assert.equal(override.json.code, 'INVALID_PRODUCT_SCHEMA');
      const [one, two] = await Promise.all([request('/api/inventory/families', { body }), request('/api/inventory/families', { body })]);
      assert.equal(one.status, 200); assert.equal(two.status, 200); assert.deepEqual(one.json, two.json); assert.equal(one.json.family.version, 1);
      const listed = await request('/api/inventory/families', { method: 'GET' }); assert.equal(listed.status, 200); assert.deepEqual(listed.json.families.find(({ familyId }) => familyId === body.familyId), one.json.family);
      const foreignHeaders = { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000517' })}` };
      const foreign = await request('/api/inventory/families', { method: 'GET', headers: foreignHeaders }); assert.equal(foreign.status, 200); assert.equal(foreign.json.families.some(({ familyId }) => familyId === body.familyId), false);
      const stale = await request('/api/inventory/families', { body: { ...body, operationId: 'http-family-stale-version' } }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PRODUCT_SCHEMA_VERSION_MISMATCH');
      assert.equal((await sql.query('SELECT 1 FROM product_family_schemas WHERE owner_phone=$1 AND family_id=$2', [owner, body.familyId])).rowCount, 1);
      assert.deepEqual((await sql.query('SELECT result_json FROM product_family_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, body.operationId])).rows[0].result_json, one.json);
    });
    await run('family HTTP SKU creation and explicit metadata upgrade preserve schema validation and exact persisted family', async () => {
      const schema = { name: 'HTTP Electrónica validada', unit: 'unit', attributes: { voltage: { type: 'number', required: true, unit: 'v', values: [12, 24] }, direction: { type: 'text', required: true, values: ['entrada', 'salida'] } }, allowAdditionalAttributes: false };
      const publication = { operationId: 'http-family-sku-publish', familyId: 'http-family-sku', expectedVersion: 0, schema };
      const first = await request('/api/inventory/families', { body: publication }); assert.equal(first.status, 200);
      const attributes = { voltage: { type: 'number', state: 'known', value: 12, unit: 'v' }, direction: { type: 'text', state: 'known', value: 'entrada' } };
      const action = { itemId: 'create', type: 'sku.create', target: { kind: 'new', sku: { name: 'HTTP Componente familia', unit: 'unit', family: { id: publication.familyId, version: 1 }, attributes } }, initialStock: { available: 3, reserved: 0 }, reason: 'Alta explícita de familia HTTP' };
      const created = await request('/api/operations', { body: plan('http-family-sku-create', [action]) }); assert.equal(created.status, 200);
      const item = created.json.domainResult.items[0], skuId = item.skuId; assert.deepEqual(item.product.family, action.target.sku.family);
      const familyRow = async () => {
        const row = (await sql.query('SELECT family_id,family_version,inventory_revision FROM products WHERE owner_phone=$1 AND id=$2', [owner, skuId])).rows[0];
        return { ...row, family_version: Number(row.family_version), inventory_revision: Number(row.inventory_revision) };
      };
      assert.deepEqual(await familyRow(), { family_id: publication.familyId, family_version: 1, inventory_revision: 0 });
      const snapshot = async () => {
        const result = {};
        for (const table of ['products', 'inventory_operations', 'inventory_movements', 'transactions', 'universal_operations']) result[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`, [owner])).rows;
        return result;
      };
      const before = await snapshot();
      for (const [index, extra] of [{ unit: 'box' }, { attributes: { ...attributes, voltage: { ...attributes.voltage, value: 36 } } }].entries()) {
        const invalid = { ...action, target: { kind: 'new', sku: { ...action.target.sku, name: `HTTP Invalid family ${index}`, ...extra } } };
        const response = await request('/api/operations', { body: plan(`http-family-invalid-${index}`, [invalid]) }); assert.equal(response.status, 409); assert.equal(response.json.code, 'PRODUCT_SCHEMA_MISMATCH');
      }
      const outsider = await request('/api/inventory/families', { body: { ...publication, operationId: 'http-family-foreign-publish', familyId: 'http-family-foreign-only' }, headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000517' })}` } }); assert.equal(outsider.status, 200);
      const foreignSku = { ...action, target: { kind: 'new', sku: { ...action.target.sku, name: 'HTTP Family foreign SKU', family: { id: 'http-family-foreign-only', version: 1 } } } };
      const refused = await request('/api/operations', { body: plan('http-family-foreign-sku', [foreignSku]) }); assert.equal(refused.status, 404); assert.equal(refused.json.code, 'PRODUCT_SCHEMA_NOT_FOUND'); assert.deepEqual(await snapshot(), before);
      const v2 = await request('/api/inventory/families', { body: { ...publication, operationId: 'http-family-sku-v2', expectedVersion: 1, schema: { ...schema, attributes: { ...schema.attributes, certified: { type: 'boolean', required: true } } } } }); assert.equal(v2.status, 200); assert.equal((await familyRow()).family_version, 1);
      const current = (await db.getStateSnapshotStrict(owner)).products.find(({ id }) => id === skuId);
      const upgradeBody = { operationId: 'http-family-sku-upgrade', expectedRevision: current.revision, expectedFingerprint: current.identityFingerprint, reason: 'Adopción explícita de contrato v2', family: { id: publication.familyId, version: 2 }, attributes: { ...attributes, certified: { type: 'boolean', state: 'known', value: true } } };
      const upgraded = await request(`/api/products/${skuId}`, { method: 'PUT', body: upgradeBody }); assert.equal(upgraded.status, 200); assert.deepEqual(await familyRow(), { family_id: publication.familyId, family_version: 2, inventory_revision: 1 });
      assert.deepEqual((await db.getStateSnapshotStrict(owner)).products.find(({ id }) => id === skuId).family, upgradeBody.family);
      assert.deepEqual((await request('/api/operations', { body: plan('http-family-sku-create', [action]) })).json, created.json);
    });
    await run('universal inventory preserves reviewed selection boundaries and forbids public stock withdrawal', async () => {
      const products = await Promise.all(['A', 'B'].map((suffix) => createHttpFixtureProduct({ name: `HTTP universal selección ${suffix}`, stockAvailable: 4 }, owner)));
      const target = (product) => ({ kind: 'existing', skuId: product.id, expectedRevision: product.revision, expectedFingerprint: product.identityFingerprint });
      const changes = products.map((product, index) => ({ itemId: `edit-${index}`, type: 'sku.update', target: target(product), changes: { price: 0 }, reason: 'Sin selección confirmada' }));
      const bypass = await request('/api/operations', { body: plan('http-universal-selection-bypass', changes) });
      assert.equal(bypass.status, 409); assert.equal(bypass.json.code, 'SELECTION_REQUIRED');
      const archive = await request('/api/operations', { body: plan('http-universal-archive-bypass', [{ itemId: 'archive', type: 'sku.deactivate', target: target(products[0]), reason: 'Sin selección confirmada' }]) });
      assert.equal(archive.status, 409); assert.equal(archive.json.code, 'SELECTION_REQUIRED');
      const withdrawal = await request('/api/operations', { body: plan('http-universal-withdraw-forbidden', [{ itemId: 'withdraw', type: 'stock.withdraw', target: { kind: 'existing', skuId: products[0].id }, quantity: { value: 1, unit: 'unit' }, reason: 'Sin permiso público de retiro' }]) });
      assert.equal(withdrawal.status, 403); assert.equal(withdrawal.json.code, 'FORBIDDEN');
      for (const product of products) assert.equal(Number((await stock(product.id))[0].stock_available), 4);
      assert.equal((await sql.query('SELECT 1 FROM universal_operations WHERE owner_phone=$1 AND operation_id=ANY($2)', [owner, ['http-universal-selection-bypass', 'http-universal-archive-bypass', 'http-universal-withdraw-forbidden']])).rowCount, 0);
    });
    await run('SET adjustment previews reject unsafe or open fields and bulk direct execution requires selection', async () => {
      const products = [await createHttpFixtureProduct({ name: 'HTTP SET validación A', stockAvailable: 8, stockReserved: 2 }, owner), await createHttpFixtureProduct({ name: 'HTTP SET validación B', stockAvailable: 6, stockReserved: 1 }, owner)];
      const body = { requestId: 'http-set-invalid', selector: { kind: 'ids', skuIds: products.map(({ id }) => id) }, mutation: { type: 'stock.adjust', balances: { available: 0 }, reason: 'Conteo de conjunto HTTP' } };
      assert.equal((await request('/api/inventory/selections', { body, auth: false })).status, 401);
      for (const balances of [{}, { available: -1 }, { reserved: '2' }, { available: 0.5 }, { available: null }, { available: Number.MAX_SAFE_INTEGER + 1 }, { available: 0, price: 1 }]) {
        assert.equal((await request('/api/inventory/selections', { body: { ...body, mutation: { ...body.mutation, balances } } })).status, 400);
      }
      for (const extra of [{ ownerPhone: 'foreign' }, { mutation: { ...body.mutation, changes: { price: 0 } } }]) assert.equal((await request('/api/inventory/selections', { body: { ...body, ...extra } })).status, 400);
      const actions = products.map((product, index) => ({ itemId: `adjust-${index}`, type: 'stock.adjust', target: { kind: 'existing', skuId: product.id, expectedRevision: product.revision }, balances: { available: 0 }, reason: body.mutation.reason }));
      for (const route of ['/api/inventory/operations', '/api/operations']) {
        const direct = await request(route, { body: plan(`http-set-bypass-${route === '/api/operations' ? 'universal' : 'inventory'}`, actions) });
        assert.equal(direct.status, 409); assert.equal(direct.json.code, 'SELECTION_REQUIRED');
      }
      for (const product of products) assert.equal(Number((await stock(product.id))[0].stock_available), product.stockAvailable);
      assert.equal((await sql.query('SELECT 1 FROM inventory_selections WHERE owner_phone=$1 AND request_id=$2', [owner, body.requestId])).rowCount, 0);
    });
    await run('SET adjustment HTTP freezes exact units and members then confirms once with immutable replay', async () => {
      const name = 'HTTP SET Conjunto Congelado';
      const products = [await createHttpFixtureProduct({ name, size: 'S', unit: 'box', stockAvailable: 8, stockReserved: 2 }, owner), await createHttpFixtureProduct({ name, size: 'M', unit: 'unit', stockAvailable: 6, stockReserved: 1 }, owner)];
      const body = { requestId: 'http-set-frozen', selector: { kind: 'filter', equals: { name } }, mutation: { type: 'stock.adjust', balances: { available: 0 }, reason: 'Conteo físico de conjunto HTTP' } };
      const preview = await request('/api/inventory/selections', { body });
      assert.equal(preview.status, 200); assert.equal(preview.json.status, 'pending'); assert.equal(preview.json.members.length, 2);
      for (const product of products) {
        const member = preview.json.members.find(({ skuId }) => skuId === product.id);
        assert.deepEqual([member.stockAvailable, member.stockReserved, member.finalAvailable, member.finalReserved, member.unit], [product.stockAvailable, product.stockReserved, 0, product.stockReserved, product.unit]);
        assert.equal(Number((await stock(product.id))[0].stock_available), product.stockAvailable);
      }
      const later = await createHttpFixtureProduct({ name, size: 'L', unit: 'box', stockAvailable: 9 }, owner);
      assert.deepEqual((await request('/api/inventory/selections', { body })).json, preview.json);
      const route = `/api/inventory/selections/${preview.json.selectionId}/confirm`, reference = { digest: preview.json.digest };
      assert.equal((await request(route, { body: reference, auth: false })).status, 401);
      const foreign = await request(route, { body: reference, headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000575' })}` } });
      assert.equal(foreign.status, 409); assert.equal(foreign.json.code, 'SELECTION_NOT_FOUND');
      const bad = await request(route, { body: { digest: 'wrong' } }); assert.equal(bad.status, 409); assert.equal(bad.json.code, 'SELECTION_CONFIRMATION_MISMATCH');
      assert.equal((await request(route, { body: { ...reference, balances: { available: 99 } } })).status, 400);
      const [one, two] = await Promise.all([request(route, { body: reference }), request(route, { body: reference })]);
      assert.equal(one.status, 200); assert.deepEqual(one.json, two.json); assert.equal(one.json.items.length, 2);
      for (const product of products) { const actual = (await stock(product.id))[0]; assert.equal(Number(actual.stock_available), 0); assert.equal(Number(actual.stock_reserved), product.stockReserved); }
      assert.equal(Number((await stock(later.id))[0].stock_available), 9);
      assert.equal((await ledger(one.json.operationId)).length, 2);
      assert.equal((await sql.query('SELECT status FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2', [owner, preview.json.selectionId])).rows[0].status, 'applied');
      const receive = await request('/api/inventory/operations', { body: plan('http-set-later-receive', [{ itemId: 'receive', type: 'stock.receive', target: { kind: 'existing', skuId: products[0].id }, quantity: { value: 2, unit: products[0].unit } }]) });
      assert.equal(receive.status, 200);
      await sql.query("UPDATE inventory_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND selection_id=$2", [owner, preview.json.selectionId]);
      assert.deepEqual((await request(route, { body: reference })).json, one.json); assert.equal(Number((await stock(products[0].id))[0].stock_available), 2); assert.equal((await ledger(one.json.operationId)).length, 2);
    });
    await run('SET adjustment HTTP rejects stale frozen membership without partial SKU changes', async () => {
      const products = [await createHttpFixtureProduct({ name: 'HTTP SET obsoleto A', stockAvailable: 8 }, owner), await createHttpFixtureProduct({ name: 'HTTP SET obsoleto B', stockAvailable: 6 }, owner)];
      const body = { requestId: 'http-set-stale', selector: { kind: 'ids', skuIds: products.map(({ id }) => id) }, mutation: { type: 'stock.adjust', balances: { available: 0, reserved: 0 }, reason: 'Conteo anterior al movimiento HTTP' } };
      const preview = await request('/api/inventory/selections', { body }); assert.equal(preview.status, 200);
      const changed = await request('/api/inventory/operations', { body: plan('http-set-stale-receive', [{ itemId: 'receive', type: 'stock.receive', target: { kind: 'existing', skuId: products[1].id }, quantity: { value: 1, unit: products[1].unit } }]) }); assert.equal(changed.status, 200);
      const response = await request(`/api/inventory/selections/${preview.json.selectionId}/confirm`, { body: { digest: preview.json.digest } });
      assert.equal(response.status, 409); assert.equal(response.json.code, 'REVISION_MISMATCH');
      assert.equal(Number((await stock(products[0].id))[0].stock_available), 8); assert.equal(Number((await stock(products[1].id))[0].stock_available), 7);
      const selected = (await sql.query('SELECT status,result_json FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2', [owner, preview.json.selectionId])).rows[0];
      assert.equal(selected.status, 'pending'); assert.equal(selected.result_json, null); assert.equal((await ledger(`selection:${preview.json.selectionId}`)).length, 0);
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
        { type: 'add_stock', productName: 'HTTP mixed must not exist', qty: 4 }, { type: 'add_debt', clientName: 'Not migrated', amount: 1 },
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
    await run('bulk model changes require frozen selection and explicit confirmation over HTTP', async () => {
      const seed = async (id, size) => (await request('/api/inventory/operations', { body: plan(id, [{ ...fresh,
        target: { kind: 'new', sku: { name: 'Modelo HTTP selección', size } } }]) })).json.items[0].skuId;
      const first = await seed('http-selection-s', 'S'), second = await seed('http-selection-m', 'M');
      const body = { requestId: 'http-selection-model', selector: { kind: 'ids', skuIds: [first, second] },
        mutation: { type: 'sku.update', changes: { name: 'Modelo HTTP revisado' }, reason: 'Nombre revisado en conjunto' } };
      assert.equal((await request('/api/inventory/selections', { body, auth: false })).status, 401);
      assert.equal((await request('/api/products/model', { method: 'PUT', body: { ids: [first, second], name: 'Bypass' } })).json.code, 'SELECTION_REQUIRED');
      const preview = await request('/api/inventory/selections', { body });
      assert.equal(preview.status, 200); assert.equal(preview.json.members.length, 2);
      assert.deepEqual((await request('/api/inventory/selections', { body })).json, preview.json);
      assert.equal((await sql.query('SELECT name FROM products WHERE id=$1', [first])).rows[0].name, 'Modelo HTTP selección');
      assert.equal((await ledger(`selection:${preview.json.selectionId}`)).length, 0);
      const direct = await request('/api/inventory/operations', { body: plan('http-selection-bypass', preview.json.members.map((member, index) => ({
        itemId: `item-${index}`, type: 'sku.update', target: { kind: 'existing', skuId: member.skuId, expectedRevision: member.revision },
        changes: { price: 0 }, reason: 'Sin previsualización confirmada',
      }))) });
      assert.equal(direct.status, 409); assert.equal(direct.json.code, 'SELECTION_REQUIRED');
      const route = `/api/inventory/selections/${preview.json.selectionId}/confirm`;
      assert.equal((await request(route, { body: { digest: 'wrong' } })).json.code, 'SELECTION_CONFIRMATION_MISMATCH');
      assert.equal((await request(route, { body: { digest: preview.json.digest, changes: { name: 'No aceptado' } } })).status, 400);
      const applied = await request('/api/products/model', { method: 'PUT', body: { selectionId: preview.json.selectionId, digest: preview.json.digest } });
      assert.equal(applied.status, 200); assert.equal(applied.json.length, 2); assert.ok(applied.json.every((product) => product.name === body.mutation.changes.name));
      const replay = await request(route, { body: { digest: preview.json.digest } });
      assert.equal(replay.status, 200); assert.deepEqual(replay.json.items.map((item) => item.product), applied.json);
      assert.equal((await ledger(`selection:${preview.json.selectionId}`)).length, 2);
      const foreign = await request(route, { body: { digest: preview.json.digest }, headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000515' })}` } });
      assert.equal(foreign.json.code, 'SELECTION_NOT_FOUND');
    });
    await run('POST product creates explicit zero stock, typed metadata and one frozen receipt on retry', async () => {
      const body = { operationId: 'http-create-zero', name: 'SKU alta HTTP café', stockAvailable: 0, stockReserved: 0, price: 0,
        priceCurrency: 'USD', unit: 'box', attributes: { color: { state: 'unknown', type: 'text' },
          sealed: { state: 'known', type: 'boolean', value: false } } };
      assert.equal((await request('/api/products', { body, auth: false })).status, 401);
      assert.equal((await request('/api/products', { body: { name: body.name } })).json.code, 'OPERATION_ID_REQUIRED');
      const created = await request('/api/products', { body });
      assert.equal(created.status, 201); assert.equal(created.json.stockAvailable, 0); assert.equal(created.json.revision, 0);
      assert.equal(created.json.stockReserved, 0); assert.equal(created.json.price, 0); assert.equal(created.json.priceCurrency, 'USD');
      assert.deepEqual(created.json.attributes, body.attributes); assert.equal(created.json.unit, 'box');
      assert.deepEqual((await request('/api/products', { body })).json, created.json);
      const moves = await ledger('product-create:http-create-zero');
      assert.equal(moves.length, 1); assert.equal(Number(moves[0].delta_available), 0); assert.equal(Number(moves[0].delta_reserved), 0);
      const history = (await sql.query('SELECT actions_json FROM transactions WHERE owner_phone=$1 AND batch_id=$2', [owner,`${owner}:product-create:http-create-zero`])).rows;
      assert.equal(history.length, 1); assert.equal(history[0].actions_json[0].type, 'create_product');
      assert.equal(Object.hasOwn(history[0].actions_json[0], 'qty'), false);
      const changed = await request('/api/products', { body: { ...body, price: 1 } });
      assert.equal(changed.status, 409); assert.equal(changed.json.code, 'IDEMPOTENCY_CONFLICT');
      const duplicate = await request('/api/products', { body: { ...body, operationId: 'http-create-duplicate' } });
      assert.equal(duplicate.json.code, 'DUPLICATE_SKU_IDENTITY');
      const count = (await sql.query('SELECT count(*) FROM products WHERE owner_phone=$1', [owner])).rows[0].count;
      for (const [index, invalid] of [{ name: { toString: null } }, { stockAvailable: 0.5 }, { stockReserved: null }, { price: '0' },
        { attributes: { color: 'azul' } }, { unit: null }, { priceCurrency: 'usd' }, { ownerPhone: '59899000999' }].entries()) {
        const response = await request('/api/products', { body: { ...body, operationId: `http-create-invalid-${index}`, ...invalid } });
        assert.equal(response.status, 400); assert.equal(response.json.code, 'INVALID_OPERATION_PLAN');
      }
      assert.equal((await sql.query('SELECT count(*) FROM products WHERE owner_phone=$1', [owner])).rows[0].count, count);
      const forged = await request('/api/state/apply', { body: { operationId: 'http-create-event-forged', actions: [history[0].actions_json[0]] } });
      assert.equal(forged.json.code, 'UNSUPPORTED_OPERATION');
    });
    await run('POST model uses one atomic create plan and replays original products after later stock changes', async () => {
      const body = { operationId: 'http-create-model', productType: 'Prenda', productModel: 'Alta HTTP', unit: 'pack', priceCurrency: 'UYU',
        attributes: { material: { state: 'known', type: 'text', value: 'algodón' } },
        variants: [{ size: 'S', stockAvailable: 0, price: 0 }, { size: 'M', stockAvailable: 6, stockReserved: 2, price: 850 }] };
      const bad = await request('/api/products/model', { body: { ...body, operationId: 'http-create-model-invalid',
        variants: [body.variants[0], { ...body.variants[1], stockAvailable: -1 }] } });
      assert.equal(bad.status, 400);
      assert.equal((await sql.query('SELECT id FROM products WHERE owner_phone=$1 AND name=$2', [owner,'Prenda Alta HTTP'])).rowCount, 0);
      const created = await request('/api/products/model', { body });
      assert.equal(created.status, 201); assert.equal(created.json.length, 2);
      assert.deepEqual(created.json.map((product) => product.stockAvailable), [0,6]);
      assert.ok(created.json.every((product) => product.unit === 'pack' && product.priceCurrency === 'UYU'));
      const one = created.json[0];
      const later = await request('/api/inventory/operations', { body: plan('http-create-model-later', [{ itemId: 'one', type: 'stock.receive',
        target: { kind: 'existing', skuId: one.id }, quantity: { value: 2, unit: 'pack' } }]) });
      assert.equal(later.status, 200);
      assert.deepEqual((await request('/api/products/model', { body })).json, created.json);
      assert.equal(Number((await stock(one.id))[0].stock_available), 2);
      assert.equal((await ledger('model-create:http-create-model')).length, 2);
      const duplicate = await request('/api/products/model', { body: { ...body, operationId: 'http-create-model-same-variant',
        productModel: 'Duplicado HTTP', variants: [body.variants[0], { ...body.variants[0], size: 's' }] } });
      assert.equal(duplicate.status, 409); assert.equal(duplicate.json.code, 'DUPLICATE_SKU_IDENTITY');
      assert.equal((await sql.query('SELECT id FROM products WHERE owner_phone=$1 AND name=$2', [owner,'Prenda Duplicado HTTP'])).rowCount, 0);
    });
    await run('DELETE archives only a reviewed selection, preserves stock and hides inactive SKUs', async () => {
      const seed = async (name) => (await request('/api/inventory/operations', { body: plan(`http-archive-${name}`, [{ ...fresh,
        target: { kind: 'new', sku: { name: `Archivo HTTP ${name}` } } }]) })).json.items[0].skuId;
      const first = await seed('primero'), second = await seed('segundo');
      assert.equal((await request(`/api/products/${first}`, { method: 'DELETE' })).json.code, 'SELECTION_REQUIRED');
      assert.equal((await request('/api/products/batch', { method: 'DELETE', body: { ids: [first, second] } })).json.code, 'SELECTION_REQUIRED');
      const preview = await request('/api/inventory/selections', { body: { requestId: 'http-archive-selection',
        selector: { kind: 'ids', skuIds: [first, second] }, mutation: { type: 'sku.deactivate', reason: 'Retiro de catálogo' } } });
      assert.equal(preview.status, 200);
      const reference = { selectionId: preview.json.selectionId, digest: preview.json.digest };
      assert.equal((await request(`/api/products/${first}`, { method: 'DELETE', body: reference })).json.code, 'SELECTION_SCOPE_MISMATCH');
      const deleted = await request('/api/products/batch', { method: 'DELETE', body: reference });
      assert.equal(deleted.status, 200); assert.equal(deleted.json.deleted, 2);
      assert.ok(deleted.json.operationResult.items.every((item) => item.product.status === 'inactive' && item.stockAvailable === 3));
      assert.deepEqual((await request('/api/products/batch', { method: 'DELETE', body: reference })).json, deleted.json);
      const actual = (await sql.query('SELECT inventory_status,stock_available FROM products WHERE id=ANY($1)', [[first,second]])).rows;
      assert.equal(actual.length, 2); assert.ok(actual.every((row) => row.inventory_status === 'inactive' && Number(row.stock_available) === 3));
      const snapshot = await request('/api/state', { method: 'GET' });
      assert.ok(!snapshot.json.products.some((product) => [first,second].includes(product.id)));
      const blocked = await request('/api/inventory/operations', { body: plan('http-archive-inactive-sale', [{ itemId: 'one', type: 'stock.sell',
        target: { kind: 'existing', skuId: first }, quantity: { value: 1, unit: 'unit' } }]) });
      assert.equal(blocked.json.code, 'SKU_INACTIVE');
      const single = await seed('individual');
      const one = await request('/api/inventory/selections', { body: { requestId: 'http-archive-one', selector: { kind: 'ids', skuIds: [single] },
        mutation: { type: 'sku.deactivate', reason: 'Baja individual revisada' } } });
      const changed = await request(`/api/products/${single}`, { method: 'DELETE', body: { selectionId: one.json.selectionId, digest: one.json.digest } });
      assert.equal(changed.status, 200); assert.equal(changed.json.operationResult.items[0].skuId, single);
    });
    await run('signed WhatsApp deactivation requires its code, scopes actors and respects cancel/stale/replay', async () => {
      const sendText = async (id, text, sender = owner) => {
        const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id, from: sender, type: 'text', text: { body: text } }] } }] }] };
        const raw = JSON.stringify(body), headers = { 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', appSecret).update(Buffer.from(raw)).digest('hex')}` };
        assert.equal((await request('/api/meta-webhook', { raw, headers, auth: false })).status, 200);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const claim = (await sql.query('SELECT status FROM meta_message_claims WHERE message_id=$1', [id])).rows[0];
          if (claim?.status === 'completed') return (await sql.query('SELECT error,actions_json,reply_text,processed FROM meta_events WHERE id=$1', [id])).rows[0];
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.fail('WhatsApp archive command did not complete');
      };
      const product = await createHttpFixtureProduct({ name: 'Taladro Archivo', stockAvailable: 4, price: 900 }, owner);
      const pending = await legacySelection('http-meta-archive-preview', product);
      assert.deepEqual(pending.actions, []); assert.match(pending.replyText, /CONFIRMAR BAJA/);
      const code = /CONFIRMAR BAJA ([A-F0-9]{8})/.exec(pending.replyText)[1];
      assert.equal(Number((await stock(product.id))[0].stock_available), 4);
      const foreign = await sendText('http-meta-archive-foreign', `CONFIRMAR BAJA ${code}`, '59899000515');
      assert.equal(foreign.error, 'SELECTION_NOT_FOUND');
      const confirmed = await sendText('http-meta-archive-confirm', `CONFIRMAR BAJA ${code}`);
      assert.equal(confirmed.error, null); assert.equal(confirmed.actions_json[0].productId, product.id); assert.equal(confirmed.actions_json[0].status, 'inactive');
      assert.match(confirmed.reply_text, /SKU desactivado/);
      assert.equal((await sendText('http-meta-archive-confirm', `CONFIRMAR BAJA ${code}`)).reply_text, confirmed.reply_text);
      assert.equal((await sendText('http-meta-archive-confirm-again', `CONFIRMAR BAJA ${code}`)).reply_text, confirmed.reply_text);
      assert.equal((await sql.query("SELECT inventory_status FROM products WHERE id=$1", [product.id])).rows[0].inventory_status, 'inactive');
      const cancelProduct = await createHttpFixtureProduct({ name: 'Taladro Cancelable', stockAvailable: 4 }, owner);
      const cancelPreview = await legacySelection('http-meta-archive-cancel-preview', cancelProduct);
      const cancelCode = /CONFIRMAR BAJA ([A-F0-9]{8})/.exec(cancelPreview.replyText)[1];
      assert.match((await sendText('http-meta-archive-cancel', `CANCELAR BAJA ${cancelCode}`)).reply_text, /cancelada/);
      assert.equal((await sendText('http-meta-archive-cancelled-confirm', `CONFIRMAR BAJA ${cancelCode}`)).error, 'SELECTION_CANCELLED');
      assert.equal((await sql.query('SELECT inventory_status FROM products WHERE id=$1', [cancelProduct.id])).rows[0].inventory_status, 'active');
      const staleProduct = await createHttpFixtureProduct({ name: 'Taladro Obsoleto', stockAvailable: 4 }, owner);
      const stalePreview = await legacySelection('http-meta-archive-stale-preview', staleProduct);
      const staleCode = /CONFIRMAR BAJA ([A-F0-9]{8})/.exec(stalePreview.replyText)[1];
      await request('/api/inventory/operations', { body: plan('http-meta-archive-stale-sale', [{ itemId: 'one', type: 'stock.sell',
        target: { kind: 'existing', skuId: staleProduct.id }, quantity: { value: 1, unit: 'unit' } }]) });
      const stale = await sendText('http-meta-archive-stale-confirm', `CONFIRMAR BAJA ${staleCode}`);
      assert.equal(stale.error, 'REVISION_MISMATCH'); assert.deepEqual(stale.actions_json, []);
      assert.equal(Number((await stock(staleProduct.id))[0].stock_available), 3);
    });
    await run('product PUT uses reviewed revision and returns frozen receipt after later changes', async () => {
      const seeded = await request('/api/inventory/operations', { body: plan('http-edit-seed', [{ ...fresh,
        target: { kind: 'new', sku: { name: 'Ficha HTTP original' } } }]) });
      const id = seeded.json.items[0].skuId;
      const reviewed = (await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === id);
      const route = `/api/products/${id}`;
      const body = { operationId: 'http-edit-once', expectedRevision: reviewed.revision, expectedFingerprint: reviewed.identityFingerprint,
        reason: 'Conteo físico y corrección de ficha', name: 'Ficha HTTP corregida', stockAvailable: 0, stockReserved: 2, price: 0 };
      assert.equal((await request(route, { method: 'PUT', body: { price: 0 } })).status, 400);
      assert.equal((await request(route, { method: 'PUT', body: { ...body, operationId: 'http-edit-no-revision', expectedRevision: undefined } })).status, 400);
      const changed = await request(route, { method: 'PUT', body });
      assert.equal(changed.status, 200); assert.equal(changed.json.revision, reviewed.revision + 1);
      assert.equal(changed.json.name, body.name); assert.equal(changed.json.stockAvailable, 0); assert.equal(changed.json.price, 0);
      const moves = await ledger('product-edit:http-edit-once');
      assert.equal(moves.length, 2); assert.equal(moves.reduce((sum, move) => sum + Number(move.delta_available), 0), -3);
      const added = await request('/api/inventory/operations', { body: plan('http-edit-later', [{ itemId: 'one', type: 'stock.receive',
        target: { kind: 'existing', skuId: id }, quantity: { value: 4, unit: 'unit' } }]) });
      assert.equal(added.status, 200);
      assert.deepEqual((await request(route, { method: 'PUT', body })).json, changed.json);
      const stale = await request(route, { method: 'PUT', body: { ...body, operationId: 'http-edit-stale' } });
      assert.equal(stale.status, 409); assert.equal(stale.json.code, 'REVISION_MISMATCH');
      const foreign = await request(route, { method: 'PUT', body, headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000515' })}` } });
      assert.equal(foreign.status, 404);
      assert.equal(Number((await stock(id))[0].stock_available), 4);
    });
    await run('signed WhatsApp catalog update previews exact SKU then confirms zero price once', async () => {
      const product = await createHttpFixtureProduct({ name: 'Taladro Contador', stockAvailable: 3, price: 900 }, owner);
      const messageId = 'http-meta-update-zero';
      const sendText = async (id, text) => {
        const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id, from: owner, type: 'text', text: { body: text } }] } }] }] };
        const raw = JSON.stringify(body), headers = { 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', appSecret).update(Buffer.from(raw)).digest('hex')}` };
        assert.equal((await request('/api/meta-webhook', { raw, headers, auth: false })).status, 200);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if ((await sql.query('SELECT status FROM meta_message_claims WHERE message_id=$1', [id])).rows[0]?.status === 'completed') return (await sql.query('SELECT error,actions_json,reply_text FROM meta_events WHERE id=$1', [id])).rows[0];
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.fail('WhatsApp selection message did not complete');
      };
      const before = (await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 ORDER BY 1', [owner])).rows;
      const pending = await legacySelection(messageId, product, { price: 0 });
      assert.deepEqual(pending.actions, []); assert.match(pending.replyText, /CONFIRMAR CAMBIO/);
      const selection = (await sql.query('SELECT preview_json FROM inventory_selections WHERE owner_phone=$1 AND request_id=$2', [owner, `meta-selection:${messageId}`])).rows[0].preview_json;
      assert.deepEqual(selection.members.map(({ skuId }) => skuId), [product.id]); assert.equal(selection.mutation.changes.price, 0);
      assert.equal(Number((await stock(product.id))[0].price), 900);
      assert.deepEqual((await sql.query('SELECT * FROM inventory_movements WHERE owner_phone=$1 ORDER BY 1', [owner])).rows, before);
      assert.equal((await sql.query('SELECT 1 FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [owner, `selection:${selection.selectionId}`])).rowCount, 0);
      const confirmId = 'http-meta-update-zero-confirm', text = `CONFIRMAR CAMBIO ${selection.digest.slice(0, 8).toUpperCase()}`;
      const event = await sendText(confirmId, text);
      assert.equal(event.error, null); assert.equal(event.actions_json[0].productId, product.id); assert.equal(event.actions_json[0].price, 0);
      assert.equal(event.actions_json.length, 1); assert.match(event.reply_text, /SKU actualizado/);
      assert.equal((await ledger(`selection:${selection.selectionId}`)).length, 1);
      assert.equal((await sql.query('SELECT 1 FROM transactions WHERE owner_phone=$1 AND batch_id=$2', [owner, `${owner}:selection:${selection.selectionId}`])).rowCount, 1);
      assert.equal(Number((await stock(product.id))[0].stock_available), 3); assert.equal(Number((await stock(product.id))[0].price), 0);
      assert.deepEqual(await sendText(confirmId, text), event);
      assert.equal((await ledger(`selection:${selection.selectionId}`)).length, 1);
      const adjustmentProduct = await createHttpFixtureProduct({ name: 'HTTP Ajuste histórico', stockAvailable: 4 }, owner);
      const adjustment = await legacySelection('http-meta-adjust-old-preview', adjustmentProduct, { stockAvailable: 0 });
      const adjustmentCommand = /CONFIRMAR AJUSTE [A-F0-9]{8}/.exec(adjustment.replyText)?.[0];
      assert.ok(adjustmentCommand);
      const adjusted = await sendText('http-meta-adjust-old-confirm', adjustmentCommand);
      assert.equal(adjusted.error, null); assert.equal(adjusted.actions_json[0].stockAvailable, 0);
      assert.equal(Number((await stock(adjustmentProduct.id))[0].stock_available), 0);
      assert.deepEqual(await sendText('http-meta-adjust-old-confirm', adjustmentCommand), adjusted);
      assert.deepEqual(await sendText('http-meta-adjust-old-confirm-again', adjustmentCommand), adjusted);
    });
    await run('signed WhatsApp insufficient sale completes rejection and cannot execute after replenishment', async () => {
      const product = await createHttpFixtureProduct({ name: 'Taladro Delta', stockAvailable: 2, price: 900 }, owner);
      const messageId = 'http-meta-insufficient-terminal';
      const command = await reviewedUniversalCommand('http-meta-insufficient-draft', 'Vendí 50 Taladro Delta', [{ itemId: 'sale', type: 'stock.sell', target: { kind: 'existing', skuId: product.id }, quantity: { value: 50, unit: 'unit' } }]);
      const inventoryBefore = {};
      for (const table of ['inventory_operations', 'inventory_movements', 'universal_operations', 'transactions'])
        inventoryBefore[table] = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows;
      const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{
        id: messageId, from: owner, type: 'text', text: { body: command },
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
      assert.equal(Number((await stock(product.id))[0].stock_available), 2);
      for (const [table, rows] of Object.entries(inventoryBefore))
        assert.deepEqual((await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows, rows);
      await sql.query('UPDATE products SET stock_available=100 WHERE owner_phone=$1 AND id=$2', [owner, product.id]);
      assert.equal((await request('/api/meta-webhook', { raw, headers, auth: false })).status, 200);
      assert.equal(Number((await stock(product.id))[0].stock_available), 100);
      for (const [table, rows] of Object.entries(inventoryBefore))
        assert.deepEqual((await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1`, [owner])).rows, rows);
      assert.equal(await db.claimMetaMessage({ messageId, ownerPhone: owner, senderPhone: owner, rawBody: body }), false);
    });
    await run('order endpoints require IDs/revisions, persist procurement and return immutable delete receipts', async () => {
      const product = await createHttpFixtureProduct({ name:'HTTP order explicit SKU',stockAvailable:0 },owner);
      const customer = await createFixtureClient({name:'HTTP order customer'},owner);
      const body = {operationId:'http-order-create',clienteId:customer.id,producto:product.name,productId:product.id,qty:3};
      assert.equal((await request('/api/pedidos',{body,auth:false})).status,401);
      assert.equal((await request('/api/pedidos',{body:{...body,operationId:undefined}})).status,400);
      assert.equal((await request('/api/pedidos',{body:{...body,operationId:'http-order-inject',ownerPhone:'foreign'}})).status,400);
      const created = await request('/api/pedidos',{body}); assert.equal(created.status,201); assert.equal(created.json.revision,0);
      assert.deepEqual((await request('/api/pedidos',{body})).json,created.json);
      const route = `/api/pedidos/${created.json.id}`, transition = {operationId:'http-order-achieved',expectedRevision:0,estado:'conseguido'};
      const changed = await request(route,{method:'PUT',body:transition}); assert.equal(changed.status,200);
      assert.deepEqual(changed.json.stockPosting,{skuId:product.id,quantity:3,unit:'unit'}); assert.equal(Number((await stock(product.id))[0].stock_available),3);
      assert.equal((await request(route,{method:'PUT',body:{...transition,operationId:'http-order-stale'}})).status,409);
      assert.deepEqual((await request(route,{method:'PUT',body:transition})).json,changed.json);
      const foreign = await request(route,{method:'PUT',body:transition,headers:{Authorization:`Bearer ${issueJwt({phoneNumber:'59899000515'})}`}}); assert.equal(foreign.status,404);
      const deletion = {operationId:'http-order-delete',expectedRevision:1};
      const removed = await request(route,{method:'DELETE',body:deletion}); assert.equal(removed.status,200); assert.equal(removed.json.deleted,true);
      assert.equal(removed.json.inventoryResult.items[0].type,'stock.withdraw'); assert.equal(Number((await stock(product.id))[0].stock_available),0);
      assert.deepEqual((await request(route,{method:'DELETE',body:deletion})).json,removed.json);
      assert.deepEqual((await request(route,{method:'PUT',body:transition})).json,changed.json);
      assert.equal((await request('/api/state/apply',{body:{operationId:'forged-withdraw-history',actions:[{type:'withdraw_stock',productId:product.id,qty:1}]}})).status,409);
    });
    await run('signed WhatsApp order transitions use the bound SKU, outbox and terminal insufficiency', async () => {
      const product = await createHttpFixtureProduct({name:'Taladro Pedido HTTP',stockAvailable:0},owner);
      const customer = await createFixtureClient({name:'HTTP proveedor pedido'},owner);
      const pedido = await db.createPedidoRecord({operationId:'http-meta-order-create',clienteId:customer.id,producto:product.name,productId:product.id,qty:2},owner);
      const send = async (messageId,text) => {
        const raw = JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id:messageId,from:owner,type:'text',text:{body:text}}]}}]}]});
        const headers = {'X-Hub-Signature-256':`sha256=${crypto.createHmac('sha256',appSecret).update(Buffer.from(raw)).digest('hex')}`};
        assert.equal((await request('/api/meta-webhook',{raw,headers,auth:false})).status,200);
        const deadline = Date.now()+5000;
        while (Date.now()<deadline) {
          const claim = (await sql.query('SELECT status FROM meta_message_claims WHERE message_id=$1',[messageId])).rows[0];
          if (claim?.status==='completed') return (await sql.query('SELECT error,reply_text,actions_json FROM meta_events WHERE id=$1',[messageId])).rows[0];
          await new Promise((resolve)=>setTimeout(resolve,30));
        }
        assert.fail('Order Meta event did not finish');
      };
      const achievedCommand = await reviewedUniversalCommand('http-order-meta-achieved-draft', 'Marcá el pedido como conseguido', [{ itemId: 'order', type: 'order.update', target: { kind: 'existing', pedidoId: pedido.id }, changes: { estado: 'conseguido' } }]);
      const achieved = await send('http-order-meta-achieved', achievedCommand);
      assert.equal(achieved.error,null); assert.match(achieved.reply_text,/Ingreso aplicado: 2 unit/); assert.equal(Number((await stock(product.id))[0].stock_available),2);
      const replay = await send('http-order-meta-achieved', achievedCommand);
      assert.deepEqual(replay,achieved); assert.equal(Number((await stock(product.id))[0].stock_available),2);
      assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1',['http-order-meta-achieved'])).rows[0].reply_text,achieved.reply_text);
      await db.executeInventoryOperation(plan('http-order-meta-sell',[{itemId:'sale',type:'stock.sell',target:{kind:'existing',skuId:product.id},quantity:{value:2,unit:'unit'}}]),{businessId:owner,actorId:owner,permissions:['inventory:sell']});
      const rejectedCommand = await reviewedUniversalCommand('http-order-meta-reject-draft', 'Descartá el pedido', [{ itemId: 'order', type: 'order.update', target: { kind: 'existing', pedidoId: pedido.id }, changes: { estado: 'descartado' } }]);
      const rejected = await send('http-order-meta-reject', rejectedCommand);
      assert.equal(rejected.error,'INSUFFICIENT_STOCK'); assert.deepEqual(rejected.actions_json,[]);
      await db.executeInventoryOperation(plan('http-order-meta-replenish',[{itemId:'receive',type:'stock.receive',target:{kind:'existing',skuId:product.id},quantity:{value:2,unit:'unit'}}]),{businessId:owner,actorId:owner,permissions:['inventory:receive']});
      assert.deepEqual(await send('http-order-meta-reject', rejectedCommand),rejected);
      assert.equal(Number((await stock(product.id))[0].stock_available),2);
    });
    await run('party creation authenticates closed input and persists tenant scoped immutable receipts', async () => {
      const foreignOwner = '59899000535';
      for (const [route, table, kind] of [['/api/clients', 'clients', 'client'], ['/api/proveedores', 'proveedores', 'supplier']]) {
        const body = { operationId: `http-party-${kind}`, name: `HTTP alta ${kind}`, notas: 'Nota de alta HTTP' };
        assert.equal((await request(route, { body, auth: false })).status, 401);
        const missing = await request(route, { body: { name: body.name } });
        assert.equal(missing.status, 400); assert.equal(missing.json.code, 'OPERATION_ID_REQUIRED');
        const unknown = await request(route, { body: { ...body, ownerPhone: foreignOwner } });
        assert.equal(unknown.status, 400); assert.equal(unknown.json.code, 'INVALID_PARTY_OPERATION');
        const [first, concurrent] = await Promise.all([request(route, { body }), request(route, { body })]);
        assert.equal(first.status, 201); assert.equal(concurrent.status, 201); assert.deepEqual(first.json, concurrent.json);
        assert.deepEqual((await request(route, { body })).json, first.json);
        const persisted = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 AND id=$2`, [owner, first.json.id])).rows[0];
        assert.ok(persisted); assert.equal(persisted.name, first.json.name); assert.equal(persisted.notas, body.notas);
        if (kind === 'client') assert.equal(Number(persisted.debt), 0);
        assert.equal((await sql.query(`SELECT 1 FROM ${table} WHERE owner_phone=$1 AND name=$2`, [owner, first.json.name])).rowCount, 1);
        const conflict = await request(route, { body: { ...body, notas: 'Cambio posterior' } });
        assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');
        const foreign = await request(route, { body, headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: foreignOwner })}` } });
        assert.equal(foreign.status, 201); assert.notEqual(foreign.json.id, first.json.id);
        assert.equal((await sql.query(`SELECT 1 FROM ${table} WHERE owner_phone=$1 AND id=$2`, [foreignOwner, foreign.json.id])).rowCount, 1);
        await sql.query(`UPDATE ${table} SET notas='Nota actualizada' WHERE owner_phone=$1 AND id=$2`, [owner, first.json.id]);
        assert.deepEqual((await request(route, { body })).json, first.json);
        await sql.query(`DELETE FROM ${table} WHERE owner_phone=$1 AND id=$2`, [owner, first.json.id]);
        assert.deepEqual((await request(route, { body })).json, first.json);
        assert.equal((await sql.query(`SELECT 1 FROM ${table} WHERE id=$1`, [first.json.id])).rowCount, 0);
      }
      const debt = await request('/api/clients', { body: { name: 'HTTP deuda inicial prohibida', debt: 1 } });
      assert.equal(debt.status, 409); assert.equal(debt.json.code, 'ACCOUNT_OPERATION_REQUIRED');
      const supplierDebt = await request('/api/proveedores', { body: { operationId: 'http-supplier-debt', name: 'HTTP deuda proveedor', debt: 0 } });
      assert.equal(supplierDebt.status, 400); assert.equal(supplierDebt.json.code, 'INVALID_PARTY_OPERATION');
    });
    await run('party metadata edits require explicit IDs and revisions and preserve immutable tenant scoped receipts', async () => {
      for (const [collection, kind] of [['/api/clients', 'client'], ['/api/proveedores', 'supplier']]) {
        const created = await request(collection, { body: { operationId: `http-party-edit-seed-${kind}`, name: `HTTP edición ${kind}`, notas: 'Nota inicial HTTP' } });
        assert.equal(created.status, 201); assert.equal(created.json.metadataRevision, 0);
        const route = `${collection}/${created.json.id}`, body = { operationId: `http-party-edit-${kind}`, expectedRevision: 0, name: 'Nombre Editado HTTP', notas: 'Nota editada HTTP' };
        assert.equal((await request(route, { method: 'PUT', body, auth: false })).status, 401);
        const missingId = await request(route, { method: 'PUT', body: { expectedRevision: 0, notas: 'Nota' } });
        assert.equal(missingId.status, 400); assert.equal(missingId.json.code, 'OPERATION_ID_REQUIRED');
        for (const invalid of [{ operationId: `http-no-revision-${kind}`, notas: 'Nota' }, { ...body, expectedRevision: '0' }, { ...body, ownerPhone: 'foreign' }, { ...body, name: '' }, { operationId: `http-no-changes-${kind}`, expectedRevision: 0 }]) {
          const response = await request(route, { method: 'PUT', body: invalid });
          assert.equal(response.status, 400); assert.equal(response.json.code, 'INVALID_PARTY_OPERATION');
        }
        const foreign = await request(route, { method: 'PUT', body, headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000545' })}` } });
        assert.equal(foreign.status, 404); assert.equal(foreign.json.code, 'PARTY_NOT_FOUND');
        const [first, concurrent] = await Promise.all([request(route, { method: 'PUT', body }), request(route, { method: 'PUT', body })]);
        assert.equal(first.status, 200); assert.deepEqual(first.json, concurrent.json); assert.equal(first.json.metadataRevision, 1);
        assert.equal(first.json.name, body.name); assert.equal(first.json.notas, body.notas);
        assert.deepEqual((await request(route, { method: 'PUT', body })).json, first.json);
        const conflict = await request(route, { method: 'PUT', body: { ...body, notas: 'Cambio de intención' } });
        assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');
        const stale = await request(route, { method: 'PUT', body: { ...body, operationId: `http-party-edit-stale-${kind}` } });
        assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PARTY_REVISION_MISMATCH');
        const later = await request(route, { method: 'PUT', body: { operationId: `http-party-edit-later-${kind}`, expectedRevision: 1, notas: null } });
        assert.equal(later.status, 200); assert.equal(later.json.metadataRevision, 2); assert.equal(later.json.notas, null);
        const table = kind === 'client' ? 'clients' : 'proveedores';
        const persisted = (await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 AND id=$2`, [owner, created.json.id])).rows[0];
        assert.equal(persisted.name, body.name); assert.equal(persisted.notas, null); assert.equal(Number(persisted.metadata_revision), 2);
        if (kind === 'client') { assert.equal(Number(persisted.debt), 0); assert.equal(Number(persisted.account_revision), 0); }
        await sql.query(`DELETE FROM ${table} WHERE owner_phone=$1 AND id=$2`, [owner, created.json.id]);
        assert.deepEqual((await request(route, { method: 'PUT', body })).json, first.json);
        assert.equal((await sql.query(`SELECT 1 FROM ${table} WHERE id=$1`, [created.json.id])).rowCount, 0);
      }
    });
    await run('party deletion requires reviewed revisions and returns immutable receipts after removal', async () => {
      for (const [collection, table, kind] of [['/api/clients', 'clients', 'client'], ['/api/proveedores', 'proveedores', 'supplier']]) {
        const created = await request(collection, { body: { operationId: `http-delete-party-seed-${kind}`, name: `HTTP baja ${kind}` } });
        assert.equal(created.status, 201);
        const route = `${collection}/${created.json.id}`, body = { operationId: `http-delete-party-${kind}`, expectedRevision: created.json.metadataRevision, ...(kind === 'client' ? { expectedAccountRevision: created.json.accountRevision } : {}), reason: 'Baja revisada por HTTP' };
        assert.equal((await request(route, { method: 'DELETE', body, auth: false })).status, 401);
        const missing = await request(route, { method: 'DELETE' });
        assert.equal(missing.status, 400); assert.equal(missing.json.code, 'OPERATION_ID_REQUIRED');
        for (const extra of [{ expectedRevision: undefined }, { reason: '' }, { ownerPhone: 'foreign' }]) {
          const invalid = await request(route, { method: 'DELETE', body: { ...body, ...extra } });
          assert.equal(invalid.status, 400); assert.equal(invalid.json.code, 'INVALID_PARTY_OPERATION');
        }
        const stale = await request(route, { method: 'DELETE', body: { ...body, expectedRevision: 1 } });
        assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PARTY_REVISION_MISMATCH');
        if (kind === 'client') {
          const staleAccount = await request(route, { method: 'DELETE', body: { ...body, expectedAccountRevision: 1 } });
          assert.equal(staleAccount.status, 409); assert.equal(staleAccount.json.code, 'ACCOUNT_REVISION_MISMATCH');
        }
        const foreign = await request(route, { method: 'DELETE', body, headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: '59899000555' })}` } });
        assert.equal(foreign.status, 404); assert.equal(foreign.json.code, 'PARTY_NOT_FOUND');
        const [one, two] = await Promise.all([request(route, { method: 'DELETE', body }), request(route, { method: 'DELETE', body })]);
        assert.equal(one.status, 200); assert.deepEqual(one.json, two.json);
        assert.deepEqual(one.json.items[0].party, created.json); assert.equal(one.json.items[0].deleted, true); assert.equal(one.json.items[0].type, `${kind}.delete`);
        assert.equal((await sql.query(`SELECT 1 FROM ${table} WHERE owner_phone=$1 AND id=$2`, [owner, created.json.id])).rowCount, 0);
        assert.deepEqual((await request(route, { method: 'DELETE', body })).json, one.json);
        const conflict = await request(route, { method: 'DELETE', body: { ...body, reason: 'Otra intención de baja' } });
        assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');
      }
    });
    await run('supplier merge validates closed reviewed input and replays a frozen receipt with current snapshot', async () => {
      const keep = await db.createProveedorRecord({ operationId: 'http-supplier-merge-keep', name: 'HTTP Proveedor Conservar', notas: 'Nota conservar' }, owner);
      const source = await db.createProveedorRecord({ operationId: 'http-supplier-merge-source', name: 'HTTP Proveedor Quitar', notas: 'Nota quitar' }, owner);
      const foreignSupplier = await db.createProveedorRecord({ operationId: 'http-supplier-merge-foreign', name: 'HTTP Proveedor Ajeno' }, '59899000555');
      const client = await createFixtureClient({ name: 'HTTP Cliente Fusión Proveedor' }, owner);
      const pedido = await db.createPedidoRecord({ operationId: 'http-supplier-merge-order', clienteId: client.id, proveedorId: source.id, producto: 'Pedido HTTP fusión proveedor', qty: 2 }, owner);
      const body = { keepId: keep.id, mergeId: source.id, operationId: 'http-supplier-merge', expectedKeepRevision: keep.metadataRevision, expectedMergeRevision: source.metadataRevision, reason: 'Fusión revisada por HTTP' };
      assert.equal((await request('/api/proveedores/merge', { body, auth: false })).status, 401);
      const noId = await request('/api/proveedores/merge', { body: { ...body, operationId: undefined } });
      assert.equal(noId.status, 400); assert.equal(noId.json.code, 'OPERATION_ID_REQUIRED');
      for (const extra of [{ expectedKeepRevision: undefined }, { reason: '' }, { ownerPhone: 'foreign' }]) {
        const invalid = await request('/api/proveedores/merge', { body: { ...body, ...extra } });
        assert.equal(invalid.status, 400); assert.equal(invalid.json.code, 'INVALID_PARTY_OPERATION');
      }
      const stale = await request('/api/proveedores/merge', { body: { ...body, expectedMergeRevision: 1 } });
      assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PARTY_REVISION_MISMATCH');
      const foreign = await request('/api/proveedores/merge', { body: { ...body, mergeId: foreignSupplier.id } });
      assert.equal(foreign.status, 404); assert.equal(foreign.json.code, 'PARTY_NOT_FOUND');
      const [one, two] = await Promise.all([request('/api/proveedores/merge', { body }), request('/api/proveedores/merge', { body })]);
      assert.equal(one.status, 200); assert.deepEqual(one.json.operationResult, two.json.operationResult);
      const item = one.json.operationResult.items[0];
      assert.equal(item.party.metadataRevision, 1); assert.equal(item.party.notas, 'Nota conservar\nNota quitar'); assert.deepEqual(item.removedParty, source);
      assert.deepEqual(item.affectedOrders, [{ id: pedido.id, revision: pedido.revision + 1, proveedorId: keep.id }]);
      const actual = (await sql.query('SELECT proveedor_id,revision FROM pedidos WHERE owner_phone=$1 AND id=$2', [owner, pedido.id])).rows[0];
      assert.deepEqual(actual, { proveedor_id: keep.id, revision: pedido.revision + 1 });
      const changed = await request(`/api/proveedores/${keep.id}`, { method: 'PUT', body: { operationId: 'http-merged-supplier-edit', expectedRevision: 1, notas: 'Nota actual HTTP' } });
      assert.equal(changed.status, 200);
      const replay = await request('/api/proveedores/merge', { body });
      assert.equal(replay.status, 200); assert.deepEqual(replay.json.operationResult, one.json.operationResult); assert.deepEqual(replay.json.proveedores.find(({ id }) => id === keep.id), changed.json);
      const conflict = await request('/api/proveedores/merge', { body: { ...body, reason: 'Otra fusión' } });
      assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');
    });
    await run('client merge requires current metadata revisions as well as financial revisions', async () => {
      const keep = await createFixtureClient({ name: 'HTTP Cliente Merge Conserva' }, owner), source = await createFixtureClient({ name: 'HTTP Cliente Merge Origen' }, owner);
      const body = { keepId: keep.id, mergeId: source.id, operationId: 'http-client-merge-meta', expectedKeepRevision: 0, expectedMergeRevision: 0, expectedKeepMetadataRevision: 0, expectedMergeMetadataRevision: 0 };
      const missing = await request('/api/clients/merge', { body: { ...body, expectedKeepMetadataRevision: undefined } });
      assert.equal(missing.status, 400); assert.equal(missing.json.code, 'INVALID_ACCOUNT_OPERATION');
      const changed = await request(`/api/clients/${source.id}`, { method: 'PUT', body: { operationId: 'http-client-before-merge-edit', expectedRevision: 0, notas: 'Nota nueva antes de fusión' } });
      assert.equal(changed.status, 200);
      const stale = await request('/api/clients/merge', { body });
      assert.equal(stale.status, 409); assert.equal(stale.json.code, 'PARTY_REVISION_MISMATCH');
      const applied = await request('/api/clients/merge', { body: { ...body, expectedMergeMetadataRevision: 1 } });
      assert.equal(applied.status, 200); assert.equal(applied.json.operationResult.client.metadataRevision, 1);
      assert.deepEqual((await request('/api/clients/merge', { body: { ...body, expectedMergeMetadataRevision: 1 } })).json.operationResult, applied.json.operationResult);
    });
    await run('accounts HTTP validates explicit money/client scope, immutable receipts and closed debt writers',async()=>{
      const customer=await createFixtureClient({name:'HTTP cuentas'},owner);
      const charge={contractVersion:1,businessId:owner,operationId:'http-account-charge',actions:[{itemId:'one',type:'account.charge',target:{kind:'existing',clientId:customer.id},amount:{value:10,unit:'legacy-money'},reason:'Cargo explícito'}]};
      assert.equal((await request('/api/accounts/operations',{body:charge,auth:false})).status,401);
      assert.equal((await request('/api/accounts/operations',{body:{...charge,businessId:'foreign'}})).status,409);
      assert.equal((await request('/api/accounts/operations',{body:{...charge,actions:[{...charge.actions[0],amount:{value:'10',unit:'legacy-money'}}]}})).status,400);
      const applied=await request('/api/accounts/operations',{body:charge});assert.equal(applied.status,200);assert.equal(applied.json.items[0].balance,10);
      const payment={...charge,operationId:'http-account-payment',actions:[{...charge.actions[0],type:'account.payment',amount:{value:3,unit:'legacy-money'}}]};
      assert.equal((await request('/api/accounts/operations',{body:payment})).json.items[0].balance,7);
      assert.deepEqual((await request('/api/accounts/operations',{body:charge})).json,applied.json);
      const excess=await request('/api/accounts/operations',{body:{...payment,operationId:'http-account-excess',actions:[{...payment.actions[0],amount:{value:8,unit:'legacy-money'}}]}});
      assert.equal(excess.status,409);assert.equal(excess.json.code,'PAYMENT_EXCEEDS_DEBT');
      assert.equal((await request(`/api/clients/${customer.id}`,{method:'PUT',body:{debt:0}})).json.code,'ACCOUNT_OPERATION_REQUIRED');
      const deleteCustomer = (await sql.query('SELECT metadata_revision,account_revision FROM clients WHERE owner_phone=$1 AND id=$2',[owner,customer.id])).rows[0];
      assert.equal((await request(`/api/clients/${customer.id}`,{method:'DELETE',body:{operationId:'http-account-blocked-delete',expectedRevision:Number(deleteCustomer.metadata_revision),expectedAccountRevision:Number(deleteCustomer.account_revision),reason:'Baja explícita'}})).json.code,'CLIENT_HAS_BALANCE');
      const foreign=await request('/api/accounts/operations',{body:{...charge,businessId:'59899000515'},headers:{Authorization:`Bearer ${issueJwt({phoneNumber:'59899000515'})}`}});
      assert.equal(foreign.status,404);assert.equal(foreign.json.code,'CLIENT_NOT_FOUND');
    });
    await run('signed WhatsApp account payment replies come from receipts and excess rejection is terminal',async()=>{
      const customer=await createFixtureClient({name:'Cuenta HTTP'},owner);
      const charge=(operationId,amount)=>({contractVersion:1,businessId:owner,operationId,actions:[{itemId:'one',type:'account.charge',target:{kind:'existing',clientId:customer.id},amount:{value:amount,unit:'legacy-money'},reason:'Saldo previo probado'}]});
      const context={businessId:owner,actorId:owner,permissions:['accounts:charge']};
      await db.executeAccountOperation(charge('http-account-meta-initial',10),context);
      const send=async(messageId,text)=>{
        const raw=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id:messageId,from:owner,type:'text',text:{body:text}}]}}]}]});
        assert.equal((await request('/api/meta-webhook',{raw,auth:false,headers:{'X-Hub-Signature-256':`sha256=${crypto.createHmac('sha256',appSecret).update(Buffer.from(raw)).digest('hex')}`}})).status,200);
        const deadline=Date.now()+5000;
        while(Date.now()<deadline){if((await sql.query('SELECT status FROM meta_message_claims WHERE message_id=$1',[messageId])).rows[0]?.status==='completed')return(await sql.query('SELECT error,actions_json,reply_text FROM meta_events WHERE id=$1',[messageId])).rows[0];await new Promise((resolve)=>setTimeout(resolve,30));}
        assert.fail('Account event did not finish');
      };
      const payment = amount => [{ itemId: 'payment', type: 'account.payment', target: { kind: 'existing', clientId: customer.id }, amount: { value: amount, unit: 'legacy-money' }, reason: 'Pago explícito revisado' }];
      const payCommand = await reviewedUniversalCommand('http-account-meta-pay-draft', 'Cuenta HTTP me pagó 3', payment(3));
      const applied=await send('http-account-meta-pay',payCommand);assert.equal(applied.error,null);assert.match(applied.reply_text,/Pago registrado:.*saldo 7/);
      assert.equal(applied.actions_json[0].clientId,customer.id);assert.equal(applied.actions_json[0].balance,7);
      assert.deepEqual(await send('http-account-meta-pay',payCommand),applied);
      const excessCommand = await reviewedUniversalCommand('http-account-meta-excess-draft', 'Cuenta HTTP me pagó 9', payment(9));
      const rejected=await send('http-account-meta-excess',excessCommand);assert.equal(rejected.error,'PAYMENT_EXCEEDS_DEBT');assert.deepEqual(rejected.actions_json,[]);
      await db.executeAccountOperation(charge('http-account-meta-later',20),context);
      assert.deepEqual(await send('http-account-meta-excess',excessCommand),rejected);
      assert.equal(Number((await sql.query('SELECT debt FROM clients WHERE id=$1',[customer.id])).rows[0].debt),27);
      assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1',['http-account-meta-pay'])).rows[0].reply_text,applied.reply_text);
    });
    await run('historical order reconciliation authenticates a reviewed zero-delta proof and preserves its receipt',async()=>{
      const customer=await createFixtureClient({name:'HTTP conciliación histórica'},owner);
      const product=await createHttpFixtureProduct({name:'SKU HTTP conciliación',stockAvailable:8,stockReserved:1,unit:'box'},owner);
      const pedidoId='http-historical-order';
      await sql.query("INSERT INTO pedidos(id,owner_phone,cliente_id,producto,qty,estado) VALUES($1,$2,$3,'Etiqueta histórica HTTP',5,'conseguido')",[pedidoId,owner,customer.id]);
      const path=`/api/pedidos/${pedidoId}/reconcile`,body={operationId:'http-order-reconcile',expectedRevision:0,reconciliation:{
        productId:product.id,expectedProductRevision:product.revision,expectedFingerprint:product.identityFingerprint,available:8,reserved:1,quantity:5,unit:'box',reason:'Conteo contrastado por el operador',confirmed:true}};
      assert.equal((await request(path,{body,auth:false})).status,401);
      assert.equal((await request(path,{body:{...body,reconciliation:{...body.reconciliation,confirmed:false}}})).status,400);
      assert.equal((await request(path,{body:{...body,reconciliation:{...body.reconciliation,available:9}}})).status,409);
      const foreign=await request(path,{body,headers:{Authorization:`Bearer ${issueJwt({phoneNumber:'59899000515'})}`}});assert.equal(foreign.status,404);
      const [one,two]=await Promise.all([request(path,{body}),request(path,{body})]);assert.equal(one.status,200);assert.deepEqual(one.json,two.json);
      assert.equal(one.json.pedido.productId,product.id);assert.equal(one.json.pedido.stockPosting.quantity,5);
      assert.deepEqual((await ledger(one.json.inventoryResult.operationId)).map((m)=>[Number(m.delta_available),Number(m.delta_reserved)]),[[0,0]]);
      assert.equal(Number((await stock(product.id))[0].stock_available),8);
      const reversal=await request(`/api/pedidos/${pedidoId}`,{method:'PUT',body:{operationId:'http-order-after-reconcile',expectedRevision:1,estado:'pendiente'}});
      assert.equal(reversal.status,200);assert.equal(Number((await stock(product.id))[0].stock_available),3);
      assert.deepEqual((await request(path,{body})).json,one.json);
    });
    await run('state read failures return unavailable without an empty snapshot and recover persisted data',async()=>{
      const product=await createHttpFixtureProduct({name:'HTTP read outage retained',stockAvailable:7},owner);
      await sql.query('ALTER TABLE products RENAME TO products_temporarily_unavailable');
      try{
        const failed=await request('/api/state',{method:'GET'});
        assert.equal(failed.status,503);assert.equal(failed.json.code,'STATE_UNAVAILABLE');
        assert.equal(Object.hasOwn(failed.json,'products'),false);assert.equal(Object.hasOwn(failed.json,'clients'),false);
        assert.equal(failed.text.includes('products_temporarily_unavailable'),false);
      }finally{await sql.query('ALTER TABLE products_temporarily_unavailable RENAME TO products');}
      const recovered=await request('/api/state',{method:'GET'});assert.equal(recovered.status,200);
      assert.equal(recovered.json.products.find((p)=>p.id===product.id).stockAvailable,7);
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
