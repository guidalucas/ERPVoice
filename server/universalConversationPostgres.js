import crypto from 'node:crypto';
import { InventoryOperationError } from './inventoryOperations.js';
import { operationRequestDigest } from './operationHash.js';
import { prepareUniversalOperation } from './universalOperations.js';
import { executeUniversalPlanInTransaction } from './universalPostgres.js';
import { validateUniversalOperationReview } from './universalOperationReview.js';

export const UNIVERSAL_CONVERSATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS universal_drafts (
    owner_phone TEXT NOT NULL, draft_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    version INTEGER NOT NULL, status TEXT NOT NULL, preview_json JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,draft_id),
    CHECK(status IN ('awaiting_confirmation','awaiting_clarification','applied','cancelled','answered'))
  );
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='universal_drafts'::regclass
      AND conname='universal_drafts_status_check' AND pg_get_constraintdef(oid) LIKE '%answered%') THEN
      ALTER TABLE universal_drafts DROP CONSTRAINT IF EXISTS universal_drafts_status_check;
      ALTER TABLE universal_drafts ADD CONSTRAINT universal_drafts_status_check
        CHECK(status IN ('awaiting_confirmation','awaiting_clarification','applied','cancelled','answered'));
    END IF;
  END $$;
  CREATE TABLE IF NOT EXISTS universal_draft_commands (
    owner_phone TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, draft_id TEXT NOT NULL, response_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_phone,actor_id,request_id),
    FOREIGN KEY(owner_phone,draft_id) REFERENCES universal_drafts(owner_phone,draft_id)
  );
