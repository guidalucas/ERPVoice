import { inventoryResultReply } from './inventoryResults.js';
import { operationResultActions } from './operationResults.js';

// Legacy control codes belong to their original namespace, including malformed
// commands. They must never become natural-language instructions for a provider.
export const isRetiredMetaControl = text => typeof text === 'string'
  && /^\s*(?:CONFIRMAR|CANCELAR)\s+(?:BAJA|CAMBIO|AJUSTE)(?=$|[^\p{L}\p{N}_])/iu.test(text);

export const LEGACY_META_RETIRED_REPLY = 'Esta operación pertenece al flujo anterior y ya no se puede continuar. No apliqué cambios. Enviá REVISAR OPERACION seguido de la instrucción completa para preparar una nueva revisión.';

// Render only the historical message snapshot. In particular, a saved ready
// transition is not permission to apply its draft during a delivery retry.
export const replayLegacyMetaBatch = (batch, messageId, outboxReply = null) => {
  if (batch.status !== 'applied') return null;
  const payload = batch.payload ?? {};
  const handled = payload.handledMessages?.find(entry => entry.messageId === messageId);
  const replyText = handled?.replyText ?? outboxReply ?? batch.replyText
    ?? (payload.operationResult ? inventoryResultReply(payload.operationResult) : null);
  if (!replyText) return null;
  return { handled: true, intent: 'mixed', requiresConfirmation: false, replyText,
    actions: payload.appliedActions ?? (payload.operationResult ? operationResultActions(payload.operationResult) : []), batchId: batch.id, batchStatus: batch.status,
    ...(payload.operationResult ? { operationResult: payload.operationResult } : {}) };
};
