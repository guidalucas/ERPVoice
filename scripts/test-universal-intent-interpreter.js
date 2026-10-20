import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUniversalIntent } from '../server/universalIntentInterpreter.js';
import { inventoryProductFingerprint } from '../server/inventoryOperations.js';
import { normalizeFamilyPublication } from '../server/productFamilySchemas.js';

const sourceText='Ingresá 3 unidades, cargá 5 a la cuenta y cambiá el nombre del cliente. Actualizá el pedido.';
const catalog={products:[{id:'sku',name:'Producto',unit:'unit',revision:7,stockAvailable:4,stockReserved:1}],clients:[{id:'client',name:'Cliente',accountRevision:9,metadataRevision:4}],proveedores:[{id:'supplier',name:'Proveedor',metadataRevision:6}],pedidos:[{id:'order',revision:8}]};
const context={businessId:'secret-tenant',actorId:'secret-actor',permissions:['inventory:receive','inventory:update','inventory:adjust','accounts:charge','accounts:transfer','clients:update','clients:create','clients:delete','suppliers:merge','orders:update','orders:create','orders:reconcile']};
const actions=[{itemId:'receive',type:'stock.receive',target:{kind:'existing',skuId:'sku'},quantity:{value:3,unit:'unit'}},{itemId:'charge',type:'account.charge',target:{kind:'existing',clientId:'client'},amount:{value:5,unit:'legacy-money'},reason:'Cargo solicitado'},{itemId:'client',type:'client.update',target:{kind:'existing',partyId:'client'},changes:{name:'Cliente nuevo'}},{itemId:'order',type:'order.update',target:{kind:'existing',pedidoId:'order'},changes:{qty:3,clienteId:'client',proveedorId:'supplier',productId:'sku'}}];
const proposal=(entries=actions)=>({contractVersion:1,kind:'proposal',actions:structuredClone(entries),evidence:entries.map(action=>({itemId:action.itemId,quote:sourceText}))});
const invoke=(json=proposal(),patch={})=>interpretUniversalIntent({sourceText,catalog:structuredClone(catalog),context,operationId:'secret-operation',channel:'test',complete:async()=>({ok:true,json}),...patch});

test('read queries return backend snapshot facts without a mutation plan or model-written answer',async()=>{
  const text='¿Cuánto stock y saldo tenemos?';
  const snapshot={products:[{id:'sku',name:'Producto',unit:'unit',price:0,priceCurrency:'UYU',stockAvailable:0,stockReserved:2}],clients:[{id:'client',name:'Cliente',debt:0}],proveedores:[],pedidos:[]};
  const data={contractVersion:1,kind:'query',queries:[{itemId:'q1',type:'inventory.query',selector:{kind:'all'}},{itemId:'q2',type:'accounts.query',selector:{kind:'ids',ids:['client']}}],evidence:[{itemId:'q1',quote:text},{itemId:'q2',quote:text}]};
  const patch={sourceText:text,catalog:snapshot,context:{...context,permissions:['inventory:read','accounts:read']}};
  const result=await invoke(data,patch);
  assert.equal(result.kind,'answer');assert.equal(result.plan,undefined);assert.equal(result.answer.items[0].rows[0].stockAvailable,0);assert.equal(result.answer.items[1].rows[0].debt,0);assert.ok(Object.isFrozen(result.answer));
  for(const mutate of [d=>d.actions=proposal().actions,d=>d.answer='Stock inventado',d=>d.queries[0].selector={kind:'ids',ids:['other-tenant']},d=>d.evidence[0].quote='inventado']) {
    const bad=structuredClone(data);mutate(bad);assert.equal((await invoke(bad,patch)).kind,'invalid');
  }
  assert.equal((await invoke(data,{...patch,context:{...context,permissions:['inventory:receive']}})).kind,'invalid');
});

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
  const trusted=await invoke(proposal([update,{...update,itemId:'b',target:{kind:'existing',skuId:'second'}}]),{
    catalog:extended,operationId:'draft-operation:reviewed',context:{...context,internalConversationOperation:true}});
  assert.equal(trusted.kind,'ready');assert.equal(trusted.plan.actions.length,2);
  assert.equal(trusted.plan.actions[1].target.expectedRevision,7);
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

