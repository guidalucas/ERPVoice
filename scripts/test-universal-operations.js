import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUniversalOperation } from '../server/universalOperations.js';
import { validateOperationPlan, operationDigest } from '../server/inventoryOperations.js';
import { validateAccountPlan, accountPlanDigest } from '../server/accountOperations.js';
import { validatePartyPlan, partyPlanDigest } from '../server/partyOperations.js';
import { operationRequestDigest } from '../server/operationHash.js';
import { operationResultActions } from '../server/operationResults.js';
import { validateUniversalOperationReview } from '../server/universalOperationReview.js';

const ctx = {businessId:'59899000961',actorId:'59899000962',permissions:['inventory:receive','inventory:update','inventory:deactivate','accounts:charge','clients:create']};
const inventory = {itemId:'one',type:'stock.receive',target:{kind:'new',sku:{name:'SKU universal',unit:'unit'}},quantity:{value:3,unit:'unit'}};
const account = {itemId:'one',type:'account.charge',target:{kind:'existing',clientId:'client'},amount:{value:4,unit:'legacy-money'},reason:'Cargo explícito'};
const party = {itemId:'one',type:'client.create',name:'Cliente universal'};
const plan = (actions) => ({contractVersion:1,businessId:ctx.businessId,operationId:'universal-test',actions});
const reject = (fn, code = 'INVALID_OPERATION_PLAN') => assert.throws(fn,{code});

test('universal entry delegates canonical immutable contracts and hashes semantic intent', () => {
  for (const [action,domain] of [[inventory,'inventory'],[account,'accounts'],[party,'parties']]) {
    const input = plan([structuredClone(action)]), prepared = prepareUniversalOperation(input,ctx);
    assert.equal(prepared.domain,domain);assert.equal(prepared.plan.contractVersion,1);
    assert.ok(Object.isFrozen(prepared.plan.actions[0]));assert.ok(Object.isFrozen(prepared));
    assert.equal(prepareUniversalOperation({...input,operationId:' universal-test '},ctx).requestHash,prepared.requestHash);
    assert.equal(prepareUniversalOperation({...input,source:{channel:'otra',text:'Fuente descriptiva'}},ctx).requestHash,prepared.requestHash);
    input.actions[0].itemId = 'another';
    assert.notEqual(prepareUniversalOperation(input,ctx).requestHash,prepared.requestHash);
    reject(() => prepareUniversalOperation(plan([action]),{...ctx,permissions:[]}), 'FORBIDDEN');
    reject(() => prepareUniversalOperation(plan([action]),{...ctx,businessId:'foreign'}),'BUSINESS_SCOPE_MISMATCH');
  }
  const one = prepareUniversalOperation({...plan([account]),source:{channel:'test',requestHash:'first'}},ctx);
  assert.notEqual(prepareUniversalOperation({...plan([account]),source:{channel:'test',requestHash:'second'}},ctx).requestHash,one.requestHash);
});

test('universal parser rejects domain reentry, unknown, forged and non-data input before execution', () => {
  reject(() => prepareUniversalOperation(plan([inventory,account,inventory]),ctx),'UNSUPPORTED_OPERATION_ORDER');
  reject(() => prepareUniversalOperation(plan([account,party,account]),ctx),'UNSUPPORTED_OPERATION_ORDER');
  for (const type of ['client.merge','order.unknown','unknown','account.unknown']) reject(() => prepareUniversalOperation(plan([{...party,type}]),ctx));
  const mutations = [p => p.contractVersion=2,p => p.actorId='forged',p => p.domain='parties',p => p.actions=[],p => delete p.actions[0],
    p => p.actions.extra=true,p => Object.defineProperty(p,'actions',{enumerable:true,get(){throw Error('getter executed');}}),
    p => Object.defineProperty(p.actions[0],'type',{enumerable:true,get(){throw Error('getter executed');}})];
  for (const mutate of mutations) {const p=plan([structuredClone(party)]);mutate(p);reject(() => prepareUniversalOperation(p,ctx));}
  for (const operationId of [undefined,'',' ','x'.repeat(181),2]) reject(() => prepareUniversalOperation({...plan([party]),operationId},ctx),'OPERATION_ID_REQUIRED');
  reject(() => prepareUniversalOperation(plan([party]),{}),'BUSINESS_SCOPE_REQUIRED');
});

