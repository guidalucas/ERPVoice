import crypto from 'node:crypto';
import { productIdentity } from './inventoryOperations.js';

const identity = (action) => {
  try {
    return productIdentity({ name: action.productName, productType: action.productType,
      productModel: action.productModel, size: action.size, attributes: action.attributes, unit: action.unit });
  } catch {
    // An identity that cannot be proven receives a new item ID.
    return null;
  }
};
const counts = (keys) => keys.reduce((result, key) => result.set(key, (result.get(key) ?? 0) + 1), new Map());

// Replacing a complete list may reorder/add/remove items. Search similarity and
// extraction indexes cannot establish which old item an action continues.
export const reconcileDraftItemIds = (previous, next, { createId = () => `item-${crypto.randomUUID()}` } = {}) => {
  const oldKeys = previous.map(identity);
  const newKeys = next.map(identity);
  const oldCounts = counts(oldKeys);
  const newCounts = counts(newKeys);
  const oldIdCounts = counts(previous.map((action) => action.itemId));
  const reserved = new Set(previous.map((action) => action.itemId).filter(Boolean));
  return next.map((action, index) => {
    const key = newKeys[index];
    const prior = key && oldCounts.get(key) === 1 && newCounts.get(key) === 1
      ? previous[oldKeys.indexOf(key)] : null;
    let itemId = prior?.itemId;
    if (typeof itemId !== 'string' || !itemId.trim() || itemId.length > 200 || oldIdCounts.get(itemId) !== 1) {
      itemId = null;
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = createId();
        if (typeof candidate === 'string' && candidate.trim() && candidate.length <= 200 && !reserved.has(candidate)) {
          itemId = candidate;
          break;
        }
      }
      if (!itemId) throw new Error('Unable to allocate a unique draft item ID');
    }
    reserved.add(itemId);
    return { ...action, itemId };
  });
};