const revisionContext={...context,internalConversationOperation:true,permissions:[...context.permissions,'accounts:adjust']};
const priorTwo=async()=>{
  const entries=[{...actions[0],itemId:'first',quantity:{value:2,unit:'unit'}},{...actions[0],itemId:'second',quantity:{value:8,unit:'unit'}}];
  return invoke(proposal(entries),{context:revisionContext});
};
const patchResponse=(patches,replyText)=>({contractVersion:1,kind:'patch',patches,evidence:patches.map(({itemId})=>({itemId,quote:replyText}))});
const revise=(previous,json,replyText='La primera cantidad es 4.',extra={})=>invoke(json,{context:revisionContext,sourceText:`${previous.plan.source.text}\n${replyText}`,revision:{plan:previous.plan,evidence:previous.evidence,replyText},...extra});

test('revision changes one quantity without re-extracting or reordering the other action',async()=>{
  const previous=await priorTwo(), original=structuredClone(previous), replyText='La primera cantidad es 4.';
  let calls=0;
  const result=await revise(previous,null,replyText,{catalog:{...catalog,products:[{...catalog.products[0],revision:10}]},complete:async options=>{
    calls++;
    const supplied=JSON.parse(options.messages[1].content);
    assert.deepEqual(supplied.previousActions.map(action=>action.itemId),['first','second']);
    assert.equal(JSON.stringify(supplied.previousActions).includes('expected'),false);
    for(const secret of ['secret-tenant','secret-actor','secret-operation']) assert.equal(JSON.stringify(options).includes(secret),false);
    assert.deepEqual(supplied.previousEvidence,previous.evidence);
    assert.equal(supplied.replyText,replyText);
    return {ok:true,json:patchResponse([{itemId:'first',changes:{quantity:{value:4}}}],replyText)};
  }});
  assert.equal(calls,1);assert.equal(result.kind,'ready');
  assert.deepEqual(result.plan.actions.map(action=>action.itemId),['first','second']);
  assert.deepEqual(result.plan.actions.map(action=>action.quantity.value),[4,8]);
  assert.equal(result.plan.actions[0].quantity.unit,'unit');
  assert.deepEqual(result.plan.actions.map(action=>action.target.expectedRevision),[10,10]);
  assert.deepEqual(result.evidence,[{itemId:'first',quote:replyText},previous.evidence[1]]);
  assert.deepEqual(previous,original);
});

test('revision preserves zero amount/price and replaces attributes rather than merging records',async()=>{
  const adjustment={itemId:'adjust',type:'account.adjust',target:{kind:'existing',clientId:'client'},amount:{value:5,unit:'legacy-money'},reason:'Saldo contado'};
  const previous=await invoke(proposal([adjustment]),{context:revisionContext});
  const reply='El saldo final es cero.';
  const result=await revise(previous,patchResponse([{itemId:'adjust',changes:{amount:{value:0}}}],reply),reply);
  assert.equal(result.kind,'ready');assert.deepEqual(result.plan.actions[0].amount,{value:0,unit:'legacy-money'});
  const update={itemId:'metadata',type:'sku.update',target:{kind:'existing',skuId:'sku'},changes:{price:5,attributes:{material:{state:'known',type:'text',value:'metal'},color:{state:'known',type:'text',value:'rojo'}}},reason:'Revisión'};
  const old=await invoke(proposal([update]),{context:revisionContext});
  const text='Precio cero y solo material madera.';
  const changed=await revise(old,patchResponse([{itemId:'metadata',changes:{changes:{price:0,attributes:{material:{state:'known',type:'text',value:'madera'}}}}}],text),text);
  assert.equal(changed.kind,'ready');assert.equal(changed.plan.actions[0].changes.price,0);
  assert.deepEqual(Object.keys(changed.plan.actions[0].changes.attributes),['material']);
  assert.equal(changed.plan.actions[0].changes.attributes.material.value,'madera');
});