test('universal execution cannot bypass existing set review or private child namespaces', () => {
  const update = {itemId:'one',type:'sku.update',target:{kind:'existing',skuId:'sku-1',expectedRevision:0},changes:{name:'Actualizado'},reason:'Revisión explícita'};
  assert.equal(prepareUniversalOperation(plan([update]),ctx).domain,'inventory');
  reject(() => prepareUniversalOperation(plan([update,{...update,itemId:'two',target:{...update.target,skuId:'sku-2'}}]),ctx),'SELECTION_REQUIRED');
  const {changes,...deactivate} = {...update,type:'sku.deactivate'};
  reject(() => prepareUniversalOperation(plan([deactivate]),ctx),'SELECTION_REQUIRED');
  for (const [action,validate] of [[inventory,validateOperationPlan],[account,validateAccountPlan],[party,validatePartyPlan]]) {
    const p = {...plan([action]),operationId:'universal-child:forged'};
    reject(() => validate(p,ctx),'FORBIDDEN');reject(() => prepareUniversalOperation(p,ctx),'FORBIDDEN');
  }
  const event = operationResultActions({domainResult:{items:[{itemId:'one',type:'client.create',party:{id:'saved',name:'Guardado',notas:null,metadataRevision:0}}]}});
  assert.equal(event[0].clientId,'saved');
});

test('only internal reserved conversation plans accept frozen bulk changes and deactivations', () => {
  const action={itemId:'one',type:'sku.update',target:{kind:'existing',skuId:'sku-1',expectedRevision:0},changes:{price:0},reason:'Revisión'};
  const entries=[action,{...action,itemId:'two',target:{...action.target,skuId:'sku-2'}}];
  const internal={...ctx,internalConversationOperation:true};
  reject(()=>prepareUniversalOperation(plan(entries),internal),'SELECTION_REQUIRED');
  reject(()=>prepareUniversalOperation({...plan(entries),operationId:'draft-operation:test'},ctx),'FORBIDDEN');
  const frozen=prepareUniversalOperation({...plan(entries),operationId:'draft-operation:test'},internal).plan;
  assert.equal(frozen.actions.length,2);
  const {changes,...deactivation}={...action,type:'sku.deactivate'};
  assert.equal(prepareUniversalOperation({...plan([deactivation]),operationId:'draft-operation:test'},internal).plan.actions[0].type,'sku.deactivate');
  reject(()=>prepareUniversalOperation({...plan(entries),operationId:'draft-operation:test'},{...internal,permissions:[]}),'FORBIDDEN');
});

test('complete operation reviews cover each frozen item once and in exact order', () => {
  const p={actions:[{itemId:'a'},{itemId:'b'}]}, review=[{itemId:'a',title:'Uno',details:['Dato']},{itemId:'b',title:'Dos',details:['Otro dato']}];
  assert.equal(validateUniversalOperationReview(p,review),review);
  for(const bad of [review.slice(0,1),[review[1],review[0]],[review[0],review[0]],review.map(item=>({...item,title:''})),review.map(item=>({...item,details:[false]}))])
    reject(()=>validateUniversalOperationReview(p,bad),'INVALID_DRAFT_REQUEST');
});

test('homogeneous contracts retain the preexisting exact normalized shape and digest', () => {
  for (const [action,domain,validate,digest] of [[inventory,'inventory',validateOperationPlan,operationDigest],[account,'accounts',validateAccountPlan,accountPlanDigest],[party,'parties',validatePartyPlan,partyPlanDigest]]) {
    const input = {...plan([action]),operationId:' universal-test ',source:{channel:' test ',text:' Descripción '}};
    const normalized = validate({...input,operationId:input.operationId.trim()},ctx);
    const expected = {domain,plan:normalized,requestHash:operationRequestDigest({domain,digest:digest(normalized)})};
    assert.equal(JSON.stringify(prepareUniversalOperation(input,ctx)),JSON.stringify(expected));
    assert.deepEqual(Object.keys(prepareUniversalOperation(input,ctx)),['domain','plan','requestHash']);
  }
});

const unique = (action,itemId) => ({...structuredClone(action),itemId});
const mixedActions = () => [unique(party,'party-1'),unique(account,'account-1'),unique(inventory,'inventory-1'),unique(inventory,'inventory-2')];

test('mixed plans preserve block and action order, canonical domain plans and semantic hash', () => {
  const input = {...plan(mixedActions()),source:{channel:' test ',text:' Texto común '}};
  const original = structuredClone(input), result = prepareUniversalOperation(input,ctx);
  assert.equal(result.domain,'mixed');
  assert.deepEqual(result.segments.map(({domain}) => domain),['parties','accounts','inventory']);
  const validators = {inventory:validateOperationPlan,accounts:validateAccountPlan,parties:validatePartyPlan};
  const digests = {inventory:operationDigest,accounts:accountPlanDigest,parties:partyPlanDigest};
  for (const segment of result.segments) {
    const expected = validators[segment.domain]({...input,actions:input.actions.filter(action => segment.plan.actions.some(normalized => normalized.itemId === action.itemId))},ctx);
    assert.deepEqual(segment.plan,expected);
    assert.equal(segment.plan.operationId,input.operationId);
    assert.ok(Object.isFrozen(segment));assert.ok(Object.isFrozen(segment.plan));
  }
  assert.deepEqual(result.plan.actions,result.segments.flatMap(({plan}) => plan.actions));
  assert.deepEqual(result.plan.source,result.segments[0].plan.source);
  assert.equal(result.plan.source.channel,'test');
  assert.equal(result.segments[1].plan.source.channel,' test ');
  assert.equal(result.requestHash,operationRequestDigest({segments:result.segments.map(({domain,plan}) => ({domain,digest:digests[domain](plan)}))}));
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.plan));assert.ok(Object.isFrozen(result.plan.actions));assert.ok(Object.isFrozen(result.segments));
  assert.deepEqual(input,original);
  const altered = structuredClone(input);altered.actions[1].amount.value++;
  assert.notEqual(prepareUniversalOperation(altered,ctx).requestHash,result.requestHash);
  assert.notEqual(prepareUniversalOperation({...input,actions:[input.actions[1],input.actions[0],...input.actions.slice(2)]},ctx).requestHash,result.requestHash);
  assert.notEqual(prepareUniversalOperation({...input,operationId:'another'},ctx).requestHash,result.requestHash);
  assert.equal(prepareUniversalOperation({...input,source:{channel:'different',text:'different'}},ctx).requestHash,result.requestHash);
});

