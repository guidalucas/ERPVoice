import { InventoryOperationError } from './inventoryOperations.js';
import { normalizeOrderRequest, ORDER_DATA_FIELDS as dataFields, ORDER_RECONCILIATION_FIELDS as proofFields } from './orderOperations.js';
import { operationRequestDigest } from './operationHash.js';

const fail = (code, message) => { throw new InventoryOperationError(code, message); };
const invalid = () => fail('INVALID_ORDER_OPERATION', 'El plan de pedidos contiene campos inválidos.');
const record = (value, keys) => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value') || property.value === undefined) invalid();
    result[key] = property.value;
  }
  return result;
};
const text = (value, max = 180) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  return value.trim();
};
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const kinds = new Set(['create', 'update', 'delete', 'reconcile']);

const normalizeAction = (input) => {
  const action = record(input, ['itemId', 'type', 'order', 'target', 'changes', 'reconciliation']);
  const itemId = text(action.itemId);
  if (typeof action.type !== 'string' || !action.type.startsWith('order.')) invalid();
  const kind = action.type.slice(6);
  if (!kinds.has(kind)) invalid();
  const allowed = kind === 'create' ? ['itemId', 'type', 'order'] : ['itemId', 'type', 'target', ...(kind === 'update' ? ['changes'] : kind === 'reconcile' ? ['reconciliation'] : [])];
  if (Object.keys(action).some(key => !allowed.includes(key))) invalid();
  const target = kind === 'create' ? null : record(action.target, ['kind', 'pedidoId', 'expectedRevision']);
  if (target && target.kind !== 'existing') invalid();
  const payload = kind === 'create' ? record(action.order, dataFields)
    : kind === 'update' ? record(action.changes, dataFields)
      : kind === 'reconcile' ? { reconciliation: record(action.reconciliation, proofFields) } : {};
  const request = normalizeOrderRequest(kind, target?.pedidoId, { operationId: 'normalization', ...(target ? { expectedRevision: target.expectedRevision } : {}), ...payload });
  return { itemId, type: action.type,
    ...(kind === 'create' ? { order: request.changes } : { target: { kind: 'existing', pedidoId: request.pedidoId, expectedRevision: request.expectedRevision } }),
    ...(kind === 'update' ? { changes: request.changes } : kind === 'reconcile' ? { reconciliation: request.reconciliation } : {}) };
};

export function normalizeUniversalOrderPlan(input) {
  const plan = record(input, ['contractVersion', 'operationId', 'businessId', 'source', 'actions']);
  if (plan.contractVersion !== 1) invalid();
  const result = { contractVersion: 1, operationId: text(plan.operationId), businessId: text(plan.businessId), actions: [] };
  if (!Array.isArray(plan.actions) || Object.getPrototypeOf(plan.actions) !== Array.prototype || !plan.actions.length || plan.actions.length > 100 || Reflect.ownKeys(plan.actions).length !== plan.actions.length + 1) invalid();
  const seen = new Set();
  result.actions = Array.from({ length: plan.actions.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(plan.actions, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
    const action = normalizeAction(property.value);
    if (seen.has(action.itemId)) invalid();
    seen.add(action.itemId);
    return action;
  });
  if (Object.hasOwn(plan, 'source')) {
    const source = record(plan.source, ['channel', 'text', 'messageId', 'requestHash']);
    result.source = { channel: text(source.channel, Infinity) };
    for (const key of ['text', 'messageId', 'requestHash']) if (Object.hasOwn(source, key)) {
      if (typeof source[key] !== 'string' || (key === 'requestHash' && !source[key].trim())) invalid();
      result.source[key] = source[key];
    }
  }
  return freeze(result);
}

export function validateUniversalOrderPlan(input, context) {
  if (typeof context?.businessId !== 'string' || !context.businessId.trim() || context.businessId === '__default__' || typeof context.actorId !== 'string' || !context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED', 'Falta el negocio/actor autorizado.');
  if (!(Array.isArray(context.permissions) || context.permissions instanceof Set)) fail('FORBIDDEN', 'Faltan permisos de pedidos.');
  const plan = normalizeUniversalOrderPlan(input);
  if (plan.businessId !== context.businessId) fail('BUSINESS_SCOPE_MISMATCH', 'El plan no pertenece al negocio autorizado.');
  if (plan.operationId.startsWith('universal-child:') && !context.internalUniversalOperation) fail('FORBIDDEN', 'Los IDs internos universales están reservados al ejecutor universal.');
  for (const action of plan.actions) if (![...context.permissions].includes(`orders:${action.type.slice(6)}`)) fail('FORBIDDEN', 'No tenés permiso para esta operación de pedido.');
  return plan;
}

export const universalOrderPlanDigest = (input) => {
  const { source, ...plan } = normalizeUniversalOrderPlan(input);
  return operationRequestDigest({ ...plan, ...(source?.requestHash ? { requestHash: source.requestHash } : {}) });
};

export function orderActionToRequest(action, operationId) {
  const normalized = normalizeAction(action), kind = normalized.type.slice(6);
  const request = normalizeOrderRequest(kind, normalized.target?.pedidoId, {
    operationId: text(operationId),
    ...(normalized.target ? { expectedRevision: normalized.target.expectedRevision } : {}),
    ...(kind === 'create' ? normalized.order : kind === 'update' ? normalized.changes : kind === 'reconcile' ? { reconciliation: normalized.reconciliation } : {}),
  });
  return { kind, pedidoId: request.pedidoId, input: { operationId: request.operationId,
    ...(kind !== 'create' ? { expectedRevision: request.expectedRevision } : {}),
    ...(kind === 'create' || kind === 'update' ? request.changes : kind === 'reconcile' ? { reconciliation: request.reconciliation } : {}) } };
}
