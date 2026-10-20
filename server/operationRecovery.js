import crypto from 'node:crypto';
import {InventoryOperationError} from './inventoryOperations.js';
import {operationRequestDigest} from './operationHash.js';
import {orderRequestDigest} from './orderOperations.js';

const fail=(code,message)=>{throw new InventoryOperationError(code,message);};
const invalid=()=>fail('INVALID_RECOVERY_REQUEST','La consulta del recibo anterior no es válida.');
function safeData(input) {
  let nodes=0;
  const copy=(value,depth=0)=>{
    if(++nodes>30000 || depth>15) invalid();
    if(value===null || typeof value==='string' || typeof value==='boolean') return value;
    if(typeof value==='number' && Number.isFinite(value)) return value;
    if(!value || typeof value!=='object') invalid();
    const list=Array.isArray(value);
    if(Object.getPrototypeOf(value)!==(list ? Array.prototype : Object.prototype) && Object.getPrototypeOf(value)!==null) invalid();
    if(list && Reflect.ownKeys(value).length!==value.length+1) invalid();
    const result=list ? [] : {};
    for(const key of Reflect.ownKeys(value)) {
      if(list && key==='length') continue;
      const d=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string' || ['__proto__','prototype','constructor'].includes(key)
        || !d.enumerable || !Object.hasOwn(d,'value')) invalid();
      Object.defineProperty(result,key,{enumerable:true,writable:true,configurable:true,value:copy(d.value,depth+1)});
    }
    return result;
  };
  return copy(input);
}

export function normalizeOperationRecovery(input) {
  const value=safeData(input);
  if(!value || Array.isArray(value) || Object.keys(value).some(key=>!['operationId','sourceText','actions'].includes(key))
    || typeof value.operationId!=='string' || !value.operationId.trim() || value.operationId.length>200
    || typeof value.sourceText!=='string' || value.sourceText.length>12000
    || !Array.isArray(value.actions) || !value.actions.length || value.actions.length>100
    || value.actions.some(action=>!action || typeof action!=='object' || Array.isArray(action))
    || JSON.stringify(value).length>200000) invalid();
  // The retired HTTP writer removed queries before hashing its mutation batch.
  return {...value,actions:value.actions.filter(action=>!['query_stock','query_pedidos'].includes(action.type))};
}

/** Receipt lookup only. Never resolves names, calls an interpreter, or executes
 * a plan. An absent receipt is distinct from an unverifiable existing receipt. */
export async function recoverLegacyPanelOperation(client,input,context) {
  if(typeof context?.businessId!=='string' || !context.businessId.trim() || context.businessId==='__default__'
    || typeof context.actorId!=='string' || !context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED','Falta el negocio o actor autorizado.');
  if(!(Array.isArray(context.permissions)||context.permissions instanceof Set)) fail('FORBIDDEN','Faltan permisos de lectura.');
  const permissions=context.permissions instanceof Set ? context.permissions : new Set(context.permissions);
  if(!['inventory:read','accounts:read','orders:read'].every(permission=>permissions.has(permission))) fail('FORBIDDEN','No tenés permiso para consultar el recibo anterior.');
  const request=normalizeOperationRecovery(input),{operationId,sourceText,actions}=request;
  const rows=(await client.query(`SELECT 'inventory' AS domain,actor_id,plan_json->'source'->>'requestHash' AS original_hash,result_json
      FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2
    UNION ALL SELECT 'accounts',actor_id,plan_json->'source'->>'requestHash',result_json
      FROM account_operations WHERE owner_phone=$1 AND operation_id=$3
    UNION ALL SELECT 'orders',actor_id,request_hash,result_json
      FROM order_operations WHERE owner_phone=$1 AND operation_id=$4`,
  [context.businessId,`panel:${operationId}`,`account-compat:panel:${operationId}`,`batch:panel:${operationId}`])).rows;
  if(!rows.length) return {status:'not_applied',operationId};
  if(rows.some(row=>row.actor_id!==context.actorId)) fail('FORBIDDEN','El recibo anterior pertenece a otro actor.');
  if(rows.length!==1) fail('LEGACY_RECEIPT_AMBIGUOUS','El ID tiene varios recibos anteriores. Revisá el historial antes de preparar otra operación.');
  const row=rows[0],hash=row.domain==='inventory'
    ? crypto.createHash('sha256').update(JSON.stringify({actions,sourceText})).digest('hex')
    : row.domain==='orders' ? orderRequestDigest({actions,sourceText}) : operationRequestDigest({actions,sourceText});
  if(row.original_hash!==hash) fail('IDEMPOTENCY_CONFLICT','El ID anterior corresponde a otra solicitud. Conservé la propuesta sin ejecutar cambios.');
  if(row.result_json?.status!=='applied') fail('LEGACY_RECEIPT_UNVERIFIABLE','No pude verificar el resultado anterior. Conservá la propuesta y revisá el historial.');
  return {status:'applied',operationId,operationResult:row.result_json};
}
