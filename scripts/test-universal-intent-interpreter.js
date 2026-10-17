import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUniversalIntent } from '../server/universalIntentInterpreter.js';
import { inventoryProductFingerprint } from '../server/inventoryOperations.js';

const sourceText='Ingresá 3 unidades, cargá 5 a la cuenta y cambiá el nombre del cliente. Actualizá el pedido.';
const catalog={products:[{id:'sku',name:'Producto',unit:'unit',revision:7,stockAvailable:4,stockReserved:1}],clients:[{id:'client',name:'Cliente',accountRevision:9,metadataRevision:4}],proveedores:[{id:'supplier',name:'Proveedor',metadataRevision:6}],pedidos:[{id:'order',revision:8}]};
const context={businessId:'secret-tenant',actorId:'secret-actor',permissions:['inventory:receive','inventory:update','inventory:adjust','accounts:charge','accounts:transfer','clients:update','clients:create','clients:delete','suppliers:merge','orders:update','orders:create','orders:reconcile']};
const actions=[{itemId:'receive',type:'stock.receive',target:{kind:'existing',skuId:'sku'},quantity:{value:3,unit:'unit'}},{itemId:'charge',type:'account.charge',target:{kind:'existing',clientId:'client'},amount:{value:5,unit:'legacy-money'},reason:'Cargo solicitado'},{itemId:'client',type:'client.update',target:{kind:'existing',partyId:'client'},changes:{name:'Cliente nuevo'}},{itemId:'order',type:'order.update',target:{kind:'existing',pedidoId:'order'},changes:{qty:3,clienteId:'client',proveedorId:'supplier',productId:'sku'}}];
const proposal=(entries=actions)=>({contractVersion:1,kind:'proposal',actions:structuredClone(entries),evidence:entries.map(action=>({itemId:action.itemId,quote:sourceText}))});
const invoke=(json=proposal(),patch={})=>interpretUniversalIntent({sourceText,catalog:structuredClone(catalog),context,operationId:'secret-operation',channel:'test',complete:async()=>({ok:true,json}),...patch});

test('mixed ready proposal uses backend envelope and frozen catalog revisions without leaking authorization',async()=>{
  let calls=0;
  const original=proposal();
  const result=await invoke(original,{complete:async options=>{
    calls++;const serialized=JSON.stringify(options);
    for(const secret of ['secret-tenant','secret-actor','secret-operation','inventory:receive']) assert.equal(serialized.includes(secret),false);
    const supplied=JSON.parse(options.messages[1].content);assert.deepEqual(Object.keys(supplied),['sourceText','catalog','clarifications']);
    return {ok:true,json:original,provider:'stub',model:'model'};
  }});
  assert.equal(calls,1);assert.equal(result.kind,'ready');
  assert.equal(result.plan.businessId,context.businessId);assert.equal(result.plan.operationId,'secret-operation');
  assert.deepEqual(result.plan.source,{channel:'test',text:sourceText});
  assert.deepEqual(result.plan.actions.map(a=>a.target.expectedRevision),[7,9,4,8]);
  assert.equal(result.plan.actions[0].target.expectedFingerprint,inventoryProductFingerprint(catalog.products[0]));
  assert.deepEqual(result.evidence,original.evidence);assert.equal(original.actions[0].target.expectedRevision,undefined);
  assert.equal(result.trace.provider,'stub');assert.equal(result.trace.ok,true);assert.ok(Object.isFrozen(result.plan));
});

test('invented IDs, revisions, fingerprints and aliases are invalid',async()=>{
  for(const mutate of [p=>p.actions[0].target.skuId='invented',p=>p.actions[1].target.clientId='invented',p=>p.actions[2].target.partyId='invented',p=>p.actions[3].target.pedidoId='invented',p=>p.actions[3].changes.productId='invented',p=>p.actions[3].changes.clienteId='invented',p=>p.actions[3].changes.proveedorId='invented',p=>p.actions[0].target.expectedRevision=7,p=>p.actions[0].target.expectedFingerprint='forged',p=>p.actions[2].target.expectedRevision=4,p=>p.actions[3].target.expectedRevision=8,p=>p.actions[0].target.name='Producto']) {
    const data=proposal();mutate(data);assert.equal((await invoke(data)).kind,'invalid');
  }
});

