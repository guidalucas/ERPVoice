import assert from 'node:assert/strict';
import { processStockBatchMessage } from '../server/voiceStockWorkflow.js';
import { operationResultActions } from '../server/operationResults.js';

/** Migration recovery checks against the harness's disposable PostgreSQL. */
export async function runOrdinaryMetaRecoveryChecks({db,sql,check}) {
  const owner='59899000981',sender='59899000982',other='59899000983';
  let sequence=0;
  const id=()=>`ordinary-meta-recovery-${++sequence}`;
  const input=(sourceText,extra={})=>({ownerPhone:owner,senderPhone:sender,messageId:id(),sourceText,...extra});
  const claim=async request=>db.claimMetaMessage({...request,rawBody:{entry:[{changes:[{value:{messages:[{
    id:request.messageId,from:request.senderPhone,type:'text',text:{body:request.sourceText},
  }]}}]}]}});
  const ledger=async()=>{
    const rows={};
    for (const table of ['products','clients','pedidos','inventory_operations','inventory_movements','account_operations','account_movements','order_operations','transactions','universal_drafts','universal_meta_commands','voice_stock_batches']) {
      rows[table]=(await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`,[owner])).rows;
    }
    return rows;
  };
  const seedBatch=async ({status='ready',sourceText='Ingresaron dos Recuperación histórica.',payload={},replyText=null}={})=>{
    const messageId=id(),action={type:'add_stock',itemId:'old-item',productName:'Recuperación histórica',qty:2,
      evidence:'Recuperación histórica',fieldEvidence:{qty:'dos'},resolution:{kind:'new'}};
    return db.createVoiceStockBatch({id:id(),ownerPhone:owner,senderPhone:sender,sourceMessageId:messageId,status,
      sourceText,replyText,payload:{actions:[action],initialActions:[action],coverageVerified:true,
        evidenceSourceText:sourceText,replyMessageId:messageId,...payload}});
  };

  await check('ordinary meta recovery: resume-only fresh messages create no legacy drafts or shadow runs',async()=>{
    const before=await ledger();
    assert.equal(await processStockBatchMessage({...input('Ingresaron cinco productos nuevos.'),resumeOnly:true}),null);
    assert.deepEqual(await ledger(),before);
    assert.equal((await sql.query('SELECT 1 FROM voice_stock_shadow_runs WHERE owner_phone=$1',[owner])).rowCount,0);
  });

  await check('ordinary meta recovery: an old ready decision finishes before the later message enters universal',async()=>{
    const batch=await seedBatch();
    const request=input('¿Qué productos tengo?');
    assert.equal(await processStockBatchMessage({...request,resumeOnly:true}),null);
    const saved=await db.getVoiceStockBatchByMessage(owner,batch.sourceMessageId,sender);
    assert.equal(saved.status,'applied');
    const before=await ledger();
    const replay=await processStockBatchMessage({...input(batch.sourceText,{messageId:batch.sourceMessageId}),resumeOnly:true});
    assert.equal(replay.batchStatus,'applied');assert.equal(replay.batchId,batch.id);
    assert.equal(await processStockBatchMessage({...request,senderPhone:other,resumeOnly:true}),null);
    assert.deepEqual(await ledger(),before);
  });

  await check('ordinary meta recovery: a late quoted question stays closed and actor-scoped',async()=>{
    const batch=await seedBatch({status:'awaiting_correction',payload:{pendingDraftQuestionSetId:id()}});
    const question='Confirmá la medida del producto.';
    const pending=await db.updateVoiceStockBatch(batch.id,{expectedVersion:batch.version,status:'awaiting_correction',payload:batch.payload,replyText:question});
    const providerId=id();
    await db.finishMetaReply(batch.sourceMessageId,null,providerId);
    await db.updateVoiceStockBatch(batch.id,{expectedVersion:pending.version,status:'cancelled',payload:pending.payload,replyText:'Cancelado.'});
    const before=await ledger(),request={...input('M'),replyToMessageId:providerId,resumeOnly:true};
    const reply=await processStockBatchMessage(request);
    assert.equal(reply.batchStatus,'ignored_reply');assert.deepEqual(reply.actions,[]);
    assert.equal(await processStockBatchMessage({...request,senderPhone:other}),null);
    assert.deepEqual(await ledger(),before);
  });

  const product=await db.createProductRecord({name:'SKU recibo anterior',stockAvailable:9,price:10},owner,{operationId:id()});
  const client=await db.createClientRecord({name:'Cliente recibo anterior',operationId:id()},owner);
  const cases=[
    {name:'inventory',text:'Vendí dos unidades de SKU recibo anterior.',actions:[{type:'sell',productId:product.id,productName:product.name,qty:2}]},
    {name:'account',text:'Cargá siete a Cliente recibo anterior.',actions:[{type:'add_debt',clientName:client.name,amount:7}]},
    {name:'order',text:'Anotá un pedido de Producto pendiente para Cliente recibo anterior.',actions:[{type:'client_order',clientName:client.name,productName:'Producto pendiente',qty:1}]},
  ];
  for (const fixture of cases) await check(`ordinary meta recovery: ${fixture.name} receipt committed before meta event replays without new effects`,async()=>{
    const request=input(fixture.text);await claim(request);
    const applied=await db.applyActionsToDatabase(fixture.actions,request.sourceText,owner,
      {messageId:request.messageId,recipient:sender,actorId:sender,channel:'whatsapp'});
    assert.equal(await db.findMetaEventById(request.messageId),null);
    const before=await ledger(),replay=await db.replayCommittedMetaMessage(request);
    assert.equal(replay.handled,true);assert.equal(replay.replyText,applied.replyText);
    assert.deepEqual(replay.operationResult,applied.operationResult);
    assert.deepEqual(replay.actions,operationResultActions(applied.operationResult));
    for (const different of [{ownerPhone:other},{senderPhone:other},{sourceText:'Otra instrucción con el mismo ID'}]) {
      await assert.rejects(db.replayCommittedMetaMessage({...request,...different}),{code:'IDEMPOTENCY_CONFLICT'});
    }
    assert.deepEqual(await ledger(),before);
  });

  await check('ordinary meta recovery: terminal universal errors replay before interpretation and retain their error code',async()=>{
    const request=input('Recibí mercadería sin identificar.');await claim(request);
    const complete=async()=>({ok:false,reason:'provider_unavailable'});
    const result=await db.processMetaUniversalMessage(request,{ordinary:true,complete});
    assert.equal(result.errorCode,'INTERPRETATION_UNAVAILABLE');
    const before=await ledger();
    assert.deepEqual(await db.replayCommittedMetaMessage(request),result);
    await assert.rejects(db.replayCommittedMetaMessage({...request,sourceText:'Texto distinto'}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.deepEqual(await ledger(),before);
  });
}
