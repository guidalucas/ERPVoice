import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePartyPlan, validatePartyPlan, partyPlanDigest, partyCreationToPlan, partyUpdateToPlan, planPartyUpdate, partyDeleteToPlan, supplierMergeToPlan, planPartyDelete, planSupplierMerge } from '../server/partyOperations.js';
import { operationResultActions } from '../server/operationResults.js';

const context = { businessId: '59899900001', actorId: '59899900002', permissions: ['clients:create','suppliers:create'] };
const plan = () => ({ contractVersion: 1, businessId: context.businessId, operationId: 'party-test',
  actions: [{itemId:'client',type:'client.create',name:'  lucas   Pérez  ',notas:'  nota  '}, {itemId:'supplier',type:'supplier.create',name:'Proveedor'}] });
const invalid = (fn, code = 'INVALID_PARTY_OPERATION') => assert.throws(fn, {code});

test('party v1 canonical immutable plan preserves identity and debt requires a separate operation', () => {
  const input = plan(), result = normalizePartyPlan(input);
  assert.equal(result.actions[0].name, 'Lucas Pérez');
  assert.equal(result.actions[0].notas, 'nota');
  assert.equal(result.actions[1].notas, null);
  assert.ok(Object.isFrozen(result.actions[0]));
  input.actions[0].name = 'changed';
  assert.equal(result.actions[0].name, 'Lucas Pérez');
  const adapter = partyCreationToPlan('client', {operationId:'id',name:'Ana',debt:0}, context.businessId);
  assert.equal(adapter.actions[0].type, 'client.create');
  invalid(() => partyCreationToPlan('client',{operationId:'id',name:'Ana',debt:1}, context.businessId),'ACCOUNT_OPERATION_REQUIRED');
  invalid(() => partyCreationToPlan('supplier',{operationId:'id',name:'Ana',debt:0}, context.businessId));
  for (const operationId of [undefined,null,1,'','  ','x'.repeat(181)])
    invalid(() => partyCreationToPlan('client',{operationId,name:'Ana'}, context.businessId),'OPERATION_ID_REQUIRED');
});

test('party contract rejects forged targets, scopes, balances, duplicate items and non-data objects', () => {
  const mutations = [
    p => p.actions[0].target = {id:'foreign'}, p => p.actions[0].debt = 0,
    p => p.actions[0].notas = 7, p => p.actions[0].name = '', p => p.actions[0].name = 'x'.repeat(201),
    p => p.actions[0].type = 'client.update', p => p.actions[1].itemId = p.actions[0].itemId,
    p => delete p.actions[0], p => p.actions.extra = true, p => p.actorId = 'forged',
    p => p.actions = [], p => p.actions = Array(101).fill(p.actions[0]),
    p => p.actions[0] = Object.create(p.actions[0]),
    p => Object.defineProperty(p.actions[0],'name',{get(){throw Error('must not execute');},enumerable:true}),
    p => p.source = {channel:'panel',businessId:'forged'}, p => p.contractVersion = 2,
  ];
  for (const mutate of mutations) { const p = plan(); mutate(p); invalid(() => normalizePartyPlan(p)); }
  invalid(() => validatePartyPlan(plan(),{...context,permissions:[]}), 'FORBIDDEN');
  invalid(() => validatePartyPlan(plan(),{...context,businessId:'foreign'}),'BUSINESS_SCOPE_MISMATCH');
  invalid(() => validatePartyPlan(plan(),{...context,actorId:''}),'BUSINESS_SCOPE_REQUIRED');
  invalid(() => validatePartyPlan({...plan(),operationId:'order-party:forged'}, context),'FORBIDDEN');
  assert.deepEqual(validatePartyPlan(plan(),{...context,permissions:new Set(context.permissions)}),normalizePartyPlan(plan()));
});

test('semantic party digest ignores display source and canonical spacing, receipts project persisted parties', () => {
  const one = plan(), two = structuredClone(one);
  two.actions[0].name = 'Lucas Pérez';two.actions[0].notas = 'nota';two.source = {channel:'orders',text:'Otra presentación'};
  assert.equal(partyPlanDigest(one),partyPlanDigest(two));
  two.actions[0].name = 'Lucas Perez';assert.notEqual(partyPlanDigest(one),partyPlanDigest(two));
  const actions = operationResultActions({items:[{itemId:'one',type:'client.create',party:{id:'saved',name:'Persistido',notas:null}}]});
  assert.equal(actions[0].clientId,'saved');assert.equal(actions[0].clientName,'Persistido');
});

