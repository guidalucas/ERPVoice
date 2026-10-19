import { InventoryOperationError } from './inventoryOperations.js';
import { operationRequestDigest } from './operationHash.js';
import { operationResultActions } from './operationResults.js';
import { authorizeUniversalConversation } from './universalConversationPostgres.js';
import { universalMetaPreviewReply } from './universalMetaOperations.js';

export const UNIVERSAL_META_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS universal_meta_commands (
    owner_phone TEXT NOT NULL,message_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,result_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,message_id)
  );
`;
const fail=(code,message)=>{throw new InventoryOperationError(code,message);};
const same=(a,b)=>operationRequestDigest(a)===operationRequestDigest(b);
export function normalizeUniversalMetaInput(input) {
  if(typeof input?.messageId!=='string'||!input.messageId.trim()||input.messageId.length>180
    ||typeof input.sourceText!=='string'||!input.sourceText.trim()||input.sourceText.length>12200) fail('INVALID_DRAFT_REQUEST','El mensaje requiere un ID estable y una instrucción válida.');
  return {messageId:input.messageId,sourceText:input.sourceText};
}
export async function findUniversalMetaCommand(client,input,context) {
  authorizeUniversalConversation(context);
  const hash=operationRequestDigest({actorId:context.actorId,sourceText:input.sourceText}),scope=[context.businessId,input.messageId];
  const row=(await client.query('SELECT actor_id,request_hash,result_json FROM universal_meta_commands WHERE owner_phone=$1 AND message_id=$2',scope)).rows[0];
  if(row&&(row.actor_id!==context.actorId||row.request_hash!==hash)) fail('IDEMPOTENCY_CONFLICT','El mensaje ya corresponde a otra instrucción o remitente.');
  return {scope,hash,response:row?.result_json};
}
export async function findUniversalMetaDraft(client,code,context) {
  authorizeUniversalConversation(context);
  const rows=(await client.query('SELECT draft_id,version,preview_json,status,expires_at<=NOW() AS expired FROM universal_drafts WHERE owner_phone=$1 AND actor_id=$2 AND left(preview_json->>\'digest\',8)=$3',
    [context.businessId,context.actorId,code])).rows;
  if(rows.length!==1) fail('DRAFT_NOT_FOUND','No encontré una única revisión con ese código para este negocio y remitente. Usá el código de la versión actual.');
  return rows[0];
}
async function putReply(client,input,context,text) {
  await client.query('INSERT INTO meta_reply_outbox(event_id,recipient,reply_text) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING',[input.messageId,context.actorId,text]);
  const row=(await client.query('SELECT recipient,reply_text FROM meta_reply_outbox WHERE event_id=$1',[input.messageId])).rows[0];
  if(!row||row.recipient!==context.actorId||row.reply_text!==text) fail('IDEMPOTENCY_CONFLICT','El ID del mensaje ya corresponde a otra respuesta.');
}

/** One root lock precedes every draft/domain lock. Network calls run before this
 * transaction. A typed rejection rolls back partial effects before its immutable
 * response/outbox are saved; an SQL failure rolls back the entire command. */
export async function executeUniversalMetaInTransaction(client,input,context,apply) {
  const command=await findUniversalMetaCommand(client,input,context);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['universal-meta',...command.scope])]);
  const prior=await findUniversalMetaCommand(client,input,context);
  if(prior.response) return prior.response;
  let result;
  await client.query('SAVEPOINT universal_meta_effect');
  try {
    const preview=await apply(client);
    const applied=preview.status==='applied';
    result={handled:true,intent:'mixed',requiresConfirmation:preview.status.startsWith('awaiting_'),
      replyText:universalMetaPreviewReply(preview),actions:applied ? operationResultActions(preview.result) : [],
      draftId:preview.draftId,version:preview.version,digest:preview.digest,status:preview.status,
      ...(applied ? {operationResult:preview.result} : {})};
  } catch(error) {
    if(error.name!=='InventoryOperationError') throw error;
    await client.query('ROLLBACK TO SAVEPOINT universal_meta_effect');
    result={handled:true,intent:'mixed',requiresConfirmation:false,replyText:error.message,actions:[],errorCode:error.code};
  }
  await client.query('RELEASE SAVEPOINT universal_meta_effect');
  result=JSON.parse(JSON.stringify(result));
  const saved=(await client.query('INSERT INTO universal_meta_commands(owner_phone,message_id,actor_id,request_hash,result_json) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *',
    [...command.scope,context.actorId,command.hash,JSON.stringify(result)])).rows[0];
  if(!saved||saved.owner_phone!==context.businessId||saved.message_id!==input.messageId||saved.actor_id!==context.actorId||saved.request_hash!==command.hash||!same(saved.result_json,result)) fail('PERSISTED_EFFECT_MISMATCH','La respuesta guardada difiere del comando ejecutado.');
  await putReply(client,input,context,result.replyText);
  return saved.result_json;
}
