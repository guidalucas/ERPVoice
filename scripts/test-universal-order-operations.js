import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUniversalOrderPlan, validateUniversalOrderPlan, universalOrderPlanDigest, orderActionToRequest } from '../server/universalOrderOperations.js';
import { normalizeOrderRequest } from '../server/orderOperations.js';
import { operationRequestDigest } from '../server/operationHash.js';
import { prepareUniversalOperation } from '../server/universalOperations.js';

const context = {businessId:'business',actorId:'actor',permissions:['orders:create','orders:update','orders:delete','orders:reconcile','accounts:charge']};
const target = {kind:'existing',pedidoId:' pedido-1 ',expectedRevision:0};
const proof = {productId:' sku-1 ',expectedProductRevision:2,expectedFingerprint:' fingerprint ',available:5,reserved:1,quantity:3,unit:' unit ',reason:' Stock revisado ',confirmed:true};
const actions = [
  {itemId:'create',type:'order.create',order:{clienteId:' client-1 ',producto:' Producto ',qty:2}},
  {itemId:'update',type:'order.update',target,changes:{estado:'conseguido',productId:' sku-1 '}},
  {itemId:'delete',type:'order.delete',target},
  {itemId:'reconcile',type:'order.reconcile',target,reconciliation:proof},
];
const plan = (entries = actions) => ({contractVersion:1,businessId:'business',operationId:' order-batch ',actions:structuredClone(entries)});
const reject = (fn,code='INVALID_ORDER_OPERATION') => assert.throws(fn,{code});

test('all action kinds use the existing request normalizer and adapt safely to its request shape', () => {
  const normalized = normalizeUniversalOrderPlan(plan());
  assert.equal(normalized.operationId,'order-batch');
  assert.ok(Object.isFrozen(normalized));assert.ok(Object.isFrozen(normalized.actions));
  for (let index=0;index<actions.length;index++) {
    const action = actions[index], kind=action.type.slice(6), actual=normalized.actions[index];
    const payload = kind==='create'?action.order:kind==='update'?action.changes:kind==='reconcile'?{reconciliation:action.reconciliation}:{};
    const expected=normalizeOrderRequest(kind,action.target?.pedidoId,{operationId:'normalization',...(action.target?{expectedRevision:action.target.expectedRevision}:{}),...payload});
    if (kind==='create') assert.deepEqual(actual.order,expected.changes);
    else assert.deepEqual(actual.target,{kind:'existing',pedidoId:expected.pedidoId,expectedRevision:expected.expectedRevision});
    if(kind==='update') assert.deepEqual(actual.changes,expected.changes);
    if(kind==='reconcile') assert.deepEqual(actual.reconciliation,expected.reconciliation);
    const adapted=orderActionToRequest(actual,'child-operation');
    assert.equal(adapted.kind,kind);assert.equal(adapted.pedidoId,expected.pedidoId);
    assert.deepEqual(normalizeOrderRequest(kind,adapted.pedidoId,adapted.input),{...expected,operationId:'child-operation'});
    assert.ok(Object.isFrozen(actual));
  }
  assert.equal(normalized.actions[0].order.estado,'pendiente');
  assert.equal(normalized.actions[0].order.proveedorId,null);
  assert.deepEqual(Object.keys(normalized.actions[2]),['itemId','type','target']);
  assert.equal(normalized.actions[3].reconciliation.reason,'Stock revisado');
});

test('closed envelope and actions reject prototypes, undefined, unknown fields and getters without executing', () => {
  const mutations = [p=>p.contractVersion=2,p=>p.extra=true,p=>p.source=undefined,p=>p.actions=[],p=>delete p.actions[0],p=>p.actions.extra=true,
    p=>p.actions[0].order.operationId='forged',p=>p.actions[0].operationId='forged',p=>p.actions[0].target=target,
    p=>p.actions[0].order.producto=undefined,p=>p.actions[1].changes.expectedRevision=99,p=>p.actions[1].target.extra=true,
    p=>p.actions[2].changes={},p=>p.actions[3].reconciliation.extra=true,p=>p.actions[3].reconciliation.reason=undefined,
    p=>Object.setPrototypeOf(p.actions[0].order,{forged:true}),p=>Object.setPrototypeOf(p.actions[1].target,{forged:true}),
    p=>Object.defineProperty(p,'source',{enumerable:true,get(){throw Error('getter ran');}}),
    p=>Object.defineProperty(p.actions[0],'type',{enumerable:true,get(){throw Error('getter ran');}}),
    p=>Object.defineProperty(p.actions[0].order,'producto',{enumerable:true,get(){throw Error('getter ran');}}),
    p=>Object.defineProperty(p.actions[3].reconciliation,'reason',{enumerable:true,get(){throw Error('getter ran');}})];
  for(const mutate of mutations){const input=plan();mutate(input);reject(()=>normalizeUniversalOrderPlan(input));}
  for(const type of ['order.unknown','client.create','constructor']) reject(()=>normalizeUniversalOrderPlan(plan([{...actions[0],type}])));
  reject(()=>normalizeUniversalOrderPlan(plan([{...actions[0],itemId:' duplicate '},{...actions[0],itemId:'duplicate'}])));
  reject(()=>orderActionToRequest({...actions[0],order:{...actions[0].order,operationId:'forged'}},'trusted'));
});