test('metadata patches use their own revision and never modify account balances or revisions', () => {
  const p = partyUpdateToPlan('client','existing',{operationId:'update',expectedRevision:4,notas:null},context.businessId);
  const current = {id:'existing',name:'Nombre',notas:'Antes',metadataRevision:4,debt:200,accountRevision:11};
  const next = planPartyUpdate(p.actions[0],current);
  assert.deepEqual(next,{...current,notas:null,metadataRevision:5});
  assert.equal(current.notas,'Antes');
  invalid(() => planPartyUpdate(p.actions[0],{...current,metadataRevision:5}),'PARTY_REVISION_MISMATCH');
  invalid(() => planPartyUpdate(p.actions[0],null),'PARTY_NOT_FOUND');
  invalid(() => planPartyUpdate(p.actions[0],{...current,debt:Number.MAX_SAFE_INTEGER+1}));
  invalid(() => validatePartyPlan(p,context),'FORBIDDEN');
  assert.deepEqual(validatePartyPlan(p,{...context,permissions:['clients:update']}),p);
});

test('metadata edits close targets and patches, require revisions and reject duplicate targets', () => {
  const make = () => partyUpdateToPlan('supplier','existing',{operationId:'edit',expectedRevision:0,name:'Nuevo'},context.businessId);
  const mutations = [
    p => p.actions[0].changes = {}, p => p.actions[0].changes.debt = 1,
    p => p.actions[0].target.kind = 'new', p => p.actions[0].target.expectedRevision = -1,
    p => p.actions[0].target.expectedRevision = Number.MAX_SAFE_INTEGER,
    p => p.actions[0].target.accountRevision = 7, p => p.actions[0].notas = null,
    p => p.actions.push({...p.actions[0],itemId:'two'}),
  ];
  for (const mutate of mutations) {const p = structuredClone(make());mutate(p);invalid(() => normalizePartyPlan(p));}
  invalid(() => partyUpdateToPlan('client','id',{operationId:'id',expectedRevision:0,debt:0},context.businessId),'ACCOUNT_OPERATION_REQUIRED');
  invalid(() => partyUpdateToPlan('supplier','id',{operationId:'id',notas:'sin revisión'},context.businessId));
  invalid(() => partyUpdateToPlan('supplier','id',{operationId:'id',expectedRevision:0},context.businessId));
});

test('client deletion requires reviewed metadata, current account revision, zero balance and no orders', () => {
  const p = partyDeleteToPlan('client','client',{operationId:'delete',expectedRevision:2,expectedAccountRevision:4,reason:'Baja revisada'},context.businessId);
  const current = {id:'client',name:'Cliente',notas:null,metadataRevision:2,accountRevision:4,debt:0};
  assert.deepEqual(planPartyDelete(p.actions[0],current,[]),current);
  invalid(() => planPartyDelete(p.actions[0],{...current,debt:1},[]),'CLIENT_HAS_BALANCE');
  invalid(() => planPartyDelete(p.actions[0],current,[{id:'pedido'}]),'CLIENT_HAS_ORDERS');
  invalid(() => planPartyDelete(p.actions[0],{...current,accountRevision:5},[]),'ACCOUNT_REVISION_MISMATCH');
  invalid(() => planPartyDelete(p.actions[0],{...current,metadataRevision:3},[]),'PARTY_REVISION_MISMATCH');
  invalid(() => partyDeleteToPlan('client','client',{operationId:'delete',expectedRevision:2,reason:'Sin revisión financiera'},context.businessId));
  invalid(() => partyDeleteToPlan('supplier','supplier',{operationId:'delete',expectedRevision:0,expectedAccountRevision:0,reason:'Campo ajeno'},context.businessId));
});

test('supplier merge requires both revisions and unique touched IDs, preserves notes without mutation', () => {
  const p = supplierMergeToPlan('keep','source',{operationId:'merge',expectedKeepRevision:4,expectedMergeRevision:2,reason:'Fusión revisada'},context.businessId);
  const keep = {id:'keep',name:'Conservar',notas:'Nota conservar',metadataRevision:4};
  const source = {id:'source',name:'Origen',notas:'Nota origen',metadataRevision:2};
  assert.deepEqual(planSupplierMerge(p.actions[0],source,keep),{...keep,notas:'Nota conservar\nNota origen',metadataRevision:5});
  assert.equal(keep.metadataRevision,4);assert.equal(source.metadataRevision,2);
  invalid(() => planSupplierMerge(p.actions[0],{...source,metadataRevision:3},keep),'PARTY_REVISION_MISMATCH');
  invalid(() => planSupplierMerge(p.actions[0],source,null),'PARTY_NOT_FOUND');
  invalid(() => supplierMergeToPlan('same','same',{operationId:'merge',expectedKeepRevision:0,expectedMergeRevision:0,reason:'Inválido'},context.businessId));
  const edited = partyUpdateToPlan('supplier','keep',{operationId:'edit',expectedRevision:4,notas:'Otra'},context.businessId).actions[0];
  invalid(() => normalizePartyPlan({...p,actions:[p.actions[0],{...edited,itemId:'two'}]}));
  const malicious = structuredClone(p);malicious.actions[0].changes={notas:'forjado'};
  invalid(() => normalizePartyPlan(malicious));
  invalid(() => validatePartyPlan({...p,operationId:'client-merge-party:forged'},{...context,permissions:['suppliers:merge']}),'FORBIDDEN');
});