test('every supported domain ordering is accepted without regrouping', () => {
  const actions = [unique(inventory,'inventory'),unique(account,'account'),unique(party,'party')];
  for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
    const input = plan(order.map(index => actions[index]));
    assert.deepEqual(prepareUniversalOperation(input,ctx).plan.actions.map(action => action.itemId),input.actions.map(action => action.itemId));
  }
});

test('mixed normalization remains stable and rejects item IDs that collide after domain normalization', () => {
  const input=plan([unique(party,'party'),unique(account,'account'),unique(inventory,'stock')]);
  const prepared=prepareUniversalOperation(input,ctx);
  assert.equal(prepareUniversalOperation(prepared.plan,ctx).requestHash,prepared.requestHash);
  reject(() => prepareUniversalOperation(plan([unique(party,' same '),unique(account,'same')]),ctx));
});

test('all mixed blocks require authorization and validation before returning a prepared plan', () => {
  const input = plan(mixedActions()), before = structuredClone(input);
  for (const permission of ['clients:create','accounts:charge','inventory:receive']) {
    reject(() => prepareUniversalOperation(input,{...ctx,permissions:ctx.permissions.filter(value => value !== permission)}),'FORBIDDEN');
  }
  const malformed = structuredClone(input);malformed.actions.at(-1).quantity.value = -1;
  reject(() => prepareUniversalOperation(malformed,ctx));
  const badAlias = structuredClone(input);badAlias.actions[1].target = {kind:'new',itemId:'party-1'};
  reject(() => prepareUniversalOperation(badAlias,ctx),'INVALID_ACCOUNT_OPERATION');
  reject(() => prepareUniversalOperation({...input,source:{channel:'test',requestHash:'account-only'}},ctx),'INVALID_PARTY_OPERATION');
  reject(() => prepareUniversalOperation({...input,operationId:'universal-child:forged'},ctx),'FORBIDDEN');
  reject(() => prepareUniversalOperation(input,{...ctx,businessId:'foreign'}),'BUSINESS_SCOPE_MISMATCH');
  assert.deepEqual(input,before);
});

test('global item IDs use exact raw strings and reject duplicates across domain blocks', () => {
  const input = plan([unique(inventory,'same'),unique(account,'same')]), original = structuredClone(input);
  reject(() => prepareUniversalOperation(input,ctx));
  assert.deepEqual(input,original);
  const distinct = prepareUniversalOperation(plan([unique(inventory,' same '),unique(account,'same')]),ctx);
  assert.deepEqual(distinct.plan.actions.map(action => action.itemId),[' same ','same']);
});

test('mixed inventory blocks retain the reviewed selection guard and explicit party updates', () => {
  const update = {itemId:'update-1',type:'sku.update',target:{kind:'existing',skuId:'sku-1',expectedRevision:0},changes:{name:'Actualizado'},reason:'Revisión explícita'};
  reject(() => prepareUniversalOperation(plan([unique(account,'account'),update,{...update,itemId:'update-2',target:{...update.target,skuId:'sku-2'}}]),ctx),'SELECTION_REQUIRED');
  const {changes,...deactivate} = {...update,type:'sku.deactivate'};
  reject(() => prepareUniversalOperation(plan([unique(account,'account'),deactivate]),ctx),'SELECTION_REQUIRED');
  const partyUpdate = {itemId:'client-update',type:'client.update',target:{kind:'existing',partyId:'client',expectedRevision:0},changes:{name:' cliente actualizado '}};
  const result = prepareUniversalOperation(plan([partyUpdate,unique(account,'charge')]),{...ctx,permissions:[...ctx.permissions,'clients:update']});
  assert.equal(result.plan.actions[0].changes.name,'Cliente Actualizado');
  assert.deepEqual(result.plan.actions[1].target,{kind:'existing',clientId:'client'});
});
