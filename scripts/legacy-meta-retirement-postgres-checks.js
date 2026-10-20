import assert from 'node:assert/strict';

/** These checks exercise the production Meta boundary against disposable PG. */
export async function runLegacyMetaRetirementChecks({db,sql,check}) {
  const owner='59899000871',sender='59899000872',other='59899000873';
  let sequence=0;
  const id=()=>`legacy-meta-retirement-${++sequence}`;
  const input=(sourceText,extra={})=>({ownerPhone:owner,senderPhone:sender,messageId:id(),sourceText,...extra});
  const forbidden=async()=>assert.fail('historical replay and retired controls must not call the provider');
  const process=async(request,complete=forbidden)=>await db.replayCommittedMetaMessage(request)
    ?? await db.processMetaUniversalMessage(request,{complete})
    ?? await db.processRetiredMetaMessage(request)
    ?? db.processMetaUniversalMessage(request,{ordinary:true,complete});
  const state=async()=>{
    const result={};
    for (const table of ['products','clients','proveedores','pedidos','inventory_operations','inventory_movements','account_operations','account_movements','party_operations','order_operations','transactions','voice_stock_batches','inventory_selections','meta_selection_commands','universal_drafts','universal_draft_commands']) {
      result[table]=(await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`,[owner])).rows;
    }
    return result;
  };
  const batch=async(status='ready',extra={})=>{
    const request=input('Ingresaron dos SKU históricos.'),batchId=id();
    const saved=await db.createVoiceStockBatch({id:batchId,ownerPhone:owner,senderPhone:sender,
      sourceMessageId:request.messageId,status,sourceText:request.sourceText,
      payload:{actions:[{type:'add_stock',itemId:'old-item',productName:'SKU históricos',qty:2,resolution:{kind:'new'}}],
        coverageVerified:true,evidenceSourceText:request.sourceText,replyMessageId:request.messageId},...extra});
    return {request,saved};
  };
  const terminal=async request=>{
    const before=await state(),reply=await process(request);
    assert.equal(reply.handled,true);assert.equal(reply.errorCode,'LEGACY_WRITER_RETIRED');
    assert.equal(reply.requiresConfirmation,false);assert.deepEqual(reply.actions,[]);
    assert.match(reply.replyText,/REVISAR OPERACION/);
    assert.deepEqual(await state(),before);
    assert.deepEqual((await sql.query('SELECT result_json FROM universal_meta_commands WHERE owner_phone=$1 AND message_id=$2',[owner,request.messageId])).rows[0]?.result_json,reply);
    assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1',[reply.replyEventId ?? request.messageId])).rows[0]?.reply_text,reply.replyText);
    assert.deepEqual(await process(request),reply);
    return reply;
  };

  await check('legacy Meta retirement: applied receipt replays frozen facts with removed catalog and no writes',async()=>{
    const action={type:'add_stock',productName:'Nombre histórico congelado',qty:2};
    const {request,saved}=await batch('applied',{replyText:'Recibo histórico congelado: +2 Nombre histórico congelado.',
      payload:{appliedActions:[action],handledMessages:[]}});
    const before=await state(),reply=await process(request);
    assert.equal(reply.batchId,saved.id);assert.equal(reply.batchStatus,'applied');
    assert.equal(reply.replyText,saved.replyText);assert.deepEqual(reply.actions,[action]);
    assert.deepEqual(await state(),before);
    assert.equal(await db.replayCommittedMetaMessage({...request,senderPhone:other}),null);
    await assert.rejects(db.replayCommittedMetaMessage({...request,sourceText:'Otra cantidad'}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.deepEqual(await state(),before);
  });

  await check('legacy Meta retirement: ready decision is preserved and requires a new universal review',async()=>{
    const {request,saved}=await batch();
    const question='¿Cuál SKU histórico corresponde?';
    await sql.query(`INSERT INTO meta_reply_outbox(event_id,recipient,reply_text,stock_batch_id,question_id)
      VALUES($1,$2,$3,$4,$5)`,[request.messageId,sender,question,saved.id,id()]);
    const oldReply=(await sql.query('SELECT * FROM meta_reply_outbox WHERE event_id=$1',[request.messageId])).rows[0];
    await terminal(request);
    const kept=(await sql.query('SELECT * FROM meta_reply_outbox WHERE event_id=$1',[request.messageId])).rows[0];
    assert.deepEqual(kept,{...oldReply,status:'retired'});
    assert.equal(kept.sent_at,null);assert.deepEqual(kept.provider_message_ids,[]);
    assert.equal((await sql.query("SELECT 1 FROM meta_reply_outbox WHERE event_id=$1 AND (status='pending' OR status='sending')",[request.messageId])).rowCount,0);
    assert.equal((await db.getVoiceStockBatchByMessage(owner,request.messageId,sender)).status,'ready');
    assert.equal((await sql.query('SELECT version FROM voice_stock_batches WHERE id=$1',[saved.id])).rows[0].version,saved.version);
  });

  await check('legacy Meta retirement: old control namespace including malformed codes is terminal without effects',async()=>{
    for (const source of ['CONFIRMAR BAJA deadbeef','CANCELAR CAMBIO deadbeef','CONFIRMAR AJUSTE deadbeef',
      'CONFIRMAR BAJA','CANCELAR CAMBIO no-es-un-codigo extra','CONFIRMAR AJUSTE:deadbeef','CANCELAR BAJA deadbeef extra']) await terminal(input(source));
  });

  await check('legacy Meta retirement: late quoted question is read only and tenant/actor scoped',async()=>{
    const {request,saved}=await batch('cancelled'),providerId=id();
    await sql.query(`INSERT INTO meta_reply_outbox(event_id,recipient,reply_text,stock_batch_id,question_id,provider_message_ids)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[request.messageId,sender,'¿Cuál SKU?',saved.id,id(),JSON.stringify([providerId])]);
    await terminal(input('1',{replyToMessageId:providerId}));
    assert.equal(await db.processRetiredMetaMessage(input('1',{senderPhone:other,replyToMessageId:providerId})),null);
    assert.equal(await db.processRetiredMetaMessage(input('1',{ownerPhone:other,replyToMessageId:providerId})),null);
  });

  await check('legacy Meta retirement: old selection source and quoted preview require new review without changing historical selection',async()=>{
    const product=await db.createProductRecord({name:'SKU de selección retirada',stockAvailable:2,price:10},owner,{operationId:id()});
    const request=input('Cambiá el precio del SKU de selección retirada a 77.');
    const preview=await db.prepareMetaInventorySelection({...request,actions:[{type:'update_product',productId:product.id,price:77}]});
    const providerId=id();
    await db.finishMetaReply(request.messageId,null,providerId);
    const frozen=(await sql.query('SELECT * FROM meta_reply_outbox WHERE event_id=$1',[request.messageId])).rows[0];
    await terminal(request);
    assert.deepEqual((await sql.query('SELECT * FROM meta_reply_outbox WHERE event_id=$1',[request.messageId])).rows[0],frozen);
    await terminal(input('1',{replyToMessageId:providerId}));
    assert.equal(await db.processRetiredMetaMessage(input('1',{senderPhone:other,replyToMessageId:providerId})),null);
    assert.equal((await sql.query('SELECT status FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2',[owner,preview.selectionId])).rows[0].status,'pending');
  });

  await check('legacy Meta retirement: applied selection command receipt replays after catalog removal',async()=>{
    const product=await db.createProductRecord({name:'SKU recibo selección anterior',stockAvailable:2,price:10},owner,{operationId:id()});
    const request=input('Cambiá el precio del SKU recibo selección anterior a 55.');
    const prepared=await db.prepareMetaInventorySelection({...request,actions:[{type:'update_product',productId:product.id,price:55}]});
    const preview=(await sql.query('SELECT preview_json FROM inventory_selections WHERE owner_phone=$1 AND selection_id=$2',[owner,prepared.selectionId])).rows[0].preview_json;
    const confirm=input(`CONFIRMAR CAMBIO ${preview.digest.slice(0,8)}`);
    const receipt=await db.processMetaInventorySelectionCommand(confirm);
    await sql.query('DELETE FROM products WHERE owner_phone=$1 AND id=$2',[owner,product.id]);
    const before=await state();
    assert.deepEqual(await process(confirm),receipt);assert.deepEqual(await state(),before);
  });

  await check('legacy Meta retirement: new instruction bypasses an active old batch and prepares universal review',async()=>{
    // This owner already has a preserved ready row. An ordinary new source must
    // not resume it or select its products by name before universal review.
    const request=input('Ingresó una unidad de un producto nuevo.'),before=await state();
    let calls=0;
    const reply=await process(request,async()=>{calls++;return {ok:true,json:{contractVersion:1,kind:'clarification',question:'¿Cuál es el producto que ingresó?'}};});
    assert.equal(calls,1);assert.equal(reply.status,'awaiting_clarification');assert.deepEqual(reply.actions,[]);
    const after=await state();
    for (const table of Object.keys(before)) if (!['universal_drafts','universal_draft_commands'].includes(table)) assert.deepEqual(after[table],before[table]);
  });
}
