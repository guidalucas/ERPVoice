import { InventoryOperationError } from './inventoryOperations.js';
import { executeAccountPlanInTransaction } from './accountPostgres.js';
import { operationRequestDigest } from './operationHash.js';
import { executePartyPlanInTransaction, movePartyOrders } from './partyPostgres.js';

/** Entity merge and its account transfer share one transaction and immutable parent receipt. */
export async function mergeClientsInTransaction(client, keepId, mergeId, input, context) {
  if (!context?.businessId || context.businessId === '__default__' || !context.actorId || !context.permissions?.includes('clients:merge')) throw new InventoryOperationError('FORBIDDEN', 'Falta autorización para fusionar clientes.');
  if (typeof input.operationId !== 'string' || !input.operationId.trim()) throw new InventoryOperationError('OPERATION_ID_REQUIRED', 'La fusión necesita un ID estable.');
  if (typeof keepId !== 'string' || !keepId.trim() || typeof mergeId !== 'string' || !mergeId.trim() || keepId === mergeId
    || ![input.expectedKeepRevision,input.expectedMergeRevision].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new InventoryOperationError('INVALID_ACCOUNT_OPERATION', 'Revisá ambos clientes y sus revisiones antes de fusionar.');
  const request = {kind:'client.merge',keepId,mergeId,expectedKeepRevision:input.expectedKeepRevision,expectedMergeRevision:input.expectedMergeRevision};
  if (input.expectedKeepMetadataRevision !== undefined || input.expectedMergeMetadataRevision !== undefined) {
    request.expectedKeepMetadataRevision = input.expectedKeepMetadataRevision;
    request.expectedMergeMetadataRevision = input.expectedMergeMetadataRevision;
  }
  const operationId = `client-merge:${input.operationId}`, scope = [context.businessId,operationId], requestHash = operationRequestDigest(request);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['account',...scope])]);
  const prior = (await client.query('SELECT request_hash,result_json FROM account_operations WHERE owner_phone=$1 AND operation_id=$2',scope)).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID de fusión corresponde a otros clientes/revisiones.');
    return prior.result_json;
  }
  // Previously stored receipts retain their original hash; all new merges review metadata too.
  if (![input.expectedKeepMetadataRevision,input.expectedMergeMetadataRevision].every((value) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER))
    throw new InventoryOperationError('INVALID_ACCOUNT_OPERATION','Revisá los metadatos y saldos de ambos clientes antes de fusionar.');
  const transferId = `client-merge-transfer:${operationRequestDigest(scope)}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['account',context.businessId,transferId])]);
  await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
  const owners = context.ownerPhoneVariants ?? [context.businessId];
  const rows = (await client.query('SELECT * FROM clients WHERE id=ANY($1) AND owner_phone=ANY($2) ORDER BY id FOR UPDATE',[[keepId,mergeId],owners])).rows;
  const keep = rows.find((row) => row.id === keepId), source = rows.find((row) => row.id === mergeId);
  if (!keep || !source) throw new InventoryOperationError('CLIENT_NOT_FOUND', 'Uno de los clientes no pertenece al negocio.');
  if (Number(keep.account_revision) !== input.expectedKeepRevision || Number(source.account_revision) !== input.expectedMergeRevision) throw new InventoryOperationError('ACCOUNT_REVISION_MISMATCH', 'El saldo de uno de los clientes cambió. Revisá antes de fusionar.');
  if (Number(keep.metadata_revision) !== input.expectedKeepMetadataRevision || Number(source.metadata_revision) !== input.expectedMergeMetadataRevision) throw new InventoryOperationError('PARTY_REVISION_MISMATCH','Los datos de uno de los clientes cambiaron. Revisá antes de fusionar.');
  if (![keep.debt,source.debt].every((value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0)) throw new InventoryOperationError('INVALID_ACCOUNT_OPERATION', 'Los saldos históricos requieren conciliación antes de fusionar.');
  let accountResult = null;
  if (Number(source.debt) > 0) accountResult = await executeAccountPlanInTransaction(client, {
    contractVersion:1,businessId:context.businessId,operationId:transferId,source:{channel:'clients',text:'Fusión explícita de cuentas'},
    actions:[{itemId:'transfer',type:'account.transfer',target:{kind:'existing',clientId:mergeId,expectedRevision:input.expectedMergeRevision},
      destination:{clientId:keepId,expectedRevision:input.expectedKeepRevision},amount:{value:Number(source.debt),unit:'legacy-money'},reason:'Fusión explícita de clientes'}],
  }, {...context,internalClientMerge:true});
  const linked = await client.query('SELECT * FROM pedidos WHERE cliente_id=$1 AND owner_phone=ANY($2) ORDER BY id FOR UPDATE',[mergeId,owners]);
  const affectedOrders = await movePartyOrders(client,linked.rows,mergeId,keepId,owners,'client');
  const notes = [keep.notas,source.notas].filter(Boolean).join('\n').trim() || null;
  const metadataResult = await executePartyPlanInTransaction(client, {contractVersion:1,businessId:context.businessId,
    operationId:`client-merge-party:${operationRequestDigest(scope)}`,source:{channel:'clients',text:'Fusión explícita de clientes'},
    actions:[{itemId:'keep',type:'client.update',target:{kind:'existing',partyId:keepId,expectedRevision:input.expectedKeepMetadataRevision},changes:{notas:notes}},
      {itemId:'source',type:'client.delete',target:{kind:'existing',partyId:mergeId,expectedRevision:input.expectedMergeMetadataRevision,
        expectedAccountRevision:Number(source.account_revision)+(Number(source.debt)>0 ? 1 : 0)},reason:'Origen eliminado después de transferir saldo y pedidos en fusión explícita'}],
  }, {...context,internalClientMerge:true,permissions:[...context.permissions,'clients:update','clients:delete']});
  const saved = metadataResult.items[0].party;
  if (saved.notas !== notes || saved.debt !== Number(keep.debt)+Number(source.debt) || saved.metadataRevision !== Number(keep.metadata_revision)+1) throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH','La fusión persistida no coincide con el plan.');
  const result = {contractVersion:1,kind:'client.merge',operationId,businessId:context.businessId,status:'applied',removedClientId:mergeId,
    client:saved,accountResult,metadataResult,affectedOrders};
  await client.query('INSERT INTO account_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [...scope,context.actorId,requestHash,JSON.stringify(request),JSON.stringify(result)]);
  await client.query('INSERT INTO transactions(id,owner_phone,timestamp,source_text,summary,actions_json) VALUES($1,$2,NOW(),$3,$4,$5::jsonb)',
    [`client-merge-${operationRequestDigest(scope)}`,context.businessId,'Fusión explícita de clientes',`Clientes fusionados: ${source.name} → ${saved.name}; saldo ${saved.debt}`,
      JSON.stringify([{type:'client_merge',clientId:keepId,removedClientId:mergeId,clientName:saved.name,balance:Number(saved.debt)}])]);
  return result;
}