test('revision, data and reconciliation proof validation remain domain-owned', () => {
  for(const expectedRevision of [undefined,-1,0.5,Number.MAX_SAFE_INTEGER+1,'0']) reject(()=>normalizeUniversalOrderPlan(plan([{...actions[1],target:{...target,expectedRevision}}])));
  for(const patch of [{confirmed:false},{quantity:0},{available:-1},{expectedProductRevision:0.5},{expectedFingerprint:''},{unit:null}]) reject(()=>normalizeUniversalOrderPlan(plan([{...actions[3],reconciliation:{...proof,...patch}}])));
  reject(()=>normalizeUniversalOrderPlan(plan([{...actions[1],changes:{}}])));
  reject(()=>normalizeUniversalOrderPlan(plan([{...actions[0],order:{clienteId:'client',producto:'Product',qty:0}}])));
  assert.equal(validateUniversalOrderPlan(plan(),context).actions.length,4);
});

test('orders require action permissions and authorized scope, without direct inventory permissions', () => {
  for(const action of actions){
    const permission=`orders:${action.type.slice(6)}`;
    assert.equal(validateUniversalOrderPlan(plan([action]),{...context,permissions:new Set([permission])}).actions[0].type,action.type);
    reject(()=>validateUniversalOrderPlan(plan([action]),{...context,permissions:context.permissions.filter(p=>p!==permission)}),'FORBIDDEN');
  }
  for(const contextPatch of [{businessId:''},{businessId:'__default__'},{actorId:''}]) reject(()=>validateUniversalOrderPlan(plan(),{...context,...contextPatch}),'BUSINESS_SCOPE_REQUIRED');
  reject(()=>validateUniversalOrderPlan(plan(),{...context,businessId:'foreign'}),'BUSINESS_SCOPE_MISMATCH');
  reject(()=>validateUniversalOrderPlan(plan(),{...context,permissions:null}),'FORBIDDEN');
  const internal={...plan(),operationId:'universal-child:reserved'};
  reject(()=>validateUniversalOrderPlan(internal,context),'FORBIDDEN');
  assert.equal(validateUniversalOrderPlan(internal,{...context,internalUniversalOperation:true}).operationId,internal.operationId);
});

test('source is closed and descriptive fields do not change semantic digest', () => {
  const input=plan(), hash=universalOrderPlanDigest(input);
  const normalized=normalizeUniversalOrderPlan({...input,source:{channel:' test ',text:'',messageId:''}});
  assert.deepEqual(normalized.source,{channel:'test',text:'',messageId:''});
  assert.equal(universalOrderPlanDigest(normalized),hash);
  const semantic={...input,source:{channel:'test',requestHash:'proof'}};
  const {source,...body}=normalizeUniversalOrderPlan(semantic);
  assert.equal(universalOrderPlanDigest(semantic),operationRequestDigest({...body,requestHash:'proof'}));
  assert.notEqual(universalOrderPlanDigest(semantic),hash);
  for(const source of [{channel:''},{channel:'test',requestHash:''},{channel:'test',requestHash:' '},{channel:'test',messageId:1},{channel:'test',extra:'x'},{channel:'test',text:undefined}]) reject(()=>normalizeUniversalOrderPlan({...input,source}));
  const changed=plan();changed.actions[0].order.qty++;
  assert.notEqual(universalOrderPlanDigest(changed),hash);
  assert.equal(universalOrderPlanDigest(normalizeUniversalOrderPlan(input)),hash);
});

test('orders integrate homogeneous and mixed positions while reentry is rejected', () => {
  const order=actions[0], account={itemId:'charge',type:'account.charge',target:{kind:'existing',clientId:'client'},amount:{value:1,unit:'legacy-money'},reason:'Cargo'};
  const homogeneous=prepareUniversalOperation(plan([order]),context);
  assert.equal(homogeneous.domain,'orders');
  assert.equal(homogeneous.requestHash,operationRequestDigest({domain:'orders',digest:universalOrderPlanDigest(homogeneous.plan)}));
  for(const entries of [[order,account],[account,order]]) {
    const input=plan(entries), original=structuredClone(input), prepared=prepareUniversalOperation(input,context);
    assert.equal(prepared.domain,'mixed');
    assert.deepEqual(prepared.plan.actions.map(a=>a.type),entries.map(a=>a.type));
    assert.deepEqual(input,original);
    assert.equal(prepared.plan.operationId,'order-batch');
  }
  reject(()=>prepareUniversalOperation(plan([order,account,{...order,itemId:'order-again'}]),context),'UNSUPPORTED_OPERATION_ORDER');
  reject(()=>prepareUniversalOperation(plan([order,{...account,itemId:order.itemId}]),context),'INVALID_OPERATION_PLAN');
});
