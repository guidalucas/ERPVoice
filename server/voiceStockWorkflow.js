import crypto from 'node:crypto';
import {
  createVoiceStockBatch, getActiveVoiceStockBatch, getVoiceStockBatchByMessage,
  updateVoiceStockBatch, applyResolvedVoiceStockBatch, getStateSnapshotStrict as getStateSnapshot, getVoiceStockBatchMode,
  saveVoiceStockShadowRun,
  getMetaReplyQuestion,
} from './postgresDatabase.js';
import { prepareStockDraft, normalizeIdentity, hasExplicitStockSize, needsDistinctIdentity, productFingerprint, ENGINE_VERSION, interpretStockClarification, validateStockDraft, auditStockDraft, resolveStockDraft } from './voiceStockEngine.js';

const pendingItem = (batch) => batch.payload.actions?.find((action) => action.resolution?.kind === 'ambiguous');
const questionForItem = (batch, item) => {
  const signature = JSON.stringify([item.itemId, item.resolution.candidateIds ?? [],
    (item.candidates ?? []).map((candidate) => [candidate.id, candidate.fingerprint])]);
  if (batch.payload.pendingQuestion?.signature === signature) return batch.payload.pendingQuestion;
  return { id: `question-${crypto.randomUUID()}`, kind: 'sku_choice', itemId: item.itemId,
    candidateIds: [...(item.resolution.candidateIds ?? [])], signature };
};
const choiceWithSize = (sourceText) => sourceText.trim().match(
  /^(?:(?:opci[oó]n|n[uú]mero)\s+)?(\d+)\s+(?:(?:en\s+)?(?:talle|talla|medida|tama[ñn]o|n[uú]mero|variante)\s+|en\s+)([\p{L}\p{N}/.-]+(?:\s+[\p{L}\p{N}/.-]+){0,2})$/iu,
);
const statedSize = (sourceText) => choiceWithSize(sourceText)?.[2]?.trim().toUpperCase()
  ?? sourceText.trim().match(/\b(?:talle|talla|medida|tama[ñn]o|n[uú]mero|variante)\s+([\p{L}\p{N}/.-]+(?:\s+[\p{L}\p{N}/.-]+){0,2})$/iu)?.[1]?.trim().toUpperCase();
const missingClothingSizes = (batch) => batch.businessCategory === 'indumentaria'
  ? (batch.payload.actions ?? []).filter((action) => !hasExplicitStockSize(action)) : [];
const clothingSizeReply = (actions) => `Antes de aplicar este ingreso de indumentaria necesito el talle de:\n${actions.map((action, index) =>
  `${index + 1}. ${action.productName}`).join('\n')}\nRespondé “todas son talle L” si comparten talle, o “1 S, 2 M” si son distintos. También podés escribir “cancelar”.`;
const parseClothingSizes = (sourceText, count) => {
  const value = normalizeIdentity(sourceText);
  const all = value.match(/^(?:todas?|todos?|las|los)\s+(?:son\s+|en\s+)?(?:talle\s+|talla\s+|medida\s+)?([a-z0-9]{1,8})$/);
  if (all) return new Map(Array.from({ length: count }, (_, index) => [index, all[1].toUpperCase()]));
  const single = count === 1 && value.match(/^(?:(?:es|en|talle|talla|medida)\s+)?([a-z0-9]{1,8})$/);
  if (single) return new Map([[0, single[1].toUpperCase()]]);
  const parts = sourceText.trim().split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const parsed = new Map();
  for (const part of parts) {
    const match = part.match(/^(\d+)\s+(?:(?:en\s+)?(?:talle|talla|medida)\s+|en\s+)?([\p{L}\p{N}]{1,8})$/iu);
    const index = Number(match?.[1]) - 1;
    if (!match || index < 0 || index >= count || parsed.has(index)) return null;
    parsed.set(index, match[2].toUpperCase());
  }
  return parsed;
};
export const stockChoiceReply = (action) => {
  const options = (action.resolution?.candidateIds ?? []).map((id, index) => {
    const product = action.candidates?.find((entry) => entry.id === id);
    return `${index + 1}. ${product?.name ?? 'Producto ya no disponible'}${product?.size ? ` — ${product.size}` : ''}`;
  });
  options.push(`${options.length + 1}. Cargar como producto nuevo`);
  if (action.needsDifferentiator) return `“${action.productName}” ya existe con esos mismos datos. Indicá qué cambia para crear otro producto (por ejemplo “nombre: …”), elegí una opción existente o escribí “cancelar”.\n${options.join('\n')}`;
  return `Dijiste “${action.evidence}” (${action.qty} u.${action.price != null ? `, $${action.price.toLocaleString('es-AR')} c/u` : ''}).\nEncontré estas opciones parecidas; comprobá también sus atributos y medida.\n${options.join('\n')}\nRespondé el número, el nombre, “nuevo” o “cancelar”. Si querés otra medida, escribí por ejemplo “1 en talle L”.`;
};

