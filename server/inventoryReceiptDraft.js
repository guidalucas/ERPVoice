import { isDeepStrictEqual } from 'node:util';
import { productIdentity } from './inventoryOperations.js';

const label = sku => `«${sku.name}»${sku.size ? ` (variante ${sku.size})` : ''}`;
const priceLabel = price => price ? `${price.amount} ${price.currency} (${({initialize:'inicializar',set:'reemplazar',preserve:'conservar'})[price.policy]})` : 'sin precio solicitado';

/** Normalize validated new-product receipts BEFORE freezing a conversation draft.
 * Exact domain identities only; never fuzzy matching or confirmation-time repair.
 * Keep the first item ID and a continuous literal quote covering every merged row.
 * Other actions are ordering barriers, and revisions keep their reviewed IDs.
 */
export function prepareInventoryReceiptDraft(plan, evidence, products, sourceText, { consolidate = true } = {}) {
  const quotes = new Map(evidence.map(item => [item.itemId, item.quote]));
  const catalog = new Map();
  for (const product of products) {
    const identity = productIdentity(product);
    if (!catalog.has(identity)) catalog.set(identity, product);
  }
  const actions = [], seen = new Map(), aliases = new Map();
  let block = 0, mergedCount = 0;
  for (const action of plan.actions) {
    if (action.type !== 'stock.receive' || action.target.kind === 'created') block++;
    if (!action.target || action.target.kind !== 'new' || !/^(stock\.|sku\.)/.test(action.type)) {
      actions.push(action);
      continue;
    }
    const sku = action.target.sku, identity = productIdentity(sku);
    if (catalog.has(identity)) {
      return { question: `El producto ${label(sku)} ya existe en el inventario. ¿Querés sumar las unidades a ese producto en lugar de crear otro igual?` };
    }
    const prior = seen.get(identity);
    if (prior) {
      const first = actions[prior.index];
      if (first.type === 'stock.receive' && action.type === 'stock.receive'
        && !isDeepStrictEqual(first.price, action.price)) {
        return { question: `El producto ${label(sku)} aparece repetido con precios distintos: ${priceLabel(first.price)} y ${priceLabel(action.price)}. ¿Qué precio debe quedar para ese producto? Voy a sumar las cantidades en un único ingreso.` };
      }
      if (!consolidate || prior.block !== block || first.type !== 'stock.receive' || action.type !== 'stock.receive'
        || !isDeepStrictEqual(first.target.sku.family, sku.family)) {
        return { question: `El producto ${label(sku)} aparece más de una vez como producto nuevo. ¿Son unidades del mismo producto o falta indicar una característica que los distingue?` };
      }
      const quantity = first.quantity.value + action.quantity.value;
      if (!Number.isSafeInteger(quantity)) {
        return { question: `La cantidad total de ${label(sku)} supera el máximo admitido. ¿Cuál es la cantidad correcta?` };
      }
      // Both quantity units were already checked against their SKU units.
      actions[prior.index] = { ...first, quantity: { ...first.quantity, value: quantity } };
      const firstQuote = quotes.get(first.itemId), nextQuote = quotes.get(action.itemId);
      const start = Math.min(sourceText.indexOf(firstQuote), sourceText.indexOf(nextQuote));
      const end = Math.max(sourceText.indexOf(firstQuote) + firstQuote.length, sourceText.indexOf(nextQuote) + nextQuote.length);
      quotes.set(first.itemId, sourceText.slice(start, end));
      aliases.set(action.itemId, first.itemId);
      mergedCount++;
    } else {
      seen.set(identity, { index: actions.length, block });
      actions.push(action);
    }
  }
  // Later stock actions and orders can refer to a product created by a receipt.
  // Rebind removed receipt IDs to the retained creation before revalidation.
  const normalized = actions.map(action => {
    let result = action;
    if (action.target?.kind === 'created' && aliases.has(action.target.itemId))
      result = { ...result, target: { ...action.target, itemId: aliases.get(action.target.itemId) } };
    if (action.productRef && aliases.has(action.productRef.itemId))
      result = { ...result, productRef: { ...action.productRef, itemId: aliases.get(action.productRef.itemId) } };
    return result;
  });
  return { actions: normalized, evidence: normalized.map(({itemId}) => ({itemId, quote:quotes.get(itemId)})), mergedCount };
}
