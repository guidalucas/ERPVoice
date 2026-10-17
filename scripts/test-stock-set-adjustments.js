import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelectionPreview, normalizeSelectionRequest } from '../server/inventorySelections.js';
import { planInventoryOperation } from '../server/inventoryOperations.js';

const product = (id,unit,stockAvailable,stockReserved) => ({id,unit,stockAvailable,stockReserved,name:`Producto ${id}`,revision:2,attributes:{},price:10,priceCurrency:'UYU',status:'active'});
const products = [product('one','unit',8,2),product('two','kg',3,1)];
const context = {businessId:'set-adjustment',actorId:'actor',selectionId:'frozen',expiresAt:'2030-01-01T00:00:00.000Z',permissions:['inventory:adjust']};
const request = (balances) => ({requestId:'adjustment',selector:{kind:'ids',skuIds:['two','one']},mutation:{type:'stock.adjust',balances,reason:'Conteo revisado por SKU'}});

test('adjustment set preview uses the same deterministic final balances in each SKU base unit', () => {
  const before = structuredClone(products), {plan,preview} = buildSelectionPreview(request({available:0}),products,context);
  assert.deepEqual(products,before);
  assert.deepEqual(preview.members.map((m) => [m.skuId,m.unit,m.stockAvailable,m.stockReserved,m.finalAvailable,m.finalReserved]),[
    ['one','unit',8,2,0,2],['two','kg',3,1,0,1],
  ]);
  const effect = planInventoryOperation(plan,products);
  for (const member of preview.members) {
    const actual = effect.changedProducts.find((p) => p.id === member.skuId);
    assert.equal(actual.stockAvailable,member.finalAvailable);assert.equal(actual.stockReserved,member.finalReserved);
  }
});

test('adjustment sets reject missing/invalid balances, crossed mutation fields and missing permission', () => {
  for (const balances of [{}, {available:-1},{available:0.1},{reserved:'0'},{available:Number.MAX_SAFE_INTEGER+1},{price:0}])
    assert.throws(() => normalizeSelectionRequest(request(balances)));
  assert.throws(() => normalizeSelectionRequest({...request({available:0}),mutation:{...request({available:0}).mutation,changes:{name:'otro'}}}));
  assert.throws(() => normalizeSelectionRequest({...request({available:0}),mutation:{type:'sku.deactivate',balances:{available:0},reason:'Campo ajeno'}}));
  assert.throws(() => buildSelectionPreview(request({reserved:0}),products,{...context,permissions:['inventory:update']}),{code:'FORBIDDEN'});
  const oneRequest = {...request({available:8,reserved:2}),selector:{kind:'ids',skuIds:['one']}};
  const {plan,preview} = buildSelectionPreview(oneRequest,products,context);
  assert.equal(preview.members[0].finalAvailable,8);assert.equal(preview.members[0].finalReserved,2);
  assert.equal(planInventoryOperation(plan,products).movements[0].deltaAvailable,0);
});