const asResult = (batch, replyText = batch.replyText) => ({ replyText, actions: batch.payload.appliedActions ?? batch.payload.actions ?? [], batchId: batch.id, batchStatus: batch.status });
const concurrentResult = async (batch, ownerPhone) => {
  const latest = await getVoiceStockBatchByMessage(ownerPhone, batch.sourceMessageId);
  if (latest?.status === 'ready') return finish(latest, ownerPhone, latest.payload.replyMessageId ?? latest.sourceMessageId);
  return asResult(latest ?? batch, latest?.replyText ?? 'Ya estoy procesando otra respuesta para ese lote.');
};

const saveTransition = async (batch, messageId, payload, status, replyText = null) => {
  const next = { ...batch, payload };
  const pending = status === 'awaiting_choice' ? pendingItem(next) : null;
  // Persist question rotation in the same CAS as the actions it describes. A crash
  // before finish() sends the next prompt must never leave Q1 attached to item 2.
  return updateVoiceStockBatch(batch.id, {
    expectedVersion: batch.version, status, replyText,
    payload: { ...payload, ...(pending ? { pendingQuestion: questionForItem(next, pending) } : {}),
      replyMessageId: messageId, handledMessages: [...(payload.handledMessages ?? []).filter((entry) => entry.messageId !== messageId), { messageId, replyText }] },
  });
};

