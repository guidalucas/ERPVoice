import assert from 'node:assert/strict';
import { runInventoryCoreChecks } from './inventory-core-postgres-checks.js';
import { runInventoryHttpChecks } from './inventory-http-checks.js';
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
import { holdUnverifiedStockMessage, processStockBatchMessage } from '../server/voiceStockWorkflow.js';
import { processMetaWebhook, sendMetaReply } from '../server/metaWebhookProcessor.js';
import { incidentText, incidentActions, ambiguousMention } from './fixtures/voice-stock-corpus.js';

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
  await runInventoryCoreChecks({ db, sql, check });
  await runInventoryHttpChecks({ db, sql, check });

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
  await check('un lote antiguo con una referencia duplicada tampoco puede aplicarse', async () => {
    const prior = action('Taladro Bosch 18V');
    const duplicate = { ...action('Taladro Bosch 18V'), itemId: 'item-2',
      evidence: 'el anterior Taladro Bosch 18V', productModel: 'anterior' };
    const batch = await createBatch([prior, duplicate]);
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner), { code: 'STOCK_REFERENCE_UNVERIFIED' });
    assert.equal((await db.getStateSnapshotStrict(owner)).products.some((entry) => entry.name === prior.productName), false);
    await db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' });
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
      assert.equal((await sql.query('SELECT operation_id FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [owner,batch.id])).rowCount, 0);
      assert.equal((await sql.query('SELECT item_id FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2', [owner,batch.id])).rowCount, 0);
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
  let drillA = await db.createProductRecord({ name: 'Taladro Makita', size: '10 mm', stockAvailable: 0 }, owner);
  const drillB = await db.createProductRecord({ name: 'Taladro Makita', size: '13 mm', stockAvailable: 0 }, owner);
  await check('la transacción rechaza un producto existente con medida distinta', async () => {
    const batch = await createBatch([{ ...action('Taladro Makita', {
      kind: 'existing', productId: drillB.id, fingerprint: productFingerprint(drillB), userConfirmed: true,
    }), size: 'L' }]);
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner), /variante elegida no coincide/);
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === drillB.id).stockAvailable, 0);
    await db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' });
  });
  await check('la transacción de indumentaria rechaza un lote sin talle explícito', async () => {
    const batch = await createBatch([action('Camiseta Aurora')], { businessCategory: 'indumentaria' });
    await assert.rejects(db.applyResolvedVoiceStockBatch(batch.id, owner), /Falta confirmar el talle/);
    await db.updateVoiceStockBatch(batch.id, { expectedVersion: batch.version, status: 'cancelled' });
  });
  let calls = 0;
  let auditComplete = true;
  let semanticClarification = null;
  let resolutionKind = 'ambiguous';
  let extractionOverride = null;
  let enrichmentOverride = null;
  let useSavedContext = false;
  let misclassifyExtract = false;
  let failRecovery = false;
  let failExtract = false;
  let failResolve = false;
  let failClarify = false;
  let failDraftPatch = false;
  let draftPatchOverride = null;
  let auditOverride = null;
  const modelInputs = [];
  globalThis.fetch = async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    const stage = body.messages[0].content;
    const input = JSON.parse(body.messages[1].content.split('\nDATOS:\n')[1]);
    modelInputs.push({ stage, input });
    if (stage.includes('Etapa: extract.') && failExtract) return new Response('Fallo simulado', { status: 400 });
    if (stage.includes('Etapa: resolve.') && failResolve) return new Response('Fallo simulado', { status: 400 });
    if (stage.includes('Etapa: clarify.') && failClarify) return new Response('Fallo simulado', { status: 400 });
    if (stage.includes('Etapa: draft_patch.') && failDraftPatch) return new Response('Fallo simulado', { status: 400 });
    const extracted = extractionOverride ?? [{ type: 'add_stock', productName: 'Taladro Makita', qty: 2, evidence: 'Taladro Makita', fieldEvidence: { qty: 'dos' } }];
    const content = stage.includes('Etapa: extract.') && misclassifyExtract ? { kind: 'other', actions: [] }
      : stage.includes('Etapa: repair_extract.') && failRecovery ? { actions: [] }
      : stage.includes('draft_patch') ? (typeof draftPatchOverride === 'function' ? draftPatchOverride(input) : draftPatchOverride ?? { kind: 'needs_clarification' })
      : stage.includes('clarify') ? (semanticClarification ?? { kind: 'unrelated' })
      : stage.includes('enrich_attributes') ? { items: input.actions.map((action, index) => enrichmentOverride?.[index] ? { ...enrichmentOverride[index], itemId: action.itemId } : ({
        itemId: action.itemId, productName: action.productName, productType: action.productType,
        productModel: action.productModel, size: action.size, attributeQuotes: [],
      })) }
      : stage.includes('extract') ? { kind: 'stock_intake', sourceText: useSavedContext ? input.clarificationContext?.sourceText : undefined, actions: extracted }
      : stage.includes('audit') ? auditOverride ? auditOverride(input) : { coverageComplete: auditComplete, issues: auditComplete ? [] : [{
        kind: 'clarification', detail: 'Una referencia puede ser otra unidad.',
        evidenceSpanId: input.sourceSpans.at(-1).id,
        question: `¿“${input.sourceSpans.at(-1).text}” es otro producto o una referencia al primero?`,
      }], verifiedItemIds: input.actions.map((item) => item.itemId) }
      : { items: input.actions.map((item) => ({ itemId: item.itemId, kind: resolutionKind, candidateIds: [drillA.id, drillB.id], reason: 'Falta medida.' })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  };
  const message = (messageId, sourceText, replyToMessageId = null) => processStockBatchMessage({ ownerPhone: owner, senderPhone: owner, messageId, sourceText, replyToMessageId, businessCategory: 'ferreteria', conversationTurns: [] });
  const clothingMessage = (messageId, sourceText) => processStockBatchMessage({ ownerPhone: owner, senderPhone: owner, messageId, sourceText, businessCategory: 'indumentaria', conversationTurns: [] });
  await check('el dictado real aplica once camisetas una sola vez con variante y precio', async () => {
    const names = [
      ['Camiseta suplente del Manchester City 2025', undefined], ['Camiseta de Independiente suplente 2026', 'suplente'],
      ['Camiseta de Racing titular, 2026', 'titular'], ['Camiseta de River 2025', 'titular'],
      ['Camiseta de Argentina, tercera equipación, 2025', 'tercera equipación'], ['Camiseta de Barcelona 2025 titular', 'titular'],
      ['Tercera camiseta de Boca', 'tercera equipación'], ['Camiseta de Italia 2025', 'titular'],
      ['Camiseta de la Roma 2025 titular', 'titular'], ['Camiseta del Real Madrid', 'titular'],
      ['Camiseta del Barcelona 2025 titular, mangas largas', 'titular'],
    ];
    const actions = incidentActions.map((action, index) => ({ ...action, productName: names[index][0], productModel: names[index][1] }));
    extractionOverride = [actions[0],
      { ...actions[1], productName: 'Camiseta de Independiente', productModel: undefined, evidence: ambiguousMention },
      { ...actions[0], productName: 'Camiseta del Manchester City', productModel: 'anterior', size: undefined, evidence: ambiguousMention },
      ...actions.slice(1)];
    enrichmentOverride = incidentActions.map((action, index) => ({
      itemId: `item-${index + 1}`, productName: action.productName, productType: action.productType,
      productModel: action.productModel, size: action.size,
      attributeQuotes: index === 0 ? [ambiguousMention] : ['Todas estas que te voy a mencionar son en versión jugador.'],
    }));
    resolutionKind = 'new';
    let createdIds = [];
    try {
      const held = await clothingMessage('incident-source', incidentText);
      assert.equal(held.batchStatus, 'awaiting_correction');
      assert.match(held.replyText, /talle/);
      const result = await clothingMessage('incident-sizes', 'todas son talle L');
      assert.equal(result.batchStatus, 'applied');
      assert.equal(result.actions.length, 11);
      assert.equal(result.actions.every((entry) => entry.size === 'L'), true);
      assert.equal(result.actions.reduce((sum, action) => sum + action.price, 0), 720000);
      const saved = await db.getVoiceStockBatchByMessage(owner, 'incident-source');
      assert.equal(saved.payload.appliedActions.length, 11);
      const state = await db.getStateSnapshotStrict(owner);
      const created = result.actions.map((action) => state.products.find((product) => product.id === action.resolvedProductId));
      createdIds = created.map((product) => product.id);
      assert.equal(created.every((product) => product.stockAvailable === 1 && /versión jugador/i.test(product.name)), true);
      assert.equal(created.filter((product) => /Barcelona/i.test(product.name) && /2025/i.test(product.name)
        && /titular/i.test(product.name)).length, 2);
      assert.equal(created.filter((product) => /Manchester City/i.test(product.name)).length, 1);
      assert.equal(created.find((product) => /mangas largas/i.test(product.name)).price, 70000);
      await clothingMessage('incident-source', incidentText);
      const rows = await sql.query('SELECT COUNT(*)::integer AS total FROM transactions WHERE batch_id = $1', [result.batchId]);
      assert.equal(rows.rows[0].total, 11);
    } finally {
      extractionOverride = null; enrichmentOverride = null; resolutionKind = 'ambiguous';
      for (const id of createdIds) await db.deleteProductRecord(id, owner);
    }
  });
  await check('indumentaria exige talles y todas son talle L completa el lote', async () => {
    extractionOverride = [
      { type: 'add_stock', productName: 'Camiseta Aurora', size: 'L', qty: 1,
        evidence: 'Camiseta Aurora talle L', fieldEvidence: {} },
      { type: 'add_stock', productName: 'Camiseta Boreal', qty: 1,
        evidence: 'Camiseta Boreal', fieldEvidence: {} },
      { type: 'add_stock', productName: 'Camiseta Prisma', qty: 1,
        evidence: 'Camiseta Prisma', fieldEvidence: {} },
    ];
    resolutionKind = 'new';
    const createdIds = [];
    try {
      const source = 'Cargué una Camiseta Aurora talle L. Camiseta Boreal. Camiseta Prisma.';
      const held = await clothingMessage('clothing-sizes-source', source);
      assert.equal(held.batchStatus, 'awaiting_correction');
      assert.match(held.replyText, /Camiseta Boreal/);
      assert.match(held.replyText, /Camiseta Prisma/);
      assert.doesNotMatch(held.replyText, /1\. Camiseta Aurora/);
      const before = await db.getStateSnapshotStrict(owner);
      assert.equal(before.products.some((product) => ['Camiseta Aurora', 'Camiseta Boreal', 'Camiseta Prisma'].includes(product.name)), false);
      const applied = await clothingMessage('clothing-sizes-answer', 'todas son talle L');
      assert.equal(applied.batchStatus, 'applied');
      assert.equal(applied.actions.every((entry) => entry.size === 'L'), true);
      const after = await db.getStateSnapshotStrict(owner);
      for (const name of ['Camiseta Aurora', 'Camiseta Boreal', 'Camiseta Prisma']) {
        const product = after.products.find((entry) => entry.name === name && entry.size === 'L');
        assert.equal(product.stockAvailable, 1);
        createdIds.push(product.id);
      }
    } finally {
      extractionOverride = null; resolutionKind = 'ambiguous';
      for (const id of createdIds) await db.deleteProductRecord(id, owner);
    }
  });
  await check('los talles parciales conservan el borrador hasta completar todos', async () => {
    extractionOverride = ['Campera Nube', 'Campera Sol'].map((name) => ({
      type: 'add_stock', productName: name, qty: 1, evidence: name, fieldEvidence: {},
    }));
    resolutionKind = 'new';
    const createdIds = [];
    try {
      const held = await clothingMessage('partial-sizes-source', 'Cargué una Campera Nube. Campera Sol.');
      assert.equal(held.batchStatus, 'awaiting_correction');
      const partial = await clothingMessage('partial-sizes-first', '1 S');
      assert.equal(partial.batchStatus, 'awaiting_correction');
      assert.match(partial.replyText, /Campera Sol/);
      assert.doesNotMatch(partial.replyText, /Campera Nube/);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.some((entry) => entry.name === 'Campera Nube'), false);
      const applied = await clothingMessage('partial-sizes-second', '1 M');
      assert.equal(applied.batchStatus, 'applied');
      const products = (await db.getStateSnapshotStrict(owner)).products;
      for (const [name, size] of [['Campera Nube', 'S'], ['Campera Sol', 'M']]) {
        const product = products.find((entry) => entry.name === name && entry.size === size);
        assert.equal(product.stockAvailable, 1);
        createdIds.push(product.id);
      }
    } finally {
      extractionOverride = null; resolutionKind = 'ambiguous';
      for (const id of createdIds) await db.deleteProductRecord(id, owner);
    }
  });
  await check('si falla el catálogo después de responder talles, reintentar conserva las respuestas', async () => {
    extractionOverride = [{ type: 'add_stock', productName: 'Campera Reintento', qty: 1,
      evidence: 'Campera Reintento', fieldEvidence: {} }];
    resolutionKind = 'new';
    let createdId;
    try {
      const held = await clothingMessage('retry-size-source', 'Cargué una Campera Reintento.');
      assert.equal(held.batchStatus, 'awaiting_correction');
      failResolve = true;
      const failed = await clothingMessage('retry-size-answer', 'todas son talle L');
      assert.equal(failed.batchStatus, 'awaiting_correction');
      assert.match(failed.replyText, /Guardé los talles/);
      failResolve = false;
      const retried = await clothingMessage('retry-size-retry', 'reintentar');
      assert.equal(retried.batchStatus, 'applied');
      const product = (await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.name === 'Campera Reintento' && entry.size === 'L');
      assert.equal(product.stockAvailable, 1);
      createdId = product.id;
    } finally {
      extractionOverride = null; resolutionKind = 'ambiguous'; failResolve = false;
      if (createdId) await db.deleteProductRecord(createdId, owner);
    }
  });
  await check('un único SKU con variante explícita aplica stock sin pedir una opción', async () => {
    const product = await db.createProductRecord({ name: 'Taladro Bosch 18V', size: '10 mm', stockAvailable: 0 }, owner);
    extractionOverride = [{ type: 'add_stock', productName: 'Taladro Bosch 18V', size: '10 mm', qty: 2,
      evidence: 'Taladro Bosch 18V de 10 mm', fieldEvidence: { qty: 'dos' } }];
    const beforeCalls = modelInputs.length;
    try {
      const result = await message('unique-sku-source', 'Ingresaron dos Taladro Bosch 18V de 10 mm');
      assert.equal(result.batchStatus, 'applied');
      assert.equal(result.actions[0].resolution.productId, product.id);
      assert.equal(result.actions[0].resolution.matchScore, 100);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === product.id).stockAvailable, 2);
      assert.equal(modelInputs.slice(beforeCalls).some((entry) => entry.stage.includes('Etapa: resolve.')), false);
    } finally { extractionOverride = null; }
  });
  await check('clasificación other de una carga explícita se repara y no pasa al parser anterior', async () => {
    misclassifyExtract = true;
    const first = await message('misclassified-source', 'Cargé dos Taladro Makita');
    assert.equal(first.batchStatus, 'awaiting_choice');
    assert.equal(first.actions.length, 1);
    assert.match(first.replyText, /Taladro Makita/);
    await message('misclassified-cancel', 'cancelar');
    misclassifyExtract = false;
  });
  await check('si la reparación falla se guarda el audio y no se modifica stock', async () => {
    misclassifyExtract = true; failRecovery = true;
    const before = await db.getStateSnapshotStrict(owner);
    const first = await message('misclassified-fail', 'Cargé dos Taladro Makita');
    assert.equal(first.batchStatus, 'awaiting_correction');
    assert.match(first.replyText, /reintentar/);
    assert.equal((await db.getVoiceStockBatchByMessage(owner, 'misclassified-fail')).payload.evidenceSourceText, 'Cargé dos Taladro Makita');
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
    await message('misclassified-fail-cancel', 'cancelar');
    misclassifyExtract = false; failRecovery = false;
  });
  await check('el desacuerdo entre parsers guarda el mensaje y reintentar usa esa fuente', async () => {
    const sourceText = 'Hoy recibimos dos Taladro Makita';
    const held = await holdUnverifiedStockMessage({ sourceText, businessCategory: 'ferreteria',
      ownerPhone: owner, senderPhone: owner, messageId: 'legacy-conflict-source' });
    assert.equal(held.batchStatus, 'awaiting_correction');
    assert.match(held.replyText, /reintentar/);
    const saved = await db.getVoiceStockBatchByMessage(owner, 'legacy-conflict-source');
    assert.equal(saved.payload.evidenceSourceText, sourceText);
    assert.equal(saved.payload.forceStockIntake, true);
    misclassifyExtract = true;
    const retried = await message('legacy-conflict-retry', 'reintentar');
    assert.equal(retried.batchStatus, 'awaiting_choice');
    assert.equal(retried.batchId, held.batchId);
    assert.equal((await db.getVoiceStockBatchByMessage(owner, 'legacy-conflict-source')).sourceText, sourceText);
    await message('legacy-conflict-cancel', 'cancelar');
    misclassifyExtract = false;
  });
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
  await check('una opción M respondida 1 EN L crea o elige L sin incrementar M', async () => {
    const before = (await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === drillA.id).stockAvailable;
    const asked = await message('size-choice-source', 'Ingresaron dos Taladro Makita');
    assert.equal(asked.batchStatus, 'awaiting_choice');
    resolutionKind = 'new';
    try {
      const applied = await message('size-choice-answer', '1 EN L');
      assert.equal(applied.batchStatus, 'applied');
      assert.equal(applied.actions[0].size, 'L');
      const products = (await db.getStateSnapshotStrict(owner)).products;
      assert.equal(products.find((entry) => entry.id === drillA.id).stockAvailable, before);
      assert.equal(products.find((entry) => entry.name === 'Taladro Makita' && entry.size === 'L').stockAvailable, 2);
    } finally { resolutionKind = 'ambiguous'; }
  });
  await check('1 en talle L reutiliza la variante L existente', async () => {
    const beforeM = (await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.id === drillA.id).stockAvailable;
    const first = await message('size-repeat-source', 'Ingresaron dos Taladro Makita');
    assert.equal(first.batchStatus, 'awaiting_choice');
    const selected = await message('size-repeat-answer', '1 en talle L');
    assert.equal(selected.batchStatus, 'applied');
    const products = (await db.getStateSnapshotStrict(owner)).products;
    assert.equal(products.find((entry) => entry.id === drillA.id).stockAvailable, beforeM);
    assert.equal(products.find((entry) => entry.name === 'Taladro Makita' && entry.size === 'L').stockAvailable, 4);
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
    const answer = 'La otra mención era una referencia, no otra unidad.';
    draftPatchOverride = (input) => ({ kind: 'confirm', questionId: input.questions[0].id, evidence: answer });
    const corrected = await message('audit-corrected', answer); assert.equal(corrected.batchStatus, 'awaiting_choice');
    await message('audit-select', '2');
    const saved = await db.getVoiceStockBatchByMessage(owner, 'audit-hold');
    assert.equal(saved.sourceText, original); assert.equal(saved.payload.draftPatches[0].messageId, 'audit-corrected');
    assert.equal(saved.status, 'applied');
    draftPatchOverride = null;
  });
  await check('respuesta breve a una duda conserva toda la lista y aplica una sola vez', async () => {
    const source = 'Ingresó Aceite Aurora y Arroz Norte. El anterior es importado.';
    extractionOverride = ['Aceite Aurora', 'Arroz Norte'].map((name) => ({ type: 'add_stock', productName: name, qty: 1, evidence: name, fieldEvidence: {} }));
    auditComplete = false;
    const held = await message('brief-source', source);
    assert.equal(held.batchStatus, 'awaiting_correction'); assert.match(held.replyText, /¿“El anterior/);
    assert.doesNotMatch(held.replyText, /lista completa|evidencia|caracteres/);
    auditComplete = true; useSavedContext = true; resolutionKind = 'new';
    const answer = 'Es una referencia al primero, no es otra unidad.';
    draftPatchOverride = (input) => ({ kind: 'confirm', questionId: input.questions[0].id, evidence: answer });
    const extractCount = modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length;
    const answered = await message('brief-answer', answer); assert.equal(answered.batchStatus, 'applied');
    const saved = await db.getVoiceStockBatchByMessage(owner, 'brief-source');
    assert.equal(saved.sourceText, source); assert.equal(saved.payload.evidenceSourceText, `${source}\n${answer}`);
    assert.equal(saved.payload.actions.length, 2);
    const patchInput = modelInputs.findLast((entry) => entry.stage.includes('Etapa: draft_patch.')).input;
    assert.equal(patchInput.sourceText, answer);
    assert.equal(modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length, extractCount);
    const beforeReplay = calls; await message('brief-answer', answer); assert.equal(calls, beforeReplay);
    const products = (await db.getStateSnapshotStrict(owner)).products;
    for (const name of ['Aceite Aurora', 'Arroz Norte']) assert.equal(products.find((product) => product.name === name).stockAvailable, 1);
    extractionOverride = null; useSavedContext = false; resolutionKind = 'ambiguous'; draftPatchOverride = null;
  });
  await check('respuesta parcial no sustituye el lote pendiente ni aplica stock', async () => {
    const source = 'Ingresó Aceite Aurora. Ingresó Arroz Norte. Ingresó Sal Sol. Ingresó Azúcar Luna.';
    extractionOverride = ['Aceite Aurora', 'Arroz Norte', 'Sal Sol', 'Azúcar Luna']
      .map((name) => ({ type: 'add_stock', productName: name, qty: 1, evidence: name, fieldEvidence: {} }));
    auditComplete = false;
    const held = await message('partial-source', source);
    assert.equal(held.batchStatus, 'awaiting_correction');
    const before = await db.getStateSnapshotStrict(owner);
    extractionOverride = extractionOverride.slice(0, 2);
    auditComplete = true;
    const partial = await message('partial-answer', 'Aceite Aurora y Arroz Norte sí; cargá el resto.');
    assert.equal(partial.batchStatus, 'awaiting_correction');
    assert.equal(partial.actions.length, 4);
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
    assert.equal((await db.getVoiceStockBatchByMessage(owner, 'partial-source')).payload.evidenceSourceText, source);
    await message('partial-cancel', 'cancelar');
    extractionOverride = null;
  });
  await check('fallo del proveedor durante una aclaración conserva ítems y reintenta esa respuesta', async () => {
    const source = 'Ingresó Bota Nube. Ingresó Casco Sol.';
    const answer = 'La primera era una corrección, no otra unidad.';
    extractionOverride = ['Bota Nube', 'Casco Sol']
      .map((name) => ({ type: 'add_stock', productName: name, qty: 1, evidence: name, fieldEvidence: {} }));
    auditComplete = false;
    const held = await message('provider-source', source);
    assert.equal(held.batchStatus, 'awaiting_correction');
    const before = await db.getStateSnapshotStrict(owner);
    failDraftPatch = true;
    draftPatchOverride = (input) => ({ kind: 'confirm', questionId: input.questions[0].id, evidence: answer });
    const extractCount = modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length;
    const failed = await message('provider-answer', answer);
    assert.equal(failed.batchStatus, 'awaiting_correction');
    assert.equal(failed.actions.length, 2);
    const saved = await db.getVoiceStockBatchByMessage(owner, 'provider-source');
    assert.equal(saved.payload.evidenceSourceText, source);
    assert.equal(saved.payload.pendingCorrectionText, answer);
    assert.equal(saved.payload.clarificationsNeeded.length, 1);
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
    failDraftPatch = false; auditComplete = true; resolutionKind = 'new';
    const retried = await message('provider-retry', 'reintentar');
    assert.equal(retried.batchStatus, 'applied');
    const lastPatch = modelInputs.findLast((entry) => entry.stage.includes('Etapa: draft_patch.')).input;
    assert.equal(lastPatch.sourceText, answer);
    assert.equal(modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length, extractCount);
    extractionOverride = null; resolutionKind = 'ambiguous'; draftPatchOverride = null;
  });
  await check('parche de cantidad/medida persiste con IDs y retry de catálogo no repite IA ni auditoría', async () => {
    const names = ['Caja Delta', 'Botella Lima', 'Tornillo Cobre'];
    const source = names.map((name) => `Ingresó ${name}.`).join(' ');
    extractionOverride = names.map((name) => ({ type: 'add_stock', productName: name, qty: 1, evidence: name, fieldEvidence: {} }));
    auditComplete = false;
    await message('patch-fields-source', source);
    const original = await db.getVoiceStockBatchByMessage(owner, 'patch-fields-source');
    assert.equal(original.payload.pendingDraftQuestions.length, 1);
    await db.finishMetaReply('patch-fields-source', null, 'wamid.patch-fields-question');
    const before = await db.getStateSnapshotStrict(owner);
    const answer = 'Son tres del último, medida 5 cm.';
    draftPatchOverride = (input) => ({ kind: 'patch', questionId: input.questions[0].id, changes: [{
      type: 'set_fields', itemId: input.actions.at(-1).itemId, fields: { qty: 3, size: '5 cm' },
      evidence: { qty: 'Son tres', size: 'medida 5 cm' },
    }] });
    try {
      auditComplete = true; failResolve = true; resolutionKind = 'new';
      const held = await message('patch-fields-answer', answer, 'wamid.patch-fields-question');
      assert.equal(held.batchStatus, 'awaiting_correction');
      const saved = await db.getVoiceStockBatchByMessage(owner, 'patch-fields-source');
      assert.deepEqual(saved.payload.actions.map((item) => item.itemId), original.payload.actions.map((item) => item.itemId));
      assert.deepEqual(saved.payload.actions.slice(0, 2), original.payload.actions.slice(0, 2));
      assert.equal(saved.payload.actions[2].qty, 3); assert.equal(saved.payload.actions[2].size, '5 cm');
      assert.equal(saved.payload.pendingDraftPatch.auditVerified, true);
      assert.equal(saved.payload.draftPatches.length, 1); assert.equal(saved.sourceText, source);
      assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
      const stageCounts = () => Object.fromEntries(['extract', 'draft_patch', 'audit'].map((stage) =>
        [stage, modelInputs.filter((entry) => entry.stage.includes(`Etapa: ${stage}.`)).length]));
      const counts = stageCounts();
      failResolve = false; failDraftPatch = true; failExtract = true;
      assert.equal((await message('patch-fields-retry', 'reintentar')).batchStatus, 'applied');
      assert.deepEqual(stageCounts(), counts);
      const state = await db.getStateSnapshotStrict(owner);
      assert.equal(state.products.find((product) => product.name === names[0]).stockAvailable, 1);
      assert.equal(state.products.find((product) => product.name === names[1]).stockAvailable, 1);
      const changed = state.products.find((product) => product.name === names[2]);
      assert.equal(changed.stockAvailable, 3); assert.equal(changed.size, '5 cm');
      const applied = await db.getVoiceStockBatchByMessage(owner, 'patch-fields-source');
      assert.equal(applied.payload.pendingDraftPatch, null);
      assert.deepEqual(applied.payload.actions.map((item) => item.itemId), original.payload.actions.map((item) => item.itemId));
    } finally { extractionOverride = null; draftPatchOverride = null; failResolve = false; failDraftPatch = false; failExtract = false; resolutionKind = 'ambiguous'; auditComplete = true; }
  });
  await check('recuperación tras guardar un parche continúa auditoría sin reinterpretar el mensaje', async () => {
    const item = { ...action('Parche recuperado tras interrupción'), itemId: 'persistent-custom-id' };
    const source = 'Ingresaron dos Parche recuperado tras interrupción';
    const batch = await createBatch([item], { status: 'awaiting_correction', sourceText: source, replyText: 'Pregunta anterior', payload: {
      engineVersion: 'stock-batch-v5', actions: [{ ...item, resolution: undefined }], initialActions: [item], coverageVerified: false,
      evidenceSourceText: source, pendingDraftPatch: { messageId: 'patch-resume-answer', auditVerified: false },
      handledMessages: [{ messageId: 'patch-resume-answer', replyText: null }], replyMessageId: 'patch-resume-answer',
    } });
    const beforeExtract = modelInputs.filter(({ stage }) => /Etapa: (extract|draft_patch)\./.test(stage)).length;
    resolutionKind = 'new';
    try {
      assert.equal((await message('patch-resume-answer', 'Este texto no debe reinterpretarse')).batchStatus, 'applied');
      assert.equal(modelInputs.filter(({ stage }) => /Etapa: (extract|draft_patch)\./.test(stage)).length, beforeExtract);
      const saved = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
      assert.equal(saved.payload.actions[0].itemId, 'persistent-custom-id');
      assert.equal((await db.getStateSnapshotStrict(owner)).products.find((product) => product.name === item.productName).stockAvailable, 2);
    } finally { resolutionKind = 'ambiguous'; }
  });
  await check('quitar un ítem explícito no elimina ni renumera los demás', async () => {
    const names = ['Abrazadera Cedro', 'Tuerca Sauce'];
    extractionOverride = names.map((name) => ({ type: 'add_stock', productName: name, qty: 1, evidence: name, fieldEvidence: {} }));
    auditComplete = false;
    await message('patch-remove-source', 'Ingresó Abrazadera Cedro. Ingresó Tuerca Sauce.');
    const original = await db.getVoiceStockBatchByMessage(owner, 'patch-remove-source');
    const answer = 'El segundo no ingresó, sacalo del lote.';
    draftPatchOverride = (input) => ({ kind: 'patch', questionId: input.questions[0].id,
      changes: [{ type: 'remove_item', itemId: input.actions[1].itemId, evidence: answer }] });
    try {
      auditComplete = true; resolutionKind = 'new';
      assert.equal((await message('patch-remove-answer', answer)).batchStatus, 'applied');
      const applied = await db.getVoiceStockBatchByMessage(owner, 'patch-remove-source');
      assert.deepEqual(applied.payload.actions.map((item) => item.itemId), [original.payload.actions[0].itemId]);
      assert.equal(applied.payload.initialActions.length, 2);
      const products = (await db.getStateSnapshotStrict(owner)).products;
      assert.equal(products.find((product) => product.name === names[0]).stockAvailable, 1);
      assert.equal(products.some((product) => product.name === names[1]), false);
    } finally { extractionOverride = null; draftPatchOverride = null; resolutionKind = 'ambiguous'; auditComplete = true; }
  });
  await check('lista completa reemplazada no hereda auditoría ni parche de la lista anterior', async () => {
    extractionOverride = [{ type: 'add_stock', productName: 'Borrador Magnolia', qty: 1, evidence: 'Borrador Magnolia', fieldEvidence: {} }];
    auditComplete = false;
    await message('patch-replace-source', 'Ingresó Borrador Magnolia.');
    const answer = 'La mención era correcta.';
    draftPatchOverride = (input) => ({ kind: 'confirm', questionId: input.questions[0].id, evidence: answer });
    try {
      auditComplete = true; failResolve = true;
      await message('patch-replace-answer', answer);
      let saved = await db.getVoiceStockBatchByMessage(owner, 'patch-replace-source');
      assert.equal(saved.payload.pendingDraftPatch.auditVerified, true);
      assert.ok(saved.payload.pendingDraftPatch.auditFingerprint);
      extractionOverride = [{ type: 'add_stock', productName: 'Reemplazo sin verificar', qty: 1, evidence: 'Reemplazo sin verificar', fieldEvidence: {} }];
      auditComplete = false; failResolve = false;
      const replaced = await message('patch-replace-list', 'Lista completa corregida: ingresó Reemplazo sin verificar.');
      assert.equal(replaced.batchStatus, 'awaiting_correction');
      saved = await db.getVoiceStockBatchByMessage(owner, 'patch-replace-source');
      assert.equal(saved.payload.pendingDraftPatch, null);
      assert.equal(saved.payload.pendingDraftAnswer, null);
      draftPatchOverride = null;
      const retried = await message('patch-replace-retry', 'reintentar');
      assert.equal(retried.batchStatus, 'awaiting_correction');
      assert.equal((await db.getStateSnapshotStrict(owner)).products.some((product) => ['Reemplazo sin verificar', 'Borrador Magnolia'].includes(product.name)), false);
    } finally { extractionOverride = null; draftPatchOverride = null; failResolve = false; auditComplete = true; await message('patch-replace-cancel', 'cancelar'); }
  });
  await check('marca de auditoría no se reutiliza si cambia el contenido persistido', async () => {
    extractionOverride = [{ type: 'add_stock', productName: 'Contenido Auditado', qty: 1, evidence: 'Contenido Auditado', fieldEvidence: {} }];
    auditComplete = false;
    await message('patch-hash-source', 'Ingresó Contenido Auditado.');
    const answer = 'La mención era correcta.';
    draftPatchOverride = (input) => ({ kind: 'confirm', questionId: input.questions[0].id, evidence: answer });
    try {
      auditComplete = true; failResolve = true;
      await message('patch-hash-answer', answer);
      const saved = await db.getVoiceStockBatchByMessage(owner, 'patch-hash-source');
      assert.equal(saved.payload.pendingDraftPatch.auditVerified, true);
      await db.updateVoiceStockBatch(saved.id, { expectedVersion: saved.version,
        payload: { ...saved.payload, evidenceSourceText: `${saved.payload.evidenceSourceText}\n¿Falta otro producto?` } });
      const audits = modelInputs.filter(({ stage }) => stage.includes('Etapa: audit.')).length;
      auditComplete = false; failResolve = false;
      assert.equal((await message('patch-hash-retry', 'reintentar')).batchStatus, 'awaiting_correction');
      assert.equal(modelInputs.filter(({ stage }) => stage.includes('Etapa: audit.')).length, audits + 1);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.some((product) => product.name === 'Contenido Auditado'), false);
    } finally { extractionOverride = null; draftPatchOverride = null; auditComplete = true; failResolve = false; await message('patch-hash-cancel', 'cancelar'); }
  });
  await check('reemplazo reordenado conserva IDs inequívocos y da ID nuevo a otro producto sin aceptar preguntas anteriores', async () => {
    const names = ['Convertidor de 12 V a 24 V', 'Convertidor de 24 V a 12 V', 'Caja Sauce'];
    const source = names.map((name) => `Ingresó ${name}.`).join(' ');
    const extracted = (name, qty = 1) => ({ type: 'add_stock', productName: name, qty, evidence: name,
      fieldEvidence: qty === 1 ? {} : { qty: 'tres' } });
    extractionOverride = names.map((name) => extracted(name)); auditComplete = false;
    await message('replacement-ids-source', source);
    const initial = await db.getVoiceStockBatchByMessage(owner, 'replacement-ids-source');
    const oldIds = new Map(initial.payload.actions.map((item) => [item.productName, item.itemId]));
    await db.finishMetaReply('replacement-ids-source', null, 'wamid.replacement-old-question');
    extractionOverride = [extracted(names[1], 3), extracted('Frasco Olivo'), extracted(names[2]), extracted(names[0])];
    const full = `Lista completa corregida: ingresaron tres ${names[1]}. Ingresó Frasco Olivo. Ingresó ${names[2]}. Ingresó ${names[0]}.`;
    try {
      assert.equal((await message('replacement-ids-list', full)).batchStatus, 'awaiting_correction');
      const replaced = await db.getVoiceStockBatchByMessage(owner, 'replacement-ids-source');
      for (const item of replaced.payload.actions.filter((item) => oldIds.has(item.productName))) assert.equal(item.itemId, oldIds.get(item.productName));
      assert.equal([...oldIds.values()].includes(replaced.payload.actions.find((item) => item.productName === 'Frasco Olivo').itemId), false);
      const beforeCalls = calls;
      assert.equal((await message('replacement-ids-late', '1', 'wamid.replacement-old-question')).batchStatus, 'awaiting_correction');
      assert.equal(calls, beforeCalls);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.some((product) => names.includes(product.name) || product.name === 'Frasco Olivo'), false);
      const answer = 'Confirmo que es la lista corregida.';
      draftPatchOverride = (input) => ({ kind: 'confirm', questionId: input.questions[0].id, evidence: answer });
      auditComplete = true; resolutionKind = 'new';
      assert.equal((await message('replacement-ids-confirm', answer)).batchStatus, 'applied');
      const products = (await db.getStateSnapshotStrict(owner)).products;
      assert.equal(products.find((product) => product.name === names[0]).stockAvailable, 1);
      assert.equal(products.find((product) => product.name === names[1]).stockAvailable, 3);
      assert.equal(products.find((product) => product.name === names[2]).stockAvailable, 1);
      assert.equal(products.find((product) => product.name === 'Frasco Olivo').stockAvailable, 1);
      const final = await db.getVoiceStockBatchByMessage(owner, 'replacement-ids-source');
      assert.deepEqual(final.payload.actions.map((item) => item.itemId), replaced.payload.actions.map((item) => item.itemId));
    } finally { extractionOverride = null; draftPatchOverride = null; auditComplete = true; resolutionKind = 'ambiguous'; }
  });
  await check('decisiones de referencia anteriores no suprimen una nueva duda después de editar identidad', async () => {
    const reference = 'El anterior es otra unidad.';
    const source = `Ingresó Arandela Olmo. ${reference}`;
    const item = { type: 'add_stock', itemId: 'reference-item-stable', productName: 'Arandela Olmo', qty: 1,
      evidence: 'Arandela Olmo', fieldEvidence: {}, resolvedReferences: [reference], repeatClarification: { kind: 'distinct', text: reference } };
    const question = `¿“${reference}” corrige el producto anterior o indica otra unidad?`;
    const batch = await createBatch([item], { status: 'awaiting_correction', sourceText: source, payload: {
      engineVersion: 'stock-batch-v5', actions: [item], initialActions: [item], evidenceSourceText: source, coverageVerified: false,
      clarificationsNeeded: [{ kind: 'clarification', evidence: reference, question }],
    } });
    const answer = 'El nombre correcto es Arandela Olmo 2.';
    draftPatchOverride = (input) => ({ kind: 'patch', questionId: input.questions[0].id, changes: [{
      type: 'set_fields', itemId: item.itemId, fields: { productName: 'Arandela Olmo 2' }, evidence: { productName: answer },
    }] });
    auditOverride = (input) => ({ coverageComplete: false, verifiedItemIds: input.actions.map((action) => action.itemId),
      issues: [{ kind: 'clarification', detail: 'Referencia todavía ambigua', question,
        evidenceSpanId: input.sourceSpans.find((span) => span.text === reference).id }] });
    try {
      assert.equal((await message('patch-stale-reference-answer', answer)).batchStatus, 'awaiting_correction');
      const saved = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
      assert.equal(saved.payload.actions[0].resolvedReferences, undefined);
      assert.equal(saved.payload.actions[0].repeatClarification, undefined);
      assert.equal(saved.payload.coverageVerified, false);
      assert.equal(saved.payload.clarificationsNeeded.length, 1);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.some((product) => product.name === 'Arandela Olmo 2'), false);
    } finally { draftPatchOverride = null; auditOverride = null; await message('patch-stale-reference-cancel', 'cancelar'); }
  });
  await check('borrar un candidato no cambia el significado de los números ofrecidos', async () => {
    const beforeDelete = await message('deleted-source', 'Ingresaron dos Taladro Makita');
    const offeredIds = beforeDelete.actions[0].resolution.candidateIds;
    const deletedChoice = offeredIds.indexOf(drillA.id) + 1;
    assert.ok(deletedChoice > 0);
    await db.deleteProductRecord(drillA.id, owner);
    const afterDeletion = await message('deleted-answer', String(deletedChoice)); assert.equal(afterDeletion.batchStatus, 'awaiting_choice');
    const saved = await db.getVoiceStockBatchByMessage(owner, 'deleted-source');
    assert.deepEqual(saved.payload.actions[0].resolution.candidateIds, offeredIds);
    await message('deleted-cancel', 'cancelar');
    drillA = await db.createProductRecord({ name: 'Taladro Makita', size: '10 mm', stockAvailable: 0 }, owner);
  });
  await check('nuevo indistinguible pide diferencia y usa la aclaración literal', async () => {
    await message('new-source', 'Ingresaron dos Taladro Makita');
    const collision = await message('new-answer', 'nuevo'); assert.equal(collision.batchStatus, 'awaiting_choice'); assert.match(collision.replyText, /qué cambia/);
    const named = await message('new-name', 'nombre: Taladro Makita edición naranja'); assert.equal(named.batchStatus, 'applied');
    const product = (await db.getStateSnapshotStrict(owner)).products.find((entry) => entry.name === 'Taladro Makita edición naranja');
    assert.equal(product.stockAvailable, 2);
  });
  await check('elección con medida inválida y nombre indistinguible conservan la pregunta para responder después', async () => {
    for (const [index, answer] of ['99 en talle L', 'nombre: Taladro Makita'].entries()) {
      const sourceId = `invalid-choice-hold-${index}`;
      await message(sourceId, 'Ingresaron dos Taladro Makita');
      const original = await db.getVoiceStockBatchByMessage(owner, sourceId);
      const held = await message(`${sourceId}-invalid`, answer);
      assert.equal(held.batchStatus, 'awaiting_choice');
      const saved = await db.getVoiceStockBatchByMessage(owner, sourceId);
      assert.equal(saved.payload.actions[0].resolution.kind, 'ambiguous');
      assert.deepEqual(saved.payload.actions[0].resolution.candidateIds, original.payload.actions[0].resolution.candidateIds);
      assert.equal(saved.payload.actions[0].size, original.payload.actions[0].size);
      assert.equal((await message(`${sourceId}-valid`, '1')).batchStatus, 'applied');
    }
  });
  await check('elección semántica en lenguaje natural usa únicamente un candidato ofrecido', async () => {
    await message('natural-source', 'Ingresaron dos Taladro Makita');
    const answer = 'Es el de trece milímetros que ya tengo.';
    semanticClarification = { kind: 'existing', productId: drillB.id, evidence: answer };
    const selected = await message('natural-answer', answer); assert.equal(selected.batchStatus, 'applied');
    semanticClarification = null;
  });
  await check('fallo de aclaración conserva pregunta/respuesta y reintento aplica una sola vez sin extraer de nuevo', async () => {
    const source = 'Ingresaron dos Taladro Makita';
    const answer = 'El que tiene trece milímetros, ya lo tengo.';
    const before = (await db.getStateSnapshotStrict(owner)).products.find((product) => product.id === drillB.id).stockAvailable;
    await message('choice-fail-source', source);
    const original = await db.getVoiceStockBatchByMessage(owner, 'choice-fail-source');
    assert.ok(original.payload.pendingQuestion.id);
    const extractCount = modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length;
    try {
      failClarify = true;
      const held = await message('choice-fail-answer', answer);
      assert.equal(held.batchStatus, 'awaiting_choice');
      assert.match(held.replyText, /Conservé tu respuesta/);
      const saved = await db.getVoiceStockBatchByMessage(owner, 'choice-fail-source');
      assert.equal(saved.sourceText, source);
      assert.deepEqual(saved.payload.actions, original.payload.actions);
      assert.deepEqual(saved.payload.pendingQuestion, original.payload.pendingQuestion);
      assert.deepEqual(saved.payload.pendingChoiceReply, { questionId: original.payload.pendingQuestion.id,
        itemId: original.payload.actions[0].itemId, messageId: 'choice-fail-answer', text: answer });
      assert.equal(saved.payload.interpreterError.kind, 'unavailable');
      const afterFailureCalls = calls;
      assert.equal((await message('choice-fail-answer', answer)).replyText, held.replyText);
      assert.equal(calls, afterFailureCalls);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.find((product) => product.id === drillB.id).stockAvailable, before);
      failClarify = false;
      semanticClarification = { kind: 'existing', productId: drillB.id, evidence: answer };
      const result = await message('choice-fail-retry', 'reintentar');
      assert.equal(result.batchStatus, 'applied');
      assert.equal(modelInputs.at(-1).input.sourceText, answer);
      assert.equal(modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length, extractCount);
      const applied = await db.getVoiceStockBatchByMessage(owner, 'choice-fail-source');
      assert.equal(applied.payload.pendingChoiceReply, null);
      assert.equal(applied.payload.clarifications.at(-1).answerMessageId, 'choice-fail-answer');
      assert.equal(applied.payload.clarifications.at(-1).questionId, original.payload.pendingQuestion.id);
      await message('choice-fail-retry', 'reintentar');
      assert.equal((await db.getStateSnapshotStrict(owner)).products.find((product) => product.id === drillB.id).stockAvailable, before + 2);
      assert.equal((await sql.query('SELECT item_id FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2', [owner, applied.id])).rowCount, 1);
    } finally { failClarify = false; semanticClarification = null; }
  });
  await check('respuesta inválida se retiene sin aceptar IDs inventados ni reutilizar una pregunta vencida', async () => {
    const answer = 'Usá el de trece milímetros.';
    await message('choice-invalid-source', 'Ingresaron dos Taladro Makita');
    try {
      semanticClarification = { kind: 'existing', productId: 'invented-candidate', evidence: answer };
      const held = await message('choice-invalid-answer', answer);
      assert.equal(held.batchStatus, 'awaiting_choice');
      let saved = await db.getVoiceStockBatchByMessage(owner, 'choice-invalid-source');
      assert.equal(saved.payload.interpreterError.kind, 'invalid');
      const oldQuestionId = saved.payload.pendingQuestion.id;
      semanticClarification = null;
      const unrelated = await message('choice-unrelated-answer', '¿A qué hora abre el local?');
      assert.equal(unrelated.batchStatus, 'awaiting_choice');
      saved = await db.getVoiceStockBatchByMessage(owner, 'choice-invalid-source');
      assert.equal(saved.payload.pendingChoiceReply.text, answer);
      await db.updateVoiceStockBatch(saved.id, { expectedVersion: saved.version, payload: {
        ...saved.payload, pendingQuestion: { ...saved.payload.pendingQuestion, id: 'question-replaced' },
      } });
      const beforeCalls = calls;
      const stale = await message('choice-invalid-retry', 'reintentar');
      assert.equal(stale.batchStatus, 'awaiting_choice');
      assert.match(stale.replyText, /pregunta pendiente cambió/);
      assert.equal(calls, beforeCalls);
      assert.notEqual(oldQuestionId, 'question-replaced');
    } finally { semanticClarification = null; await message('choice-invalid-cancel', 'cancelar'); }
  });
  await check('fallo al resolver una corrección conserva el parche y reintenta sin reconstruir la lista', async () => {
    await message('choice-correction-fail-source', 'Ingresaron dos Taladro Makita');
    const initial = await db.getVoiceStockBatchByMessage(owner, 'choice-correction-fail-source');
    const answer = 'En realidad son tres, medida 17 mm.';
    try {
      semanticClarification = { kind: 'correction', evidence: answer, correctedAction: { type: 'add_stock',
        productName: 'Taladro Makita', size: '17 mm', qty: 3,
        fieldEvidence: { qty: 'son tres', attributes: ['medida 17 mm'] } } };
      resolutionKind = 'new'; failResolve = true;
      assert.equal((await message('choice-correction-fail-answer', answer)).batchStatus, 'awaiting_choice');
      const held = await db.getVoiceStockBatchByMessage(owner, 'choice-correction-fail-source');
      assert.deepEqual(held.payload.actions, initial.payload.actions);
      assert.equal(held.payload.interpreterError.kind, 'unavailable');
      assert.equal(held.payload.pendingChoiceReply.text, answer);
      const extractCount = modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length;
      failResolve = false;
      assert.equal((await message('choice-correction-fail-retry', 'reintentar')).batchStatus, 'applied');
      assert.equal(modelInputs.filter(({ stage }) => stage.includes('Etapa: extract.')).length, extractCount);
      const applied = await db.getVoiceStockBatchByMessage(owner, 'choice-correction-fail-source');
      assert.equal(applied.payload.actions[0].itemId, initial.payload.actions[0].itemId);
      assert.equal(applied.payload.pendingChoiceReply, null);
      assert.equal((await db.getStateSnapshotStrict(owner)).products.find((product) => product.name === 'Taladro Makita' && product.size === '17 mm').stockAvailable, 3);
    } finally { semanticClarification = null; resolutionKind = 'ambiguous'; failResolve = false; }
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
  await check('respuesta citada se vincula a pregunta/negocio/remitente y nunca contesta otra pregunta', async () => {
    const first = await message('quoted-first-source', 'Ingresaron dos Taladro Makita');
    const original = await db.getVoiceStockBatchByMessage(owner, 'quoted-first-source');
    const questionId = original.payload.pendingQuestion.id;
    const queued = (await sql.query('SELECT stock_batch_id,question_id FROM meta_reply_outbox WHERE event_id=$1', ['quoted-first-source'])).rows[0];
    assert.deepEqual(queued, { stock_batch_id: first.batchId, question_id: questionId });
    // All IDs returned by retransmissions remain bound to the original question.
    await db.finishMetaReply('quoted-first-source', null, 'wamid.question-first');
    await db.finishMetaReply('quoted-first-source', null, 'wamid.question-first-retry');
    await db.finishMetaReply('quoted-first-source', null, 'wamid.question-first');
    assert.equal((await sql.query('SELECT jsonb_array_length(provider_message_ids) AS count FROM meta_reply_outbox WHERE event_id=$1', ['quoted-first-source'])).rows[0].count, 2);
    assert.deepEqual(await db.getMetaReplyQuestion('wamid.question-first', owner, owner), { batchId: first.batchId, questionId });
    assert.equal(await db.getMetaReplyQuestion('wamid.question-first', other, owner), null);
    assert.equal(await db.getMetaReplyQuestion('wamid.question-first', owner, other), null);
    const beforeCalls = calls;
    assert.equal((await message('quoted-first-answer', '1', 'wamid.question-first-retry')).batchStatus, 'applied');
    assert.equal(calls, beforeCalls);
    await message('quoted-second-source', 'Ingresaron dos Taladro Makita');
    const second = await db.getVoiceStockBatchByMessage(owner, 'quoted-second-source');
    assert.notEqual(second.payload.pendingQuestion.id, questionId);
    const before = await db.getStateSnapshotStrict(owner);
    const late = await message('quoted-late-answer', '1', 'wamid.question-first');
    assert.equal(late.batchStatus, 'awaiting_choice');
    assert.match(late.replyText, /no corresponde/);
    const held = await db.getVoiceStockBatchByMessage(owner, 'quoted-second-source');
    assert.deepEqual(held.payload.actions, second.payload.actions);
    assert.equal(held.payload.pendingQuestion.id, second.payload.pendingQuestion.id);
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
    assert.equal((await message('quoted-unknown-answer', 'cancelar', 'wamid.unknown')).batchStatus, 'awaiting_choice');
    await message('quoted-second-cancel', 'cancelar');
    const closed = await message('quoted-closed-answer', '1', 'wamid.question-first');
    assert.equal(closed.batchStatus, 'ignored_reply');
    assert.deepEqual(closed.actions, []);
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
  });
  await check('webhook conserva context.id y envío devuelve wamid sin repetir un envío aceptado', async () => {
    const quotedId = 'wamid.transport-reply';
    let received;
    const results = await processMetaWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [
      { id: 'transport-quoted-inbound', from: owner, type: 'text', text: { body: '1' }, context: { id: quotedId } },
    ] } }] }] }, { processStockText: async ({ metaMessage }) => {
      received = metaMessage.replyToMessageId;
      return { actions: [], replyText: 'Pregunta vinculada', batchStatus: 'awaiting_choice' };
    } });
    assert.equal(received, quotedId);
    assert.equal(results[0].replyToMessageId, quotedId);
    const previous = { META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN, META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID };
    const modelFetch = globalThis.fetch;
    try {
      process.env.META_ACCESS_TOKEN = 'test-not-real'; process.env.META_PHONE_NUMBER_ID = 'test-phone';
      let sends = 0;
      globalThis.fetch = async () => { sends++; return new Response(JSON.stringify({ messages: [{ id: quotedId }] }), { status: 200 }); };
      assert.equal((await sendMetaReply({ to: owner, text: 'Pregunta' })).messageId, quotedId);
      assert.equal(sends, 1);
      globalThis.fetch = async () => { sends++; return new Response('missing receipt', { status: 200 }); };
      const accepted = await sendMetaReply({ to: owner, text: 'Pregunta' });
      assert.equal(accepted.sent, true); assert.equal(accepted.messageId, null); assert.equal(sends, 2);
    } finally {
      globalThis.fetch = modelFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  await check('dos preguntas del mismo lote tienen IDs distintos y un reply tardío no elige el siguiente ítem', async () => {
    const catalog = await db.getStateSnapshotStrict(owner);
    const candidates = catalog.products.filter((product) => [drillA.id, drillB.id].includes(product.id))
      .map((product) => ({ ...product, fingerprint: productFingerprint(product) }));
    const makeItem = (itemId) => ({ ...action('Taladro Makita', { kind: 'ambiguous', candidateIds: [drillA.id, drillB.id] }), itemId, candidates });
    const batch = await createBatch([makeItem('stable-first'), makeItem('stable-second')], { payload: {
      engineVersion: 'stock-batch-v5', actions: [makeItem('stable-first'), makeItem('stable-second')],
      coverageVerified: true, evidenceSourceText: 'Ingresaron dos Taladro Makita y dos Taladro Makita',
    } });
    await message(batch.sourceMessageId, batch.sourceText);
    let saved = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
    const firstQuestion = saved.payload.pendingQuestion.id;
    const firstQuestionSnapshot = saved.payload.pendingQuestion;
    await db.finishMetaReply(batch.sourceMessageId, null, 'wamid.same-batch-first');
    assert.equal((await message('same-batch-first-answer', '1', 'wamid.same-batch-first')).batchStatus, 'awaiting_choice');
    saved = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
    assert.notEqual(saved.payload.pendingQuestion.id, firstQuestion);
    assert.equal(saved.payload.pendingQuestion.itemId, 'stable-second');
    await db.finishMetaReply('same-batch-first-answer', null, 'wamid.same-batch-second');
    // Reproduce an interrupted transition from a previous build: actions advanced,
    // but the persisted question still points to item 1. The gate must repair it.
    await db.updateVoiceStockBatch(saved.id, { expectedVersion: saved.version,
      payload: { ...saved.payload, pendingQuestion: firstQuestionSnapshot } });
    const before = await db.getStateSnapshotStrict(owner);
    const callsBefore = calls;
    assert.equal((await message('same-batch-late-answer', '2', 'wamid.same-batch-first')).batchStatus, 'awaiting_choice');
    assert.equal(calls, callsBefore);
    assert.deepEqual((await db.getStateSnapshotStrict(owner)).products, before.products);
    const repaired = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
    assert.notEqual(repaired.payload.pendingQuestion.id, firstQuestion);
    assert.equal(repaired.payload.pendingQuestion.itemId, 'stable-second');
    await db.finishMetaReply('same-batch-late-answer', null, 'wamid.same-batch-repaired');
    assert.equal((await message('same-batch-second-answer', '1', 'wamid.same-batch-repaired')).batchStatus, 'applied');
    const applied = await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId);
    assert.deepEqual(applied.payload.actions.map((item) => item.itemId), ['stable-first', 'stable-second']);
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((product) => product.id === drillA.id).stockAvailable,
      before.products.find((product) => product.id === drillA.id).stockAvailable + 4);
  });
  await check('cancelación citada de otro lote no cancela una decisión ready recuperable', async () => {
    const batch = await createBatch([action('Recuperación antes de respuesta tardía')]);
    const result = await message('ready-late-cancel', 'cancelar', 'wamid.question-first');
    assert.equal(result.batchStatus, 'ignored_reply');
    assert.equal((await db.getVoiceStockBatchByMessage(owner, batch.sourceMessageId)).status, 'applied');
    assert.equal((await db.getStateSnapshotStrict(owner)).products.find((product) => product.name === 'Recuperación antes de respuesta tardía').stockAvailable, 2);
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
    const base = {
      at: new Date().toISOString(), fromNumber: owner, sourceText: 'listado anterior', processed: true,
      parseContextJson: JSON.stringify({ intent: 'delete_product', missingFields: ['productMatch'] }),
    };
    await db.saveMetaEvent({ ...base, id: 'history-owner', ownerPhone: owner });
    await db.saveMetaEvent({ ...base, id: 'history-other', ownerPhone: other });
    const events = await db.getMetaEvents(20, owner, { senderPhone: owner });
    assert.ok(events.some((event) => event.id === 'history-owner'));
    assert.deepEqual(events.find((event) => event.id === 'history-owner').parseContext?.missingFields, ['productMatch']);
    assert.equal(events.some((event) => event.id === 'history-other'), false);
  });
  await check('borrado por variante faltante usa ID y valida el estado actual', async () => {
    const missing = await db.createProductRecord({ name: 'Prueba Variante Ausente', stockAvailable: 1 }, owner);
    const sized = await db.createProductRecord({ name: 'Prueba Variante Ausente', size: 'L', stockAvailable: 1 }, owner);
    const selection = { field: 'size', operator: 'missing' };
    await assert.rejects(
      db.applyActionsToDatabase([
        { type: 'delete_product', productName: missing.name, productId: missing.id, selection },
        { type: 'delete_product', productName: sized.name, productId: sized.id, selection },
      ], 'Borrado desactualizado', owner),
      /ya tiene talle o medida/,
    );
    assert.ok((await db.getStateSnapshotStrict(owner)).products.some((product) => product.id === missing.id));
    await db.applyActionsToDatabase([{ type: 'delete_product', productName: missing.name, productId: missing.id, selection }], 'Borrado sin variante', owner);
    const products = (await db.getStateSnapshotStrict(owner)).products;
    assert.equal(products.some((product) => product.id === missing.id), false);
    assert.equal(products.some((product) => product.id === sized.id), true);
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
