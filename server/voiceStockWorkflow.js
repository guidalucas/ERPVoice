import crypto from 'node:crypto';
import {
  createVoiceStockBatch, getActiveVoiceStockBatch, getVoiceStockBatchByMessage,
  updateVoiceStockBatch, applyResolvedVoiceStockBatch, getStateSnapshotStrict as getStateSnapshot, getVoiceStockBatchMode,
  saveVoiceStockShadowRun,
} from './postgresDatabase.js';
import { prepareStockDraft, normalizeIdentity, needsDistinctIdentity, productFingerprint, ENGINE_VERSION, interpretStockClarification, validateStockDraft, auditStockDraft, resolveStockDraft } from './voiceStockEngine.js';

const pendingItem = (batch) => batch.payload.actions?.find((action) => action.resolution?.kind === 'ambiguous');
export const stockChoiceReply = (action) => {
  const options = (action.resolution?.candidateIds ?? []).map((id, index) => {
    const product = action.candidates?.find((entry) => entry.id === id);
    return `${index + 1}. ${product?.name ?? 'Producto ya no disponible'}${product?.size ? ` — ${product.size}` : ''}`;
  });
  options.push(`${options.length + 1}. Cargar como producto nuevo`);
  if (action.needsDifferentiator) return `“${action.productName}” ya existe con esos mismos datos. Indicá qué cambia para crear otro producto (por ejemplo “nombre: …”), elegí una opción existente o escribí “cancelar”.\n${options.join('\n')}`;
  return `Dijiste “${action.evidence}” (${action.qty} u.${action.price != null ? `, $${action.price.toLocaleString('es-AR')} c/u` : ''}).\n${options.join('\n')}\nRespondé el número, el nombre, “nuevo” o “cancelar”.`;
};

const asResult = (batch, replyText = batch.replyText) => ({ replyText, actions: batch.payload.appliedActions ?? batch.payload.actions ?? [], batchId: batch.id, batchStatus: batch.status });
const concurrentResult = async (batch, ownerPhone) => {
  const latest = await getVoiceStockBatchByMessage(ownerPhone, batch.sourceMessageId);
  if (latest?.status === 'ready') return finish(latest, ownerPhone, latest.payload.replyMessageId ?? latest.sourceMessageId);
  return asResult(latest ?? batch, latest?.replyText ?? 'Ya estoy procesando otra respuesta para ese lote.');
};

const saveTransition = async (batch, messageId, payload, status, replyText = null) => updateVoiceStockBatch(batch.id, {
  expectedVersion: batch.version, status, replyText,
  payload: { ...payload, replyMessageId: messageId, handledMessages: [...(payload.handledMessages ?? []).filter((entry) => entry.messageId !== messageId), { messageId, replyText }] },
});

