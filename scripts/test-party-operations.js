import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePartyPlan, validatePartyPlan, partyPlanDigest, partyCreationToPlan } from '../server/partyOperations.js';
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
