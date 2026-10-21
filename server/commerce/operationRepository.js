import { operationRequestDigest } from '../operationHash.js';
import { authorizeCommerce } from './authorization.js';
import { readProfile } from './productRepository.js';
import { fail } from './errors.js';
import { uuid } from './validation.js';

export async function requireCommerceAccess(client, context, permission) {
  authorizeCommerce(context, { enabled: true, permission });
  const profile = await readProfile(client, context.businessId);
  authorizeCommerce(context, { enabled: profile?.enabled === true, permission });
  return profile;
}
export async function executeCommerceCommand(runtime, context, { operationId, type, entityId, command, permission = 'commerce:write', repeatableRead = false }, apply) {
  uuid(operationId);
  const hash = operationRequestDigest({ type, entityId: entityId ?? null, command });
  const execute = () => runtime.transaction(async client => {
    await requireCommerceAccess(client, context, permission);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['commerce', context.businessId, operationId])]);
    const existing = (await client.query('SELECT request_hash,result_json FROM commercial_operations WHERE owner_phone=$1 AND operation_id=$2', [context.businessId, operationId])).rows[0];
    if (existing) {
      if (existing.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'El intento ya corresponde a otro contenido.', 409);
      return existing.result_json;
    }
    const result = { contractVersion: 1, operationId, status: 'applied', result: await apply(client) };
    await client.query(`INSERT INTO commercial_operations(owner_phone,operation_id,actor_id,operation_type,entity_id,request_hash,request_json,result_json)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [context.businessId, operationId, context.actorId, type,
      entityId ?? null, hash, JSON.stringify(command), JSON.stringify(result)]);
    return result;
  }, { repeatableRead });
  for (let attempt = 0; ; attempt++) {
    try { return await execute(); } catch (error) {
      if (!repeatableRead || attempt >= 2 || !(error.code === '40001' || (error.code === '23505' && error.constraint === 'commercial_operations_pkey'))) throw error;
    }
  }
}
