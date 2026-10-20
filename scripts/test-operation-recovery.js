import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {normalizeOperationRecovery,recoverLegacyPanelOperation} from '../server/operationRecovery.js';

const request={operationId:'old-operation',sourceText:'Ingresó un producto',actions:[{type:'add_stock',productName:'Producto',qty:1}]};
const context={businessId:'business',actorId:'actor',permissions:['inventory:read','accounts:read','orders:read']};
const receipt={status:'applied',operationId:'panel:old-operation',items:[{skuId:'stored-id'}]};
const original_hash=crypto.createHash('sha256').update(JSON.stringify({actions:request.actions,sourceText:request.sourceText})).digest('hex');

test('recovery looks up frozen receipts only, ignores read actions like the old writer and never needs a catalog',async()=>{
  let calls=0;
  const client={query:async(sql,params)=>{calls++;assert.match(sql,/^SELECT/);assert.deepEqual(params,['business','panel:old-operation','account-compat:panel:old-operation','batch:panel:old-operation']);return {rows:[{domain:'inventory',actor_id:'actor',original_hash,result_json:receipt}]};}};
  assert.deepEqual(await recoverLegacyPanelOperation(client,{...request,actions:[...request.actions,{type:'query_stock'}]},context),{status:'applied',operationId:request.operationId,operationResult:receipt});
  assert.equal(calls,1);
  assert.deepEqual(await recoverLegacyPanelOperation({query:async()=>({rows:[]})},request,context),{status:'not_applied',operationId:request.operationId});
});

test('recovery rejects altered content, other actors and ambiguous or unverifiable receipts',async()=>{
  for(const [rows,code,input] of [
    [[{domain:'inventory',actor_id:'actor',original_hash,result_json:receipt}],'IDEMPOTENCY_CONFLICT',{...request,sourceText:'Otra intención'}],
    [[{domain:'inventory',actor_id:'other',original_hash,result_json:receipt}],'FORBIDDEN',request],
    [[{actor_id:'actor'},{actor_id:'actor'}],'LEGACY_RECEIPT_AMBIGUOUS',request],
    [[{domain:'inventory',actor_id:'actor',original_hash,result_json:{}}],'LEGACY_RECEIPT_UNVERIFIABLE',request],
  ]) await assert.rejects(recoverLegacyPanelOperation({query:async()=>({rows})},input,context),{code});
});

test('recovery validates closed descriptor-safe requests and permissions before SQL',async()=>{
  const noSQL={query:()=>assert.fail('no SQL for invalid recovery')};
  for(const input of [{...request,businessId:'forged'},{...request,actions:[]},{...request,sourceText:'x'.repeat(12001)},
    {...request,actions:[Object.defineProperty({},'qty',{enumerable:true,get(){throw Error('getter ran');}})]},
    {...request,actions:[JSON.parse('{"__proto__":{"polluted":true}}')]}]) {
    assert.throws(()=>normalizeOperationRecovery(input),{code:'INVALID_RECOVERY_REQUEST'});
    await assert.rejects(recoverLegacyPanelOperation(noSQL,input,context),{code:'INVALID_RECOVERY_REQUEST'});
  }
  await assert.rejects(recoverLegacyPanelOperation(noSQL,request,{...context,permissions:[]}),{code:'FORBIDDEN'});
  await assert.rejects(recoverLegacyPanelOperation(noSQL,request,{...context,businessId:'__default__'}),{code:'BUSINESS_SCOPE_REQUIRED'});
});
