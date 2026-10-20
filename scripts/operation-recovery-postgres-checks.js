import assert from 'node:assert/strict';
import {recoverLegacyPanelOperation} from '../server/operationRecovery.js';

export async function runOperationRecoveryChecks({db,sql,check}) {
  const owner='59899000993';let sequence=0;
  const id=()=>`operation-recovery-${++sequence}`;
  const context={businessId:owner,actorId:owner,permissions:['inventory:read','accounts:read','orders:read']};
  const recover=(request,ctx=context)=>recoverLegacyPanelOperation(sql,request,ctx);
  const product=await db.createProductRecord({name:'Producto recuperación lectura',stockAvailable:9,price:10},owner,{operationId:id()});
  const client=await db.createClientRecord({name:'Cliente recuperación lectura',operationId:id()},owner);
  for(const actions of [
    [{type:'sell',productId:product.id,productName:product.name,qty:2}],
    [{type:'add_debt',clientName:client.name,clientId:client.id,amount:7}],
    [{type:'client_order',clientName:client.name,clienteId:client.id,productName:'Producto pedido histórico',qty:1}],
  ]) await check(`operation recovery returns immutable ${actions[0].type} receipt without a new operation`,async()=>{
    const request={operationId:id(),sourceText:'Propuesta anterior confirmada',actions};
    const applied=await db.applyActionsToDatabase(actions,request.sourceText,owner,{operationId:request.operationId,actorId:owner,channel:'panel'});
    const before=await db.getStateSnapshotStrict(owner);
    const result=await recover(request);assert.equal(result.status,'applied');assert.deepEqual(result.operationResult,applied.operationResult);
    assert.deepEqual(await recover(request),result);assert.deepEqual(await db.getStateSnapshotStrict(owner),before);
    await assert.rejects(recover({...request,sourceText:'Solicitud diferente'}),{code:'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(recover(request,{...context,actorId:'other'}),{code:'FORBIDDEN'});
    assert.equal((await recover(request,{...context,businessId:'59899000994'})).status,'not_applied');
  });
  await check('operation recovery distinguishes absent legacy receipt and preserves applied facts after catalog deletion',async()=>{
    const request={operationId:id(),sourceText:'Venta guardada',actions:[{type:'sell',productId:product.id,productName:product.name,qty:1}]};
    const applied=await db.applyActionsToDatabase(request.actions,request.sourceText,owner,{operationId:request.operationId,actorId:owner,channel:'panel'});
    await sql.query('DELETE FROM products WHERE owner_phone=$1 AND id=$2',[owner,product.id]);
    const before=await db.getStateSnapshotStrict(owner);
    assert.deepEqual((await recover(request)).operationResult,applied.operationResult);
    assert.equal((await recover({...request,operationId:id()})).status,'not_applied');
    assert.deepEqual(await db.getStateSnapshotStrict(owner),before);
  });
}
