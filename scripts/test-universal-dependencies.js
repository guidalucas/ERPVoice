import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretUniversalIntent} from '../server/universalIntentInterpreter.js';
import {prepareUniversalOperation} from '../server/universalOperations.js';
import {planInventoryOperation} from '../server/inventoryOperations.js';
import {buildUniversalOperationReview} from '../server/universalOperationReview.js';

const context={businessId:'dependency-tests',actorId:'actor',internalConversationOperation:true,permissions:[
  'clients:create','suppliers:create','orders:create','orders:update','accounts:charge','inventory:create','inventory:receive','inventory:reserve','inventory:update']};
const catalog={products:[],clients:[{id:'existing',name:'Emiliano',debt:0,accountRevision:0}],proveedores:[],pedidos:[]};
const customer={itemId:'customer',type:'client.create',name:'Emiliano'};
const order={itemId:'order',type:'order.create',clientRef:{itemId:'customer'},order:{producto:'Camiseta blanca',talle:'L'}};
const receipt={itemId:'new-product',type:'stock.receive',target:{kind:'new',sku:{name:'Producto nuevo',unit:'caja'}},quantity:{value:5,unit:'caja'}};
const reserve={itemId:'reserve',type:'stock.reserve',target:{kind:'created',itemId:'new-product'},quantity:{value:2,unit:'caja'}};
const proposal=(actions,text)=>({contractVersion:1,kind:'proposal',actions,evidence:actions.map(action=>({itemId:action.itemId,quote:text}))});
const interpret=(json,text='Alta y operación solicitadas.',extra={})=>interpretUniversalIntent({sourceText:text,catalog,context,operationId:'draft-operation:dependency-tests',channel:'test',complete:async()=>({ok:true,json}),...extra});
const ready=actions=>interpret(proposal(actions,'Alta y operación solicitadas.'));
const edit=async(previous,edits,reply='Corregí explícitamente estas operaciones.',extra={})=>interpret({contractVersion:1,kind:'edit',edits,
  evidence:edits.map(item=>({itemId:item.itemId??item.action.itemId,quote:reply}))},`${previous.plan.source.text}\n${reply}`,{
  revision:{plan:previous.plan,evidence:previous.evidence,replyText:reply},...extra});

test('created customers and suppliers can be used by account charges and pending orders',async()=>{
  const charge={itemId:'charge',type:'account.charge',target:{kind:'created',itemId:'customer'},amount:{value:5000,unit:'legacy-money'},reason:'Fiado solicitado'};
  const result=await ready([customer,{itemId:'supplier',type:'supplier.create',name:'Proveedor nuevo'},charge,{...order,supplierRef:{itemId:'supplier'}}]);
  assert.equal(result.kind,'ready');assert.equal(prepareUniversalOperation(result.plan,context).domain,'mixed');
  const review=buildUniversalOperationReview(result.plan,catalog);
  assert.match(review[2].title,/Emiliano/);assert.match(review[2].details.join(' '),/Cliente nuevo/);
  assert.match(review[3].details.join(' '),/Proveedor nuevo/);
  for(const itemId of ['missing','order','supplier']) {
    const bad=structuredClone(charge);bad.target.itemId=itemId;
    const result=await ready([customer,{itemId:'supplier',type:'supplier.create',name:'Proveedor'},bad]);
    assert.equal(result.kind,'invalid');assert.equal(result.reason,'INVALID_OPERATION_REFERENCE');
  }
  assert.equal((await ready([charge,customer])).kind,'invalid');
  assert.equal((await ready([customer,charge])).kind,'ready');
  assert.equal((await interpret(proposal([customer,charge],'x'),'x',{context:{...context,permissions:['clients:create']}})).reason,'FORBIDDEN');
});

test('new product receipt and dependent reservation share one inventory plan and exact units',async()=>{
  const result=await ready([receipt,reserve]);assert.equal(result.kind,'ready');
  const effect=planInventoryOperation(result.plan,[],{createId:()=> 'generated-sku'});
  assert.equal(effect.changedProducts.length,1);assert.equal(effect.changedProducts[0].stockAvailable,3);assert.equal(effect.changedProducts[0].stockReserved,2);
  assert.deepEqual(effect.items.map(item=>item.skuId),['generated-sku','generated-sku']);
  assert.equal(effect.items[0].created,true);assert.equal(effect.items[1].created,false);
  const review=buildUniversalOperationReview(result.plan,catalog);assert.match(review[1].title,/Producto nuevo/);
  assert.equal((await ready([receipt,{...reserve,quantity:{value:2,unit:'unit'}}])).reason,'INVALID_INVENTORY_UNIT');
  for(const target of [{kind:'created',itemId:'missing'},{kind:'created',itemId:'reserve'},{kind:'created',itemId:'new-product',expectedRevision:0}])
    assert.equal((await ready([receipt,{...reserve,target}])).kind,'invalid');
  assert.equal((await ready([reserve,receipt])).kind,'invalid');
  assert.throws(()=>planInventoryOperation((prepareUniversalOperation({...result.plan,actions:[result.plan.actions[0],{...result.plan.actions[1],quantity:{value:6,unit:'caja'}}]},context)).plan,[],{createId:()=> 'generated-sku'}),{code:'INSUFFICIENT_STOCK'});
});

