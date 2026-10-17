import crypto from 'node:crypto';
import { InventoryOperationError } from './inventoryOperations.js';
import { validatePartyPlan, partyPlanDigest, partyResultActions, planPartyUpdate, planPartyDelete, planSupplierMerge } from './partyOperations.js';
import { operationRequestDigest } from './operationHash.js';

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

const mismatch = () => { throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH','El cliente/proveedor persistido difiere del plan.'); };
const loadParty = async (client, table, id, owners) => (await client.query(`SELECT * FROM ${table} WHERE id=$1 AND owner_phone=ANY($2) FOR UPDATE`,[id,owners])).rows[0];

export async function movePartyOrders(client, before, sourceId, destinationId, owners, kind = 'supplier') {
  const column = kind === 'client' ? 'cliente_id' : 'proveedor_id';
  const field = kind === 'client' ? 'clienteId' : 'proveedorId';
  const saved = await client.query(`UPDATE pedidos SET ${column}=$1,revision=revision+1 WHERE ${column}=$2 AND owner_phone=ANY($3) RETURNING *`,[destinationId,sourceId,owners]);
  const original = new Map(before.map((row) => [row.id,row]));
  if (saved.rowCount !== original.size) mismatch();
  for (const actual of saved.rows) {
    const previous = original.get(actual.id);
    if (!previous || actual[column] !== destinationId || Number(actual.revision) !== Number(previous.revision)+1) mismatch();
    const oldFields = {...previous}, newFields = {...actual};
    delete oldFields[column]; delete oldFields.revision;
    delete newFields[column]; delete newFields.revision;
    if (operationRequestDigest(JSON.parse(JSON.stringify(oldFields))) !== operationRequestDigest(JSON.parse(JSON.stringify(newFields)))) mismatch();
  }
  return saved.rows.map((row) => ({id:row.id,revision:Number(row.revision),[field]:row[column]})).sort((a,b) => a.id.localeCompare(b.id));
}

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
  const owners = context.ownerPhoneVariants ?? [context.businessId];
  const items = [];
  for (const action of plan.actions) {
    const isClient = action.type.startsWith('client.'), create = action.type.endsWith('.create');
    const table = isClient ? 'clients' : 'proveedores';
    const id = create ? `${isClient ? 'client' : 'proveedor'}-${crypto.randomUUID()}` : action.target.partyId;
    let saved, expected;
    if (action.type.endsWith('.delete') || action.type === 'supplier.merge') {
      const currentRow = await loadParty(client,table,id,owners);
      const current = currentRow ? partyRowToEntity(currentRow,isClient) : null;
      const linked = await client.query(`SELECT * FROM pedidos WHERE ${isClient ? 'cliente_id' : 'proveedor_id'}=$1 AND owner_phone=ANY($2) ORDER BY id FOR UPDATE`,[id,owners]);
      if (action.type === 'supplier.merge') {
        const keepRow = await loadParty(client,table,action.destination.partyId,owners);
        const keep = keepRow ? partyRowToEntity(keepRow,false) : null;
        expected = planSupplierMerge(action,current,keep);
        saved = await client.query('UPDATE proveedores SET notas=$1,metadata_revision=metadata_revision+1 WHERE id=$2 AND owner_phone=ANY($3) AND metadata_revision=$4 RETURNING *',
          [expected.notas,expected.id,owners,action.destination.expectedRevision]);
        if (saved.rowCount !== 1 || operationRequestDigest(partyRowToEntity(saved.rows[0],false)) !== operationRequestDigest(expected)) mismatch();
        const affectedOrders = await movePartyOrders(client,linked.rows,id,expected.id,owners);
        const removed = await client.query('DELETE FROM proveedores WHERE id=$1 AND owner_phone=ANY($2) AND metadata_revision=$3 RETURNING *',[id,owners,action.target.expectedRevision]);
        if (removed.rowCount !== 1 || operationRequestDigest(partyRowToEntity(removed.rows[0],false)) !== operationRequestDigest(current)) mismatch();
        items.push({itemId:action.itemId,type:action.type,party:partyRowToEntity(saved.rows[0],false),removedParty:current,affectedOrders,deleted:false,reason:action.reason});
      } else {
        planPartyDelete(action,current,linked.rows);
        const affectedOrders = isClient ? [] : await movePartyOrders(client,linked.rows,id,null,owners);
        const removed = await client.query(`DELETE FROM ${table} WHERE id=$1 AND owner_phone=ANY($2) AND metadata_revision=$3 RETURNING *`,[id,owners,action.target.expectedRevision]);
        if (removed.rowCount !== 1 || operationRequestDigest(partyRowToEntity(removed.rows[0],isClient)) !== operationRequestDigest(current)) mismatch();
        items.push({itemId:action.itemId,type:action.type,party:current,deleted:true,affectedOrders,reason:action.reason});
      }
      continue;
    }
    if (create) {
      expected = {id,ownerPhone:context.businessId,name:action.name,notas:action.notas,metadataRevision:0,...(isClient ? {debt:0,accountRevision:0} : {})};
      saved = isClient
      ? await client.query('INSERT INTO clients(id,owner_phone,name,debt,notas) VALUES($1,$2,$3,0,$4) RETURNING *', [id, context.businessId, action.name, action.notas])
      : await client.query('INSERT INTO proveedores(id,owner_phone,name,notas) VALUES($1,$2,$3,$4) RETURNING *', [id, context.businessId, action.name, action.notas]);
    } else {
      const current = await loadParty(client,table,id,owners);
      expected = planPartyUpdate(action,current ? partyRowToEntity(current,isClient) : null);
      saved = await client.query(`UPDATE ${table} SET name=$1,notas=$2,metadata_revision=metadata_revision+1
        WHERE id=$3 AND owner_phone=ANY($4) AND metadata_revision=$5 RETURNING *`,
        [expected.name,expected.notas,id,owners,action.target.expectedRevision]);
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
      plan.source?.text ?? '', `${item.type.startsWith('client.') ? 'Cliente' : 'Proveedor'} ${item.type.endsWith('.create') ? 'creado' : item.type.endsWith('.delete') ? 'eliminado' : item.type.endsWith('.merge') ? 'fusionado' : 'actualizado'}: ${item.party.name}`, JSON.stringify([actions[index]])]);
  }
  return result;
}
