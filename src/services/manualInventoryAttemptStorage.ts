import type { ManualInventoryOperation } from './productService';

export type ManualMovementInput = Omit<ManualInventoryOperation, 'contractVersion' | 'businessId'>;
export type ManualInventoryAttempt = { version: 1; operation: ManualMovementInput; acknowledged: boolean };
type Mode = 'ingreso' | 'venta';

export const manualInventoryAttemptKey = (tenant: string, actor: string, mode: Mode) =>
  `manual-inventory-attempt:${JSON.stringify([tenant, actor, mode])}`;

const record = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(',') === expected.sort().join(',');
const text = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
const integer = (value: unknown, min = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

function validate(value: unknown, mode: Mode): asserts value is ManualInventoryAttempt {
  const attempt = record(value), operation = record(attempt.operation), source = record(operation.source);
  const actions = Array.isArray(operation.actions) ? operation.actions : [];
  const action = record(actions[0]), target = record(action.target), quantity = record(action.quantity);
  const hasPrice = Object.prototype.hasOwnProperty.call(action, 'salePrice'), price = record(action.salePrice);
  if (!keys(attempt, ['version', 'operation', 'acknowledged']) || attempt.version !== 1 || typeof attempt.acknowledged !== 'boolean'
    || !keys(operation, ['operationId', 'source', 'actions']) || !text(operation.operationId)
    || (operation.operationId as string).length > 180 || !keys(source, ['channel', 'text']) || source.channel !== 'manual' || !text(source.text)
    || actions.length !== 1 || !keys(action, ['itemId', 'type', 'target', 'quantity', ...(hasPrice ? ['salePrice'] : [])])
    || !text(action.itemId) || action.type !== (mode === 'ingreso' ? 'stock.receive' : 'stock.sell')
    || !keys(target, ['kind', 'skuId', 'expectedRevision', 'expectedFingerprint']) || target.kind !== 'existing'
    || !text(target.skuId) || !integer(target.expectedRevision) || !text(target.expectedFingerprint)
    || !keys(quantity, ['value', 'unit']) || !integer(quantity.value, 1) || !text(quantity.unit)
    || (hasPrice && (mode !== 'venta' || !keys(price, ['amount', 'currency']) || !integer(price.amount)
      || typeof price.currency !== 'string' || !/^[A-Z]{3}$/.test(price.currency)))) {
    throw new Error('La referencia guardada del movimiento no es válida. No se enviaron cambios.');
  }
}

export function loadManualInventoryAttempt(key: string, mode: Mode): ManualInventoryAttempt | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('La referencia guardada del movimiento no es válida. No se enviaron cambios.'); }
  validate(parsed, mode);
  return parsed;
}

export function saveManualInventoryAttempt(key: string, mode: Mode, attempt: ManualInventoryAttempt) {
  validate(attempt, mode);
  try { localStorage.setItem(key, JSON.stringify(attempt)); }
  catch { throw new Error('No pudimos guardar la referencia recuperable del movimiento. No cierres esta ventana; reintentá cuando haya espacio disponible.'); }
}

export function clearManualInventoryAttempt(key: string) {
  localStorage.removeItem(key);
}
