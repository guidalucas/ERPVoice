import crypto from 'node:crypto';
import { InventoryOperationError } from './inventoryOperations.js';
import { validatePartyPlan, partyPlanDigest, partyResultActions, planPartyUpdate } from './partyOperations.js';

export const PARTY_SCHEMA_SQL = `
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS metadata_revision BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS metadata_revision BIGINT NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS party_operations(
    owner_phone TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    plan_json JSONB NOT NULL,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,operation_id)
  );
`;

export const partyRowToEntity = (row, isClient) => ({ id:row.id,ownerPhone:row.owner_phone,name:row.name,
  metadataRevision:Number(row.metadata_revision),notas:row.notas ?? null,
  ...(isClient ? {debt:Number(row.debt),accountRevision:Number(row.account_revision)} : {}) });

/** Caller owns the transaction; orders use this exact writer inside their atomic batch. */
export async function executePartyPlanInTransaction(client, input, context) {
  const plan = validatePartyPlan(input, context), hash = partyPlanDigest(plan), scope = [context.businessId, plan.operationId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['party', ...scope])]);
  const prior = await client.query('SELECT request_hash,result_json FROM party_operations WHERE owner_phone=$1 AND operation_id=$2', scope);
  if (prior.rowCount) {
    if (prior.rows[0].request_hash !== hash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID ya corresponde a otra alta.');
    return prior.rows[0].result_json;
  }
  // Keep the shared ordering while legacy metadata/order writers remain active.
  await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
  const items = [];
  for (const action of plan.actions) {
    const isClient = action.type.startsWith('client.'), create = action.type.endsWith('.create');
    const table = isClient ? 'clients' : 'proveedores';
    const id = create ? `${isClient ? 'client' : 'proveedor'}-${crypto.randomUUID()}` : action.target.partyId;
    let saved, expected;
    if (create) {
      expected = {id,ownerPhone:context.businessId,name:action.name,notas:action.notas,metadataRevision:0,...(isClient ? {debt:0,accountRevision:0} : {})};
      saved = isClient
      ? await client.query('INSERT INTO clients(id,owner_phone,name,debt,notas) VALUES($1,$2,$3,0,$4) RETURNING *', [id, context.businessId, action.name, action.notas])
      : await client.query('INSERT INTO proveedores(id,owner_phone,name,notas) VALUES($1,$2,$3,$4) RETURNING *', [id, context.businessId, action.name, action.notas]);
    } else {
      const current = (await client.query(`SELECT * FROM ${table} WHERE id=$1 AND owner_phone=ANY($2) FOR UPDATE`,[id,context.ownerPhoneVariants ?? [context.businessId]])).rows[0];
      expected = planPartyUpdate(action,current ? partyRowToEntity(current,isClient) : null);
      saved = await client.query(`UPDATE ${table} SET name=$1,notas=$2,metadata_revision=metadata_revision+1
        WHERE id=$3 AND owner_phone=ANY($4) AND metadata_revision=$5 RETURNING *`,
        [expected.name,expected.notas,id,context.ownerPhoneVariants ?? [context.businessId],action.target.expectedRevision]);
    }
    const actual = saved.rows[0];
    if (saved.rowCount !== 1 || actual.id !== id || actual.owner_phone !== expected.ownerPhone || actual.name !== expected.name
      || (actual.notas ?? null) !== expected.notas || Number(actual.metadata_revision) !== expected.metadataRevision
      || (isClient && (Number(actual.debt) !== expected.debt || Number(actual.account_revision) !== expected.accountRevision)))
      throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH', 'El cliente/proveedor persistido difiere del plan.');
    const party = partyRowToEntity(actual,isClient);
    items.push({ itemId: action.itemId, type: action.type, party });
  }
  const result = { contractVersion: 1, operationId: plan.operationId, businessId: context.businessId, status: 'applied', items };
  await client.query('INSERT INTO party_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [...scope, context.actorId, hash, JSON.stringify(plan), JSON.stringify(result)]);
  const actions = partyResultActions(result);
  for (const [index, item] of items.entries()) {
    await client.query('INSERT INTO transactions(id,owner_phone,timestamp,source_text,summary,actions_json) VALUES($1,$2,NOW(),$3,$4,$5::jsonb)', [
      `party-${crypto.createHash('sha256').update(JSON.stringify([...scope, item.itemId])).digest('hex')}`, context.businessId,
      plan.source?.text ?? '', `${item.type.startsWith('client.') ? 'Cliente' : 'Proveedor'} ${item.type.endsWith('.create') ? 'creado' : 'actualizado'}: ${item.party.name}`, JSON.stringify([actions[index]])]);
  }
  return result;
}