test('revision target replaces completely and only offers known explicit catalog IDs',async()=>{
  const previous=await priorTwo(),reply='Usá el otro producto para la primera.';
  const extra={catalog:{...catalog,products:[...catalog.products,{...catalog.products[0],id:'other',revision:15}]}};
  const changed=await revise(previous,patchResponse([{itemId:'first',changes:{target:{kind:'existing',skuId:'other'}}}],reply),reply,extra);
  assert.equal(changed.kind,'ready');assert.equal(changed.plan.actions[0].target.skuId,'other');assert.equal(changed.plan.actions[0].target.expectedRevision,15);
  const unknown=await revise(previous,patchResponse([{itemId:'first',changes:{target:{kind:'existing',skuId:'unseen'}}}],reply),reply,extra);
  assert.equal(unknown.kind,'invalid');
  const fresh=await revise(previous,patchResponse([{itemId:'first',changes:{target:{kind:'new',sku:{name:'Nuevo explícito',unit:'unit'}}}}],reply),reply);
  assert.equal(fresh.kind,'ready');assert.equal(fresh.plan.actions[0].target.kind,'new');assert.equal(fresh.plan.actions[0].target.skuId,undefined);
});

test('revision rejects authority, preconditions, changed identity, new/drop/reordered action output and original-text evidence',async()=>{
  const previous=await priorTwo(),reply='La primera cantidad es 4.';
  const invalid=[
    patchResponse([{itemId:'first',changes:{target:{kind:'existing',skuId:'sku',expectedRevision:7}}}],reply),
    patchResponse([{itemId:'first',changes:{quantity:{expectedFingerprint:'forged',value:4}}}],reply),
    patchResponse([{itemId:'first',changes:{changes:{attributes:{expectedAccountRevision:0}}}}],reply),
    patchResponse([{itemId:'first',changes:{source:{text:'forged'}}}],reply),
    patchResponse([{itemId:'first',changes:{operationId:'forged'}}],reply),
    patchResponse([{itemId:'first',changes:{type:'stock.sell'}}],reply),
    patchResponse([{itemId:'first',changes:{itemId:'changed'}}],reply),
    patchResponse([{itemId:'invented',changes:{quantity:{value:4}}}],reply),
    patchResponse([{itemId:'first',changes:{}}],reply),
    patchResponse([],reply),
    patchResponse([{itemId:'first',changes:{quantity:{}}}],reply),
    {...patchResponse([{itemId:'first',changes:{quantity:{value:4}}}],reply),actions:[]},
    proposal(previous.plan.actions.toReversed()),
    {contractVersion:1,kind:'patch',patches:[{itemId:'first',changes:{quantity:{value:4}}}],evidence:[{itemId:'first',quote:sourceText}]},
    {contractVersion:1,kind:'patch',patches:[{itemId:'first',changes:{quantity:{value:4}}}],evidence:[]},
  ];
  for(const output of invalid) assert.equal((await revise(previous,output,reply)).kind,'invalid',JSON.stringify(output));
  const reordered=await revise(previous,patchResponse([{itemId:'second',changes:{quantity:{value:6}}},{itemId:'first',changes:{quantity:{value:4}}}],reply),reply);
  assert.deepEqual(reordered.plan.actions.map(action=>action.itemId),['first','second']);
});

test('revision clarification keeps the complete validated plan and original evidence',async()=>{
  const previous=await priorTwo(),reply='No sé.';
  const result=await revise(previous,{contractVersion:1,kind:'clarification',question:'¿Cuál de las dos cantidades querés cambiar?'},reply);
  assert.equal(result.kind,'clarification');assert.deepEqual(result.plan,previous.plan);assert.deepEqual(result.evidence,previous.evidence);
  assert.ok(Object.isFrozen(result.plan));
});

