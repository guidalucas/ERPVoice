import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUniversalIntent } from '../server/universalIntentInterpreter.js';
import { inventoryProductFingerprint } from '../server/inventoryOperations.js';
import { normalizeFamilyPublication } from '../server/productFamilySchemas.js';
import { buildUniversalOperationReview } from '../server/universalOperationReview.js';

const sourceText='Ingresá 3 unidades, cargá 5 a la cuenta y cambiá el nombre del cliente. Actualizá el pedido.';
const catalog={products:[{id:'sku',name:'Producto',unit:'unit',revision:7,stockAvailable:4,stockReserved:1}],clients:[{id:'client',name:'Cliente',accountRevision:9,metadataRevision:4}],proveedores:[{id:'supplier',name:'Proveedor',metadataRevision:6}],pedidos:[{id:'order',revision:8}]};
const context={businessId:'secret-tenant',actorId:'secret-actor',permissions:['inventory:receive','inventory:update','inventory:adjust','accounts:charge','accounts:transfer','clients:update','clients:create','clients:delete','suppliers:merge','orders:update','orders:create','orders:reconcile']};
const actions=[{itemId:'receive',type:'stock.receive',target:{kind:'existing',skuId:'sku'},quantity:{value:3,unit:'unit'}},{itemId:'charge',type:'account.charge',target:{kind:'existing',clientId:'client'},amount:{value:5,unit:'legacy-money'},reason:'Cargo solicitado'},{itemId:'client',type:'client.update',target:{kind:'existing',partyId:'client'},changes:{name:'Cliente nuevo'}},{itemId:'order',type:'order.update',target:{kind:'existing',pedidoId:'order'},changes:{qty:3,clienteId:'client',proveedorId:'supplier',productId:'sku'}}];
const proposal=(entries=actions)=>({contractVersion:1,kind:'proposal',actions:structuredClone(entries),evidence:entries.map(action=>({itemId:action.itemId,quote:sourceText}))});
const invoke=(json=proposal(),patch={})=>interpretUniversalIntent({sourceText,catalog:structuredClone(catalog),context,operationId:'secret-operation',channel:'test',complete:async()=>({ok:true,json}),...patch});

test('new customer and pending order survive a short size clarification in one reviewable proposal',async()=>{
  const original='Me pidieron la camiseta blanca de boca, tercera equipación. Me lo pidió Emiliano.';
  const clarifications=[{question:'¿A qué cliente corresponde Emiliano y qué talle tiene la camiseta blanca de boca?',answer:'nuevo cliente. la camseta talle L o XL'},
    {question:'¿Qué talle es la camiseta, L o XL?',answer:'L'}];
  const text=[original,...clarifications.map(item=>item.answer)].join('\n');
  const entries=[{itemId:'customer',type:'client.create',name:'Emiliano'},
    {itemId:'order',type:'order.create',clientRef:{itemId:'customer'},order:{producto:'Camiseta blanca de Boca, tercera equipación',talle:'L',qty:1,estado:'pendiente'}}];
  const data={contractVersion:1,kind:'proposal',actions:entries,evidence:[{itemId:'customer',quote:'nuevo cliente'},{itemId:'order',quote:original}]};
  const result=await invoke(data,{sourceText:text,clarifications,complete:async options=>{
    assert.match(options.messages[0].content,/Pedido para cliente nuevo/);
    assert.match(options.messages[0].content,/OMITÍ order.clienteId/);
    assert.deepEqual(JSON.parse(options.messages[1].content).latestClarification,clarifications[1]);
    return {ok:true,json:data};
  }});
  assert.equal(result.kind,'ready');assert.equal(result.plan.actions[1].order.talle,'L');
  assert.equal(result.plan.actions[1].order.productId,null);
  assert.deepEqual(result.plan.actions[1].clientRef,{itemId:'customer'});
  const review=buildUniversalOperationReview(result.plan,catalog);
  assert.match(review[0].title,/Alta de cliente.*Emiliano/);
  assert.ok(review[1].details.includes('Cliente nuevo: Emiliano (alta incluida en esta propuesta).'));
  assert.ok(review[1].details.includes('Variante: L'));
  const bad=structuredClone(data);bad.actions[1].clientRef.itemId='not-in-this-plan';
  assert.equal((await invoke(bad,{sourceText:text,clarifications})).reason,'INVALID_ORDER_CLIENT_REFERENCE');
});

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