test('literal evidence is exact, exhaustive, unique and closed',async()=>{
  for(const mutate of [p=>p.evidence.pop(),p=>p.evidence.push(p.evidence[0]),p=>p.evidence[0].quote='invented evidence',p=>p.evidence[0].quote='',p=>p.evidence[0].itemId='unknown',p=>p.evidence[1].itemId=p.evidence[0].itemId,p=>p.evidence[0].extra=true,p=>p.actions[1].itemId=p.actions[0].itemId]) {
    const data=proposal();mutate(data);assert.equal((await invoke(data)).kind,'invalid');
  }
});

test('provider failure remains technical and malformed output never falls back to a parser',async()=>{
  for(const complete of [async()=>{throw Error('network');},async()=>({ok:false,reason:'missing_api_key'}),async()=>({ok:false,reason:'all_providers_failed',failures:[{reason:'http_error'}]})]) assert.equal((await invoke(null,{complete})).kind,'unavailable');
  for(const complete of [async()=>({ok:false,reason:'invalid_model_json'}),async()=>({ok:false,reason:'all_providers_failed',failures:[{reason:'empty_content'}]}),async()=>({ok:true,json:'not-json'}),async()=>({ok:true,json:{kind:'proposal'}})]) assert.equal((await invoke(null,{complete})).kind,'invalid');
  assert.equal((await invoke({contractVersion:1,kind:'clarification',question:'¿Qué producto querés cambiar?'})).kind,'clarification');
  assert.equal((await invoke({contractVersion:1,kind:'clarification',question:'¿Cuál?',actions:[]})).kind,'invalid');
});

test('invalid requests and contexts make no provider calls; catalog overflow rejects without truncation',async()=>{
  let calls=0;const complete=async()=>{calls++;return {ok:true,json:proposal()};};
  for(const patch of [{sourceText:''},{sourceText:'x'.repeat(12001)},{operationId:''},{operationId:'universal-child:forged'},{channel:''},{context:{}},{context:{...context,businessId:'__default__'}},{context:{...context,permissions:[]}}, {catalog:{...catalog,clients:[...catalog.clients,...catalog.clients]}}]) assert.equal((await invoke(null,{complete,...patch})).kind,'invalid');
  assert.equal(calls,0);
  const large={...catalog,products:Array.from({length:1001},(_,index)=>({...catalog.products[0],id:`sku-${index}`}))};
  assert.ok(['unavailable','invalid'].includes((await invoke(null,{complete,catalog:large})).kind));assert.equal(calls,0);
  const tooMuch={...catalog,products:[{...catalog.products[0],name:'x'.repeat(199999)}]};
  assert.equal((await invoke(null,{complete,catalog:tooMuch})).kind,'unavailable');assert.equal(calls,0);
});

test('closed safe records reject getters, pollution, prototypes, undefined and authorization overrides',async()=>{
  for(const mutate of [p=>p.businessId='forged',p=>p.permissions=['all'],p=>p.actions[0].operationId='forged',p=>p.actions[0].quantity.unit='invalid unit!',p=>p.contractVersion=2,p=>p.actions[0].quantity.value=undefined,p=>Object.setPrototypeOf(p.actions[0],{bad:true}),p=>Object.defineProperty(p.actions[0].target,'skuId',{enumerable:true,get(){throw Error('getter ran');}}),p=>Object.defineProperty(p.actions[0],'__proto__',{enumerable:true,value:{polluted:true}})]) {
    const data=proposal();mutate(data);assert.equal((await invoke(data)).kind,'invalid');
  }
  let calls=0;const badContext={...context};Object.defineProperty(badContext,'actorId',{enumerable:true,get(){throw Error('getter ran');}});
  assert.equal((await invoke(null,{context:badContext,complete:async()=>{calls++;}})).kind,'invalid');assert.equal(calls,0);
  assert.equal({}.polluted,undefined);
});

