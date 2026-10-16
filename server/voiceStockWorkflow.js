import crypto from 'node:crypto';
import {
  createVoiceStockBatch, getActiveVoiceStockBatch, getVoiceStockBatchByMessage,
  updateVoiceStockBatch, applyResolvedVoiceStockBatch, getStateSnapshotStrict as getStateSnapshot, getVoiceStockBatchMode,
  saveVoiceStockShadowRun,
  getMetaReplyQuestion,
} from './postgresDatabase.js';
import { prepareStockDraft, normalizeIdentity, hasExplicitStockSize, needsDistinctIdentity, productFingerprint, ENGINE_VERSION, interpretStockClarification, validateStockDraft, auditStockDraft, resolveStockDraft } from './voiceStockEngine.js';
import { interpretStockDraftPatch, invalidateDraftItem } from './stockDraftPatches.js';

const pendingItem = (batch) => batch.payload.actions?.find((action) => action.resolution?.kind === 'ambiguous');
const canonicalJson = (value) => Array.isArray(value) ? value.map(canonicalJson)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])) : value;
const draftAuditFingerprint = (payload) => crypto.createHash('sha256').update(JSON.stringify(canonicalJson({
  sourceText: payload.evidenceSourceText, actions: payload.actions,
}))).digest('hex');
const withDraftQuestions = (payload) => {
  const actions = payload.actions ?? [];
  const sourceHash = crypto.createHash('sha256').update(payload.evidenceSourceText ?? '').digest('hex');
  const questions = (payload.clarificationsNeeded ?? []).filter((issue) => issue.question && issue.evidence).map((issue) => {
    const related = actions.filter((action) => action.evidence?.includes(issue.evidence) || issue.evidence.includes(action.evidence));
    // A global/reference question may span the whole draft rather than one mention.
    const itemIds = (related.length ? related : actions).map((action) => action.itemId);
    const signature = JSON.stringify([issue.question, issue.evidence, itemIds, sourceHash]);
    const prior = payload.pendingDraftQuestions?.find((entry) => entry.signature === signature);
    return prior ?? { id: `question-${crypto.randomUUID()}`, kind: 'draft_clarification',
      question: issue.question, evidence: issue.evidence, itemIds, signature };
  });
  const signature = JSON.stringify(questions.map((question) => question.id));
  return { ...payload, pendingDraftQuestions: questions, draftQuestionSignature: signature,
    pendingDraftQuestionSetId: questions.length ? payload.draftQuestionSignature === signature
      ? payload.pendingDraftQuestionSetId : `questions-${crypto.randomUUID()}` : null };
};
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
  if (status === 'awaiting_correction') payload = withDraftQuestions(payload);
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

const draftPayload = (draft, messageId, previous = {}, fallbackSourceText = '') => withDraftQuestions({
  ...previous, actions: draft.actions ?? previous.actions ?? [], coverageVerified: Boolean(draft.ok && draft.coverageVerified),
  pendingDraftPatch: null, pendingDraftAnswer: null, pendingChoiceReply: null, pendingQuestion: null,
  evidenceSourceText: draft.sourceText ?? previous.evidenceSourceText ?? fallbackSourceText, engineVersion: ENGINE_VERSION,
  initialActions: previous.initialActions ?? draft.actions ?? [],
  traces: [...(previous.traces ?? []), ...(draft.traces ?? [draft.trace]).filter(Boolean)],
  issues: draft.issues ?? (draft.ok ? [] : previous.issues ?? []), resolutionError: draft.ok ? null : draft.reason, replyMessageId: messageId,
  clarificationsNeeded: draft.clarifications ?? (draft.ok ? [] : previous.clarificationsNeeded ?? []),
  validationError: draft.ok ? null : { reason: draft.reason, itemIndex: draft.itemIndex, field: draft.field },
});