`;
const fail = (code,message) => { throw new InventoryOperationError(code,message); };
const json = (value) => JSON.parse(JSON.stringify(value));
const same = (a,b) => operationRequestDigest(a) === operationRequestDigest(b);
export function authorizeUniversalConversation(context) {
  if (typeof context?.businessId !== 'string' || !context.businessId.trim() || context.businessId === '__default__'
    || typeof context.actorId !== 'string' || !context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED','Falta el negocio y el actor autorizado.');
  if (!(Array.isArray(context.permissions) || context.permissions instanceof Set)) fail('FORBIDDEN','Faltan permisos de operación.');
}
const record = (input,keys) => {
  if (!input || typeof input !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) fail('INVALID_DRAFT_REQUEST','Solicitud de borrador inválida.');
  const result={};
  for (const key of Reflect.ownKeys(input)) {
    const d=Object.getOwnPropertyDescriptor(input,key);
    if (!keys.includes(key) || !d.enumerable || !Object.hasOwn(d,'value') || d.value === undefined) fail('INVALID_DRAFT_REQUEST','Solicitud de borrador inválida.');
    result[key]=d.value;
  }
  return result;
};
export function normalizeDraftRequest(input,reply=false) {
  const value=record(input,reply ? ['requestId','text','version'] : ['requestId','text']);
  if (typeof value.requestId !== 'string' || !value.requestId.trim() || value.requestId.length>180
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length>12000
    || (reply && (!Number.isSafeInteger(value.version) || value.version<1 || value.version>20))) fail('INVALID_DRAFT_REQUEST','Indicá texto, un ID estable y la versión vigente.');
  return {...value,requestId:value.requestId.trim(),text:value.text.trim()};
}
export function normalizeDraftConfirmation(input) {
  const value=record(input,['version','digest']);
  if (!Number.isSafeInteger(value.version) || value.version<1 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) fail('INVALID_DRAFT_REQUEST','Confirmá la versión y el digest revisados.');
  return value;
}
export async function findDraftCommand(client,request,context,kind='prepare',draftId=null) {
  authorizeUniversalConversation(context);
  const hash=operationRequestDigest({kind,draftId,request,channel:context.channel ?? 'panel'});
  const scope=[context.businessId,context.actorId,request.requestId];
  const row=(await client.query('SELECT request_hash,response_json FROM universal_draft_commands WHERE owner_phone=$1 AND actor_id=$2 AND request_id=$3',scope)).rows[0];
  if (row && row.request_hash!==hash) fail('IDEMPOTENCY_CONFLICT','El mensaje ya corresponde a otro borrador.');
  return {hash,scope,response:row?.response_json};
}
export async function readUniversalDraft(client,draftId,context,{lock=false}={}) {
  authorizeUniversalConversation(context);
  if (typeof draftId !== 'string' || !draftId.trim() || draftId.length>180) fail('INVALID_DRAFT_REQUEST','ID de borrador inválido.');
  const row=(await client.query(`SELECT *,expires_at<=NOW() AS expired FROM universal_drafts WHERE owner_phone=$1 AND draft_id=$2 AND actor_id=$3${lock ? ' FOR UPDATE' : ''}`,[context.businessId,draftId,context.actorId])).rows[0];
  if (!row) fail('DRAFT_NOT_FOUND','El borrador no pertenece a esta conversación.');
  return row;
}
function requirePending(row,version,allowExpired=false) {
  if (row.version!==version) fail('DRAFT_VERSION_MISMATCH','El borrador cambió. Revisá la versión actual.');
  if (!row.status.startsWith('awaiting_')) fail('DRAFT_NOT_PENDING','El borrador ya tiene un resultado definitivo.');
  if (row.expired && !allowExpired) fail('DRAFT_EXPIRED','El borrador venció. Prepará una revisión nueva.');
}
function previewFromInterpretation(interpretation,{draftId,version,text,clarifications,expiresAt,context}) {
  if (!['ready','clarification','answer','cancelled'].includes(interpretation?.kind)) fail('INTERPRETATION_UNAVAILABLE','No pude preparar una interpretación válida. No apliqué cambios.');
  if (interpretation.kind==='ready' && !interpretation.plan) fail('INVALID_DRAFT_REQUEST','Falta el plan revisado de la operación.');
  if(interpretation.kind==='answer' && (interpretation.plan || !interpretation.answer || typeof interpretation.answer.text!=='string' || !Array.isArray(interpretation.answer.items))) fail('INVALID_DRAFT_REQUEST','La consulta no contiene una respuesta válida.');
  const preview=json({draftId,version,text,clarifications,expiresAt,
    status:interpretation.kind==='cancelled' ? 'cancelled' : interpretation.kind==='answer' ? 'answered' : interpretation.kind==='ready' ? 'awaiting_confirmation' : 'awaiting_clarification',
    ...(interpretation.kind==='answer' ? {queries:interpretation.queries,evidence:interpretation.evidence,answer:interpretation.answer} : {}),
    ...(interpretation.plan ? {plan:interpretation.plan,evidence:interpretation.evidence,review:interpretation.review} : {}),
    ...(interpretation.kind==='clarification' ? {question:interpretation.question} : {}),
    trace:interpretation.trace});
  if (preview.plan) {
    if (preview.plan.operationId!==`draft-operation:${draftId}`) fail('INVALID_DRAFT_REQUEST','El plan no corresponde al borrador.');
    prepareUniversalOperation(preview.plan,{...context,internalConversationOperation:true});
    validateUniversalOperationReview(preview.plan,preview.review);
  }
  preview.digest=operationRequestDigest({businessId:context.businessId,actorId:context.actorId,preview});
  return preview;
}
async function storeCommand(client,command,context,draftId,preview) {
  const saved=(await client.query('INSERT INTO universal_draft_commands(owner_phone,actor_id,request_id,request_hash,draft_id,response_json) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',
    [...command.scope,command.hash,draftId,JSON.stringify(preview)])).rows[0];
  if (!saved || saved.owner_phone!==context.businessId || saved.actor_id!==context.actorId || saved.request_id!==command.scope[2]
    || saved.request_hash!==command.hash || saved.draft_id!==draftId || !same(saved.response_json,preview)) fail('PERSISTED_EFFECT_MISMATCH','La respuesta guardada difiere del borrador.');
}
async function saveDraft(client,preview,context,insert=false) {
  const values=[context.businessId,preview.draftId,context.actorId,preview.version,preview.status,JSON.stringify(preview),preview.expiresAt];
  const row=(await client.query(insert
    ? 'INSERT INTO universal_drafts(owner_phone,draft_id,actor_id,version,status,preview_json,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *'
    : 'UPDATE universal_drafts SET version=$4,status=$5,preview_json=$6::jsonb,expires_at=$7 WHERE owner_phone=$1 AND draft_id=$2 AND actor_id=$3 RETURNING *',values)).rows[0];
  if (!row || row.owner_phone!==context.businessId || row.actor_id!==context.actorId || row.draft_id!==preview.draftId
    || row.version!==preview.version || row.status!==preview.status || !same(row.preview_json,preview)
    || new Date(row.expires_at).toISOString()!==preview.expiresAt) fail('PERSISTED_EFFECT_MISMATCH','El borrador guardado difiere de la revisión.');
  return row.preview_json;
}
export async function persistUniversalInterpretation(client,request,interpretation,context,{draftId=crypto.randomUUID(),reply=false}={}) {
  const kind=reply ? 'reply' : 'prepare';
  const command=await findDraftCommand(client,request,context,kind,reply ? draftId : null);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[JSON.stringify(['draft-command',...command.scope])]);
  const prior=await findDraftCommand(client,request,context,kind,reply ? draftId : null);
  if (prior.response) return prior.response;
  let version=1,text=request.text,clarifications=[];
  if (reply) {
    const row=await readUniversalDraft(client,draftId,context,{lock:true}); requirePending(row,request.version);
    version=row.version+1; text=`${row.preview_json.text}\n${request.text}`;
    clarifications=[...(row.preview_json.clarifications ?? []),...(row.preview_json.question ? [{question:row.preview_json.question,answer:request.text}] : [])];
    if (version>20 || text.length>12000) fail('INVALID_DRAFT_REQUEST','La conversación excede el límite. Prepará un borrador nuevo.');
  }
  const expiresAt=(await client.query("SELECT NOW()+INTERVAL '15 minutes' AS expires_at")).rows[0].expires_at.toISOString();
  const preview=previewFromInterpretation(interpretation,{draftId,version,text,clarifications,expiresAt,context});
  const saved=await saveDraft(client,preview,context,!reply);
  await storeCommand(client,command,context,draftId,saved);
  return saved;
}
export async function confirmUniversalDraftInTransaction(client,draftId,input,context,persistInventoryTransactions) {
  const confirmation=normalizeDraftConfirmation(input),row=await readUniversalDraft(client,draftId,context,{lock:true});
  if (row.preview_json.digest!==confirmation.digest || row.version!==confirmation.version) fail('DRAFT_VERSION_MISMATCH','La confirmación no corresponde a la revisión vigente.');
  if (row.preview_json.plan) {
    prepareUniversalOperation(row.preview_json.plan,{...context,internalConversationOperation:true});
    validateUniversalOperationReview(row.preview_json.plan,row.preview_json.review);
  }
  if (row.status==='applied') return row.preview_json;
  requirePending(row,confirmation.version);
  if (row.status!=='awaiting_confirmation') fail('DRAFT_NOT_READY','Falta responder la pregunta pendiente.');
  const result=await executeUniversalPlanInTransaction(client,row.preview_json.plan,{...context,internalConversationOperation:true},persistInventoryTransactions);
  return saveDraft(client,{...row.preview_json,status:'applied',result},context);
}
export async function cancelUniversalDraftInTransaction(client,draftId,input,context) {
  const confirmation=normalizeDraftConfirmation(input),row=await readUniversalDraft(client,draftId,context,{lock:true});
  if (row.preview_json.digest!==confirmation.digest || row.version!==confirmation.version) fail('DRAFT_VERSION_MISMATCH','La cancelación no corresponde a la revisión vigente.');
  if (row.status==='cancelled') return row.preview_json;
  requirePending(row,confirmation.version,true);
  return saveDraft(client,{...row.preview_json,status:'cancelled'},context);
}
