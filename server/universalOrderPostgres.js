import { InventoryOperationError } from './inventoryOperations.js';
import { executeOrderInTransaction } from './orderPostgres.js';
import { validateUniversalOrderPlan, universalOrderPlanDigest, orderActionToRequest } from './universalOrderOperations.js';
import { operationRequestDigest } from './operationHash.js';

/** Universal order blocks delegate every effect to the established order + inventory adapters. */
export async function executeUniversalOrderPlanInTransaction(client,input,context,persistInventoryTransactions) {
  const plan=validateUniversalOrderPlan(input,context),hash=universalOrderPlanDigest(plan),scope=[context.businessId,plan.operationId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['order',...scope])]);
  const prior=(await client.query('SELECT request_hash,result_json FROM order_operations WHERE owner_phone=$1 AND operation_id=$2',scope)).rows[0];
  if (prior) {
    if (prior.request_hash !== hash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT','El ID del bloque de pedidos ya corresponde a otro plan.');
    return prior.result_json;
  }
  // These permissions authorize only the deterministic movements derived from an
  // authorized order transition. The public stock block never receives this grant.
  const orderContext={...context,channel:plan.source?.channel ?? 'operations',
    permissions:[...context.permissions,'inventory:receive','inventory:withdraw','inventory:adjust']};
  const receipts=[];
  for (const action of plan.actions) {
    const operationId=`universal-child:${operationRequestDigest([...scope,action.itemId])}`;
    const request=orderActionToRequest(action,operationId);
    const receipt=await executeOrderInTransaction(client,request.kind,request.pedidoId,request.input,orderContext,persistInventoryTransactions);
    receipts.push({...receipt,itemId:action.itemId});
  }
  const result={contractVersion:1,businessId:context.businessId,operationId:plan.operationId,status:'applied',receipts};
  await client.query('INSERT INTO order_operations(owner_phone,operation_id,actor_id,request_hash,request_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [...scope,context.actorId,hash,JSON.stringify(plan),JSON.stringify(result)]);
  return result;
}
