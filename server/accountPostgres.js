import crypto from 'node:crypto';
import { InventoryOperationError } from './inventoryOperations.js';
import { validateAccountPlan, accountPlanDigest, planAccountOperation, accountResultActions, accountResultReply } from './accountOperations.js';
export const ACCOUNT_SCHEMA_SQL = `
  ALTER TABLE clients ALTER COLUMN debt TYPE BIGINT;
  ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_revision INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS account_operations(
    owner_phone TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    plan_json JSONB NOT NULL,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(owner_phone,operation_id)
  );
  CREATE TABLE IF NOT EXISTS account_movements(
    owner_phone TEXT NOT NULL,operation_id TEXT NOT NULL,item_id TEXT NOT NULL,client_id TEXT NOT NULL,
    delta BIGINT NOT NULL,unit TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,operation_id,item_id,client_id),FOREIGN KEY(owner_phone,operation_id) REFERENCES account_operations(owner_phone,operation_id)
  );
`;
export async function executeAccountPlanInTransaction(client, input, context) {
    const plan = validateAccountPlan(input, context), requestHash = accountPlanDigest(plan), scope = [context.businessId, plan.operationId];
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['account', ...scope])]);
    const replay = await client.query('SELECT request_hash,result_json FROM account_operations WHERE owner_phone=$1 AND operation_id=$2', scope);
    if (replay.rowCount) {
        if (replay.rows[0].request_hash !== requestHash)
            throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID ya corresponde a otra operación de cuenta.');
        return replay.rows[0].result_json;
    }
    // Compatible ordering with client merges/deletions and procurement orders during migration.
    await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
    const owners = context.ownerPhoneVariants ?? [context.businessId];
    const rows = await client.query('SELECT * FROM clients WHERE owner_phone=ANY($1) ORDER BY id FOR UPDATE', [owners]);
    const effect = planAccountOperation(plan, rows.rows.map((row) => ({ id: row.id, name: row.name, debt: Number(row.debt), accountRevision: Number(row.account_revision) })));
    const persisted = new Map();
    for (const entry of effect.changedClients) {
        const saved = await client.query('UPDATE clients SET debt=$1,account_revision=account_revision+1 WHERE id=$2 AND owner_phone=ANY($3) AND account_revision=$4 RETURNING *', [entry.debt, entry.id, owners, entry.accountRevision]);
        const actual = saved.rows[0];
        if (saved.rowCount !== 1 || Number(actual.debt) !== entry.debt || Number(actual.account_revision) !== entry.accountRevision + 1)
            throw new InventoryOperationError('PERSISTED_EFFECT_MISMATCH', 'El saldo persistido difiere del plan.');
        persisted.set(entry.id, actual);
    }
    const result = { contractVersion: 1, operationId: plan.operationId, businessId: context.businessId, status: 'applied', items: effect.items.map((item) => ({ ...item,
            clientName: persisted.get(item.clientId).name, balance: Number(persisted.get(item.clientId).debt), revision: Number(persisted.get(item.clientId).account_revision),
            ...(item.destinationId ? { destinationName: persisted.get(item.destinationId).name, destinationBalance: Number(persisted.get(item.destinationId).debt), destinationRevision: Number(persisted.get(item.destinationId).account_revision) } : {}) })) };
    result.replyText = [context.replyPrefix, accountResultReply(result)].filter(Boolean).join('\n\n');
    await client.query('INSERT INTO account_operations(owner_phone,operation_id,actor_id,request_hash,plan_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [...scope, context.actorId, requestHash, JSON.stringify(plan), JSON.stringify(result)]);
    for (const movement of effect.movements)
        await client.query('INSERT INTO account_movements(owner_phone,operation_id,item_id,client_id,delta,unit) VALUES($1,$2,$3,$4,$5,$6)', [...scope, movement.itemId, movement.clientId, movement.delta, 'legacy-money']);
    const actions = accountResultActions(result);
    for (const [index, item] of result.items.entries())
        await client.query('INSERT INTO transactions(id,owner_phone,timestamp,source_text,summary,actions_json) VALUES($1,$2,NOW(),$3,$4,$5::jsonb)', [
            `account-${crypto.createHash('sha256').update(JSON.stringify([...scope, item.itemId])).digest('hex')}`, context.businessId, plan.source?.text ?? '', accountResultReply({ ...result, items: [item] }), JSON.stringify([actions[index]])
        ]);
    return result;
}
