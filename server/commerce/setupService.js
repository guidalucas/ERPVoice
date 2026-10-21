import { randomUUID } from 'node:crypto';
import { operationRequestDigest } from '../operationHash.js';
import { authorizeCommerce } from './authorization.js';
import { inspectCommerceSchema } from './schemaInspection.js';
import { readProfile, readMoneyPolicy } from './productRepository.js';
import { record, uuid, integer, text } from './validation.js';
import { fail } from './errors.js';

// Activation only writes business configuration. DDL and inventory corrections
// belong to their explicit migration and reviewed inventory-operation flows.
export function createCommerceSetupService(runtime) {
  const owner = async (client, context) => {
    authorizeCommerce(context, { enabled: true, permission: 'commerce:settings' });
    const member = (await client.query('SELECT tenant_phone FROM business_members WHERE member_phone=$1 AND tenant_phone<>$1 LIMIT 1', [context.actorId])).rows[0];
    if (member) fail('COMMERCE_FORBIDDEN', 'Solo el propietario puede configurar el negocio.', 403);
    if (!(await inspectCommerceSchema(client)).ready) fail('COMMERCE_SCHEMA_NOT_READY', 'El servicio comercial necesita una actualización del administrador. Tu negocio no necesita ejecutar scripts.', 503);
  };
  const status = async (client, context) => {
    const profile = await readProfile(client, context.businessId), moneyPolicy = await readMoneyPolicy(client, context.businessId);
    return { enabled: profile?.enabled === true, needsSetup: !profile || !moneyPolicy,
      profile: profile ? { brandName: profile.brand_name, salesWhatsapp: profile.sales_whatsapp, brandPreset: profile.brand_preset, revision: Number(profile.revision), moneyPolicy } : null,
      moneyPolicy };
  };
  return {
    status: context => runtime.transaction(async client => { await owner(client, context); return status(client, context); }, { readOnly: true, repeatableRead: true }),
    activate: async (context, input) => {
      const data = record(input, ['operationId', 'expectedProfileRevision', 'expectedPolicyRevision', 'brandName', 'salesWhatsapp', 'currency', 'confirmedMajorInteger']);
      const command = { operationId: uuid(data.operationId), expectedProfileRevision: integer(data.expectedProfileRevision), expectedPolicyRevision: integer(data.expectedPolicyRevision),
        brandName: text(data.brandName, 80, 'nombre comercial'), salesWhatsapp: data.salesWhatsapp === null ? null : text(data.salesWhatsapp, 15, 'WhatsApp comercial'),
        currency: text(data.currency, 3, 'moneda'), confirmedMajorInteger: data.confirmedMajorInteger };
      if (!['ARS', 'UYU', 'USD'].includes(command.currency) || command.confirmedMajorInteger !== true) fail('MONEY_CONFIRMATION_REQUIRED', 'Elegí la moneda y confirmá que los precios se cargan en unidades enteras, no en centavos.', 422);
      if (command.salesWhatsapp !== null && !/^\d{8,15}$/.test(command.salesWhatsapp)) fail('INVALID_COMMAND', 'Ingresá WhatsApp con código de país, solo números (8 a 15 dígitos).', 422);
      const hash = operationRequestDigest({ type: 'business.activate', command });
      return runtime.transaction(async client => {
        await owner(client, context);
        // All setup attempts for this owner serialize, including different IDs.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['commerce-setup', context.businessId])]);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['commerce', context.businessId, command.operationId])]);
        const receipt = (await client.query('SELECT request_hash,result_json FROM commercial_operations WHERE owner_phone=$1 AND operation_id=$2', [context.businessId, command.operationId])).rows[0];
        if (receipt) {
          if (receipt.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'Este intento pertenece a otra configuración.', 409);
          return receipt.result_json;
        }
        await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
        const profile = (await client.query('SELECT * FROM commerce_profiles WHERE owner_phone=$1 FOR UPDATE', [context.businessId])).rows[0] ?? null;
        const policy = await readMoneyPolicy(client, context.businessId);
        if (profile && !profile.enabled) fail('COMMERCE_DISABLED', 'El acceso comercial de este negocio está deshabilitado. Contactá al administrador.', 403);
        if ((Number(profile?.revision) || 0) !== command.expectedProfileRevision || (policy?.revision ?? 0) !== command.expectedPolicyRevision) fail('REVISION_CONFLICT', 'La configuración cambió. Actualizá y revisá los datos.', 409);
        if (policy && (policy.currency !== command.currency || policy.storageUnit !== 'major_integer' || policy.fractionDigits !== 2)) fail('MONEY_POLICY_CONFLICT', 'La moneda ya fue confirmada. Cambiarla requiere revisar el inventario; no se convierten importes automáticamente.', 409);
        if (!policy) await client.query(`INSERT INTO inventory_money_policies(owner_phone,currency,storage_unit,fraction_digits,confirmed_by,confirmed_at)
          VALUES($1,$2,'major_integer',2,$3,NOW())`, [context.businessId, command.currency, context.actorId]);
        if (!profile) await client.query(`INSERT INTO commerce_profiles(owner_phone,id,brand_name,sales_whatsapp,enabled,created_by)
          VALUES($1,$2,$3,$4,true,$5)`, [context.businessId, randomUUID(), command.brandName, command.salesWhatsapp, context.actorId]);
        else await client.query(`UPDATE commerce_profiles SET brand_name=$2,sales_whatsapp=$3,revision=revision+1,updated_at=NOW() WHERE owner_phone=$1`, [context.businessId, command.brandName, command.salesWhatsapp]);
        const result = { contractVersion: 1, operationId: command.operationId, status: 'applied', result: await status(client, context) };
        await client.query(`INSERT INTO commercial_operations(owner_phone,operation_id,actor_id,operation_type,request_hash,request_json,result_json)
          VALUES($1,$2,$3,'business.activate',$4,$5::jsonb,$6::jsonb)`, [context.businessId, command.operationId, context.actorId, hash, JSON.stringify(command), JSON.stringify(result)]);
        return result;
      });
    },
  };
}
