import { InventoryOperationError } from './inventoryOperations.js';
import { executeInventoryPlanInTransaction } from './inventoryPostgres.js';
import { executeAccountPlanInTransaction } from './accountPostgres.js';
import { executePartyPlanInTransaction } from './partyPostgres.js';
import { prepareUniversalOperation } from './universalOperations.js';
import { operationRequestDigest } from './operationHash.js';
import { executeUniversalOrderPlanInTransaction } from './universalOrderPostgres.js';

export const UNIVERSAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS universal_operations(
    owner_phone TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    plan_json JSONB NOT NULL,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,operation_id)
  );
`;

/** Orchestration only: all effects/history still come from the established domain adapters. */
export async function executeUniversalPlanInTransaction(client, input, context, persistInventoryTransactions) {
  const {domain,plan,segments,requestHash} = prepareUniversalOperation(input,context), scope = [context.businessId,plan.operationId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['universal',...scope])]);
  const prior = (await client.query('SELECT request_hash,result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2',scope)).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT','El ID universal ya corresponde a otro plan.');
    return prior.result_json;
  }
  const childContext = {...context,internalUniversalOperation:true};
  const blocks = domain === 'mixed' ? segments : [{domain,plan}], receipts = [], createdEntities = new Map();
  // Child IDs are reserved for this root/ordinal, so domain callers cannot claim
  // the same child ID and introduce a reverse lock dependency.
  for (const [index,block] of blocks.entries()) {
    const child = {...block.plan,operationId:`universal-child:${operationRequestDigest(domain === 'mixed' ? [block.domain,...scope,index] : [domain,...scope])}`,
      actions: block.plan.actions.map(action => {
        const resolve=ref=>{
          const entity=createdEntities.get(ref.itemId);
          if(!entity) throw new InventoryOperationError('INVALID_OPERATION_REFERENCE','No se obtuvo el alta referenciada para esta operación.');
          return entity;
        };
        if (block.domain==='accounts' && action.target.kind==='created') {
          const entity=resolve(action.target);
          return {...action,target:{kind:'existing',clientId:entity.id,expectedRevision:entity.accountRevision}};
        }
        if (block.domain!=='orders' || !['clientRef','supplierRef','productRef'].some(key=>action[key])) return action;
        const bound={...action},field=action.type==='order.create'?'order':'changes';bound[field]={...action[field]};
        for(const [key,idField] of [['clientRef','clienteId'],['supplierRef','proveedorId'],['productRef','productId']]) if(action[key]) {
          bound[field][idField]=resolve(action[key]).id;delete bound[key];
        }
        return bound;
      })};
    const execute = {inventory:executeInventoryPlanInTransaction,accounts:executeAccountPlanInTransaction,parties:executePartyPlanInTransaction,orders:executeUniversalOrderPlanInTransaction}[block.domain];
    const receipt = await execute(client,child,childContext,persistInventoryTransactions);
    if (block.domain === 'inventory') await persistInventoryTransactions(client,child,receipt);
    if (block.domain === 'parties') for (const item of receipt.items)
      if (['client.create','supplier.create'].includes(item.type)) createdEntities.set(item.itemId,item.party);
    if (block.domain === 'inventory') for (const item of receipt.items)
      if (item.created) createdEntities.set(item.itemId,{id:item.skuId});
    receipts.push(receipt);
  }
  const result = {contractVersion:1,operationId:plan.operationId,businessId:context.businessId,status:'applied',domain,
    ...(domain === 'mixed' ? {receipts} : {domainResult:receipts[0]})};
  await client.query('INSERT INTO universal_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [...scope,context.actorId,requestHash,JSON.stringify(plan),JSON.stringify(result)]);
  return result;
}