test('universal authorization and reviewed inventory selection guards remain authoritative',async()=>{
  assert.equal((await invoke(proposal(),{context:{...context,permissions:['inventory:receive']}})).reason,'FORBIDDEN');
  const update={itemId:'a',type:'sku.update',target:{kind:'existing',skuId:'sku'},changes:{price:10},reason:'Revisión'};
  const extended={...catalog,products:[...catalog.products,{...catalog.products[0],id:'second'}]};
  const result=await invoke(proposal([update,{...update,itemId:'b',target:{kind:'existing',skuId:'second'}}]),{catalog:extended});
  assert.equal(result.kind,'invalid');assert.equal(result.reason,'SELECTION_REQUIRED');
});

test('transfer destinations, deletion account revision and order reconciliation use backend snapshot',async()=>{
  const extended={...catalog,clients:[...catalog.clients,{id:'destination',name:'Destino',accountRevision:12,metadataRevision:3}]};
  const transfer={itemId:'transfer',type:'account.transfer',target:{kind:'existing',clientId:'client'},destination:{clientId:'destination'},amount:{value:2,unit:'legacy-money'},reason:'Transferencia'};
  const deletion={itemId:'delete',type:'client.delete',target:{kind:'existing',partyId:'client'},reason:'Baja'};
  const result=await invoke(proposal([transfer]),{catalog:extended});
  assert.equal(result.kind,'ready');assert.equal(result.plan.actions[0].destination.expectedRevision,12);
  const deleted=await invoke(proposal([deletion]));assert.equal(deleted.kind,'ready');assert.equal(deleted.plan.actions[0].target.expectedAccountRevision,9);
  assert.equal((await invoke(proposal([transfer,deletion]),{catalog:extended})).reason,'UNSUPPORTED_OPERATION_ORDER');
  const reconcile={itemId:'reconcile',type:'order.reconcile',target:{kind:'existing',pedidoId:'order'},reconciliation:{productId:'sku',available:4,reserved:1,quantity:3,unit:'unit',reason:'Revisión explícita',confirmed:true}};
  const reconciled=await invoke(proposal([reconcile]));assert.equal(reconciled.kind,'ready');assert.equal(reconciled.plan.actions[0].reconciliation.expectedProductRevision,7);
  reconcile.reconciliation.expectedProductRevision=7;assert.equal((await invoke(proposal([reconcile]))).kind,'invalid');
});

test('explicit new SKU and entity creation are supported without allowing aliases',async()=>{
  const receipt={itemId:'new',type:'stock.receive',target:{kind:'new',sku:{name:'Nuevo producto',unit:'unit'}},quantity:{value:3,unit:'unit'}};
  const create={itemId:'new-client',type:'client.create',name:'Nuevo cliente'};
  assert.equal((await invoke(proposal([receipt,create]))).kind,'ready');
  const invented={...actions[1],target:{kind:'existing',clientId:'new-client'}};
  assert.equal((await invoke(proposal([create,invented]))).kind,'invalid');
});

test('backend conversation capability is preserved and duplicate order mutations are rejected',async()=>{
  const result=await invoke(proposal(),{operationId:'draft-operation:trusted',context:{...context,internalConversationOperation:true}});
  assert.equal(result.kind,'ready');
  assert.equal((await invoke(proposal(),{operationId:'draft-operation:untrusted'})).kind,'invalid');
  const order=actions[3];assert.equal((await invoke(proposal([order,{...order,itemId:'second-order'}]))).reason,'UNSUPPORTED_OPERATION_ORDER');
});

test('clarification questions resolve conversational references but never become user evidence',async()=>{
  const clarifications=[{question:'¿Fueron 7 unidades?',answer:'Sí'}];
  const data=proposal([actions[0]]);data.evidence[0].quote='7';
  let observed;
  const result=await invoke(data,{sourceText:'Ingresó mercadería.\nSí',clarifications,complete:async options=>{
    observed=JSON.parse(options.messages[1].content);return {ok:true,json:data};
  }});
  assert.deepEqual(observed.clarifications,clarifications);assert.equal(result.kind,'invalid');assert.equal(result.reason,'INVALID_EVIDENCE');
  data.evidence[0].quote='Sí';
  assert.equal((await invoke(data,{sourceText:'Ingresó mercadería.\nSí',clarifications})).kind,'ready');
});
