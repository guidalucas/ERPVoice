import { inventoryResultActions } from './inventoryResults.js';
import { orderReceiptAction } from './orderOperations.js';

/** Channels project applied facts from receipts, independently of the proposed commands. */
export function operationResultActions(result, originalActions = []) {
  if (Array.isArray(result.receipts)) return result.receipts.flatMap((receipt) => operationResultActions(receipt));
  if (result.pedido) return [orderReceiptAction(result.kind, result.pedido),
    ...(result.inventoryResult ? inventoryResultActions(result.inventoryResult) : [])];
  return inventoryResultActions(result, originalActions);
}
