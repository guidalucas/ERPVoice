import assert from 'node:assert/strict';

export async function runOrderReconciliationChecks({db,sql,check}) {
  const a='59899000891',b='59899000892';let sequence=0;
  const id=()=>`order-reconcile-${++sequence}`;
  const customer=await db.createClientRecord({name:'Cliente conciliación histórica'},a);
  const fixture=async()=>{
    const product=await db.createProductRecord({name:`SKU explícito histórico ${id()}`,stockAvailable:8,stockReserved:1,unit:'box'},a,{operationId:id()});
    const pedidoId=id();
    await sql.query("INSERT INTO pedidos(id,owner_phone,cliente_id,producto,qty,estado) VALUES($1,$2,$3,'Etiqueta histórica distinta del SKU',5,'conseguido')",[pedidoId,a,customer.id]);
    const pedido=(await db.getStateSnapshotStrict(a)).pedidos.find((p)=>p.id===pedidoId);
    const input={operationId:id(),expectedRevision:pedido.revision,reconciliation:{productId:product.id,expectedProductRevision:product.revision,expectedFingerprint:product.identityFingerprint,
      available:product.stockAvailable,reserved:product.stockReserved,quantity:pedido.qty,unit:product.unit,reason:'Conteo físico e identificación explícita',confirmed:true}};
    return {product,pedido,input};
  };
  const productRow=async(product)=>(await sql.query('SELECT * FROM products WHERE id=$1',[product.id])).rows[0];
  const orderRow=async(pedido)=>(await sql.query('SELECT * FROM pedidos WHERE id=$1',[pedido.id])).rows[0];
  await check('historical reconciliation audits zero once, binds exact SKU and supports immutable replay after later effects/deletion',async()=>{
    const {product,pedido,input}=await fixture();
    const [one,two]=await Promise.all([db.executeOrderOperation('reconcile',pedido.id,input,a),db.executeOrderOperation('reconcile',pedido.id,input,a)]);
    assert.deepEqual(one,two);assert.deepEqual(one.pedido.stockPosting,{skuId:product.id,quantity:5,unit:'box'});
    assert.equal(one.pedido.revision,1);assert.equal(one.inventoryResult.items[0].type,'stock.adjust');assert.equal(one.inventoryResult.items[0].stockAvailable,8);
    const row=await productRow(product);assert.equal(Number(row.stock_available),8);assert.equal(Number(row.stock_reserved),1);assert.equal(Number(row.inventory_revision),product.revision+1);
    const movements=(await sql.query('SELECT delta_available,delta_reserved FROM inventory_movements WHERE owner_phone=$1 AND operation_id=$2',[a,one.inventoryResult.operationId])).rows;
    assert.deepEqual(movements.map((m)=>[Number(m.delta_available),Number(m.delta_reserved)]),[[0,0]]);
    await db.executeInventoryOperation({contractVersion:1,businessId:a,operationId:id(),actions:[{itemId:'receive',type:'stock.receive',target:{kind:'existing',skuId:product.id},quantity:{value:3,unit:'box'}}]},{businessId:a,actorId:a,permissions:['inventory:receive']});
    assert.deepEqual(await db.executeOrderOperation('reconcile',pedido.id,input,a),one);
    const exited=await db.updatePedidoRecord(pedido.id,{operationId:id(),expectedRevision:1,estado:'pendiente'},a);
    assert.equal(Number((await productRow(product)).stock_available),6);
    await db.deletePedidoRecord(pedido.id,a,{operationId:id(),expectedRevision:exited.revision});
    assert.deepEqual(await db.executeOrderOperation('reconcile',pedido.id,input,a),one);
  });
  await check('historical reconciliation rejects changed review, forged balances/quantity, unconfirmed and foreign SKU without writes',async()=>{
    const {product,pedido,input}=await fixture(),before=[await productRow(product),await orderRow(pedido)];
    const foreign=await db.createProductRecord({name:'Foreign historical SKU',stockAvailable:10},b,{operationId:id()});
    for(const [patch,code] of [[{expectedProductRevision:1},'REVISION_MISMATCH'],[{available:7},'ORDER_RECONCILIATION_MISMATCH'],[{quantity:6},'ORDER_RECONCILIATION_MISMATCH'],[{confirmed:false},'INVALID_ORDER_OPERATION'],[{expectedFingerprint:'forged'},'SKU_FINGERPRINT_MISMATCH'],[{productId:foreign.id},'SKU_NOT_FOUND']]){
      await assert.rejects(db.executeOrderOperation('reconcile',pedido.id,{...input,operationId:id(),reconciliation:{...input.reconciliation,...patch}},a),{code});
      assert.deepEqual([await productRow(product),await orderRow(pedido)],before);
    }
    await assert.rejects(db.executeOrderOperation('reconcile',pedido.id,input,b),{code:'ORDER_NOT_FOUND'});
    await sql.query('UPDATE products SET stock_available=4,inventory_revision=inventory_revision+1 WHERE id=$1',[product.id]);
    await assert.rejects(db.executeOrderOperation('reconcile',pedido.id,{...input,operationId:id(),reconciliation:{...input.reconciliation,expectedProductRevision:1,available:4}},a),{code:'INSUFFICIENT_STOCK'});
  });
  await check('historical reconciliation SQL failure rolls back proof, zero movement and both receipts before retry',async()=>{
    const {product,pedido,input}=await fixture(),before=[await productRow(product),await orderRow(pedido)];
    await sql.query(`CREATE FUNCTION reject_historical_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${pedido.id}' AND NEW.stock_posting_json IS NOT NULL THEN RAISE EXCEPTION 'proof persistence failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_historical_proof BEFORE UPDATE ON pedidos FOR EACH ROW EXECUTE FUNCTION reject_historical_proof();`);
    try{await assert.rejects(db.executeOrderOperation('reconcile',pedido.id,input,a),/proof persistence failure/);}finally{await sql.query('DROP TRIGGER reject_historical_proof ON pedidos; DROP FUNCTION reject_historical_proof()');}
    assert.deepEqual([await productRow(product),await orderRow(pedido)],before);
    assert.equal((await sql.query('SELECT 1 FROM order_operations WHERE owner_phone=$1 AND operation_id=$2',[a,input.operationId])).rowCount,0);
    const applied=await db.executeOrderOperation('reconcile',pedido.id,input,a);assert.equal(applied.pedido.stockPosting.quantity,5);
  });
}
