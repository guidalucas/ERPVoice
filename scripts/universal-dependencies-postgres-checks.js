import assert from 'node:assert/strict';

export async function runUniversalDependencyChecks({db,sql,check}) {
  const owner='59899000981',permissions=['clients:create','suppliers:create','orders:create','orders:update','accounts:charge','inventory:create','inventory:receive','inventory:reserve'];
  const context={businessId:owner,actorId:owner,permissions,channel:'whatsapp'};
  let serial=0;
  const id=()=>`dependency-check-${++serial}`;
  const input=sourceText=>({ownerPhone:owner,senderPhone:owner,messageId:id(),sourceText});
  const forbidden=async()=>assert.fail('replay/confirmation must not call the model');
  const process=(request,complete=forbidden)=>db.processMetaUniversalMessage(request,{ordinary:true,complete});
  const proposal=(actions,text)=>({ok:true,json:{contractVersion:1,kind:'proposal',actions,evidence:actions.map(action=>({itemId:action.itemId,quote:text}))}});
  const prepare=(text,actions)=>process(input(`REVISAR OPERACION ${text}`),async()=>proposal(actions,text));
  const revise=(preview,reply,edits)=>process(input(reply),async options=>{
    assert.ok(JSON.parse(options.messages[1].content).previousActions);
    return {ok:true,json:{contractVersion:1,kind:'edit',edits,evidence:edits.map(edit=>({itemId:edit.itemId??edit.action.itemId,quote:reply}))}};
  });
  const snapshot=async()=>{
    const result={};
    for(const table of ['products','clients','proveedores','pedidos','transactions','inventory_operations','inventory_movements','account_operations','account_movements','party_operations','order_operations','universal_operations'])
      result[table]=(await sql.query(`SELECT * FROM ${table} WHERE owner_phone=$1 ORDER BY 1,2`,[owner])).rows;
    return result;
  };
  const customer={itemId:'customer',type:'client.create',name:'Cliente dependiente'};
  const order={itemId:'order',type:'order.create',clientRef:{itemId:'customer'},order:{producto:'Camiseta blanca',talle:'L',qty:1}};
  const charge={itemId:'charge',type:'account.charge',target:{kind:'created',itemId:'customer'},amount:{value:5000,unit:'legacy-money'},reason:'Fiado solicitado'};
  const receipt=()=>({itemId:'new-sku',type:'stock.receive',target:{kind:'new',sku:{name:`Producto ${id()}`,unit:'caja'}},quantity:{value:5,unit:'caja'}});
  const reserve={itemId:'reserve',type:'stock.reserve',target:{kind:'created',itemId:'new-sku'},quantity:{value:2,unit:'caja'}};
  const confirm=preview=>db.confirmUniversalDraft(preview.draftId,{version:preview.version,digest:preview.digest},context);

  await check('dependencies: new client and charge are reviewed without effects and concurrent confirmations commit once',async()=>{
    const before=await snapshot(),preview=await prepare('Creá al cliente dependiente y anotale 5000 de fiado.',[customer,charge]);
    assert.equal(preview.status,'awaiting_confirmation');assert.match(preview.replyText,/Cliente nuevo/);assert.deepEqual(await snapshot(),before);
    const request=input('confirmar');
    const [one,two]=await Promise.all([process(request),process(request)]);assert.deepEqual(one,two);assert.equal(one.status,'applied');
    const after=await snapshot(),created=after.clients.find(row=>!before.clients.some(old=>old.id===row.id));
    assert.equal(after.clients.length,before.clients.length+1);assert.equal(Number(created.debt),5000);
    assert.equal(after.account_movements.length,before.account_movements.length+1);assert.equal(after.transactions.length,before.transactions.length+2);
    assert.deepEqual(await process(request),one);assert.deepEqual(await snapshot(),after);
    await assert.rejects(db.executeAccountOperation({contractVersion:1,businessId:owner,operationId:id(),actions:[charge]},context),{code:'INVALID_OPERATION_REFERENCE'});
    assert.deepEqual(await snapshot(),after);
  });

  await check('dependencies: new supplier and client bind to one pending order with real stored identities',async()=>{
    const supplier={itemId:'supplier',type:'supplier.create',name:'Proveedor dependiente'},before=await snapshot();
    const preview=await prepare('Creá cliente y proveedor y anotá el pedido pendiente.',[customer,supplier,{...order,supplierRef:{itemId:'supplier'}}]);
    assert.equal(preview.status,'awaiting_confirmation');assert.match(preview.replyText,/Proveedor nuevo/);assert.deepEqual(await snapshot(),before);
    const applied=await confirm(preview),after=await snapshot(),pedido=after.pedidos.find(row=>!before.pedidos.some(old=>old.id===row.id));
    assert.equal(applied.status,'applied');assert.ok(after.clients.some(row=>row.id===pedido.cliente_id));assert.ok(after.proveedores.some(row=>row.id===pedido.proveedor_id));
    assert.equal(after.clients.length,before.clients.length+1);assert.equal(after.proveedores.length,before.proveedores.length+1);
    assert.equal(after.inventory_movements.length,before.inventory_movements.length);
    assert.deepEqual(await confirm(preview),applied);assert.deepEqual(await snapshot(),after);
  });

  await check('dependencies: receipt plus reservation creates one product and exact movements; insufficient reservation rolls back the creation',async()=>{
    const before=await snapshot(),receive=receipt();
    const preview=await prepare('Ingresá cinco cajas de un producto nuevo y reservá dos.',[receive,reserve]);
    assert.equal(preview.status,'awaiting_confirmation');assert.deepEqual(await snapshot(),before);
    const applied=await confirm(preview),after=await snapshot(),product=after.products.find(row=>!before.products.some(old=>old.id===row.id));
    assert.equal(after.products.length,before.products.length+1);assert.equal(Number(product.stock_available),3);assert.equal(Number(product.stock_reserved),2);
    assert.equal(after.inventory_movements.length,before.inventory_movements.length+2);
    const movements=after.inventory_movements.filter(row=>!before.inventory_movements.some(old=>old.operation_id===row.operation_id&&old.item_id===row.item_id));
    assert.ok(movements.every(row=>row.sku_id===product.id));assert.deepEqual(await confirm(preview),applied);assert.deepEqual(await snapshot(),after);
    const bad=await prepare('Ingresá cinco cajas de otro producto y reservá seis.',[receipt(),{...reserve,quantity:{value:6,unit:'caja'}}]);
    assert.equal(bad.status,'awaiting_confirmation');await assert.rejects(confirm(bad),{code:'INSUFFICIENT_STOCK'});assert.deepEqual(await snapshot(),after);
  });

  await check('dependencies: newly created product can be linked to an achieved order and derives its stock exactly once',async()=>{
    const before=await snapshot(),receive=receipt();
    const create={...receive,type:'sku.create',initialStock:{available:0,reserved:0},reason:'Alta para pedido conseguido'};delete create.quantity;
    const achieved={...order,productRef:{itemId:'new-sku'},order:{...order.order,qty:3,estado:'conseguido'}};
    const preview=await prepare('Creá el producto y cliente y anotá tres cajas conseguidas.',[create,customer,achieved]);
    assert.equal(preview.status,'awaiting_confirmation');const applied=await confirm(preview),after=await snapshot();
    const product=after.products.find(row=>!before.products.some(old=>old.id===row.id)),pedido=after.pedidos.find(row=>!before.pedidos.some(old=>old.id===row.id));
    assert.equal(pedido.product_id,product.id);assert.equal(Number(product.stock_available),3);assert.equal(pedido.stock_posting_json.skuId,product.id);
    assert.deepEqual(await confirm(preview),applied);assert.deepEqual(await snapshot(),after);
  });

  await check('dependencies: add/remove proposal edits preserve unrelated actions, invalidate old confirmation and apply only final items',async()=>{
    const before=await snapshot(),preview=await prepare('Creá al cliente y anotá una camiseta blanca L.',[customer,order]);
    const added={...order,itemId:'second-order',order:{producto:'Camiseta azul',talle:'M',qty:2}};
    const expanded=await revise(preview,'Agregá también dos camisetas azules M.',[{op:'add',afterItemId:'order',action:added}]);
    assert.equal(expanded.status,'awaiting_confirmation');assert.equal(expanded.version,2);assert.equal(expanded.draftId,preview.draftId);
    assert.match(expanded.replyText,/Camiseta blanca/);assert.match(expanded.replyText,/Camiseta azul/);assert.deepEqual(await snapshot(),before);
    await assert.rejects(confirm(preview),{code:'DRAFT_VERSION_MISMATCH'});
    const reduced=await revise(expanded,'Sacá la camiseta blanca; dejá las azules.',[{op:'remove',itemId:'order'}]);
    assert.equal(reduced.version,3);assert.doesNotMatch(reduced.replyText,/Camiseta blanca/);assert.match(reduced.replyText,/Camiseta azul/);
    assert.deepEqual(await snapshot(),before);await confirm(reduced);
    const after=await snapshot(),pedido=after.pedidos.find(row=>!before.pedidos.some(old=>old.id===row.id));
    assert.equal(after.pedidos.length,before.pedidos.length+1);assert.equal(pedido.producto,'Camiseta azul');assert.equal(Number(pedido.qty),2);
  });

  await check('dependencies: replace a mistaken client creation by an existing client without a duplicate client',async()=>{
    const existing=await db.createClientRecord({operationId:id(),name:'Cliente ya existente'},owner),before=await snapshot();
    const preview=await prepare('Creá al cliente y anotá la camiseta blanca L.',[customer,order]);
    const replacement={...order,order:{...order.order,clienteId:existing.id}};delete replacement.clientRef;
    const corrected=await revise(preview,'El cliente ya existía, usá Cliente ya existente.',[{op:'remove',itemId:'customer'},{op:'replace',itemId:'order',action:replacement}]);
    assert.equal(corrected.status,'awaiting_confirmation');assert.doesNotMatch(corrected.replyText,/Alta de cliente/);assert.match(corrected.replyText,/Cliente ya existente/i);
    assert.deepEqual(await snapshot(),before);await confirm(corrected);
    const after=await snapshot();assert.equal(after.clients.length,before.clients.length);
    assert.equal(after.pedidos.find(row=>!before.pedidos.some(old=>old.id===row.id)).cliente_id,existing.id);
  });

  await check('dependencies: removing all proposal actions cancels without effects; removing a referenced creation preserves the prior draft',async()=>{
    const before=await snapshot(),preview=await prepare('Creá al cliente y anotá el pedido.',[customer,order]);
    const invalid=await revise(preview,'Sacá el alta.',[{op:'remove',itemId:'customer'}]);
    assert.equal(invalid.errorCode,'INTERPRETATION_INVALID');assert.equal(invalid.interpretationReason,'INVALID_ORDER_CLIENT_REFERENCE');
    const unchanged=await db.getUniversalDraft(preview.draftId,context);assert.equal(unchanged.version,1);assert.equal(unchanged.digest,preview.digest);
    const cancelled=await revise(preview,'Sacá tanto el pedido como el alta.',[{op:'remove',itemId:'order'},{op:'remove',itemId:'customer'}]);
    assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.requiresConfirmation,false);assert.match(cancelled.replyText,/cancelada/);
    assert.deepEqual(await snapshot(),before);await assert.rejects(confirm(cancelled),{code:'DRAFT_NOT_PENDING'});
  });

  await check('dependencies: confirmation outbox failure rolls back linked creations, charge, history and receipts',async()=>{
    const before=await snapshot(),preview=await prepare('Creá al cliente y anotale fiado.',[customer,charge]),request=input('confirmar');
    await sql.query(`CREATE FUNCTION dependency_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${request.messageId}' THEN RAISE EXCEPTION 'dependency outbox failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER dependency_outbox_failure BEFORE INSERT ON meta_reply_outbox FOR EACH ROW EXECUTE FUNCTION dependency_outbox_failure()`);
    try {await assert.rejects(process(request),/dependency outbox failure/);} finally {await sql.query('DROP TRIGGER dependency_outbox_failure ON meta_reply_outbox; DROP FUNCTION dependency_outbox_failure()');}
    assert.deepEqual(await snapshot(),before);assert.equal((await db.getUniversalDraft(preview.draftId,context)).status,'awaiting_confirmation');
    assert.equal((await process(request)).status,'applied');
  });
}
