import { InventoryOperationError } from './inventoryOperations.js';

const supported = Object.freeze({ ARS: 2, UYU: 2, USD: 2 });
export function validateMoneyPolicy(policy) {
  if (!policy || !Object.hasOwn(supported, policy.currency) || policy.storageUnit !== 'major_integer'
    || policy.fractionDigits !== supported[policy.currency] || !Number.isSafeInteger(policy.revision) || policy.revision < 1) {
    throw new InventoryOperationError('MONEY_UNCONFIRMED', 'La moneda y la escala del inventario necesitan confirmación.');
  }
  return policy;
}
export function inventoryPriceToMoney(price, currency, policy) {
  validateMoneyPolicy(policy);
  const raw = typeof price === 'number' && Number.isSafeInteger(price) ? String(price) : typeof price === 'string' ? price : '';
  if (!/^(0|[1-9]\d*)$/.test(raw) || BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER) || currency !== policy.currency) {
    throw new InventoryOperationError('MONEY_UNCONFIRMED', 'El precio no coincide con la moneda o escala confirmada.');
  }
  return { amountMinor: (BigInt(raw) * 10n ** BigInt(policy.fractionDigits)).toString(), currency, fractionDigits: policy.fractionDigits };
}

/** Call only for a NEW price-writing operation, after receipt replay. No implicit defaults/conversions. */
export function enforceInventoryMoneyPolicy(actions, policy) {
  validateMoneyPolicy(policy);
  for (const action of actions) {
    if (action.price) inventoryPriceToMoney(action.price.amount, action.price.currency, policy);
    if (action.salePrice) inventoryPriceToMoney(action.salePrice.amount, action.salePrice.currency, policy);
    if (action.changes && (Object.hasOwn(action.changes, 'price') || Object.hasOwn(action.changes, 'priceCurrency'))) {
      // Partial price/currency changes are checked against the resolved resulting SKU by the executor.
      if (Object.hasOwn(action.changes, 'priceCurrency') && action.changes.priceCurrency !== policy.currency) {
        throw new InventoryOperationError('MONEY_UNCONFIRMED', 'La moneda no coincide con la política del inventario.');
      }
    }
  }
}