const finish = async (batch, ownerPhone, messageId) => {
  const missingSizes = missingClothingSizes(batch);
  if (missingSizes.length) {
    const reply = clothingSizeReply(missingSizes);
    const payload = { ...batch.payload,
      sizeRequiredItemIds: [...new Set([...(batch.payload.sizeRequiredItemIds ?? []), ...missingSizes.map((action) => action.itemId)])],
      missingSizeItemIds: missingSizes.map((action) => action.itemId) };
    const saved = await saveTransition(batch, messageId, payload, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
  const pending = pendingItem(batch);
  if (pending) {
    const reply = stockChoiceReply(pending);
    const saved = await saveTransition(batch, messageId, { ...batch.payload,
      pendingQuestion: questionForItem(batch, pending),
    }, 'awaiting_choice', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
  try {
    await applyResolvedVoiceStockBatch(batch.id, ownerPhone);
    return asResult(await getVoiceStockBatchByMessage(ownerPhone, batch.sourceMessageId));
  } catch (error) {
    if (/^(08|40|53|57)/.test(String(error.code ?? '')) || /timeout|connection|ECONN/i.test(error.message)) throw error;
    const latest = await getVoiceStockBatchByMessage(ownerPhone, batch.sourceMessageId);
    if (latest.status === 'applied') return asResult(latest);
    const reply = error.code === 'STOCK_REFERENCE_UNVERIFIED'
      ? 'Conservé el lote y no apliqué cambios: una referencia al producto anterior podría duplicar stock. Escribí “reintentar” para revisar el mensaje guardado, sin reenviar el audio, o “cancelar”.'
      : 'No pude aplicar el lote completo. Revisá los datos del inventario y reenviame la lista corregida. El lote conserva todos sus productos.';
    const saved = await saveTransition(latest, messageId, { ...latest.payload, applyError: error.message }, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
};

const prepare = async (input) => {
  const draft = await prepareStockDraft(input);
  if (draft.kind === 'other') return null;
  if (!draft.ok && !draft.kind && !input.clarificationContext
    && !/\b(ingres|recib|lleg|entr|carg|agreg|compr)/i.test(input.sourceText)) return null;
  return draft;
};

const draftPayload = (draft, messageId, previous = {}, fallbackSourceText = '') => ({
  ...previous, actions: draft.actions ?? previous.actions ?? [], coverageVerified: Boolean(draft.ok && draft.coverageVerified),
  evidenceSourceText: draft.sourceText ?? previous.evidenceSourceText ?? fallbackSourceText, engineVersion: ENGINE_VERSION,
  initialActions: previous.initialActions ?? draft.actions ?? [],
  traces: [...(previous.traces ?? []), ...(draft.traces ?? [draft.trace]).filter(Boolean)],
  issues: draft.issues ?? (draft.ok ? [] : previous.issues ?? []), resolutionError: draft.ok ? null : draft.reason, replyMessageId: messageId,
  clarificationsNeeded: draft.clarifications ?? (draft.ok ? [] : previous.clarificationsNeeded ?? []),
  validationError: draft.ok ? null : { reason: draft.reason, itemIndex: draft.itemIndex, field: draft.field },
});

export const stockDraftFailureReply = (draft) => {
  if (draft.reason === 'clarification_dropped_items') return `Conservé el borrador completo y no apliqué cambios. No pude vincular tu respuesta con todos los productos guardados. ${draft.clarifications?.map((issue) => issue.question).filter(Boolean).join(' ') ?? ''} También podés enviar “Lista completa corregida: …” con todos los productos, o escribir “cancelar”.`;
  if (draft.clarifications?.length) return `Guardé el ingreso como borrador y no apliqué cambios.\n${draft.clarifications.map((issue) => issue.question).join('\n')}\nRespondé esas preguntas; conservo el resto de la lista. También podés escribir “cancelar”.`;
  return 'Guardé tu mensaje como borrador y no apliqué cambios. No pude verificar automáticamente la lista de productos. Podés escribir “reintentar” para procesar lo guardado sin repetir el mensaje ni el audio, o “cancelar”.';
};

export const holdUnverifiedStockMessage = async ({ sourceText, businessCategory, ownerPhone, senderPhone, messageId }) => {
  const replyText = 'Guardé el ingreso como borrador y no apliqué cambios. No pude verificar la lista. Escribí “reintentar” para procesar el mensaje guardado, sin repetir el texto ni el audio, o “cancelar”.';
  const batch = await createVoiceStockBatch({
    id: `voice-stock-${crypto.randomUUID()}`, ownerPhone, senderPhone, sourceMessageId: messageId,
    status: 'awaiting_correction', sourceText, businessCategory, replyText,
    payload: { actions: [], initialActions: [], coverageVerified: false, evidenceSourceText: sourceText,
      engineVersion: ENGINE_VERSION, forceStockIntake: true, resolutionError: 'legacy_stock_unverified',
      replyMessageId: messageId, handledMessages: [{ messageId, replyText }] },
  });
  return asResult(batch);
};

export const processStockBatchMessage = async ({ sourceText, businessCategory, ownerPhone, senderPhone, messageId, replyToMessageId = null }) => {
  const replay = await getVoiceStockBatchByMessage(ownerPhone, messageId);
  if (replay) {
    if (replay.status === 'ready') return finish(replay, ownerPhone, replay.payload.replyMessageId ?? messageId);
    const prior = replay.payload.handledMessages?.find((entry) => entry.messageId === messageId);
    if (!prior?.replyText && !replay.replyText && ['awaiting_choice', 'awaiting_correction'].includes(replay.status)) {
      if (pendingItem(replay)) return finish(replay, ownerPhone, messageId);
      const saved = await saveTransition(replay, messageId, replay.payload, 'awaiting_correction', stockDraftFailureReply({ clarifications: replay.payload.clarificationsNeeded }));
      return saved ? asResult(saved) : concurrentResult(replay, ownerPhone);
    }
    return asResult(replay, prior?.replyText ?? replay.replyText);
  }
  const active = await getActiveVoiceStockBatch(ownerPhone, senderPhone);
  if (active?.status === 'ready') {
    await finish(active, ownerPhone, active.payload.replyMessageId ?? active.sourceMessageId);
    // Recover the committed ready decision before interpreting a later command.
    return processStockBatchMessage({ sourceText, businessCategory, ownerPhone, senderPhone, messageId, replyToMessageId });
  }
  if (replyToMessageId) {
    const quoted = await getMetaReplyQuestion(replyToMessageId, ownerPhone, senderPhone);
    const pending = active && pendingItem(active);
    const currentQuestion = pending ? questionForItem(active, pending) : null;
    if (!active && quoted) return { actions: [], batchId: quoted.batchId, batchStatus: 'ignored_reply',
      replyText: 'Esa respuesta cita una pregunta de un lote cerrado. No cambié el inventario. Enviá una nueva operación para continuar.' };
    if (active && (quoted?.batchId !== active.id
      || quoted?.questionId !== currentQuestion?.id || active.status !== 'awaiting_choice')) {
      const reply = 'Esa respuesta no corresponde a la pregunta pendiente. Conservé el lote sin cambios; respondé la pregunta actual sin citar mensajes anteriores.';
      const saved = await saveTransition(active, messageId, { ...active.payload,
        ignoredReplies: [...(active.payload.ignoredReplies ?? []), { messageId, replyToMessageId, text: sourceText }],
      }, active.status, reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
  }
  const retryChoice = active?.status === 'awaiting_choice' && /^(reintentar|reintenta|volver a intentar)$/.test(normalizeIdentity(sourceText))
    && active.payload.pendingChoiceReply;
  let answerMessageId = messageId;
  if (retryChoice) {
    if (active.payload.pendingChoiceReply.questionId !== active.payload.pendingQuestion?.id
      || active.payload.pendingChoiceReply.itemId !== pendingItem(active)?.itemId) {
      const reply = 'La pregunta pendiente cambió. Conservé el lote; respondé la pregunta actual para continuar.';
      const saved = await saveTransition(active, messageId, active.payload, 'awaiting_choice', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
    sourceText = active.payload.pendingChoiceReply.text;
    answerMessageId = active.payload.pendingChoiceReply.messageId;
  }
  const text = normalizeIdentity(sourceText);
  if (active && /^(cancelar|cancela|anular|dejalo|dejalo asi)$/.test(text)) {
    const reply = 'Listo, cancelé ese lote. No cambié el inventario.';
    const saved = await saveTransition(active, messageId, { ...active.payload, cancellation: { messageId, text: sourceText } }, 'cancelled', reply);
    return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
  }
  const catalog = await getStateSnapshot(ownerPhone);
  if (active?.status === 'awaiting_choice' && active.payload.engineVersion !== ENGINE_VERSION) {
    const reply = 'Conservé tu borrador anterior. Escribí “reintentar” para verificar el mensaje guardado con el nuevo flujo, o “cancelar”.';
    const saved = await saveTransition(active, messageId, active.payload, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
  }
  if (active?.status === 'awaiting_correction' && active.payload.missingSizeItemIds?.length) {
    const actions = active.payload.actions.map((action) => ({ ...action }));
    const missing = active.payload.missingSizeItemIds.map((id) => actions.find((action) => action.itemId === id)).filter(Boolean);
    const sizes = parseClothingSizes(sourceText, missing.length);
    if (!sizes?.size) {
      const reply = `No pude vincular los talles con los productos pendientes.\n${clothingSizeReply(missing)}`;
      const saved = await saveTransition(active, messageId, active.payload, 'awaiting_correction', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
    for (const [index, size] of sizes) {
      const action = actions.find((entry) => entry.itemId === missing[index].itemId);
      action.size = size;
      action.clarificationEvidence = { text: sourceText, messageId };
    }
    const combined = `${active.payload.evidenceSourceText ?? active.sourceText}\n${sourceText}`;
    const remaining = actions.filter((action) => active.payload.sizeRequiredItemIds.includes(action.itemId) && !hasExplicitStockSize(action));
    if (remaining.length) {
      const reply = clothingSizeReply(remaining);
      const saved = await saveTransition(active, messageId, { ...active.payload, actions, evidenceSourceText: combined,
        missingSizeItemIds: remaining.map((action) => action.itemId),
        sizeClarifications: [...(active.payload.sizeClarifications ?? []), { messageId, text: sourceText, assignments: [...sizes] }],
      }, 'awaiting_correction', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
    const required = new Set(active.payload.sizeRequiredItemIds);
    const rerun = await resolveStockDraft({ sourceText: combined, actions: actions.filter((action) => required.has(action.itemId)), catalog });
    if (!rerun.ok) {
      const reply = 'Guardé los talles, pero no pude verificar las variantes del catálogo. Escribí “reintentar” o “cancelar”.';
      const saved = await saveTransition(active, messageId, { ...active.payload, actions, evidenceSourceText: combined,
        missingSizeItemIds: [], sizeResolutionPending: true, resolutionError: rerun.reason }, 'awaiting_correction', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
    const byId = new Map(rerun.actions.map((action) => [action.itemId, action]));
    const revised = actions.map((action) => byId.get(action.itemId) ?? action);
    const saved = await saveTransition(active, messageId, { ...active.payload, actions: revised, evidenceSourceText: combined,
      missingSizeItemIds: [], sizeRequiredItemIds: [], sizeResolutionPending: false, resolutionError: null,
      traces: [...(active.payload.traces ?? []), ...(rerun.traces ?? [])],
      sizeClarifications: [...(active.payload.sizeClarifications ?? []), { messageId, text: sourceText, assignments: [...sizes] }],
    }, 'ready');
    return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
  }
  if (active?.status === 'awaiting_correction' && active.payload.sizeResolutionPending
    && /^(reintentar|reintenta|volver a intentar)$/.test(text)) {
    const required = new Set(active.payload.sizeRequiredItemIds ?? []);
    const rerun = await resolveStockDraft({
      sourceText: active.payload.evidenceSourceText ?? active.sourceText,
      actions: active.payload.actions.filter((action) => required.has(action.itemId)), catalog,
    });
    if (!rerun.ok) {
      const reply = 'Todavía no pude verificar las variantes del catálogo. Conservé el lote y los talles; escribí “reintentar” o “cancelar”.';
      const saved = await saveTransition(active, messageId, { ...active.payload, resolutionError: rerun.reason }, 'awaiting_correction', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
    const byId = new Map(rerun.actions.map((action) => [action.itemId, action]));
    const actions = active.payload.actions.map((action) => byId.get(action.itemId) ?? action);
    const saved = await saveTransition(active, messageId, { ...active.payload, actions,
      sizeRequiredItemIds: [], sizeResolutionPending: false, resolutionError: null,
      traces: [...(active.payload.traces ?? []), ...(rerun.traces ?? [])],
    }, 'ready');
    return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
  }
  if (active?.status === 'awaiting_choice') {
    const actions = active.payload.actions.map((action) => ({ ...action }));
    const item = actions.find((action) => action.resolution.kind === 'ambiguous');
    const question = questionForItem(active, item);
    // Compatibility for already pending v5 batches. Persist on the next transition.
    active.payload = { ...active.payload, pendingQuestion: question };
    const holdAnswer = async (reason, traces = []) => {
      const reply = 'Conservé tu respuesta y el lote sin aplicar cambios. No pude verificar la aclaración; escribí “reintentar” para procesar esa misma respuesta, o “cancelar”.';
      const saved = await saveTransition(active, messageId, { ...active.payload, actions,
        pendingChoiceReply: { questionId: question.id, itemId: item.itemId, messageId: answerMessageId, text: sourceText },
        interpreterError: reason,
        traces: [...(active.payload.traces ?? []), ...traces.filter(Boolean)],
      }, 'awaiting_choice', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    };
    const holdUnverified = (reason, traces) => holdAnswer({
      kind: /unavailable/.test(reason) ? 'unavailable' : 'invalid', reason,
    }, traces);
    const ids = item.resolution.candidateIds ?? [];
    let resolution = null;
    let clarificationTrace = null;
    const numeric = text.match(/^(?:(?:opcion|numero) )?(\d+)$/);
    const sizedChoice = choiceWithSize(sourceText);
    const selectedNumber = numeric?.[1] ?? sizedChoice?.[1];
    const requestedSize = statedSize(sourceText);
    if (/^(nuevo|nueva|es nuevo|es nueva|producto nuevo|cargar como nuevo|ninguno|ninguna)$/.test(text) || Number(selectedNumber) === ids.length + 1) resolution = { kind: 'new' };
    else {
      const named = ids.filter((id) => normalizeIdentity(item.candidates?.find((entry) => entry.id === id)?.name) === text);
      const id = selectedNumber ? ids[Number(selectedNumber) - 1] : named.length === 1 ? named[0] : null;
      if (id) {
        const current = catalog.products.find((entry) => entry.id === id);
        const offered = item.candidates?.find((entry) => entry.id === id);
        if (current && offered && productFingerprint(current) === offered.fingerprint) resolution = { kind: 'existing', productId: id, fingerprint: offered.fingerprint, userConfirmed: true };
      }
    }
    const newName = sourceText.match(/^(?:nombre|diferencia)\s*:\s*(.{3,200})$/i)?.[1]?.trim();
    if (!resolution && !selectedNumber && !newName) {
      const semantic = await interpretStockClarification({ sourceText, action: item });
      clarificationTrace = semantic.trace ?? null;
      if (semantic.kind === 'unavailable' || semantic.kind === 'invalid') {
        return holdAnswer({ kind: semantic.kind, reason: semantic.reason }, [clarificationTrace]);
      }
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
            pendingChoiceReply: null, interpreterError: null,
            traces: [...(active.payload.traces ?? []), ...(clarificationTrace ? [clarificationTrace] : []), audit.trace, resolved.trace],
            clarifications: [...(active.payload.clarifications ?? []), { itemId: item.itemId, messageId, answerMessageId, questionId: question.id, text: sourceText, correction: patch }],
          }, revised.some((action) => action.resolution.kind === 'ambiguous') ? 'awaiting_choice' : 'ready');
          return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
        }
        return holdUnverified((!valid.ok ? valid.reason : !audit.ok ? audit.reason : resolved.reason) ?? 'correction_unverified',
          [clarificationTrace, audit.trace, ...(resolved.traces ?? [])]);
      }
    }
    if (resolution?.kind === 'existing' && requestedSize) {
      const selected = catalog.products.find((product) => product.id === resolution.productId);
      if (selected && normalizeIdentity(selected.size) !== normalizeIdentity(requestedSize)) {
        const corrected = { ...item, size: requestedSize,
          clarificationEvidence: { text: sourceText, messageId } };
        const combined = `${active.payload.evidenceSourceText ?? active.sourceText}\n${sourceText}`;
        const valid = validateStockDraft(combined, [corrected]);
        const rerun = valid.ok ? await resolveStockDraft({ sourceText: combined, actions: [corrected], catalog }) : { ok: false };
        if (rerun.ok) {
          const revised = actions.map((action) => action.itemId === item.itemId ? rerun.actions[0] : action);
          const saved = await saveTransition(active, messageId, { ...active.payload, actions: revised, evidenceSourceText: combined,
            pendingChoiceReply: null, interpreterError: null,
            traces: [...(active.payload.traces ?? []), ...(clarificationTrace ? [clarificationTrace] : []), ...(rerun.traces ?? [])],
            clarifications: [...(active.payload.clarifications ?? []), { messageId, answerMessageId, questionId: question.id, itemId: item.itemId, text: sourceText,
              requestedSize, selectedProductId: selected.id, resolution: rerun.actions[0].resolution }],
          }, revised.some((action) => action.resolution.kind === 'ambiguous') ? 'awaiting_choice' : 'ready');
          return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
        }
        return holdUnverified(valid.reason ?? rerun.reason ?? 'variant_unverified',
          [clarificationTrace, ...(rerun.traces ?? [])]);
      }
      item.size = requestedSize;
    }
    if (resolution?.kind === 'new' && requestedSize) item.size = requestedSize;
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
      const saved = await saveTransition(active, messageId, { ...active.payload, actions,
        traces: [...(active.payload.traces ?? []), ...(clarificationTrace ? [clarificationTrace] : [])],
      }, 'awaiting_choice', reply);
      return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
    }
    item.resolution = resolution;
    if (requestedSize) item.clarificationEvidence = { text: sourceText, messageId };
    const status = actions.some((entry) => entry.resolution.kind === 'ambiguous') ? 'awaiting_choice' : 'ready';
    const payload = { ...active.payload, actions, pendingChoiceReply: null, interpreterError: null,
      evidenceSourceText: requestedSize ? `${active.payload.evidenceSourceText ?? active.sourceText}\n${sourceText}` : active.payload.evidenceSourceText,
      traces: [...(active.payload.traces ?? []), ...(clarificationTrace ? [clarificationTrace] : [])],
      clarifications: [...(active.payload.clarifications ?? []), { messageId, answerMessageId, questionId: question.id, itemId: item.itemId, text: sourceText, resolution }] };
    const saved = await saveTransition(active, messageId, payload, status);
    return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
  }
  const mode = await getVoiceStockBatchMode(ownerPhone);
  if (!active && mode === 'disabled') return null;
  const retrySaved = active?.status === 'awaiting_correction' && /^(reintentar|reintenta|volver a intentar)$/.test(text);
  const pendingCorrection = retrySaved ? active.payload.pendingCorrectionText : null;
  const savedSource = active?.payload.evidenceSourceText ?? active?.sourceText;
  const draft = await prepare({ sourceText: retrySaved ? pendingCorrection ?? savedSource : sourceText,
    businessCategory, catalog, forceStockIntake: Boolean(retrySaved && active.payload.forceStockIntake),
    clarificationContext: active?.status === 'awaiting_correction' && (!retrySaved || pendingCorrection) ? {
      sourceText: savedSource,
      actions: active.payload.actions, questions: active.payload.clarificationsNeeded ?? [],
    } : null });
  if (!draft) return active ? asResult(active, stockDraftFailureReply({ clarifications: active.payload.clarificationsNeeded })) : null;
  if (!active && mode === 'shadow') {
    await saveVoiceStockShadowRun(messageId, ownerPhone, draft);
    console.log('[VoiceStockBatch] shadow', { messageId, ok: draft.ok, reason: draft.reason, items: draft.actions?.length, traces: draft.traces });
    return null;
  }
  const status = draft.ok ? 'ready' : 'awaiting_correction';
  const payload = draftPayload(draft, messageId, active?.payload, retrySaved ? savedSource : sourceText);
  if (draft.ok || (draft.sourceText && draft.sourceText !== savedSource)) delete payload.pendingCorrectionText;
  else if (active && !retrySaved && !draft.ok) payload.pendingCorrectionText = sourceText;
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
