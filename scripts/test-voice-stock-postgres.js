import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import * as db from '../server/postgresDatabase.js';
import { productFingerprint } from '../server/voiceStockEngine.js';
import { processStockBatchMessage } from '../server/voiceStockWorkflow.js';
import { processMetaWebhook } from '../server/metaWebhookProcessor.js';

const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erpvoice-test-pg-'));
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: 'local-test', port, persistent: true, onLog: () => {}, onError: () => {}, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
let sql;
let checks = 0;
const originalFetch = globalThis.fetch;
const owner = '59899000101';
const other = '59899000202';
let sequence = 0;
const action = (name, resolution = { kind: 'new' }) => ({ type: 'add_stock', itemId: 'item-1', productName: name, qty: 2, evidence: name, fieldEvidence: { qty: 'dos' }, resolution });
const createBatch = async (actions, options = {}) => {
  const serial = ++sequence;
  const sourceText = `Ingresaron dos ${actions.map((item) => item.evidence).join(' y ')}`;
  return db.createVoiceStockBatch({
    id: `test-batch-${serial}`, ownerPhone: owner, senderPhone: owner, sourceMessageId: `test-source-${serial}`, status: 'ready', sourceText,
    payload: { actions, initialActions: actions, coverageVerified: true, evidenceSourceText: sourceText, replyMessageId: `test-source-${serial}` }, ...options,
  });
};
const check = async (name, callback) => { await callback(); checks++; console.log(`PASS ${name}`); };

