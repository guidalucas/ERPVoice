import { InventoryOperationError } from './inventoryOperations.js';
import { executeAccountPlanInTransaction } from './accountPostgres.js';
import { operationRequestDigest } from './operationHash.js';

/** Entity merge and its account transfer share one transaction and immutable parent receipt. */
export async function mergeClientsInTransaction(client, keepId, mergeId, input, context) {
  if (!context?.businessId || context.businessId === '__default__' || !context.actorId || !context.permissions?.includes('clients:merge')) throw new InventoryOperationError('FORBIDDEN', 'Falta autorización para fusionar clientes.');
  if (typeof input.operationId !== 'string' || !input.operationId.trim()) throw new InventoryOperationError('OPERATION_ID_REQUIRED', 'La fusión necesita un ID estable.');
  if (typeof keepId !== 'string' || !keepId.trim() || typeof mergeId !== 'string' || !mergeId.trim() || keepId === mergeId
    || ![input.expectedKeepRevision,input.expectedMergeRevision].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new InventoryOperationError('INVALID_ACCOUNT_OPERATION', 'Revisá ambos clientes y sus revisiones antes de fusionar.');
  const request = {kind:'client.merge',keepId,mergeId,expectedKeepRevision:input.expectedKeepRevision,expectedMergeRevision:input.expectedMergeRevision};
  const operationId = `client-merge:${input.operationId}`, scope = [context.businessId,operationId], requestHash = operationRequestDigest(request);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['account',...scope])]);
  const prior = (await client.query('SELECT request_hash,result_json FROM account_operations WHERE owner_phone=$1 AND operation_id=$2',scope)).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID de fusión corresponde a otros clientes/revisiones.');
    return prior.result_json;
  }
  const transferId = `client-merge-transfer:${operationRequestDigest(scope)}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['account',context.businessId,transferId])]);
  await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
  const owners = context.ownerPhoneVariants ?? [context.businessId];
  const rows = (await client.query('SELECT * FROM clients WHERE id=ANY($1) AND owner_phone=ANY($2) ORDER BY id FOR UPDATE',[[keepId,mergeId],owners])).rows;
  const keep = rows.find((row) => row.id === keepId), source = rows.find((row) => row.id === mergeId);
  if (!keep || !source) throw new InventoryOperationError('CLIENT_NOT_FOUND', 'Uno de los clientes no pertenece al negocio.');
  if (Number(keep.account_revision) !== input.expectedKeepRevision || Number(source.account_revision) !== input.expectedMergeRevision) throw new InventoryOperationError('ACCOUNT_REVISION_MISMATCH', 'El saldo de uno de los clientes cambió. Revisá antes de fusionar.');
  if (![keep.debt,source.debt].every((value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0)) throw new InventoryOperationError('INVALID_ACCOUNT_OPERATION', 'Los saldos históricos requieren conciliación antes de fusionar.');
  let accountResult = null;
  if (Number(source.debt) > 0) accountResult = await executeAccountPlanInTransaction(client, {
    contractVersion:1,businessId:context.businessId,operationId:transferId,source:{channel:'clients',text:'Fusión explícita de cuentas'},
    actions:[{itemId:'transfer',type:'account.transfer',target:{kind:'existing',clientId:mergeId,expectedRevision:input.expectedMergeRevision},
      destination:{clientId:keepId,expectedRevision:input.expectedKeepRevision},amount:{value:Number(source.debt),unit:'legacy-money'},reason:'Fusión explícita de clientes'}],
  }, {...context,internalClientMerge:true});
  await client.query('UPDATE pedidos SET cliente_id=$1,revision=revision+1 WHERE cliente_id=$2 AND owner_phone=ANY($3)',[keepId,mergeId,owners]);
  const notes = [keep.notas,source.notas].filter(Boolean).join('\n').trim() || null;
  const saved = (await client.query('UPDATE clients SET notas=$1,metadata_revision=metadata_revision+1 WHERE id=$2 AND owner_phone=ANY($3) RETURNING *',[notes,keepId,owners])).rows[0];
  const deleted = await client.query('DELETE FROM clients WHERE id=$1 AND owner_phone=ANY($2) AND debt=0 RETURNING id',[mergeId,owners]);
  if (!saved || saved.notas !== notes || Number(saved.debt) !== Number(keep.debt)+Number(source.debt) || Number(saved.metadata_revision) !== Number(keep.metadata_revision)+1 || deleted.rowCount !== 1) throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH', 'La fusión persistida no coincide con el plan.');
  const result = {contractVersion:1,kind:'client.merge',operationId,businessId:context.businessId,status:'applied',removedClientId:mergeId,
    client:{id:saved.id,ownerPhone:saved.owner_phone,name:saved.name,debt:Number(saved.debt),notas:saved.notas,accountRevision:Number(saved.account_revision),metadataRevision:Number(saved.metadata_revision)},accountResult};
  await client.query('INSERT INTO account_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [...scope,context.actorId,requestHash,JSON.stringify(request),JSON.stringify(result)]);
  await client.query('INSERT INTO transactions(id,owner_phone,timestamp,source_text,summary,actions_json) VALUES($1,$2,NOW(),$3,$4,$5::jsonb)',
    [`client-merge-${operationRequestDigest(scope)}`,context.businessId,'Fusión explícita de clientes',`Clientes fusionados: ${source.name} → ${saved.name}; saldo ${saved.debt}`,
      JSON.stringify([{type:'client_merge',clientId:keepId,removedClientId:mergeId,clientName:saved.name,balance:Number(saved.debt)}])]);
  return result;
}