test('patching another item preserves business attributes named expected* or source',async()=>{
  const attributes={expected_lifespan:{state:'known',type:'number',value:10},source:{state:'known',type:'text',value:'catálogo'},expectedrevision:{state:'known',type:'number',value:7}};
  const entries=['A','B'].map((name,index)=>({itemId:name,type:'stock.receive',target:{kind:'new',sku:{name,unit:'unit',attributes:index ? {} : attributes}},quantity:{value:2,unit:'unit'}}));
  const previous=await invoke(proposal(entries),{context:revisionContext}),reply='La cantidad de B es cuatro.';
  const result=await revise(previous,patchResponse([{itemId:'B',changes:{quantity:{value:4}}}],reply),reply);
  assert.equal(result.kind,'ready');assert.deepEqual(result.plan.actions[0],previous.plan.actions[0]);
  const changed=await revise(previous,patchResponse([{itemId:'A',changes:{target:{kind:'new',sku:{name:'A',unit:'unit',attributes:{expected_lifespan:{state:'known',type:'number',value:20}}}}}}],reply),reply);
  assert.equal(changed.kind,'ready');assert.equal(changed.plan.actions[0].target.sku.attributes.expected_lifespan.value,20);
});

test('invalid prior revision/context/evidence/history makes no provider calls',async()=>{
  const previous=await priorTwo(),reply='La primera cantidad es 4.';
  let calls=0;const complete=async()=>{calls++;return {ok:true,json:patchResponse([{itemId:'first',changes:{quantity:{value:4}}}],reply)};};
  for(const extra of [
    {context},
    {context:{...revisionContext,permissions:['accounts:charge']}},
    {revision:{plan:{...previous.plan,businessId:'foreign'},evidence:previous.evidence,replyText:reply}},
    {revision:{plan:previous.plan,evidence:[],replyText:reply}},
    {revision:{plan:previous.plan,evidence:previous.evidence,replyText:''}},
    {sourceText:reply},
    {sourceText:`${previous.plan.source.text}\nOtra respuesta`},
    {operationId:'different'},
  ]) assert.equal((await revise(previous,null,reply,{complete,...extra})).kind,'invalid');
  assert.equal(calls,0);
  const history=`${previous.plan.source.text}\nRespuesta intermedia.\n${reply}`;
  assert.equal((await revise(previous,null,reply,{complete,sourceText:history})).kind,'ready');assert.equal(calls,1);
});

const voltageAttribute=value=>({state:'known',type:'number',value,unit:'v'});
const familySchema=(version,values=[110,220])=>({familyId:'electrical',version,schema:normalizeFamilyPublication({operationId:'publish',familyId:'electrical',expectedVersion:version-1,schema:{name:'Componentes eléctricos',unit:'unit',attributes:{voltaje:{type:'number',required:true,unit:'v',values}}}}).schema});
const familyReceipt=()=>({itemId:'new-family',type:'stock.receive',target:{kind:'new',sku:{name:'Conector nuevo',unit:'unit',family:{id:'electrical',version:1},attributes:{voltaje:voltageAttribute(220)}}},quantity:{value:3,unit:'unit'}});

test('offered family schema enables new products with pinned version and projects family on existing products',async()=>{
  const familySchemas=[familySchema(1),familySchema(2,[12])];
  const familyCatalog={...catalog,familySchemas,products:[{...catalog.products[0],family:{id:'electrical',version:1},attributes:{voltaje:voltageAttribute(220)}}]};
  const original=structuredClone(familyCatalog);
  const action=familyReceipt();
  const result=await invoke(proposal([action]),{catalog:familyCatalog,complete:async options=>{
    const data=JSON.parse(options.messages[1].content);
    assert.deepEqual(data.catalog.familySchemas,familySchemas);
    assert.deepEqual(data.catalog.products[0].family,{id:'electrical',version:1});
    assert.equal(data.catalog.familySchemas[0].id,undefined);
    return {ok:true,json:proposal([action])};
  }});
  assert.equal(result.kind,'ready');
  assert.deepEqual(result.plan.actions[0].target.sku.family,{id:'electrical',version:1});
  assert.deepEqual(familyCatalog,original);
  const create={...action,type:'sku.create',initialStock:{available:0,reserved:0},reason:'Alta explícita'};delete create.quantity;
  assert.equal((await invoke(proposal([create]),{catalog:familyCatalog,context:{...context,permissions:[...context.permissions,'inventory:create']}})).kind,'ready');
});

