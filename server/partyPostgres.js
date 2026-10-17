import crypto from 'node:crypto';
import { InventoryOperationError } from './inventoryOperations.js';
import { validatePartyPlan, partyPlanDigest, partyResultActions } from './partyOperations.js';

export const PARTY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS party_operations(
    owner_phone TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    plan_json JSONB NOT NULL,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,operation_id)
  );
`;

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
    const isClient = action.type === 'client.create', id = `${isClient ? 'client' : 'proveedor'}-${crypto.randomUUID()}`;
    const saved = isClient
      ? await client.query('INSERT INTO clients(id,owner_phone,name,debt,notas) VALUES($1,$2,$3,0,$4) RETURNING *', [id, context.businessId, action.name, action.notas])
      : await client.query('INSERT INTO proveedores(id,owner_phone,name,notas) VALUES($1,$2,$3,$4) RETURNING *', [id, context.businessId, action.name, action.notas]);
    const actual = saved.rows[0];
    if (saved.rowCount !== 1 || actual.id !== id || actual.owner_phone !== context.businessId || actual.name !== action.name
      || (actual.notas ?? null) !== action.notas || (isClient && (Number(actual.debt) !== 0 || Number(actual.account_revision) !== 0)))
      throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH', 'El alta persistida difiere del plan.');
    const party = { id: actual.id, ownerPhone: actual.owner_phone, name: actual.name,
      ...(isClient ? { debt: Number(actual.debt), accountRevision: Number(actual.account_revision) } : {}), notas: actual.notas ?? null };
    items.push({ itemId: action.itemId, type: action.type, party });
  }
  const result = { contractVersion: 1, operationId: plan.operationId, businessId: context.businessId, status: 'applied', items };
  await client.query('INSERT INTO party_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
    [...scope, context.actorId, hash, JSON.stringify(plan), JSON.stringify(result)]);
  const actions = partyResultActions(result);
  for (const [index, item] of items.entries()) {
    await client.query('INSERT INTO transactions(id,owner_phone,timestamp,source_text,summary,actions_json) VALUES($1,$2,NOW(),$3,$4,$5::jsonb)', [
      `party-${crypto.createHash('sha256').update(JSON.stringify([...scope, item.itemId])).digest('hex')}`, context.businessId,
      plan.source?.text ?? '', `${item.type === 'client.create' ? 'Cliente creado' : 'Proveedor creado'}: ${item.party.name}`, JSON.stringify([actions[index]])]);
  }
  return result;
}