try {
  await postgres.initialise();
  await postgres.start();
  const connection = `postgresql://postgres:local-test@127.0.0.1:${port}/postgres`;
  for (const key of ['SUPABASE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_CONNECTION_STRING']) process.env[key] = connection;
  process.env.POSTGRES_SSL = 'false';
  await db.migrateDatabase();
  await db.closeDatabase();
  await db.migrateDatabase();
  sql = new Client({ connectionString: connection }); await sql.connect();

  await check('migración repetible y RLS', async () => {
    const rows = await sql.query("SELECT relrowsecurity FROM pg_class WHERE relname IN ('voice_stock_batches', 'meta_reply_outbox', 'voice_stock_batch_settings')");
    assert.equal(rows.rowCount, 3); assert.ok(rows.rows.every((row) => row.relrowsecurity));
  });
  await check('webhook concurrente se reclama una sola vez y conserva transcripción', async () => {
    const args = { messageId: 'concurrent-inbound', ownerPhone: owner, senderPhone: owner, rawBody: { object: 'whatsapp_business_account', entry: [] } };
    const claimed = await Promise.all(Array.from({ length: 8 }, () => db.claimMetaMessage(args)));
    assert.equal(claimed.filter(Boolean).length, 1);
    await db.saveMetaTranscript(args.messageId, 'original'); await db.saveMetaTranscript(args.messageId, 'overwrite');
    assert.equal(await db.loadMetaTranscript(args.messageId), 'original');
    await db.failMetaMessageClaim(args.messageId, 'temporary');
    await sql.query("UPDATE meta_message_claims SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE message_id = $1", [args.messageId]);
    const jobs = await db.claimRecoverableMetaMessages(); assert.equal(jobs[0].message_id, args.messageId);
    await db.completeMetaMessageClaim(args.messageId); assert.equal(await db.claimMetaMessage(args), false);
  });
  await check('aplicación concurrente y reintento después del commit son idempotentes', async () => {
    const batch = await createBatch([action('Taladro nuevo 18V')]);
    await Promise.all([db.applyResolvedVoiceStockBatch(batch.id, owner), db.applyResolvedVoiceStockBatch(batch.id, owner)]);
    await db.applyResolvedVoiceStockBatch(batch.id, owner);
    const state = await db.getStateSnapshotStrict(owner);
    assert.equal(state.products.find((entry) => entry.name === 'Taladro nuevo 18V').stockAvailable, 2);
    assert.equal(state.transactions.filter((entry) => entry.actions[0]?.productName === 'Taladro nuevo 18V').length, 1);
    const outbox = await sql.query('SELECT * FROM meta_reply_outbox WHERE event_id = $1', [batch.sourceMessageId]);
    assert.equal(outbox.rowCount, 1); assert.match(outbox.rows[0].reply_text, /Ingreso aplicado/);
  });
  await check('lote incompleto y cobertura no verificada no escriben stock', async () => {
    const batch = await createBatch([action('No aplicar', { kind: 'ambiguous', candidateIds: [] })]);
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner));
    assert.equal((await db.getStateSnapshotStrict(owner)).products.some((item) => item.name === 'No aplicar'), false);
    await db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' });
    const unverified = await createBatch([action('Sin auditoría')], { payload: { actions: [action('Sin auditoría')], coverageVerified: false } });
    await assert.rejects(db.applyResolvedVoiceStockBatch(unverified.id, owner));
    await db.updateVoiceStockBatch(unverified.id, { expectedVersion: unverified.version, status: 'cancelled' });
  });
  await check('rollback completo si un segundo ítem es inválido', async () => {
    const batch = await createBatch([action('Primero válido'), { ...action('Segundo inválido'), itemId: 'item-2', qty: 1.5 }]);
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner));
    assert.equal((await db.getStateSnapshotStrict(owner)).products.some((item) => item.name === 'Primero válido'), false);
    await db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' });
  });
  await check('fallo al guardar la respuesta revierte stock, registros y estado juntos', async () => {
    const batch = await createBatch([action('Rollback de outbox')]);
    await sql.query(`CREATE FUNCTION test_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure before commit'; END $$;
      CREATE TRIGGER test_outbox_failure BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION test_outbox_failure();`);
    try {
      await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner));
      assert.equal((await db.getStateSnapshotStrict(owner)).products.some((entry) => entry.name === 'Rollback de outbox'), false);
      assert.equal((await sql.query('SELECT id FROM transactions WHERE batch_id = $1', [batch.id])).rowCount, 0);
      assert.equal((await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId)).status, 'ready');
    } finally {
      await sql.query('DROP TRIGGER test_outbox_failure ON meta_reply_outbox; DROP FUNCTION test_outbox_failure();');
    }
    await db.applyResolvedVoiceStockBatch(batch.id, owner);
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.name === 'Rollback de outbox').stockAvailable, 2);
  });
  const existing = await db.createProductRecord({ name: 'Taladro Bosch', stockAvailable: 3, size: '10 mm' }, owner);
  await check('ID existente, aislamiento por negocio y cambio de catálogo', async () => {
    const item = { ...action('Taladro Bosch', { kind: 'existing', productId: existing.id, fingerprint: productFingerprint(existing) }), size: '10 mm' };
    const batch = await createBatch([item]);
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, other));
    await db.updateProductRecord(existing.id, { name: 'Taladro Bosch modificado' }, owner);
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner));
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === existing.id).stockAvailable, 3);
    await db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' });
  });
  await check('crear nuevo no duplica una identidad indistinguible', async () => {
    const batch = await createBatch([{ ...action('Taladro Bosch modificado'), size: '10 mm' }]);
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner));
    await db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' });
  });
  await check('dos respuestas sobre la misma versión: solo una gana', async () => {
    const batch = await createBatch([action('Carrera CAS')], { status: 'awaiting_choice' });
    const results = await Promise.all([
      db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' }),
      db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'awaiting_correction' }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const latest = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
    if (latest.status !== 'cancelled') await db.updateVoiceStockBatch(batch.id, { expectedVersion: latest.version, status: 'cancelled' });
    assert.equal(await db.updateVoiceStockBatch(batch.id, { expectedVersion: latest.version + 1, status: 'ready' }), null);
  });
  await check('vencimiento libera el lote pendiente', async () => {
    const batch = await createBatch([action('Lote vencido')], { status: 'awaiting_correction' });
    await sql.query("UPDATE voice_stock_batches SET updated_at = NOW() - INTERVAL '8 days' WHERE id = $1", [batch.id]);
    assert.equal(await db.getActiveVoiceStockBatch(owner, owner), null);
    assert.equal((await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId)).status, 'expired');
  });
  await check('outbox concurrente y reenvío no repiten stock', async () => {
    const before = await db.getStateSnapshotStrict(owner);
    const groups = await Promise.all([db.claimPendingMetaReplies(), db.claimPendingMetaReplies()]);
    const messages = groups.flat(); assert.equal(new Set(messages.map((item) => item.event_id)).size, messages.length);
    const item = messages[0]; await db.finishMetaReply(item.event_id, 'WhatsApp unavailable');
    await sql.query("UPDATE meta_reply_outbox SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE event_id = $1", [item.event_id]);
    assert.ok((await db.claimPendingMetaReplies()).some((row) => row.event_id === item.event_id));
    await db.finishMetaReply(item.event_id);
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
  });
  await check('modo por negocio no afecta otros tenants', async () => {
    await db.setVoiceStockBatchMode(owner, 'shadow'); await db.setVoiceStockBatchMode(other, 'disabled');
    assert.equal(await db.getVoiceStockBatchMode(owner), 'shadow'); assert.equal(await db.getVoiceStockBatchMode(other), 'disabled');
    await db.setVoiceStockBatchMode(owner, 'active');
  });

  // Real workflow, fake model; all writes still use the real PostgreSQL transaction.
  process.env.GEMINI_API_KEY = 'test'; process.env.LLM_PROVIDER = 'gemini'; process.env.LLM_DISABLE_FALLBACK = '1';
  const drillA = await db.createProductRecord({ name: 'Taladro Makita', size: '10 mm', stockAvailable: 0 }, owner);
  const drillB = await db.createProductRecord({ name: 'Taladro Makita', size: '13 mm', stockAvailable: 0 }, owner);
  let calls = 0;
  let auditComplete = true;
  let semanticClarification = null;
  let resolutionKind = 'ambiguous';
  let extractionOverride = null;
  let useSavedContext = false;
  const modelInputs = [];
  globalThis.fetch = async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    const stage = body.messages[0].content;
    const input = JSON.parse(body.messages[1].content.split('\nDATOS:\n')[1]);
    modelInputs.push({ stage, input });
    const extracted = extractionOverride ?? [{ type: 'add_stock', productName: 'Taladro Makita', qty: 2, evidence: 'Taladro Makita', fieldEvidence: { qty: 'dos' } }];
    const content = stage.includes('clarify') ? (semanticClarification ?? { kind: 'unrelated' })
      : stage.includes('extract') ? { kind: 'stock_intake', sourceText: useSavedContext ? input.clarificationContext?.sourceText : undefined, actions: extracted }
      : stage.includes('audit') ? { coverageComplete: auditComplete, issues: auditComplete ? [] : [{ kind: 'clarification', detail: 'Una referencia puede ser otra unidad.', evidence: extracted[0].evidence, question: '¿La segunda mención es otro producto o una referencia al primero?' }], verifiedItemIds: input.actions.map((item) => item.itemId) }
      : { items: input.actions.map((item) => ({ itemId: item.itemId, kind: resolutionKind, candidateIds: [drillA.id, drillB.id], reason: 'Falta medida.' })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  };
  const message = (messageId, sourceText) => processStockBatchMessage({ ownerPhone: owner, senderPhone: owner, messageId, sourceText, businessCategory: 'ferreteria', conversationTurns: [] });
  await check('diálogo real: pregunta, elección, replay y no reinterpretación', async () => {
    const first = await message('dialog-source', 'Ingresaron dos Taladro Makita');
    assert.equal(first.batchStatus, 'awaiting_choice'); assert.match(first.replyText, /13 mm/);
    const before = calls;
    assert.equal((await message('dialog-source', 'Ingresaron dos Taladro Makita')).replyText, first.replyText);
    assert.equal(calls, before);
    const selected = await message('dialog-answer', '2');
    assert.equal(selected.batchStatus, 'applied'); assert.equal(calls, before);
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === drillB.id).stockAvailable, 2);
    await message('dialog-answer', '2'); await message('dialog-source', 'Ingresaron dos Taladro Makita');
    assert.equal(calls, before);
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === drillB.id).stockAvailable, 2);
  });
  await check('dos aclaraciones simultáneas del diálogo aplican una sola decisión', async () => {
    const before = (await db.getStateSnapshotStrict(owner)).products.filter((entry) => [drillA.id, drillB.id].includes(entry.id)).reduce((sum, item) => sum + item.stockAvailable, 0);
    await message('race-source', 'Ingresaron dos Taladro Makita');
    await Promise.all([message('race-one', '1'), message('race-two', '2')]);
    const after = (await db.getStateSnapshotStrict(owner)).products.filter((entry) => [drillA.id, drillB.id].includes(entry.id)).reduce((sum, item) => sum + item.stockAvailable, 0);
    assert.equal(after - before, 2);
    assert.equal((await db.getVoiceStockBatchByMessage(owner, 'race-source')).status, 'applied');
  });
  await check('cancelar desde esperando corrección y respuesta inválida conserva lote', async () => {
    const batch = await createBatch([action('Corrección')], { status: 'awaiting_correction' });
    const result = await message('correction-cancel', 'cancelar'); assert.equal(result.batchStatus, 'cancelled');
    assert.equal((await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId)).status, 'cancelled');
  });
  await check('reintentar recupera la transcripción guardada de un borrador sin acciones', async () => {
    const sourceText = 'Ingresaron dos Taladro Makita';
    const batch = await createBatch([], { status: 'awaiting_correction', sourceText,
      payload: { actions: [], coverageVerified: false, resolutionError: 'unsupported_price', evidenceSourceText: sourceText } });
    const retried = await message('retry-saved-transcript', 'reintentar');
    assert.equal(retried.batchId, batch.id); assert.equal(retried.batchStatus, 'awaiting_choice');
    assert.match(retried.replyText, /Taladro Makita/);
    const saved = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
    assert.equal(saved.sourceText, sourceText); assert.equal(saved.payload.evidenceSourceText, sourceText);
    assert.equal(saved.payload.actions.length, 1); assert.equal(saved.payload.coverageVerified, true);
    const selected = await message('retry-saved-select', '1'); assert.equal(selected.batchStatus, 'applied');
    const beforeReplay = calls;
    assert.equal((await message('retry-saved-transcript', 'reintentar')).replyText, retried.replyText);
    assert.equal(calls, beforeReplay);
  });
  await check('corrección conserva el texto original y requiere una nueva auditoría', async () => {
    auditComplete = false;
    const original = 'Ingresaron dos Taladro Makita. Hay otra mención dudosa.';
    const held = await message('audit-hold', original); assert.equal(held.batchStatus, 'awaiting_correction');
    auditComplete = true;
    const corrected = await message('audit-corrected', 'Ingresaron dos Taladro Makita'); assert.equal(corrected.batchStatus, 'awaiting_choice');
    await message('audit-select', '2');
    const saved = await db.getVoiceStockBatchByMessage(owner, 'audit-hold');
    assert.equal(saved.sourceText, original); assert.equal(saved.payload.corrections[0].messageId, 'audit-corrected');
    assert.equal(saved.status, 'applied');
  });
  await check('respuesta breve a una duda conserva toda la lista y aplica una sola vez', async () => {
    const source = 'Ingresó Aceite Aurora y Arroz Norte. El anterior es importado.';
    extractionOverride = ['Aceite Aurora', 'Arroz Norte'].map((name) => ({ type: 'add_stock', productName: name, qty: 1, evidence: name, fieldEvidence: {} }));
    auditComplete = false;
    const held = await message('brief-source', source);
    assert.equal(held.batchStatus, 'awaiting_correction'); assert.match(held.replyText, /¿La segunda mención/);
    assert.doesNotMatch(held.replyText, /lista completa|evidencia|caracteres/);
    auditComplete = true; useSavedContext = true; resolutionKind = 'new';
    const answer = 'Es una referencia al primero, no es otra unidad.';
    const answered = await message('brief-answer', answer); assert.equal(answered.batchStatus, 'applied');
    const saved = await db.getVoiceStockBatchByMessage(owner, 'brief-source');
    assert.equal(saved.sourceText, source); assert.equal(saved.payload.evidenceSourceText, `${source}\n${answer}`);
    assert.equal(saved.payload.actions.length, 2);
    const extractionInput = modelInputs.findLast((entry) => entry.stage.includes('Etapa: extract.')).input;
    assert.equal(extractionInput.sourceText, answer); assert.equal(extractionInput.clarificationContext.sourceText, source);
    const beforeReplay = calls; await message('brief-answer', answer); assert.equal(calls, beforeReplay);
    const products = (await db.getStateSnapshotStrict(owner)).products;
    for (const name of ['Aceite Aurora', 'Arroz Norte']) assert.equal(products.find((product) => product.name === name).stockAvailable, 1);
    extractionOverride = null; useSavedContext = false; resolutionKind = 'ambiguous';
  });
  await check('borrar un candidato no cambia el significado de los números ofrecidos', async () => {
    await message('deleted-source', 'Ingresaron dos Taladro Makita');
    await db.deleteProductRecord(drillA.id, owner);
    const afterDeletion = await message('deleted-answer', '1'); assert.equal(afterDeletion.batchStatus, 'awaiting_choice');
    const saved = await db.getVoiceStockBatchByMessage(owner, 'deleted-source');
    assert.deepEqual(saved.payload.actions[0].resolution.candidateIds, [drillA.id, drillB.id]);
    await message('deleted-cancel', 'cancelar');
  });
  await check('nuevo indistinguible pide diferencia y usa la aclaración literal', async () => {
    await message('new-source', 'Ingresaron dos Taladro Makita');
    const collision = await message('new-answer', 'nuevo'); assert.equal(collision.batchStatus, 'awaiting_choice'); assert.match(collision.replyText, /qué cambia/);
    const named = await message('new-name', 'nombre: Taladro Makita edición naranja'); assert.equal(named.batchStatus, 'applied');
    const product = (await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.name === 'Taladro Makita edición naranja');
    assert.equal(product.stockAvailable, 2);
  });
  await check('elección semántica en lenguaje natural usa únicamente un candidato ofrecido', async () => {
    await message('natural-source', 'Ingresaron dos Taladro Makita');
    const answer = 'Es el de trece milímetros que ya tengo.';
    semanticClarification = { kind: 'existing', productId: drillB.id, evidence: answer };
    const selected = await message('natural-answer', answer); assert.equal(selected.batchStatus, 'applied');
    semanticClarification = null;
  });
  await check('corrección de un solo ítem vuelve a auditar y conserva los demás datos', async () => {
    await message('item-correct-source', 'Ingresaron dos Taladro Makita');
    const answer = 'En realidad son tres, medida 14 mm.';
    semanticClarification = { kind: 'correction', evidence: answer, correctedAction: { type: 'add_stock', productName: 'Taladro Makita', size: '14 mm', qty: 3, fieldEvidence: { qty: 'son tres', attributes: ['medida 14 mm'] } } };
    resolutionKind = 'new';
    const corrected = await message('item-correct-answer', answer); assert.equal(corrected.batchStatus, 'applied');
    const product = (await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.name === 'Taladro Makita' && entry.size === '14 mm');
    assert.equal(product.stockAvailable, 3);
    semanticClarification = null; resolutionKind = 'ambiguous';
  });
  await check('sombra conserva comparación y no modifica inventario', async () => {
    await db.setVoiceStockBatchMode(owner, 'shadow');
    const before = await db.getStateSnapshotStrict(owner);
    assert.equal(await message('shadow-source', 'Ingresaron dos Taladro Makita'), null);
    await db.saveVoiceStockShadowBaseline('shadow-source', { actions: [] });
    const stored = await sql.query('SELECT * FROM voice_stock_shadow_runs WHERE message_id = $1', ['shadow-source']);
    assert.equal(stored.rowCount, 1); assert.ok(stored.rows[0].proposed_json); assert.deepEqual(stored.rows[0].baseline_json.actions, []);
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
    await db.setVoiceStockBatchMode(owner, 'active');
  });
  await check('reintento de audio usa transcripción persistida sin consultar Meta ni Whisper', async () => {
    const before = calls;
    const results = await processMetaWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: 'cached-audio', from: owner, type: 'audio', audio: { id: 'no-download' } }] } }] }] }, {
      loadTranscript: async () => 'Ingresaron dos Taladro Makita', saveTranscript: async () => {},
      processStockText: async () => ({ actions: [], replyText: 'Borrador recuperado', batchStatus: 'awaiting_choice' }),
    });
    assert.equal(results[0].replyText, 'Borrador recuperado'); assert.equal(calls, before);
  });
  await check('recuperación de otros intents tampoco repite una mutación ya confirmada', async () => {
    const product = await db.createProductRecord({ name: 'Producto de venta', stockAvailable: 10 }, owner);
    const options = { messageId: 'legacy-sale-once', recipient: owner, replyText: 'Venta registrada.' };
    await Promise.all(Array.from({ length: 3 }, () => db.applyActionsToDatabase([{ type: 'sell', productName: product.name, qty: 2 }], 'Vendí dos Producto de venta', owner, options)));
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === product.id).stockAvailable, 8);
    assert.equal((await sql.query('SELECT id FROM transactions WHERE batch_id = $1', ['meta:legacy-sale-once'])).rowCount, 1);
    assert.equal((await sql.query('SELECT event_id FROM meta_reply_outbox WHERE event_id = $1', [options.messageId])).rowCount, 1);
  });
  await check('historial del remitente queda limitado al negocio actual', async () => {
    const base = { at: new Date().toISOString(), fromNumber: owner, sourceText: 'listado anterior', processed: true };
    await db.saveMetaEvent({ ...base, id: 'history-owner', ownerPhone: owner });
    await db.saveMetaEvent({ ...base, id: 'history-other', ownerPhone: other });
    const events = await db.getMetaEvents(20, owner, { senderPhone: owner });
    assert.ok(events.some((event) => event.id === 'history-owner'));
    assert.equal(events.some((event) => event.id === 'history-other'), false);
  });
  console.log(`PostgreSQL integration: ${checks} checks passed.`);
} finally {
  globalThis.fetch = originalFetch;
  await db.closeDatabase();
  if (sql) await sql.end();
  // The package uses taskkill on Windows; graceful pg_ctl also closes PG18 I/O workers.
  if (process.platform === 'win32' && postgres.process) {
    const control = fileURLToPath(new URL('../node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe', import.meta.url));
    await promisify(execFile)(control, ['-D', directory, '-m', 'fast', '-w', 'stop'], { windowsHide: true });
    postgres.process = undefined;
  }
  await postgres.stop();
  const target = path.resolve(directory);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('erpvoice-test-pg-')) await fs.rm(target, { recursive: true, force: true });
}
