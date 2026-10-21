import { inventoryPriceToMoney } from '../inventoryMoneyPolicy.js';
import { inventoryProductFingerprint } from '../inventoryOperations.js';
import { variantLabel, commercialSpecifications } from './presentation.js';

export function buildCommercialReadiness(product, skus, images, policy) {
  const blockers = new Set(), seenSizes = new Set(), moneyIssues = [];
  const variants = skus.map(sku => {
    let money = null, fingerprint = null;
    try { money = inventoryPriceToMoney(sku.price, sku.priceCurrency, policy); } catch { if (sku.status === 'active') {
      blockers.add('MONEY_UNCONFIRMED');
      moneyIssues.push({ skuId: sku.id, cause: !policy ? 'POLICY_MISSING' : sku.priceCurrency !== policy.currency ? 'CURRENCY_MISMATCH' : 'INVALID_PRICE' });
    } }
    try { fingerprint = inventoryProductFingerprint(sku); } catch { blockers.add('SKU_IDENTITY_INVALID'); }
    const validStock = [sku.stockAvailable, sku.stockReserved].every(value => Number.isSafeInteger(value) && value >= 0);
    if (!validStock) blockers.add('INVENTORY_INVALID');
    const active = sku.status === 'active';
    const identityReviewed = fingerprint !== null && fingerprint === sku.linkFingerprint;
    if (active && !identityReviewed) blockers.add('SKU_IDENTITY_CHANGED');
    if (active && !(sku.unit ?? 'unit').trim()) blockers.add('INVALID_VARIANT');
    if (active) {
      const size = variantLabel(sku).normalize('NFC').trim().toLowerCase();
      if (seenSizes.has(size)) blockers.add('DUPLICATE_SIZE');
      seenSizes.add(size);
    }
    if (active && money && BigInt(money.amountMinor) <= 0n) blockers.add('PRICE_NOT_READY');
    return { skuId: sku.id, name: sku.name, size: sku.size, label: variantLabel(sku), unit: sku.unit ?? 'unit',
      productType: sku.productType ?? null, specifications: commercialSpecifications(sku.attributes), active, revision: sku.revision,
      identityFingerprint: fingerprint, identityReviewed, stockAvailable: validStock ? sku.stockAvailable : null,
      stockReserved: validStock ? sku.stockReserved : null, price: money };
  });
  const active = variants.filter(variant => variant.active);
  if (!active.length) blockers.add('NO_ACTIVE_SKU');
  if (!product.title?.trim()) blockers.add('IDENTITY_INCOMPLETE');
  const readyImages = images.filter(image => image.status === 'ready');
  const hasCover = readyImages.some(image => image.id === product.coverImageId);
  const available = active.filter(variant => variant.identityReviewed && variant.stockAvailable !== null && variant.stockAvailable > 0);
  const total = available.reduce((sum, variant) => sum + BigInt(variant.stockAvailable), 0n);
  const comparable = (available.length ? available : active).filter(variant => variant.price);
  let priceRange = null;
  if (comparable.length && comparable.every(variant => variant.price.currency === comparable[0].price.currency)) {
    const sorted = comparable.map(variant => variant.price.amountMinor).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    priceRange = { currency: comparable[0].price.currency, fractionDigits: comparable[0].price.fractionDigits,
      minAmountMinor: sorted[0], maxAmountMinor: sorted.at(-1) };
  }
  const blocked = [...blockers];
  const missingFields = product.title?.trim() ? [] : ['title'];
  return { variants, priceRange, availability: blockers.has('INVENTORY_INVALID') ? 'unavailable' : total > 0n ? 'in_stock' : 'out_of_stock',
    availableQuantity: total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null,
    readiness: { blockers: blocked, missingFields, moneyIssues, canPrepare: blocked.length === 0 && product.status !== 'archived',
      canGenerateStory: blocked.length === 0 && hasCover && product.status === 'ready' && available.length > 0 } };
}
