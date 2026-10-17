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

export const bindStockConsumptionAction = (action, products) => {
  const sku = skuFromAction(action);
  // Parser IDs/fingerprints are proposals, not server-issued identity authority.
  const exact = products.filter((product) => productIdentity(product) === productIdentity({ ...sku,
    // Legacy parsers may repeat the full name as a type/model. An absent stored
    // descriptor cannot authorize another identity; keep its authoritative absence.
    productType: product.productType == null ? undefined : sku.productType,
    productModel: product.productModel == null ? undefined : sku.productModel,
    unit: action.unit ?? product.unit ?? 'unit' }));
  if (exact.length !== 1) return null;
  const product = exact[0];
  const bound = { ...action, productId: product.id,
    expectedFingerprint: product.identityFingerprint ?? inventoryProductFingerprint(product),
    productName: product.name, productType: product.productType ?? undefined, productModel: product.productModel ?? undefined,
    size: product.size ?? undefined, unit: action.unit ?? product.unit ?? 'unit' };
  if (action.type === 'update_product') bound.expectedRevision = product.revision;
  delete bound.resolvedProductId;
  return bound;
};

/** Absolute edits retain the revision that the caller actually reviewed. */
export const productUpdateActions = (productId, updates, options, prefix = 'item-1') => {
  const target = { kind: 'existing', skuId: productId, expectedRevision: options.expectedRevision,
    ...(options.expectedFingerprint ? { expectedFingerprint: options.expectedFingerprint } : {}) };
  const reason = options.reason ?? 'Actualización confirmada';
  const actions = [];
  const changes = Object.fromEntries(['name', 'productType', 'productModel', 'size', 'attributes', 'price', 'priceCurrency']
    .filter((field) => updates[field] !== undefined).map((field) => [field, updates[field]]));
  if (Object.keys(changes).length) actions.push({ itemId: `${prefix}-update`, type: 'sku.update', target, changes, reason });
  const balances = { ...(updates.stockAvailable !== undefined ? { available: updates.stockAvailable } : {}),
    ...(updates.stockReserved !== undefined ? { reserved: updates.stockReserved } : {}) };
  if (Object.keys(balances).length) actions.push({ itemId: `${prefix}-adjust`, type: 'stock.adjust', target, balances, reason });
  if (!actions.length) throw new InventoryOperationError('INVALID_OPERATION_PLAN', 'No hay cambios de inventario para aplicar.');
  return actions;
};

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
  actions: actions.flatMap((action, index) => {
    if (action.type === 'update_product') {
      const explicitId = action.productId ?? action.resolvedProductId;
      if (typeof explicitId !== 'string' || !explicitId.trim() || (action.productId && action.resolvedProductId && action.productId !== action.resolvedProductId)) throw new InventoryOperationError('SKU_SELECTION_REQUIRED', 'Elegí un SKU explícito para actualizar; no apliqué cambios.');
      return productUpdateActions(explicitId, { price: action.price, priceCurrency: action.priceCurrency,
        stockAvailable: action.stockAvailable, stockReserved: action.stockReserved }, action, `item-${index + 1}`);
    }
    if (action.type === 'sell' || action.type === 'reserve_stock') {
      const explicitId = action.productId ?? action.resolvedProductId;
      if (typeof explicitId !== 'string' || !explicitId.trim()) throw new InventoryOperationError('SKU_SELECTION_REQUIRED', 'Elegí un SKU explícito para vender o reservar; no apliqué cambios.');
      const product = products.find((entry) => entry.id === explicitId);
      if (!product) throw new InventoryOperationError('SKU_NOT_FOUND', 'El SKU seleccionado ya no está disponible.');
      if (action.productId && action.resolvedProductId && action.productId !== action.resolvedProductId) throw new InventoryOperationError('SKU_SELECTION_REQUIRED', 'La selección contiene IDs de SKU incompatibles.');
      return { itemId: `item-${index + 1}`, type: action.type === 'sell' ? 'stock.sell' : 'stock.reserve',
        target: { kind: 'existing', skuId: product.id,
          expectedFingerprint: action.expectedFingerprint ?? product.identityFingerprint ?? inventoryProductFingerprint(product) },
        quantity: { value: action.qty, unit: action.unit ?? product.unit ?? 'unit' },
        ...(action.price != null ? { salePrice: { amount: action.price, currency: action.priceCurrency ?? 'XXX' } } : {}) };
    }
    if (action.type !== 'add_stock') throw new InventoryOperationError('UNSUPPORTED_OPERATION', 'La operación todavía no está migrada al núcleo.');
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