// A validated patch is saved before another model call. Recovery resumes its audit
// and resolution using the same actions/IDs instead of extracting the list again.
const verifyDraftPatch = async (batch, ownerPhone, messageId) => {
  const pending = batch.payload.pendingDraftPatch;
  const traces = [];
  const fingerprint = draftAuditFingerprint(batch.payload);
  const audit = pending.auditVerified && pending.auditFingerprint === fingerprint ? { ok: true } : await auditStockDraft({
    sourceText: batch.payload.evidenceSourceText, actions: batch.payload.actions,
  });
  if (audit.trace) traces.push(audit.trace);
  if (!audit.ok) {
    const semanticQuestions = audit.clarifications?.length;
    const payload = { ...batch.payload, coverageVerified: false,
      pendingDraftPatch: semanticQuestions ? null : pending,
      clarificationsNeeded: semanticQuestions ? audit.clarifications : batch.payload.clarificationsNeeded,
      issues: audit.issues ?? batch.payload.issues, resolutionError: audit.reason,
      traces: [...(batch.payload.traces ?? []), ...traces] };
    const saved = await saveTransition(batch, messageId, payload, 'awaiting_correction', stockDraftFailureReply(audit));
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
  const catalog = await getStateSnapshot(ownerPhone);
  const unresolved = batch.payload.actions.filter((action) => !action.resolution || action.resolution.kind === 'ambiguous');
  const resolution = unresolved.length ? await resolveStockDraft({
    sourceText: batch.payload.evidenceSourceText, actions: unresolved, catalog,
  }) : { ok: true, actions: [] };
  traces.push(...(resolution.traces ?? []));
  if (!resolution.ok) {
    const reply = 'Guardé la aclaración y todos los productos. No pude verificar el catálogo; escribí “reintentar” para continuar sin repetir la respuesta, o “cancelar”.';
    const saved = await saveTransition(batch, messageId, { ...batch.payload,
      pendingDraftPatch: { ...pending, auditVerified: true, auditFingerprint: fingerprint }, resolutionError: resolution.reason,
      traces: [...(batch.payload.traces ?? []), ...traces],
    }, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
  const byId = new Map(resolution.actions.map((action) => [action.itemId, action]));
  const saved = await saveTransition(batch, messageId, { ...batch.payload,
    actions: batch.payload.actions.map((action) => byId.get(action.itemId) ?? action),
    coverageVerified: true, pendingDraftPatch: null, pendingDraftAnswer: null, pendingCorrectionText: null,
    clarificationsNeeded: [], pendingDraftQuestions: [], pendingDraftQuestionSetId: null, issues: [], resolutionError: null,
    traces: [...(batch.payload.traces ?? []), ...traces],
  }, 'ready');
  return saved ? finish(saved, ownerPhone, messageId) : concurrentResult(batch, ownerPhone);
};

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
    if (replay.status === 'awaiting_correction' && replay.payload.pendingDraftPatch && prior && !prior.replyText) {
      return verifyDraftPatch(replay, ownerPhone, messageId);
    }
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
    const currentQuestionId = active?.status === 'awaiting_choice' && pending
      ? questionForItem(active, pending).id : active?.status === 'awaiting_correction'
        ? withDraftQuestions(active.payload).pendingDraftQuestionSetId : null;
    if (!active && quoted) return { actions: [], batchId: quoted.batchId, batchStatus: 'ignored_reply',
      replyText: 'Esa respuesta cita una pregunta de un lote cerrado. No cambié el inventario. Enviá una nueva operación para continuar.' };
    if (active && (quoted?.batchId !== active.id
      || quoted?.questionId !== currentQuestionId || !currentQuestionId)) {
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
      const position = actions.findIndex((entry) => entry.itemId === missing[index].itemId);
      const action = invalidateDraftItem(actions[position], { identityChanged: true });
      actions[position] = action;
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
  const retryDraft = /^(reintentar|reintenta|volver a intentar)$/.test(text);
  const replacesDraft = /^(?:lista completa(?: corregida)?|reemplazo (?:la lista completa|el listado completo)|esta es la lista completa|este es el listado completo)\b/.test(text);
  if (active?.status === 'awaiting_correction' && !replacesDraft) {
    if (retryDraft && active.payload.pendingDraftPatch) return verifyDraftPatch(active, ownerPhone, messageId);
    active.payload = withDraftQuestions(active.payload);
    if (active.payload.actions?.length && active.payload.pendingDraftQuestions.length) {
      const savedAnswer = retryDraft ? active.payload.pendingDraftAnswer : null;
      if (savedAnswer && savedAnswer.questionSetId !== active.payload.pendingDraftQuestionSetId) {
        const saved = await saveTransition(active, messageId, active.payload, 'awaiting_correction',
          'La pregunta pendiente cambió. Conservé el lote; respondé las preguntas actuales.');
        return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
      }
      const answerText = savedAnswer?.text ?? sourceText;
      const answerId = savedAnswer?.messageId ?? messageId;
      const interpreted = await interpretStockDraftPatch({ sourceText: answerText,
        actions: active.payload.actions, questions: active.payload.pendingDraftQuestions });
      const traces = [...(active.payload.traces ?? []), ...(interpreted.trace ? [interpreted.trace] : [])];
      if (!['patch', 'confirm'].includes(interpreted.kind)) {
        const unrelated = interpreted.kind === 'unrelated';
        const saved = await saveTransition(active, messageId, { ...active.payload, traces,
          ...(unrelated ? {} : { pendingDraftAnswer: { messageId: answerId, text: answerText,
            questionSetId: active.payload.pendingDraftQuestionSetId }, pendingCorrectionText: answerText }),
          resolutionError: interpreted.reason ?? interpreted.kind,
        }, 'awaiting_correction', unrelated ? stockDraftFailureReply({ clarifications: active.payload.clarificationsNeeded })
          : 'Conservé tu respuesta y todos los ítems. No pude verificar la aclaración; escribí “reintentar” para procesar esa respuesta, o “cancelar”.');
        return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
      }
      const combined = `${active.payload.evidenceSourceText ?? active.sourceText}\n${answerText}`;
      const valid = validateStockDraft(combined, interpreted.actions);
      if (!valid.ok) {
        const saved = await saveTransition(active, messageId, { ...active.payload, traces,
          pendingDraftAnswer: { messageId: answerId, text: answerText, questionSetId: active.payload.pendingDraftQuestionSetId },
          pendingCorrectionText: answerText, resolutionError: valid.reason,
        }, 'awaiting_correction', 'Conservé tu respuesta. La aclaración no pasó la validación; escribí “reintentar” o “cancelar”.');
        return saved ? asResult(saved) : concurrentResult(active, ownerPhone);
      }
      const saved = await saveTransition(active, messageId, { ...active.payload,
        actions: valid.actions, evidenceSourceText: combined, coverageVerified: false, traces,
        pendingDraftAnswer: null, pendingCorrectionText: null,
        pendingDraftPatch: { messageId: answerId, questionId: interpreted.patch.questionId, auditVerified: false },
        draftPatches: [...(active.payload.draftPatches ?? []), { messageId: answerId, text: answerText, patch: interpreted.patch }],
      }, 'awaiting_correction');
      return saved ? verifyDraftPatch(saved, ownerPhone, messageId) : concurrentResult(active, ownerPhone);
    }
  }
  if (active?.status === 'awaiting_choice') {
    const actions = active.payload.actions.map((action) => ({ ...action }));
    let item = actions.find((action) => action.resolution.kind === 'ambiguous');
    const pendingSnapshot = { ...item };
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
        const identityChanged = ['productName', 'productType', 'productModel', 'size'].some((field) => patch[field] !== undefined && patch[field] !== item[field]);
        const corrected = invalidateDraftItem(item, { identityChanged });
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
        const corrected = { ...invalidateDraftItem(item, { identityChanged: true }), size: requestedSize,
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
    if (requestedSize || newName) {
      const revised = invalidateDraftItem(item, { identityChanged: true });
      actions[actions.indexOf(item)] = revised;
      item = revised;
      item.clarificationEvidence = { text: sourceText, messageId };
    }
    if (resolution?.kind === 'new' && catalog.products.some((product) => needsDistinctIdentity(item, product))) {
      item.needsDifferentiator = true; resolution = null;
    }
    if (!resolution) {
      // An invalid choice cannot replace the pending SKU/candidate snapshot with
      // an item whose derived resolution was invalidated during interpretation.
      const held = { ...pendingSnapshot, ...(item.needsDifferentiator ? { needsDifferentiator: true } : {}) };
      actions[actions.indexOf(item)] = held;
      item = held;
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
      itemIndex: draft.itemIndex, field: draft.field, issueKinds: draft.issues?.map((issue) => issue.kind) });
    const reply = stockDraftFailureReply(draft);
    const saved = await saveTransition(batch, messageId, batch.payload, 'awaiting_correction', reply);
    return saved ? asResult(saved) : concurrentResult(batch, ownerPhone);
  }
  return finish(batch, ownerPhone, messageId);
};