test('new family SKU rejects unoffered versions and invalid required attributes/types/units/enums',async()=>{
  const familyCatalog={...catalog,familySchemas:[familySchema(1)]};
  for(const mutate of [
    action=>action.target.sku.family.id='invented',action=>action.target.sku.family.version=2,
    action=>action.target.sku.family.extra='forged',action=>action.target.sku.family.version=0,
    action=>action.target.sku.attributes={},
    action=>action.target.sku.attributes.voltaje={state:'unknown',type:'number',unit:'v'},
    action=>action.target.sku.attributes.voltaje={state:'known',type:'text',value:'220',unit:'v'},
    action=>action.target.sku.attributes.voltaje.unit='kv',action=>action.target.sku.attributes.voltaje.value=12,
    action=>{action.target.sku.unit='kg';action.quantity.unit='kg';},
  ]) {const action=familyReceipt();mutate(action);assert.equal((await invoke(proposal([action]),{catalog:familyCatalog})).kind,'invalid');}
  assert.equal((await invoke(proposal([familyReceipt()]))).kind,'invalid');
});

test('SKU metadata validates current family and explicit version upgrades with closed references',async()=>{
  const familyCatalog={...catalog,familySchemas:[familySchema(1),familySchema(2,[12])],products:[{...catalog.products[0],family:{id:'electrical',version:1},attributes:{voltaje:voltageAttribute(220)}}]};
  const action={itemId:'metadata',type:'sku.update',target:{kind:'existing',skuId:'sku'},changes:{price:0},reason:'Cambio explícito'};
  const unchanged=await invoke(proposal([action]),{catalog:familyCatalog});assert.equal(unchanged.kind,'ready');
  assert.equal(Object.hasOwn(unchanged.plan.actions[0].changes,'family'),false);
  const invalidAttributes={...action,changes:{attributes:{voltaje:voltageAttribute(12)}}};
  assert.equal((await invoke(proposal([invalidAttributes]),{catalog:familyCatalog})).kind,'invalid');
  const upgrade={...action,changes:{family:{id:'electrical',version:2},attributes:{voltaje:voltageAttribute(12)}}};
  const changed=await invoke(proposal([upgrade]),{catalog:familyCatalog});assert.equal(changed.kind,'ready');
  assert.deepEqual(changed.plan.actions[0].changes.family,{id:'electrical',version:2});
  for(const family of [{id:'electrical',version:3},{id:'electrical',version:2,expectedRevision:1},null]) assert.equal((await invoke(proposal([{...upgrade,changes:{...upgrade.changes,family}}]),{catalog:familyCatalog})).kind,'invalid');
  assert.equal((await invoke(proposal([{...action,changes:{family:{id:'electrical',version:2}}}]),{catalog:familyCatalog})).kind,'invalid');
  const sequentialCatalog={...familyCatalog,familySchemas:[familySchema(1),familySchema(2,[220])]};
  const first={...action,itemId:'first',changes:{attributes:{voltaje:voltageAttribute(110)}}};
  const second={...action,itemId:'second',changes:{family:{id:'electrical',version:2}}};
  assert.equal((await invoke(proposal([first,second]),{catalog:sequentialCatalog})).kind,'invalid');
});

test('family catalog references are unique, descriptor-safe and count toward the existing total limit',async()=>{
  let calls=0;const complete=async()=>{calls++;return {ok:true,json:proposal()};};
  const entry=familySchema(1);
  assert.equal((await invoke(null,{complete,catalog:{...catalog,familySchemas:[entry,entry]}})).kind,'invalid');
  const getter=structuredClone(entry);Object.defineProperty(getter,'version',{enumerable:true,get(){throw Error('getter ran');}});
  assert.equal((await invoke(null,{complete,catalog:{...catalog,familySchemas:[getter]}})).kind,'invalid');
  const many=Array.from({length:997},(_,index)=>({...entry,familyId:`family-${index}`}));
  assert.equal((await invoke(null,{complete,catalog:{...catalog,familySchemas:many}})).kind,'unavailable');
  assert.equal(calls,0);
  const legacy=familyReceipt();delete legacy.target.sku.family;delete legacy.target.sku.attributes;
  assert.equal((await invoke(proposal([legacy]))).kind,'ready');
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
