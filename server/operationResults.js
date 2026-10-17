import { inventoryResultActions } from './inventoryResults.js';
import { orderReceiptAction } from './orderOperations.js';
import { accountResultActions } from './accountOperations.js';
import { partyResultActions } from './partyOperations.js';

/** Channels project applied facts from receipts, independently of the proposed commands. */
export function operationResultActions(result, originalActions = []) {
  if (result.domainResult) return operationResultActions(result.domainResult,originalActions);
  if (result.kind === 'client.merge') return [{type:'client_merge',clientId:result.client.id,clientName:result.client.name,removedClientId:result.removedClientId,balance:result.client.debt},
    ...(result.accountResult ? accountResultActions(result.accountResult) : [])];
  if (Array.isArray(result.receipts)) return result.receipts.flatMap((receipt) => operationResultActions(receipt));
  if (result.pedido) return [orderReceiptAction(result.kind, result.pedido),
    ...(result.inventoryResult ? inventoryResultActions(result.inventoryResult) : [])];
  if (result.items?.[0]?.type.startsWith('account.')) return accountResultActions(result);
  if (['client.create','supplier.create','client.update','supplier.update','client.delete','supplier.delete','supplier.merge'].includes(result.items?.[0]?.type)) return partyResultActions(result);
  return inventoryResultActions(result, originalActions);
}