test('order product references are explicit and cannot also carry an existing product ID',async()=>{
  const pending={itemId:'pending',type:'order.create',productRef:{itemId:'new-product'},order:{clienteId:'existing',producto:'Producto nuevo'}};
  const valid=await ready([receipt,pending]);assert.equal(valid.kind,'ready');
  assert.match(buildUniversalOperationReview(valid.plan,catalog)[1].details.join(' '),/Producto nuevo/);
  assert.equal((await ready([receipt,{...pending,order:{...pending.order,productId:null}}])).kind,'invalid');
  assert.equal((await ready([receipt,{...pending,productRef:{itemId:'missing'}}])).reason,'INVALID_OPERATION_REFERENCE');
});

test('structural revisions add, remove and replace only specified actions and preserve unrelated evidence',async()=>{
  const previous=await ready([customer,order]),original=structuredClone(previous);
  const added={itemId:'another-order',type:'order.create',clientRef:{itemId:'customer'},order:{producto:'Otra camiseta',talle:'M'}};
  const expanded=await edit(previous,[{op:'add',afterItemId:'order',action:added}],'Agregá otra camiseta M.');
  assert.equal(expanded.kind,'ready');assert.deepEqual(expanded.plan.actions.map(action=>action.itemId),['customer','order','another-order']);
  assert.deepEqual(expanded.evidence.slice(0,2),previous.evidence);
  const reduced=await edit(expanded,[{op:'remove',itemId:'another-order'}],'Sacá el último pedido.');
  assert.equal(reduced.kind,'ready');assert.deepEqual(reduced.plan.actions,previous.plan.actions);
  const existing={...order,order:{...order.order,clienteId:'existing'}};delete existing.clientRef;
  const switched=await edit(previous,[{op:'remove',itemId:'customer'},{op:'replace',itemId:'order',action:existing}],'Emiliano ya existía, usá el cliente guardado.');
  assert.equal(switched.kind,'ready');assert.equal(switched.plan.actions.length,1);assert.equal(switched.plan.actions[0].order.clienteId,'existing');
  assert.equal(switched.plan.actions[0].clientRef,undefined);
  assert.deepEqual(previous,original);
  const cancelled=await edit(previous,[{op:'remove',itemId:'customer'},{op:'remove',itemId:'order'}],'Sacá todo el pedido y el alta.');
  assert.equal(cancelled.kind,'cancelled');assert.equal(cancelled.plan,undefined);
});

test('structural revisions reject dangling references, unauthorized actions, evidence omissions and forged preconditions',async()=>{
  const previous=await ready([customer,order]);
  const cases=[
    [{op:'remove',itemId:'customer'}],
    [{op:'remove',itemId:'missing'}],
    [{op:'remove',itemId:'order'},{op:'remove',itemId:'order'}],
    [{op:'add',afterItemId:'missing',action:{...customer,itemId:'another'}}],
    [{op:'add',afterItemId:null,action:customer}],
    [{op:'replace',itemId:'order',action:{...order,itemId:'changed'}}],
    [{op:'replace',itemId:'order',action:{...order,order:{...order.order,operationId:'forged'}}}],
    [{op:'patch',itemId:'order',changes:{type:'order.delete'}}],
    [{op:'add',afterItemId:'order',action:{itemId:'x',type:'client.delete',target:{kind:'existing',partyId:'existing',expectedRevision:0},reason:'forged'}}],
  ];
  for(const edits of cases) assert.equal((await edit(previous,edits)).kind,'invalid',JSON.stringify(edits));
  const reply='Sacá el pedido.';
  for(const evidence of [[],[{itemId:'order',quote:previous.plan.source.text}],[{itemId:'other',quote:reply}]]) {
    const json={contractVersion:1,kind:'edit',edits:[{op:'remove',itemId:'order'}],evidence};
    const result=await interpret(json,`${previous.plan.source.text}\n${reply}`,{revision:{plan:previous.plan,evidence:previous.evidence,replyText:reply}});
    assert.equal(result.kind,'invalid');
  }
});