const finish = async (batch, ownerPhone, messageId) => {
  const pending = pendingItem(batch);
  if (pending) {
    const reply = stockChoiceReply(pending);
    const saved = await saveTransition(batch, messageId, batch.payload, 'awaiting_choice', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
  try {
    await applyResolvedVoiceStockBatch(batch.id, ownerPhone);
    return asResult(await getVoiceStockBatchByMessage(ownerPhone, batch.sourceMessageId));
  } catch (error) {
    if (/^(08|40|53|57)/.test(String(error.code ?? '')) || /timeout|connection|ECONN/i.test(error.message)) throw error;
    const latest = await getVoiceStockBatchByMessage(ownerPhone, batch.sourceMessageId);
    if (latest.status === 'applied') return asResult(latest);
    const reply = 'No pude aplicar el lote completo. Revisá los datos del inventario y reenviame la lista corregida. El lote conserva todos sus productos.';
    const saved = await saveTransition(latest, messageId, { ...latest.payload, applyError: error.message }, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
};

const prepare = async (input) => {
  const draft = await prepareStockDraft(input);
  if (draft.kind === 'other') return null;
  if (!draft.ok && !draft.kind && !/\b(ingres|recib|lleg|entr|carg|agreg|compr)/i.test(input.sourceText)) return null;
  return draft;
};

const draftPayload = (draft, messageId, previous = {}) => ({
  ...previous, actions: draft.actions ?? [], coverageVerified: Boolean(draft.ok && draft.coverageVerified),
  evidenceSourceText: draft.sourceText, engineVersion: ENGINE_VERSION,
  initialActions: previous.initialActions ?? draft.actions ?? [],
  traces: [...(previous.traces ?? []), ...(draft.traces ?? [draft.trace]).filter(Boolean)],
  issues: draft.issues ?? [], resolutionError: draft.ok ? null : draft.reason, replyMessageId: messageId,
  validationError: draft.ok ? null : { reason: draft.reason, itemIndex: draft.itemIndex, field: draft.field },
});

export const stockDraftFailureReply = (draft) => {
  if (draft.issues?.length) return `Guardé el ingreso como borrador y no apliqué cambios. Necesito aclarar lo siguiente:\n${draft.issues.join('\n')}\nEnviame la lista completa con esa aclaración, o escribí “cancelar”.`;
  return 'Guardé tu mensaje como borrador y no apliqué cambios. No pude verificar automáticamente la lista de productos. Podés escribir “reintentar” para procesar lo guardado sin repetir el mensaje ni el audio, o “cancelar”.';
};

export const processStockBatchMessage = async ({ sourceText, businessCategory, conversationTurns, ownerPhone, senderPhone, messageId }) => {
  const replay = await getVoiceStockBatchByMessage(ownerPhone, messageId);
  if (replay) {
    if (replay.status === 'ready') return finish(replay, ownerPhone, replay.payload.replyMessageId ?? messageId);
    const prior = replay.payload.handledMessages?.find((entry) => entry.messageId === messageId);
    if (!prior?.replyText && !replay.replyText && ['awaiting_choice', 'awaiting_correction'].includes(replay.status)) {
      if (pendingItem(replay)) return finish(replay, ownerPhone, messageId);
      const saved = await saveTransition(replay, messageId, replay.payload, 'awaiting_correction', 'Tu ingreso está guardado como borrador. Enviame la lista completa corregida o escribí “cancelar”.');
      return saved ? asResult(saved) : concurrentResult(replay, ownerPhone);
    }
    return asResult(replay, prior?.replyText ?? replay.replyText);
  }
  const active = await getActiveVoiceStockBatch(ownerPhone, senderPhone);
  const text = normalizeIdentity(sourceText);
  if (active && /^(cancelar|cancela|anular|dejalo|dejalo asi)$/.test(text)) {
    const reply = 'Listo, cancelé ese lote. No cambié el inventario.';
    const saved = await saveTransition(active, messageId, { ...active.payload, cancellation: { messageId, text: sourceText } }, 'cancelled', reply);
    return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
  }
  const catalog = await getStateSnapshot(ownerPhone);
  if (active?.status === 'awaiting_choice' && active.payload.engineVersion !== ENGINE_VERSION) {
    const reply = 'Conservé tu borrador anterior. Enviame la lista completa para verificarla con el nuevo flujo, o escribí “cancelar”.';
    const saved = await saveTransition(active, messageId, active.payload, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
  }
  if (active?.status === 'ready') {
    await finish(active, ownerPhone, active.payload.replyMessageId ?? active.sourceMessageId);
    // A ready batch is recovered independently; the new incoming message still gets handled.
    return processStockBatchMessage({ sourceText, businessCategory, conversationTurns, ownerPhone, senderPhone, messageId });
  }
  if (active?.status === 'awaiting_choice') {
    const actions = active.payload.actions.map((action) => ({ ...action }));
    const item = actions.find((action) => action.resolution.kind === 'ambiguous');
    const ids = item.resolution.candidateIds ?? [];
    let resolution = null;
    let clarificationTrace = null;
    const numeric = text.match(/^(?:(?:opcion|numero) )?(\d+)$/);
    if (/^(nuevo|nueva|es nuevo|es nueva|producto nuevo|cargar como nuevo|ninguno|ninguna)$/.test(text) || Number(numeric?.[1]) === ids.length + 1) resolution = { kind: 'new' };
    else {
      const named = ids.filter((id) => normalizeIdentity(item.candidates?.find((entry) => entry.id === id)?.name) === text);
      const id = numeric ? ids[Number(numeric[1]) - 1] : named.length === 1 ? named[0] : null;
      if (id) {
        const current = catalog.products.find((entry) => entry.id === id);
        const offered = item.candidates?.find((entry) => entry.id === id);
        if (current && offered && productFingerprint(current) === offered.fingerprint) resolution = { kind: 'existing', productId: id, fingerprint: offered.fingerprint, userConfirmed: true };
      }
    }
    const newName = sourceText.match(/^(?:nombre|diferencia)\s*:\s*(.{3,200})$/i)?.[1]?.trim();
    if (!resolution && !numeric && !newName) {
      const semantic = await interpretStockClarification({ sourceText, action: item });
      clarificationTrace = semantic.trace ?? null;
      if (semantic.kind === 'new') resolution = { kind: 'new' };
      if (semantic.kind === 'existing') {
        const offered = item.candidates?.find((entry) => entry.id === semantic.productId);
        const current = catalog.products.find((entry) => entry.id === semantic.productId);
        if (offered && current && offered.fingerprint === productFingerprint(current)) resolution = { kind: 'existing', productId: current.id, fingerprint: offered.fingerprint, userConfirmed: true };
      }
      if (semantic.kind === 'correction' && semantic.correctedAction) {
        const patch = semantic.correctedAction;
        const corrected = { ...item };
        for (const field of ['productName', 'productType', 'productModel', 'size', 'qty', 'price', 'fieldEvidence']) if (patch[field] !== undefined) corrected[field] = patch[field];
        corrected.evidence = item.evidence;
        const combined = `${active.payload.evidenceSourceText ?? active.sourceText}\nCorrección del usuario: ${sourceText}`;
        const valid = validateStockDraft(combined, [corrected]);
        const correctedActions = actions.map((action) => action.itemId === item.itemId ? corrected : action);
        const audit = valid.ok ? await auditStockDraft({ sourceText: combined, actions: correctedActions }) : { ok: false };
        const resolved = audit.ok ? await resolveStockDraft({ sourceText: combined, actions: [corrected], catalog }) : { ok: false };
        if (resolved.ok) {
          const revised = correctedActions.map((action) => action.itemId === item.itemId ? resolved.actions[0] : action);
          const saved = await saveTransition(active, messageId, { ...active.payload, actions: revised, evidenceSourceText: combined,
            traces: [...(active.payload.traces ?? []), ...(clarificationTrace ? [clarificationTrace] : []), audit.trace, resolved.trace],
            clarifications: [...(active.payload.clarifications ?? []), { itemId: item.itemId, messageId, text: sourceText, correction: patch }],
          }, revised.some((action) => action.resolution.kind === 'ambiguous') ? 'awaiting_choice' : 'ready');
          return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
        }
      }
    }
    if (newName) {
      item.productName = newName; item.productType = undefined; item.productModel = undefined;
      item.clarificationEvidence = { text: sourceText, messageId };
      resolution = { kind: 'new' };
    }
    if (resolution?.kind === 'new' && catalog.products.some((product) => needsDistinctIdentity(item, product))) {
      item.needsDifferentiator = true; resolution = null;
    }
    if (!resolution) {
      const reply = stockChoiceReply(item);
      const saved = await saveTransition(active, messageId, { ...active.payload, actions }, 'awaiting_choice', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
    item.resolution = resolution;
    const status = actions.some((entry) => entry.resolution.kind === 'ambiguous') ? 'awaiting_choice' : 'ready';
    const payload = { ...active.payload, actions, traces: [...(active.payload.traces ?? []), ...(clarificationTrace ? [clarificationTrace] : [])], clarifications: [...(active.payload.clarifications ?? []), { messageId, itemId: item.itemId, text: sourceText, resolution }] };
    const saved = await saveTransition(active, messageId, payload, status);
    return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
  }
  const mode = await getVoiceStockBatchMode(ownerPhone);
  if (!active && mode === 'disabled') return null;
  const retrySaved = active?.status === 'awaiting_correction' && /^(reintentar|reintenta|volver a intentar)$/.test(text);
  const draft = await prepare({ sourceText: retrySaved ? active.payload.evidenceSourceText ?? active.sourceText : sourceText,
    businessCategory, conversationTurns: retrySaved ? [] : conversationTurns, catalog });
  if (!draft) return active ? asResult(active, 'El ingreso sigue en borrador. Enviame la lista completa corregida o escribí “cancelar”.') : null;
  if (!active && mode === 'shadow') {
    await saveVoiceStockShadowRun(messageId, ownerPhone, draft);
    console.log('[VoiceStockBatch] shadow', { messageId, ok: draft.ok, reason: draft.reason, items: draft.actions?.length, traces: draft.traces });
    return null;
  }
  const status = draft.ok ? 'ready' : 'awaiting_correction';
  const payload = draftPayload(draft, messageId, active?.payload);
  if (active) payload.corrections = [...(active.payload.corrections ?? []), { messageId, text: sourceText }];
  const batch = active ? await saveTransition(active, messageId, payload, status) : await createVoiceStockBatch({
    id: `voice-stock-${crypto.randomUUID()}`, ownerPhone, senderPhone, sourceMessageId: messageId,
    status, sourceText, businessCategory, payload,
  });
  if (!batch) return concurrentResult(active, ownerPhone);
  if (!draft.ok) {
    console.warn('[VoiceStockBatch] draft held', { batchId: batch.id, messageId, reason: draft.reason,
      itemIndex: draft.itemIndex, field: draft.field, issues: draft.issues });
    const reply = stockDraftFailureReply(draft);
    const saved = await saveTransition(batch, messageId, batch.payload, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
  return finish(batch, ownerPhone, messageId);
};
