import type { ParsedVoicePayload } from '../domain/types';

// sessionStorage deliberately covers reloads in this tab, not a closed browser/tab.
export const pendingProposalKey = (tenant: string, actor: string) =>
  `erpvoice.pendingProposal.v1:${encodeURIComponent(tenant)}:${encodeURIComponent(actor)}`;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const actionTypes = new Set(['add_stock', 'reserve_stock', 'sell', 'add_debt', 'payment_received', 'client_order',
  'query_stock', 'query_pedidos', 'update_product', 'update_pedido', 'delete_pedido', 'delete_product']);

const validAction = (value: unknown) => {
  if (!object(value) || !actionTypes.has(String(value.type))) return false;
  if (value.type !== 'query_pedidos' && !['add_debt', 'payment_received'].includes(String(value.type)) && !text(value.productName)) return false;
  if (['add_stock', 'reserve_stock', 'sell'].includes(String(value.type)) && (!Number.isSafeInteger(value.qty) || Number(value.qty) <= 0)) return false;
  if (value.qty !== undefined && (!Number.isSafeInteger(value.qty) || Number(value.qty) <= 0)) return false;
  if (['add_debt', 'payment_received'].includes(String(value.type)) && (!text(value.clientName) || !finite(value.amount))) return false;
  for (const key of ['qty', 'price', 'amount', 'stockAvailable']) {
    if (value[key] !== undefined && !finite(value[key])) return false;
  }
  for (const key of ['productName', 'productId', 'expectedFingerprint', 'productType', 'productModel', 'size', 'clientName', 'proveedorName', 'notas', 'unit', 'priceCurrency']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  return value.estado === undefined || ['pendiente', 'conseguido', 'descartado', 'todos'].includes(String(value.estado));
};

const validProposal = (value: unknown): value is ParsedVoicePayload =>
  object(value) && value.schemaVersion === 1 && text(value.operationId) && String(value.operationId).length <= 200 &&
  typeof value.sourceText === 'string' && (actionTypes.has(String(value.intent)) || ['mixed', 'unknown'].includes(String(value.intent))) &&
  finite(value.confidence) && typeof value.requiresConfirmation === 'boolean' && Array.isArray(value.actions) &&
  value.actions.length > 0 && value.actions.every(validAction) &&
  ['missingFields', 'suggestedPhrases'].every((key) => value[key] === undefined ||
    (Array.isArray(value[key]) && value[key].every((entry: unknown) => typeof entry === 'string')));

export function restorePendingProposal(key: string): ParsedVoicePayload | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    if (object(stored) && stored.version === 1 && validProposal(stored.proposal)) return stored.proposal;
  } catch {
    // Malformed or inaccessible storage must never break session bootstrapping.
  }
  clearStoredProposal(key);
  return null;
}

export function persistPendingProposal(key: string, proposal: ParsedVoicePayload): boolean {
  try {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, proposal }));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredProposal(key: string, operationId?: string): void {
  try {
    // A response from an unmounted provider must not erase a newer draft in this scope.
    if (operationId && restorePendingProposal(key)?.operationId !== operationId) return;
    sessionStorage.removeItem(key);
  } catch { /* Storage can be disabled by browser policy. */ }
}
