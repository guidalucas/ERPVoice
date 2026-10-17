import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUniversalOperation } from '../server/universalOperations.js';
import { validateOperationPlan } from '../server/inventoryOperations.js';
import { validateAccountPlan } from '../server/accountOperations.js';
import { validatePartyPlan } from '../server/partyOperations.js';
import { operationResultActions } from '../server/operationResults.js';

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

test('universal parser rejects mixed, unknown, forged and non-data input before execution', () => {
  reject(() => prepareUniversalOperation(plan([inventory,account]),ctx),'MIXED_OPERATION_PLAN_UNSUPPORTED');
  reject(() => prepareUniversalOperation(plan([account,party]),ctx),'MIXED_OPERATION_PLAN_UNSUPPORTED');
  for (const type of ['client.merge','order.create','unknown','account.unknown']) reject(() => prepareUniversalOperation(plan([{...party,type}]),ctx));
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
