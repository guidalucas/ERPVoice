import { InventoryOperationError } from './inventoryOperations.js';
import { normalizeFamilyPublication, productFamilyPublicationDigest } from './productFamilySchemas.js';
import { operationRequestDigest } from './operationHash.js';

export const PRODUCT_FAMILY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS product_family_schemas (
    owner_phone TEXT NOT NULL, family_id TEXT NOT NULL, version BIGINT NOT NULL,
    schema_json JSONB NOT NULL, actor_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,family_id,version), CHECK(version>0)
  );
  CREATE TABLE IF NOT EXISTS product_family_operations (
    owner_phone TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,request_json JSONB NOT NULL,result_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(owner_phone,operation_id)
  );
`;
const fail=(code,message)=>{throw new InventoryOperationError(code,message);};
export function authorizeProductFamilies(context,publish=false) {
  if(typeof context?.businessId!=='string'||!context.businessId.trim()||context.businessId==='__default__'
    ||typeof context.actorId!=='string'||!context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED','Falta el negocio/actor autorizado.');
  if(!(Array.isArray(context.permissions)||context.permissions instanceof Set)
    || ![...context.permissions].some(permission=>permission==='inventory:schema'||(!publish&&permission==='inventory:read'))) fail('FORBIDDEN','No tenés permiso para esta configuración de inventario.');
}
export async function loadProductFamilySchemas(client,owners) {
  const rows=(await client.query('SELECT family_id,version,schema_json FROM product_family_schemas WHERE owner_phone=ANY($1) ORDER BY family_id,version',[owners])).rows;
  const seen=new Set();
  return rows.map(row=>{
    const family={familyId:row.family_id,version:Number(row.version),schema:row.schema_json},key=JSON.stringify([family.familyId,family.version]);
    if(seen.has(key)||!Number.isSafeInteger(family.version)) fail('INVALID_PRODUCT_SCHEMA','Hay versiones de familia ambiguas o fuera de rango.');
    seen.add(key);return family;
  });
}
export async function publishProductFamilyInTransaction(client,input,context) {
  authorizeProductFamilies(context,true);
  const request=normalizeFamilyPublication(input),hash=productFamilyPublicationDigest(request),scope=[context.businessId,request.operationId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['family-operation',...scope])]);
  const prior=(await client.query('SELECT request_hash,result_json FROM product_family_operations WHERE owner_phone=$1 AND operation_id=$2',scope)).rows[0];
  if(prior) {if(prior.request_hash!==hash) fail('IDEMPOTENCY_CONFLICT','El ID ya corresponde a otra publicación de familia.');return prior.result_json;}
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['family-schema',context.businessId,request.familyId])]);
  const current=Number((await client.query('SELECT COALESCE(MAX(version),0) AS version FROM product_family_schemas WHERE owner_phone=$1 AND family_id=$2',[context.businessId,request.familyId])).rows[0].version);
  if(!Number.isSafeInteger(current)||current!==request.expectedVersion) fail('PRODUCT_SCHEMA_VERSION_MISMATCH','La familia cambió. Revisá su versión antes de publicar otra.');
  const version=current+1,saved=(await client.query('INSERT INTO product_family_schemas(owner_phone,family_id,version,schema_json,actor_id) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *',
    [context.businessId,request.familyId,version,JSON.stringify(request.schema),context.actorId])).rows[0];
  if(!saved||saved.owner_phone!==context.businessId||saved.family_id!==request.familyId||Number(saved.version)!==version||saved.actor_id!==context.actorId
    ||operationRequestDigest(saved.schema_json)!==operationRequestDigest(request.schema)) fail('PERSISTED_EFFECT_MISMATCH','La definición guardada difiere de la familia publicada.');
  const result={operationId:request.operationId,businessId:context.businessId,status:'applied',family:{familyId:request.familyId,version,schema:saved.schema_json}};
  const receipt=(await client.query('INSERT INTO product_family_operations(owner_phone,operation_id,actor_id,request_hash,request_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING *',
    [...scope,context.actorId,hash,JSON.stringify(request),JSON.stringify(result)])).rows[0];
  if(!receipt||receipt.owner_phone!==context.businessId||receipt.operation_id!==request.operationId||receipt.actor_id!==context.actorId||receipt.request_hash!==hash
    ||operationRequestDigest(receipt.request_json)!==operationRequestDigest(request)||operationRequestDigest(receipt.result_json)!==operationRequestDigest(result)) fail('PERSISTED_EFFECT_MISMATCH','El recibo guardado difiere de la publicación.');
  return receipt.result_json;
}
