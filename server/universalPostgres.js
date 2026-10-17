import { InventoryOperationError } from './inventoryOperations.js';
import { executeInventoryPlanInTransaction } from './inventoryPostgres.js';
import { executeAccountPlanInTransaction } from './accountPostgres.js';
import { executePartyPlanInTransaction } from './partyPostgres.js';
import { prepareUniversalOperation } from './universalOperations.js';
import { operationRequestDigest } from './operationHash.js';

export const UNIVERSAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS universal_operations(
    owner_phone TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    plan_json JSONB NOT NULL,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,operation_id)
  );
`;

/** Orchestration only: all effects/history still come from the established domain adapters. */
export async function executeUniversalPlanInTransaction(client, input, context, persistInventoryTransactions) {
  const {domain,plan,requestHash} = prepareUniversalOperation(input,context), scope = [context.businessId,plan.operationId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['universal',...scope])]);
  const prior = (await client.query('SELECT request_hash,result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2',scope)).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT','El ID universal ya corresponde a otro plan.');
    return prior.result_json;
  }
  const child = {...plan,operationId:`universal-child:${operationRequestDigest([domain,...scope])}`};
  const childContext = {...context,internalUniversalOperation:true};
  const execute = {inventory:executeInventoryPlanInTransaction,accounts:executeAccountPlanInTransaction,parties:executePartyPlanInTransaction}[domain];
  const domainResult = await execute(client,child,childContext);
  if (domain === 'inventory') await persistInventoryTransactions(client,child,domainResult);
  const result = {contractVersion:1,operationId:plan.operationId,businessId:context.businessId,status:'applied',domain,domainResult};
  await client.query('INSERT INTO universal_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [...scope,context.actorId,requestHash,JSON.stringify(plan),JSON.stringify(result)]);
  return result;
}
