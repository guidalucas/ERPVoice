import test from 'node:test';
import assert from 'node:assert/strict';
import {checkInterpretation,checkPersistedEffects} from './evaluate-argentine-production.js';
import {compareUniversalGold} from './evaluate-universal-corpus.js';
import {argentineCases} from './fixtures/argentine-live-corpus.js';
import {universalIntentCorpus} from './fixtures/universal-intent-corpus.js';

test('clarification oracles require the missing fact and reject generic, unrelated or repeated questions',()=>{
  const expected={kind:'clarification',questionMustMention:[['talle','tamaño'],'short'],questionMustNotMention:['remera','moneda']};
  for(const question of ['¿Qué talle tiene el short?','¿Qué tamaño corresponde al short?']) {
    assert.doesNotThrow(()=>checkInterpretation(expected,{kind:'clarification',question},{}));
    assert.deepEqual(compareUniversalGold({expected},{kind:'clarification',question}),[]);
  }
  for(const question of ['', '¿Podés repetir todo?', '¿Qué moneda usás?', '¿Qué talle tienen el short y la remera?']) {
    assert.throws(()=>checkInterpretation(expected,{kind:'clarification',question},{}));
    assert.ok(compareUniversalGold({expected},{kind:'clarification',question}).length);
  }
  assert.ok(compareUniversalGold({expected:{kind:'clarification'}},{kind:'clarification',question:'¿Qué talle?'}).length);
  for(const fixture of [...universalIntentCorpus,...argentineCases({})]) if(fixture.expected.kind==='clarification')
    assert.ok(fixture.expected.questionMustMention?.length,fixture.id);
});

test('universal oracle checks created-reference wiring and accepts harmless order-description casing',()=>{
  const expected={kind:'ready',actions:[{type:'client.create',name:'Uno',notas:null},{type:'client.create',name:'Dos',notas:null},
    {type:'order.create',clientRef:0,order:{producto:'Camiseta Blanca',qty:1}},{type:'order.create',clientRef:1,order:{producto:'Camiseta Azul',qty:2}}]};
  const result={kind:'ready',plan:{actions:[{itemId:'a',type:'client.create',name:'Uno',notas:null},{itemId:'b',type:'client.create',name:'Dos',notas:null},
    {itemId:'c',type:'order.create',clientRef:{itemId:'a'},order:{producto:'camiseta blanca',qty:1}},{itemId:'d',type:'order.create',clientRef:{itemId:'b'},order:{producto:'camiseta azul',qty:2}}]}};
  assert.deepEqual(compareUniversalGold({expected},result),[]);
  for(const mutate of [r=>r.plan.actions[2].clientRef.itemId='b',r=>r.plan.actions[2].order.qty=2,r=>r.plan.actions[0].name='Otro']) {
    const bad=structuredClone(result);mutate(bad);assert.ok(compareUniversalGold({expected},bad).length);
  }
});

test('live oracle rejects the wrong garment, quantity, operation and invented sale price',()=>{
  const expected={kind:'ready',actions:[{type:'stock.sell',key:'remera-l',quantity:2}]},ids={'remera-l':'correct-l'};
  const result={kind:'ready',plan:{actions:[{type:'stock.sell',target:{skuId:'correct-l'},quantity:{value:2,unit:'unit'}}]}};
  assert.doesNotThrow(()=>checkInterpretation(expected,result,ids));
  for(const mutate of [r=>r.plan.actions[0].target.skuId='other-m',r=>r.plan.actions[0].quantity.value=3,r=>r.plan.actions[0].type='stock.reserve',r=>r.plan.actions[0].salePrice={amount:25000,currency:'ARS'}]){
    const bad=structuredClone(result);mutate(bad);assert.throws(()=>checkInterpretation(expected,bad,ids));
  }
});

test('live oracle accepts equivalent size wording and still rejects different size, price or lost garment facts',()=>{
  const expected={kind:'ready',actions:[{type:'new',quantity:4,terms:['media','negra'],size:'único',price:4000,units:['par']}]};
  const result={kind:'ready',plan:{actions:[{type:'stock.receive',target:{kind:'new',sku:{name:'Medias negras',size:'Talle único',unit:'par'}},quantity:{value:4,unit:'par'},price:{amount:4000,currency:'ARS'}}]}};
  assert.doesNotThrow(()=>checkInterpretation(expected,result,{}));
  for(const mutate of [r=>r.plan.actions[0].target.sku.size='M',r=>r.plan.actions[0].price.amount=4,r=>r.plan.actions[0].target.sku.name='Medias blancas',r=>r.plan.actions[0].target.sku.unit='kg']){
    const bad=structuredClone(result);mutate(bad);assert.throws(()=>checkInterpretation(expected,bad,{}));
  }
});

test('live oracle does not accept a repeat question where a resolved group must be ready',()=>{
  assert.throws(()=>checkInterpretation({kind:'ready',actions:[]},{kind:'clarification',question:'¿Para cuáles es L?'},{}));
  assert.throws(()=>checkInterpretation({kind:'clarification'},{kind:'ready',plan:{actions:[]}},{}));
});

test('sector oracle preserves commercial units and does not require clothing fields or an optional price',()=>{
  const expected={kind:'ready',actions:[{type:'new',quantity:3,terms:['fideo'],units:['paquete']}]};
  const result={kind:'ready',plan:{actions:[{type:'stock.receive',target:{kind:'new',sku:{name:'Fideos',unit:'paquete'}},quantity:{value:3,unit:'paquete'}}]}};
  assert.doesNotThrow(()=>checkInterpretation(expected,result,{}));
  for(const mutate of [r=>r.plan.actions[0].target.sku.unit='unit',r=>r.plan.actions[0].price={amount:1000,currency:'ARS'}]){
    const bad=structuredClone(result);mutate(bad);assert.throws(()=>checkInterpretation(expected,bad,{}));
  }
  const cableExpected={kind:'ready',actions:[{type:'stock.sell',key:'cable',quantity:8,unit:'metro'}]};
  const cableResult={kind:'ready',plan:{actions:[{type:'stock.sell',target:{skuId:'wire'},quantity:{value:8,unit:'metro'}}]}};
  assert.doesNotThrow(()=>checkInterpretation(cableExpected,cableResult,{cable:'wire'}));
  cableResult.plan.actions[0].quantity.unit='unit';assert.throws(()=>checkInterpretation(cableExpected,cableResult,{cable:'wire'}));
});

test('SQL oracle independently rejects incorrect persisted stock, account balances and units',()=>{
  const expected={actions:[{type:'stock.reserve',key:'cable',quantity:2},{type:'account.charge',client:'mica',amount:5000}]};
  const ids={cable:'wire',mica:'client'};
  const before={products:[{id:'wire',stock_available:10,stock_reserved:1,inventory_unit:'metro'}],clients:[{id:'client',debt:10000}]};
  const after={products:[{id:'wire',stock_available:8,stock_reserved:3,inventory_unit:'metro'}],clients:[{id:'client',debt:15000}]};
  assert.doesNotThrow(()=>checkPersistedEffects(expected,before,after,ids));
  for(const mutate of [r=>r.products[0].stock_available=7,r=>r.products[0].stock_reserved=1,r=>r.products[0].inventory_unit='unit',r=>r.clients[0].debt=5000]){
    const bad=structuredClone(after);mutate(bad);assert.throws(()=>checkPersistedEffects(expected,before,bad,ids));
  }
});