test('order requests on WhatsApp and panel answer with business currency configured',async()=>{
  const snapshot={products:[],clients:[{id:'client',name:'Emiliano',debt:0}],proveedores:[],
    pedidos:[{id:'order',producto:'Camiseta de Boca',talle:'L',qty:1,estado:'pendiente',clienteId:'client',proveedorId:null,stockPosting:null}],
    moneyPolicy:{currency:'ARS',storageUnit:'major_integer',fractionDigits:2,revision:1}};
  const before=structuredClone(snapshot);
  for(const channel of ['whatsapp','panel']) for(const text of ['Cuales son los pedidos que tengo','Decime mis pedidos']) {
    let calls=0;
    const data={contractVersion:1,kind:'query',queries:[{itemId:'q',type:'orders.query',selector:{kind:'all'}}],evidence:[{itemId:'q',quote:text}]};
    const result=await invoke(data,{sourceText:text,catalog:snapshot,channel,context:{...context,permissions:['orders:read']},complete:async options=>{
      calls++;assert.deepEqual(JSON.parse(options.messages[1].content).catalog.moneyPolicy,snapshot.moneyPolicy);
      return {ok:true,json:data};
    }});
    assert.equal(result.kind,'answer',result.reason);assert.equal(calls,1);
    assert.equal(result.plan,undefined);assert.equal(result.trace.ok,true);
    assert.match(result.answer.text,/Camiseta de Boca \(L\): 1; pendiente; cliente Emiliano/);
    assert.equal(result.answer.items[0].rows[0].id,'order');
    assert.deepEqual(snapshot,before);
    const denied=await invoke(data,{sourceText:text,catalog:snapshot,channel,context:{...context,permissions:['orders:create']}});
    assert.equal(denied.kind,'invalid');assert.equal(denied.reason,'FORBIDDEN');
  }
});

