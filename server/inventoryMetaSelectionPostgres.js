import { InventoryOperationError } from './inventoryOperations.js';
import { normalizeSelectionRequest } from './inventorySelections.js';
import { productUpdateActions } from './stockOperationAdapter.js';
import { operationRequestDigest } from './operationHash.js';
import { inventoryResultActions } from './inventoryResults.js';
import { inventorySelectionPreviewReply, inventorySelectionReceiptReply } from './inventoryMetaSelections.js';

export const META_SELECTION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta_selection_commands(
    owner_phone TEXT NOT NULL,message_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,message_id)
  );
`;
const fail = (code,message) => { throw new InventoryOperationError(code,message); };
const requireScope = (context,input) => {
  if (!context.businessId || context.businessId === '__default__' || !context.actorId) fail('BUSINESS_SCOPE_REQUIRED','Falta el negocio o remitente autorizado.');
  if (typeof input.messageId !== 'string' || !input.messageId.trim()) fail('OPERATION_ID_REQUIRED','El mensaje necesita un ID estable.');
  if (typeof input.sourceText !== 'string' || !input.sourceText.trim()) fail('INVALID_SELECTION','Falta la instrucción que se revisará.');
};
const putReply = async (client,input,context,reply) => {
  await client.query('INSERT INTO meta_reply_outbox(event_id,recipient,reply_text) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING',[input.messageId,context.actorId,reply]);
  const persisted = (await client.query('SELECT recipient,reply_text FROM meta_reply_outbox WHERE event_id=$1',[input.messageId])).rows[0];
  if (!persisted || persisted.recipient !== context.actorId || persisted.reply_text !== reply) fail('IDEMPOTENCY_CONFLICT','El ID del mensaje ya corresponde a otra respuesta.');
};
const preparedReply = (preview) => ({replyText:inventorySelectionPreviewReply(preview),pendingSelection:true,actions:[],selectionId:preview.selectionId,
  intent:preview.mutation.type === 'sku.deactivate' ? 'delete_product' : 'update_product'});

/** Grounded IDs only. This boundary never resolves a product name during persistence. */
function selectionRequest(input) {
  const {actions,sourceText,messageId} = input;
  if (!Array.isArray(actions) || !actions.length || actions.length > 100) fail('INVALID_SELECTION','La selección necesita entre 1 y 100 instrucciones.');
  if (actions.every((action) => action.type === 'delete_product')) {
    const all = actions.length === 1 && actions[0].productName === '*';
    if (!all && actions.some((action) => typeof action.productId !== 'string' || !action.productId.trim())) fail('SKU_SELECTION_REQUIRED','Falta identificar los SKU de la baja.');
    return normalizeSelectionRequest({requestId:`meta-deactivate:${messageId}`,selector:all ? {kind:'all'} : {kind:'ids',skuIds:[...new Set(actions.map((action)=>action.productId))]},
      mutation:{type:'sku.deactivate',reason:sourceText}});
  }
  if (actions.some((action) => action.type !== 'update_product')) fail('UNSUPPORTED_MIXED_OPERATION','La selección necesita cambios o ajustes independientes; no apliqué el lote mixto.');
  const mutations = actions.map((action,index) => {
    if (typeof action.productId !== 'string' || !action.productId.trim()) fail('SKU_SELECTION_REQUIRED','Elegí un SKU explícito antes de preparar el cambio.');
    const converted = productUpdateActions(action.productId,{price:action.price,priceCurrency:action.priceCurrency,stockAvailable:action.stockAvailable,stockReserved:action.stockReserved},
      {expectedRevision:0,reason:sourceText},`meta-${index}`);
    if (converted.length !== 1) fail('UNSUPPORTED_MIXED_OPERATION','Revisá por separado los cambios de ficha y los saldos.');
    const {target,itemId,...mutation} = converted[0];
    return mutation;
  });
  if (mutations.some((mutation) => operationRequestDigest(mutation) !== operationRequestDigest(mutations[0]))) fail('UNSUPPORTED_MIXED_OPERATION','El conjunto debe tener un mismo cambio revisable. Prepará los cambios diferentes por separado.');
  return normalizeSelectionRequest({requestId:`meta-selection:${messageId}`,selector:{kind:'ids',skuIds:actions.map((action)=>action.productId)},mutation:mutations[0]});
}

export async function prepareMetaSelectionInTransaction(client,input,context,previewSelection) {
  requireScope(context,input);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['meta-selection-preview',context.businessId,context.actorId,input.messageId])]);
  const existing = await client.query('SELECT preview_json FROM inventory_selections WHERE owner_phone=$1 AND actor_id=$2 AND request_id=ANY($3)',
    [context.businessId,context.actorId,[`meta-selection:${input.messageId}`,`meta-deactivate:${input.messageId}`]]);
  if (existing.rowCount > 1) fail('IDEMPOTENCY_CONFLICT','El mensaje ya tiene más de una selección. Revisá una nueva instrucción.');
  let preview = existing.rows[0]?.preview_json;
  if (preview) {
    if (preview.mutation.reason !== input.sourceText) fail('IDEMPOTENCY_CONFLICT','El ID del mensaje ya corresponde a otra instrucción.');
  } else {
    if (input.resumeOnly) return null;
    preview = await previewSelection(client,selectionRequest(input),context);
  }
  const result = preparedReply(preview);
  const existingReply = (await client.query('SELECT recipient,reply_text FROM meta_reply_outbox WHERE event_id=$1',[input.messageId])).rows[0];
  if (existingReply && existingReply.recipient !== context.actorId) fail('IDEMPOTENCY_CONFLICT','El ID del mensaje ya corresponde a otro remitente.');
  result.replyText = existingReply?.reply_text ?? [input.replyPrefix,result.replyText].filter(Boolean).join('\n\n');
  if (result.replyText.length > 3500) fail('SELECTION_PREVIEW_TOO_LARGE','La respuesta completa es demasiado larga para revisar el conjunto; pedí grupos más pequeños.');
  await putReply(client,input,context,result.replyText);
  return result;
}

/** A savepoint keeps a rejected multi-SKU effect terminal without committing partial writes. */
export async function processMetaSelectionInTransaction(client,input,command,context,confirmSelection) {
  requireScope(context,input);
  const hash = operationRequestDigest({actorId:context.actorId,command}),scope=[context.businessId,input.messageId];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['meta-selection-command',...scope])]);
  const prior = (await client.query('SELECT request_hash,result_json FROM meta_selection_commands WHERE owner_phone=$1 AND message_id=$2',scope)).rows[0];
  if (prior) {
    if (prior.request_hash !== hash) return {handled:true,intent:command.intent,requiresConfirmation:false,replyText:'El ID del mensaje ya corresponde a otro comando.',actions:[],errorCode:'IDEMPOTENCY_CONFLICT'};
    return prior.result_json;
  }
  let result;
  await client.query('SAVEPOINT meta_selection_effect');
  try {
    const candidates = await client.query(`SELECT selection_id,preview_json,status FROM inventory_selections
      WHERE owner_phone=$1 AND actor_id=$2 AND (request_id LIKE 'meta-deactivate:%' OR request_id LIKE 'meta-selection:%')
      AND left(preview_json->>'digest',8)=$3 AND preview_json->'mutation'->>'type'=$4 FOR UPDATE`,[context.businessId,context.actorId,command.code,command.mutationType]);
    if (candidates.rowCount !== 1) fail('SELECTION_NOT_FOUND','No encontré una selección con ese código y operación para este negocio y remitente.');
    const selected = candidates.rows[0];
    if (!command.confirm) {
      if (selected.status === 'applied') fail('SELECTION_ALREADY_APPLIED','La selección ya estaba aplicada. El historial conserva su recibo.');
      await client.query('UPDATE inventory_selections SET cancelled_at=COALESCE(cancelled_at,NOW()) WHERE owner_phone=$1 AND selection_id=$2',[context.businessId,selected.selection_id]);
      result={handled:true,intent:command.intent,requiresConfirmation:false,replyText:command.mutationType === 'sku.deactivate' ? 'Baja cancelada. No desactivé ningún SKU.' : 'Selección cancelada. No apliqué cambios.',actions:[]};
    } else {
      const receipt = await confirmSelection(client,selected.selection_id,selected.preview_json.digest,context,{mutationType:command.mutationType});
      result={handled:true,intent:command.intent,requiresConfirmation:false,replyText:inventorySelectionReceiptReply(receipt),actions:inventoryResultActions(receipt),operationResult:receipt};
    }
  } catch(error) {
    if (error.name !== 'InventoryOperationError') throw error;
    await client.query('ROLLBACK TO SAVEPOINT meta_selection_effect');
    result={handled:true,intent:command.intent,requiresConfirmation:false,replyText:error.message,actions:[],errorCode:error.code};
  }
  await client.query('RELEASE SAVEPOINT meta_selection_effect');
  result = JSON.parse(JSON.stringify(result));
  await client.query('INSERT INTO meta_selection_commands(owner_phone,message_id,actor_id,request_hash,result_json) VALUES($1,$2,$3,$4,$5::jsonb)',[...scope,context.actorId,hash,JSON.stringify(result)]);
  await putReply(client,input,context,result.replyText);
  return result;
}
