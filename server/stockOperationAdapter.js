import { normalizeProductMetadata, productBaseName } from './productIdentity.js';
import { productIdentity, inventoryProductFingerprint, InventoryOperationError } from './inventoryOperations.js';

const skuFromAction = (action) => {
  const metadata = normalizeProductMetadata(action);
  const sku = { name: productBaseName(metadata), attributes: action.attributes ?? {}, unit: action.unit ?? 'unit' };
  for (const field of ['productType', 'productModel', 'size']) {
    if (metadata[field] != null) sku[field] = metadata[field];
  }
  return sku;
};

const receiveAction = (action, target, itemId) => ({
  itemId, type: 'stock.receive', target,
  quantity: { value: action.qty, unit: action.unit ?? 'unit' },
  ...(action.price != null ? { price: { amount: action.price, currency: action.priceCurrency ?? 'XXX', policy: 'initialize' } } : {}),
});

/** Compatibility boundary only; evidence and conversational decisions stay outside execution. */
export const resolvedStockBatchToPlan = (batch) => ({
  contractVersion: 1, operationId: batch.id, businessId: batch.ownerPhone,
  source: { channel: 'whatsapp', text: batch.sourceText, messageId: batch.sourceMessageId },
  actions: batch.payload.actions.map((action) => receiveAction(action,
    action.resolution.kind === 'existing'
      ? { kind: 'existing', skuId: action.resolution.productId, expectedFingerprint: action.resolution.fingerprint }
      : { kind: 'new', sku: skuFromAction(action) }, action.itemId)),
});

/** Panel confirmation resolves only exact identities or explicit IDs, never fuzzy names. */
export const confirmedStockActionsToPlan = ({ actions, sourceText, ownerPhone, operationId, products }) => ({
  contractVersion: 1, operationId, businessId: ownerPhone,
  source: { channel: 'panel', text: sourceText },
  actions: actions.map((action, index) => {
    if (action.type !== 'add_stock') throw new InventoryOperationError('UNSUPPORTED_OPERATION', 'Separá los ingresos de las otras operaciones.');
    const sku = skuFromAction(action);
    const explicitId = action.productId ?? action.resolvedProductId;
    const exact = explicitId ? products.filter((product) => product.id === explicitId)
      : products.filter((product) => productIdentity(product) === productIdentity(sku));
    if (explicitId && !exact.length) throw new InventoryOperationError('SKU_NOT_FOUND', 'El producto confirmado ya no está disponible.');
    if (exact.length > 1) throw new InventoryOperationError('SKU_SELECTION_REQUIRED', 'Hay varios SKU con esa identidad. Elegí un ID.');
    // Omission does not mean "the only variant in the catalog".
    if (!exact.length && !sku.size && products.some((product) => product.size && productIdentity({ ...product, size: null, attributes: {} }) === productIdentity({ ...sku, attributes: {} }))) {
      throw new InventoryOperationError('SKU_SELECTION_REQUIRED', 'Falta indicar la variante del producto.');
    }
    return receiveAction(action, exact.length
      ? { kind: 'existing', skuId: exact[0].id, expectedFingerprint: action.expectedFingerprint ?? exact[0].identityFingerprint ?? inventoryProductFingerprint(exact[0]) }
      : { kind: 'new', sku }, `item-${index + 1}`);
  }),
});
