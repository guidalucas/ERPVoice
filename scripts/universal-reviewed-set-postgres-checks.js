import assert from 'node:assert/strict';

/** Reviewed conversation sets reuse the same inventory executor and ledgers. */
export async function runUniversalReviewedSetChecks({db,sql,check}) {
  const owner='59899000981';let serial=0;
  const id=()=>`reviewed-set-${++serial}`;
  const context={businessId:owner,actorId:owner,channel:'panel',permissions:['inventory:receive','inventory:update','inventory:adjust','inventory:deactivate']};
  const text='Revisá los cambios para estos productos.';
  const seed=()=>db.createProductRecord({name:`Conjunto ${id()}`,unit:'unit',stockAvailable:3,price:25},owner,{operationId:id()});
  const action=(p,type='sku.update',extra={changes:{price:0}})=>({itemId:p.id,type,target:{kind:'existing',skuId:p.id},reason:'Cambio de conjunto revisado',...extra});
  const provider=actions=>async()=>({ok:true,json:{contractVersion:1,kind:'proposal',actions,evidence:actions.map(({itemId})=>({itemId,quote:text}))}});
  const prepare=actions=>db.prepareUniversalDraft({requestId:id(),text},context,{complete:provider(actions)});
  const confirm=preview=>db.confirmUniversalDraft(preview.draftId,{version:preview.version,digest:preview.digest},context);
  const rows=async()=>(await sql.query('SELECT * FROM products WHERE owner_phone=$1 ORDER BY id',[owner])).rows;
  const state=async()=>{
    const result={};
    for(const table of ['products','inventory_operations','inventory_movements','universal_operations','transactions','universal_drafts'])
      result[table]=(await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`,[owner])).rows;
    return result;
  };

  await check('universal reviewed set: bulk metadata freezes members and concurrent confirmation persists once',async()=>{
    const a=await seed(),b=await seed(),before=await rows(),preview=await prepare([action(a),action(b)]);
    assert.deepEqual(await rows(),before);
    assert.deepEqual(preview.review.map(({itemId})=>itemId),[a.id,b.id]);
    const late=await seed(),[one,two]=await Promise.all([confirm(preview),confirm(preview)]);
    assert.deepEqual(one,two);assert.equal(one.status,'applied');
    const products=await rows();assert.equal(Number(products.find(p=>p.id===a.id).price),0);assert.equal(Number(products.find(p=>p.id===b.id).price),0);assert.equal(Number(products.find(p=>p.id===late.id).price),25);
    const receipt=one.result.domainResult;assert.deepEqual(receipt.items.map(({skuId})=>skuId),[a.id,b.id]);
    assert.deepEqual((await sql.query('SELECT result_json FROM universal_operations WHERE owner_phone=$1 AND operation_id=$2',[owner,preview.plan.operationId])).rows[0].result_json,one.result);
    assert.equal((await sql.query('SELECT COUNT(*)::int AS n FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2',[owner,receipt.operationId])).rows[0].n,2);
    await sql.query('DELETE FROM products WHERE owner_phone=$1 AND id=ANY($2)',[owner,[a.id,b.id]]);
    assert.deepEqual(await confirm(preview),one);
  });

  await check('universal reviewed set: one stale member rejects all bulk adjustments and receipts',async()=>{
    const a=await seed(),b=await seed(),preview=await prepare([a,b].map(p=>action(p,'stock.adjust',{balances:{available:0,reserved:0}})));
    await db.executeInventoryOperation({contractVersion:1,businessId:owner,operationId:id(),actions:[{itemId:'drift',type:'stock.receive',target:{kind:'existing',skuId:b.id},quantity:{value:1,unit:'unit'}}]},context);
    const before=await state();await assert.rejects(confirm(preview),{code:'REVISION_MISMATCH'});assert.deepEqual(await state(),before);
    const fresh=await prepare([a,b].map(p=>action(p,'stock.adjust',{balances:{available:0,reserved:0}}))),applied=await confirm(fresh);
    assert.deepEqual(applied.result.domainResult.items.map(p=>[p.stockAvailable,p.stockReserved]),[[0,0],[0,0]]);
    const products=await rows();for(const p of [a,b]) assert.equal(Number(products.find(row=>row.id===p.id).stock_available),0);
  });

  await check('universal reviewed set: deactivation preserves balances and reservations reject the entire set',async()=>{
    const a=await seed(),b=await seed();await sql.query('UPDATE products SET stock_reserved=1 WHERE owner_phone=$1 AND id=$2',[owner,b.id]);
    const actions=[a,b].map(p=>action(p,'sku.deactivate',{})),preview=await prepare(actions),before=await state();
    await assert.rejects(confirm(preview),{code:'SKU_HAS_RESERVATIONS'});assert.deepEqual(await state(),before);
    await sql.query('UPDATE products SET stock_reserved=0,inventory_revision=inventory_revision+1 WHERE owner_phone=$1 AND id=$2',[owner,b.id]);
    const fresh=await prepare(actions),result=await confirm(fresh);
    assert.deepEqual(result.result.domainResult.items.map(p=>[p.status,p.stockAvailable,p.deltaAvailable]),[['inactive',3,0],['inactive',3,0]]);
    const products=await rows();for(const p of [a,b]) assert.equal(products.find(row=>row.id===p.id).inventory_status,'inactive');
  });

  await check('universal reviewed set: incomplete stored review cannot confirm a frozen plan',async()=>{
    const a=await seed(),b=await seed(),preview=await prepare([action(a),action(b)]);
    await sql.query("UPDATE universal_drafts SET preview_json=jsonb_set(preview_json,'{review}',(preview_json->'review')-1) WHERE owner_phone=$1 AND draft_id=$2",[owner,preview.draftId]);
    const before=await state();await assert.rejects(confirm(preview),{code:'INVALID_DRAFT_REQUEST'});assert.deepEqual(await state(),before);
  });

  await check('universal reviewed set: failure saving final status rolls back every inventory effect and retry is exact',async()=>{
    const a=await seed(),b=await seed(),preview=await prepare([action(a),action(b)]),before=await state();
    await sql.query(`CREATE FUNCTION reviewed_set_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_phone='${owner}' AND NEW.draft_id='${preview.draftId}' AND NEW.status='applied' THEN RAISE EXCEPTION 'reviewed set failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reviewed_set_failure BEFORE UPDATE ON universal_drafts FOR EACH ROW EXECUTE FUNCTION reviewed_set_failure()`);
    try{await assert.rejects(confirm(preview),/reviewed set failure/);}finally{await sql.query('DROP TRIGGER reviewed_set_failure ON universal_drafts; DROP FUNCTION reviewed_set_failure()');}
    assert.deepEqual(await state(),before);assert.equal((await confirm(preview)).status,'applied');
  });

  await check('universal reviewed set: ordinary WhatsApp bulk proposal requires its exact persisted review code',async()=>{
    const a=await seed(),b=await seed(),actions=[a,b].map(p=>action(p,'sku.deactivate',{})),before=await rows();
    const prepared=await db.processMetaUniversalMessage({ownerPhone:owner,senderPhone:owner,messageId:id(),sourceText:text},{ordinary:true,complete:provider(actions)});
    assert.equal(prepared.requiresConfirmation,true);assert.deepEqual(await rows(),before);
    const code=prepared.digest.slice(0,8),request={ownerPhone:owner,senderPhone:owner,messageId:id(),sourceText:`CONFIRMAR OPERACION ${code}`};
    const [one,two]=await Promise.all([db.processMetaUniversalMessage(request),db.processMetaUniversalMessage(request)]);
    assert.deepEqual(one,two);assert.equal(one.status,'applied');
    const saved=await db.getUniversalDraft(prepared.draftId,{...context,channel:'meta'});
    assert.equal(saved.result.domainResult.items.length,2);
    assert.deepEqual((await sql.query('SELECT result_json FROM universal_meta_commands WHERE owner_phone=$1 AND message_id=$2',[owner,request.messageId])).rows[0].result_json,one);
    assert.equal((await sql.query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1',[request.messageId])).rows[0].reply_text,one.replyText);
  });
}