test('mixed ready proposal uses backend envelope and frozen catalog revisions without leaking authorization',async()=>{
  let calls=0;
  const original=proposal();
  const result=await invoke(original,{complete:async options=>{
    calls++;const serialized=JSON.stringify(options);
    assert.equal(options.reasoningEffort,'medium');
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

test('size clarification without a plan accepts the complete batch and keeps prices and variants',async()=>{
  const original='Ingresá una unidad de cada SKU nuevo: camiseta City suplente 2025, camiseta River titular 2025 y camiseta Barcelona titular 2025 manga larga. Todas versión jugador. Las primeras cuestan 65000 ARS y la manga larga 70000 ARS.';
  const reply='talle L',text=`${original}\n${reply}`;
  const clarifications=[{question:'¿Qué talle corresponde a cada uno de los siguientes productos: camiseta City suplente 2025, camiseta River titular 2025 y camiseta Barcelona titular 2025 manga larga?',answer:reply}];
  const items=['City suplente 2025','River titular 2025','Barcelona titular 2025 manga larga'].map((name,index)=>({
    itemId:`shirt-${index}`,type:'stock.receive',target:{kind:'new',sku:{name:`Camiseta ${name}`,unit:'unit',size:'L',attributes:{version:{state:'known',type:'text',value:'jugador'}}}},
    quantity:{value:1,unit:'unit'},price:{amount:index===2?70000:65000,currency:'ARS',policy:'initialize'},
  }));
  const data={contractVersion:1,kind:'proposal',actions:items,evidence:items.map(item=>({itemId:item.itemId,quote:original}))};
  const result=await invoke(data,{sourceText:text,clarifications,complete:async options=>{
    assert.match(options.messages[0].content,/MODO ACLARACIÓN SIN PLAN PREVIO/);
    assert.match(options.messages[0].content,/una respuesta breve con un solo valor se aplica a TODO el grupo consultado/);
    assert.match(options.messages[0].content,/No le exijas repetir los nombres ni agregar "para todos"/);
    assert.doesNotMatch(options.messages[0].content,/MODO REVISIÓN/);
    const supplied=JSON.parse(options.messages[1].content);
    assert.equal(supplied.sourceText,text);assert.deepEqual(supplied.clarifications,clarifications);
    assert.deepEqual(supplied.latestClarification,clarifications[0]);
    assert.equal(supplied.previousActions,undefined);
    return {ok:true,json:data};
  }});
  assert.equal(result.kind,'ready');
  assert.deepEqual(result.plan.actions.map(item=>item.itemId),items.map(item=>item.itemId));
  assert.deepEqual(result.plan.actions.map(item=>item.target.sku.size),['L','L','L']);
  assert.deepEqual(result.plan.actions.map(item=>item.price.amount),[65000,65000,70000]);
  assert.ok(result.plan.actions.every(item=>item.target.sku.attributes.version.value==='jugador'));
  const rewritten=structuredClone(data);rewritten.evidence[0].quote='camiseta City suplente 2025 talle L';
  assert.equal((await invoke(rewritten,{sourceText:text,clarifications})).reason,'INVALID_EVIDENCE');
  assert.equal((await invoke({contractVersion:1,kind:'patch',patches:[{itemId:'shirt-0',changes:{size:'L'}}],evidence:[{itemId:'shirt-0',quote:reply}]},{sourceText:text,clarifications})).kind,'invalid');
});

test('latest clarification focuses the current answer while retaining previous values and literal evidence',async()=>{
  const original='Ingresá tres unidades de Producto.',clarifications=[
    {question:'¿Qué tamaño tienen los productos?',answer:'L'},
    {question:'¿A qué productos corresponde L?',answer:'A TODOS LOS PRODUCTOS'},
  ];
  const text=[original,...clarifications.map(item=>item.answer)].join('\n');
  const data={contractVersion:1,kind:'proposal',actions:[structuredClone(actions[0])],evidence:[{itemId:actions[0].itemId,quote:original}]};
  const result=await invoke(data,{sourceText:text,clarifications,complete:async options=>{
    const supplied=JSON.parse(options.messages[1].content);
    assert.deepEqual(supplied.latestClarification,clarifications.at(-1));
    assert.deepEqual(supplied.clarifications,clarifications);assert.equal(supplied.sourceText,text);
    assert.match(options.messages[0].content,/"a todos" puede precisar el alcance de un valor dado en la respuesta anterior/);
    return {ok:true,json:data};
  }});
  assert.equal(result.kind,'ready');assert.equal(result.evidence[0].quote,original);
  // Neither the backend focus nor an assistant question becomes user evidence.
  data.evidence[0].quote=clarifications[0].question;
  assert.equal((await invoke(data,{sourceText:text,clarifications})).reason,'INVALID_EVIDENCE');
});

test('a restricted group reply is kept intact and can ask only for the remaining products',async()=>{
  const original='Ingresá las camisetas River y Barcelona.',answer='L solo la de River';
  const clarifications=[{question:'¿Qué talle corresponde a cada camiseta?',answer}];
  const result=await invoke(null,{sourceText:`${original}\n${answer}`,clarifications,complete:async options=>{
    const supplied=JSON.parse(options.messages[1].content);
    assert.equal(supplied.latestClarification.answer,answer);
    assert.match(options.messages[0].content,/Una respuesta con alcance explícito .* prevalece sobre el alcance grupal/);
    return {ok:true,json:{contractVersion:1,kind:'clarification',question:'¿Qué talle tiene la de Barcelona?'}};
  }});
  assert.equal(result.kind,'clarification');assert.equal(result.question,'¿Qué talle tiene la de Barcelona?');assert.equal(result.plan,undefined);
});

test('clarification with a prior plan retains patch mode and cannot replace the batch',async()=>{
  const previous=await priorTwo();
  const reply='La primera cantidad es 4.';
  const clarifications=[{question:'¿Cuántas unidades en la primera?',answer:reply}];
  const data={contractVersion:1,kind:'patch',patches:[{itemId:previous.plan.actions[0].itemId,changes:{quantity:{value:4}}}],evidence:[{itemId:previous.plan.actions[0].itemId,quote:reply}]};
  const result=await revise(previous,data,reply,{clarifications,complete:async options=>{
    assert.match(options.messages[0].content,/MODO REVISIÓN/);
    assert.doesNotMatch(options.messages[0].content,/MODO ACLARACIÓN SIN PLAN PREVIO/);
    return {ok:true,json:data};
  }});
  assert.equal(result.kind,'ready');assert.equal(result.plan.actions[0].quantity.value,4);
  assert.deepEqual(result.plan.actions.slice(1),previous.plan.actions.slice(1));
});

test('competing variants are surfaced together without selecting by order, size proximity or stock',async()=>{
  const products=[
    {id:'shirt-m',name:'Remera negra',productType:'Remera',productModel:'Negra',size:'M',unit:'unit',stockAvailable:20},
    {id:'short-l',name:'Short azul',productType:'Short',productModel:'Azul',size:'L',unit:'unit',stockAvailable:0},
    {id:'short-m',name:'Short azul',productType:'Short',productModel:'Azul',size:'M',unit:'unit',stockAvailable:10},
    {id:'bolt-6',name:'Tornillo zincado',size:'6 mm',unit:'kg'},
    {id:'bolt-8',name:'Tornillo zincado',size:'8 mm',unit:'kg'},
    {id:'bolt-box',name:'Tornillo zincado',size:'8 mm',unit:'caja'},
  ];
  const result=await invoke(null,{sourceText:'Sumá una remera negra M y un short azul.',catalog:{...catalog,products},complete:async options=>{
    const supplied=JSON.parse(options.messages[1].content);
    assert.deepEqual(supplied.catalog.products,products);
    assert.deepEqual(supplied.variantGroups,[
      {name:'Short azul',variants:[{id:'short-l',size:'L'},{id:'short-m',size:'M'}]},
      {name:'Tornillo zincado',variants:[{id:'bolt-6',size:'6 mm'},{id:'bolt-8',size:'8 mm'}]},
    ]);
    assert.match(options.messages[0].content,/stock.receive; por sí solos NO significan vender/);
    assert.match(options.messages[0].content,/COMPROBACIÓN DE REFERENCIAS/);
    return {ok:true,json:{contractVersion:1,kind:'clarification',question:'¿Qué talle tiene el short azul?'}};
  }});
  assert.equal(result.kind,'clarification');assert.equal(result.plan,undefined);
});

test('commercial units and optional new-product fields stay generic across sectors',async()=>{
  for(const [name,unit] of [['Medias negras','par'],['Tarugos de nylon','caja'],['Fideos tirabuzón','paquete'],['Cable unipolar','metro']]){
    const text=`Ingresá 4 ${unit} nuevos de ${name}.`;
    const action={itemId:'new',type:'stock.receive',target:{kind:'new',sku:{name,unit}},quantity:{value:4,unit}};
    const data={contractVersion:1,kind:'proposal',actions:[action],evidence:[{itemId:'new',quote:text}]};
    const result=await invoke(data,{sourceText:text});
    assert.equal(result.kind,'ready');assert.equal(result.plan.actions[0].target.sku.unit,unit);
    assert.equal(result.plan.actions[0].quantity.unit,unit);assert.equal(result.plan.actions[0].price,undefined);
    assert.equal(result.plan.actions[0].target.sku.size,undefined);
    for(const extra of [{reason:'No admitido'},{initialStock:{available:4,reserved:0}}]){
      const bad=structuredClone(data);Object.assign(bad.actions[0],extra);
      assert.equal((await invoke(bad,{sourceText:text})).kind,'invalid');
    }
  }
});

test('a mixed sale does not need a sale customer or invent missing account references',async()=>{
  const text='Vendí 99 productos y al Cliente sumale 5000 a su cuenta.';
  const entries=[{itemId:'sale',type:'stock.sell',target:{kind:'existing',skuId:'sku'},quantity:{value:99,unit:'unit'}},
    {itemId:'charge',type:'account.charge',target:{kind:'existing',clientId:'client'},amount:{value:5000,unit:'legacy-money'},reason:'Fiado solicitado'}];
  const data={contractVersion:1,kind:'proposal',actions:entries,evidence:entries.map(a=>({itemId:a.itemId,quote:text}))};
  const result=await invoke(data,{sourceText:text,context:{...context,permissions:[...context.permissions,'inventory:sell']}});
  assert.equal(result.kind,'ready');assert.equal(result.plan.actions[0].quantity.value,99);
  assert.equal(result.plan.actions[1].target.clientId,'client');
  const bad=structuredClone(data);bad.actions[1].target.clientId='missing';
  assert.equal((await invoke(bad,{sourceText:text})).kind,'invalid');
});

test('one format repair restores literal evidence without changing the requested actions',async()=>{
  const good=proposal(),bad=proposal();bad.evidence.pop();let calls=0;
  const result=await invoke(null,{complete:async options=>{
    calls++;
    if(calls===1) return {ok:true,json:bad};
    assert.match(options.messages[0].content,/REPARACIÓN DE FORMATO \(único intento\)/);
    assert.equal(options.messages.at(-2).role,'assistant');
    assert.deepEqual(JSON.parse(options.messages.at(-2).content),bad);
    return {ok:true,json:good};
  }});
  assert.equal(calls,2);assert.equal(result.kind,'ready');assert.deepEqual(result.evidence,good.evidence);
  assert.equal(result.trace.formatRepairAttempts,1);assert.equal(result.trace.formatRepairSucceeded,true);
});

test('format repair is bounded and rejects semantic changes, unauthorized data and nonliteral quotes',async()=>{
  const bad=proposal();bad.evidence.pop();
  for(const mutate of [p=>p.actions[0].quantity.value=4,p=>p.actions[0].target.skuId='other',p=>p.actions.reverse(),p=>p.actions[1].amount.value=99,p=>p.actions[1].reason='Otro motivo',p=>p.actions.pop(),p=>p.evidence[0].quote='paráfrasis']){
    let calls=0;const fixed=proposal();mutate(fixed);
    const result=await invoke(null,{complete:async()=>({ok:true,json:++calls===1?bad:fixed})});
    assert.equal(calls,2);assert.equal(result.kind,'invalid');assert.equal(result.trace.formatRepairSucceeded,false);
  }
  let calls=0;
  const twiceBad=await invoke(null,{complete:async()=>{calls++;return {ok:true,json:bad};}});
  assert.equal(calls,2);assert.equal(twiceBad.kind,'invalid');
  for(const json of [proposal(),{contractVersion:1,kind:'query',queries:[],evidence:[]}]){
    calls=0;const rejected=await invoke(null,{context:{...context,permissions:['inventory:read']},complete:async()=>{calls++;return {ok:true,json};}});
    assert.equal(rejected.kind,'invalid');assert.equal(calls,1);
  }
});

test('format repair can supply a required creation reason but never invent stock or attributes',async()=>{
  const text='Dame de alta dos cajas nuevas de tarugos.';
  const action={itemId:'new',type:'sku.create',target:{kind:'new',sku:{name:'Tarugos',unit:'caja'}},initialStock:{available:2,reserved:0}};
  const bad={contractVersion:1,kind:'proposal',actions:[action],evidence:[{itemId:'new',quote:text}]};
  for(const changed of [false,true]){
    const fixed=structuredClone(bad);fixed.actions[0].reason='Alta solicitada';
    if(changed) fixed.actions[0].initialStock.available=20;
    let calls=0;const result=await invoke(null,{sourceText:text,context:{...context,permissions:['inventory:create']},complete:async()=>({ok:true,json:++calls===1?bad:fixed})});
    assert.equal(calls,2);assert.equal(result.kind,changed?'invalid':'ready');
  }
});

test('format repair cannot widen a query or change a revision patch',async()=>{
  const text='¿Cuánto stock hay de Producto?';
  const good={contractVersion:1,kind:'query',queries:[{itemId:'q',type:'inventory.query',selector:{kind:'ids',ids:['sku']}}],evidence:[{itemId:'q',quote:text}]};
  const bad=structuredClone(good);bad.evidence[0].quote='cita inventada';
  for(const widened of [false,true]){
    const fixed=structuredClone(good);if(widened) fixed.queries[0].selector={kind:'all'};
    let calls=0;
    const result=await invoke(null,{sourceText:text,catalog:{...catalog,products:[{...catalog.products[0],price:0,priceCurrency:'ARS'}]},context:{...context,permissions:['inventory:read']},complete:async()=>({ok:true,json:++calls===1?bad:fixed})});
    assert.equal(calls,2);assert.equal(result.kind,widened?'invalid':'answer');
  }
  const previous=await priorTwo(),reply='La primera cantidad es 4.';
  const fixed=patchResponse([{itemId:'first',changes:{quantity:{value:4}}}],reply);
  const wrong=structuredClone(fixed);wrong.evidence[0].quote='texto ajeno';
  for(const changed of [false,true]){
    const repaired=structuredClone(fixed);if(changed) repaired.patches[0].changes.quantity.value=99;
    let calls=0;const result=await revise(previous,null,reply,{complete:async()=>({ok:true,json:++calls===1?wrong:repaired})});
    assert.equal(calls,2);assert.equal(result.kind,changed?'invalid':'ready');
  }
});
