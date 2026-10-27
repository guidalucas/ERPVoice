import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { clarificationErrors } from './clarification-expectations.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {resolveProviderChain,extractChatContent,parseModelJsonContent} from '../server/llmChatClient.js';
import {interpretUniversalIntent} from '../server/universalIntentInterpreter.js';
import {inventoryRowToProduct} from '../server/inventoryPostgres.js';
import {partyRowToEntity} from '../server/partyPostgres.js';
import {orderRowToPedido} from '../server/orderPostgres.js';
import {loadProductFamilySchemas} from '../server/productFamilyPostgres.js';
import {buildUniversalOperationReview} from '../server/universalOperationReview.js';
import {persistUniversalInterpretation,confirmUniversalDraftInTransaction,cancelUniversalDraftInTransaction} from '../server/universalConversationPostgres.js';
import {universalMetaPreviewReply} from '../server/universalMetaOperations.js';
import {persistInventoryTransactions} from '../server/postgresDatabase.js';
import {testProducts,argentineCases} from './fixtures/argentine-live-corpus.js';

const normalized=value=>String(value).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const normalizedSize=value=>normalized(value).replace(/^(?:talle|tamano|numero|nro\.?)\s+/,'');
const safeCode=error=>/^[A-Z][A-Z0-9_]*$/.test(error?.code??'')?error.code:'CHECK_FAILED';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables=['products','clients','proveedores','pedidos','transactions','inventory_operations','inventory_movements','account_operations','account_movements','party_operations','order_operations','universal_operations','product_family_schemas','universal_drafts','universal_draft_commands'];
const domainTables=tables.filter(table=>!['universal_drafts','universal_draft_commands','product_family_schemas'].includes(table));

export function checkInterpretation(expected,result,ids){
  assert.equal(result.kind,expected.kind,`Se esperaba ${expected.kind}; recibido ${result.kind}${result.reason?`: ${result.reason}`:''}${result.question?`: ${result.question}`:''}`);
  if(expected.kind==='clarification') {assert.deepEqual(clarificationErrors(expected,result),[]);return;}
  if(expected.kind==='answer'){
    assert.equal(result.plan,undefined);assert.ok(result.answer?.items?.length);
    for(const type of expected.queryTypes) assert.ok(result.queries.some(query=>query.type===type),`Falta ${type}`);
    const actualIds=new Set(result.answer.items.flatMap(item=>item.rows.map(row=>row.id)));
    if(expected.productKeys) assert.deepEqual([...actualIds].sort(),expected.productKeys.map(key=>ids[key]).sort(),'La consulta debe respetar los productos y talles pedidos.');
    if(expected.productionProductId) assert.ok(actualIds.has(expected.productionProductId),'La consulta omitió el producto real.');
    return;
  }
  assert.equal(result.plan.actions.length,expected.actions.length,'Cantidad de operaciones distinta de la pedida.');
  expected.actions.forEach((wanted,index)=>{
    const actual=result.plan.actions[index];
    if(wanted.type==='new'){
      assert.ok(['stock.receive','sku.create'].includes(actual.type));assert.equal(actual.target.kind,'new');
      assert.equal(actual.quantity?.value??actual.initialStock?.available,wanted.quantity,'Cantidad inicial incorrecta.');
      assert.equal(actual.initialStock?.reserved??0,0);
      const sku=actual.target.sku,description=normalized(JSON.stringify(sku));
      for(const term of wanted.terms) assert.ok(description.includes(normalized(term)),`Se perdió el dato ${term}.`);
      if(wanted.size!==undefined) assert.equal(normalizedSize(sku.size??sku.attributes?.size?.value),normalizedSize(wanted.size),'Talle nuevo incorrecto.');
      assert.equal(actual.price?.amount,wanted.price,'Precio del producto nuevo incorrecto.');
      if(wanted.price!==undefined) assert.equal(actual.price?.currency,'ARS');
      else assert.equal(actual.price,undefined,'Se inventó un precio opcional.');
      if(wanted.units) assert.ok(wanted.units.includes(sku.unit),`Se perdió la unidad comercial: ${sku.unit}`);
    }else{
      assert.equal(actual.type,wanted.type,`Tipo incorrecto en la operación ${index+1}.`);
      if(wanted.key) assert.equal(actual.target.skuId,ids[wanted.key],'Producto o variante incorrectos.');
      if(wanted.client && wanted.type!=='order.create') assert.equal(actual.target.clientId,ids[wanted.client]);
      if(wanted.quantity && wanted.type!=='order.create') assert.equal(actual.quantity.value,wanted.quantity,'Cantidad incorrecta.');
      if(actual.quantity) assert.equal(actual.quantity.unit,wanted.unit??'unit');
      if(wanted.type==='order.create'){
        assert.equal(actual.order.clienteId,ids[wanted.client]);assert.equal(actual.order.proveedorId,ids[wanted.supplier]);
        assert.equal(actual.order.qty,wanted.quantity);assert.equal(actual.order.talle,wanted.size);assert.equal(actual.order.estado??'pendiente',wanted.estado);
        for(const term of wanted.terms) assert.ok(normalized(actual.order.producto).includes(term));
      }
      if(wanted.order) assert.equal(actual.target.pedidoId,ids[wanted.order]);
      if(wanted.amount!==undefined) assert.equal(actual.amount.value,wanted.amount,'Monto en lucas mal interpretado.');
      if(wanted.changes) for(const [key,value] of Object.entries(wanted.changes)) assert.deepEqual(actual.changes[key],value);
      if(wanted.type==='client.create'){
        assert.equal(normalized(actual.name),normalized(wanted.name));
        for(const term of wanted.noteTerms) assert.ok(normalized(actual.notas).includes(term));
      }
      if(wanted.salePrice!==undefined){assert.equal(actual.salePrice?.amount,wanted.salePrice);assert.equal(actual.salePrice?.currency,'ARS');}
      else if(['stock.sell','stock.reserve'].includes(wanted.type)) assert.equal(actual.salePrice,undefined,'Se inventó un precio de venta/reserva.');
      if(wanted.type==='stock.receive') assert.equal(actual.price,undefined,'Se copió o pidió un precio opcional no declarado.');
    }
  });
}

// Independent of the executor's own effect checks: compare the requested stock
// and money deltas with the actual SQL rows before testing idempotent replay.
export function checkPersistedEffects(expected,before,after,ids){
  const productDeltas=new Map(),accountDeltas=new Map();
  for(const action of expected.actions){
    if(action.key&&action.quantity!==undefined){
      const id=ids[action.key],delta=productDeltas.get(id)??{available:0,reserved:0};
      delta.available+=action.type==='stock.receive'?action.quantity:-action.quantity;
      if(action.type==='stock.reserve') delta.reserved+=action.quantity;
      productDeltas.set(id,delta);
    }
    if(['account.charge','account.payment'].includes(action.type)){
      const id=ids[action.client];accountDeltas.set(id,(accountDeltas.get(id)??0)+(action.type==='account.charge'?action.amount:-action.amount));
    }
  }
  for(const old of before.products){
    const saved=after.products.find(p=>p.id===old.id);assert.ok(saved,'Se perdió un producto existente.');
    const delta=productDeltas.get(old.id)??{available:0,reserved:0};
    assert.equal(Number(saved.stock_available),Number(old.stock_available)+delta.available,'Stock SQL disponible distinto de lo pedido.');
    assert.equal(Number(saved.stock_reserved),Number(old.stock_reserved)+delta.reserved,'Stock SQL reservado distinto de lo pedido.');
    assert.equal(saved.inventory_unit,old.inventory_unit,'La operación cambió la unidad existente.');
  }
  for(const old of before.clients){
    const saved=after.clients.find(p=>p.id===old.id);assert.ok(saved);
    assert.equal(Number(saved.debt),Number(old.debt)+(accountDeltas.get(old.id)??0),'Saldo SQL distinto de lo pedido.');
  }
  const created=after.products.filter(p=>!before.products.some(old=>old.id===p.id));
  const wantedNew=expected.actions.filter(action=>action.type==='new');assert.equal(created.length,wantedNew.length);
  const remaining=[...created];
  for(const wanted of wantedNew){
    const index=remaining.findIndex(p=>wanted.terms.every(term=>normalized(JSON.stringify(p)).includes(normalized(term))));
    assert.ok(index>=0,'No se guardó el producto nuevo solicitado.');const [saved]=remaining.splice(index,1);
    assert.equal(Number(saved.stock_available),wanted.quantity);assert.equal(Number(saved.stock_reserved),0);
    if(wanted.units) assert.ok(wanted.units.includes(saved.inventory_unit));
    if(wanted.price!==undefined){assert.equal(Number(saved.price),wanted.price);assert.equal(saved.price_currency,'ARS');}
    if(wanted.size!==undefined) assert.equal(normalizedSize(saved.size??saved.attributes_json?.size?.value),normalizedSize(wanted.size));
  }
}

async function main(){
  dotenv.config({path:'.env.local',override:true,quiet:true});dotenv.config({quiet:true});
  if(!process.argv.includes('--live')||!process.argv.includes('--production-temp')) throw new Error('Requiere --live --production-temp; nunca modifica tablas permanentes.');
  const provider=resolveProviderChain()[0];if(!provider) throw new Error('LLM_NOT_CONFIGURED');
  let connectionString=process.env.SUPABASE_DATABASE_URL||process.env.DATABASE_URL||process.env.POSTGRES_URL||process.env.POSTGRES_CONNECTION_STRING;
  if(!connectionString) throw new Error('DATABASE_NOT_CONFIGURED');
  const url=new URL(connectionString);if(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) throw new Error('NOT_A_PRODUCTION_CONNECTION');
  // Supabase transaction pooling cannot retain temporary tables between turns.
  // Port 5432 on the same shared pooler selects its documented session mode.
  if(url.hostname.endsWith('.pooler.supabase.com')&&url.port==='6543'){url.port='5432';connectionString=url.toString();}
  const minPauseMs=6000,runId=crypto.randomUUID(),owner=`qa-${runId}`,ids=Object.fromEntries(testProducts.map(p=>[p.key,`${runId}-${p.key}`]));
  ids.mica=`${runId}-mica`;ids.bauti=`${runId}-bauti`;ids.textil=`${runId}-textil`;ids.calza=`${runId}-pedido-calza`;
  const context={businessId:owner,actorId:'argentine-live-evaluation',channel:'whatsapp',internalConversationOperation:true,ownerPhoneVariants:[owner],permissions:['inventory:read','orders:read','accounts:read','inventory:receive','inventory:sell','inventory:reserve','inventory:withdraw','inventory:adjust','inventory:update','inventory:create','accounts:charge','accounts:payment','clients:create','clients:update','orders:create','orders:update','orders:delete']};
  const client=new Client({connectionString,ssl:process.env.POSTGRES_SSL==='false'?false:{rejectUnauthorized:false},connectionTimeoutMillis:15000,application_name:'stocky-argentine-qa-temp'});
  const report={runId,mode:'LIVE_PRODUCTION_TEMP_TABLES',connectionMode:'session',startedAt:new Date().toISOString(),provider:provider.id,model:provider.models[0],minPauseMs,parallelRequests:1,automaticRetries:0,maxFormatRepairsPerTurn:1,cases:[],wireCalls:0,usage:{promptTokens:0,completionTokens:0},permanentTablesModified:false};
  const outIndex=process.argv.indexOf('--out'),out=path.resolve(outIndex>=0?process.argv[outIndex+1]:'scripts/test-results-cross-sector-verified.json');
  let inTransaction=false,lastCompleted=0,halt=false,lastModelOutput;const createdTables=[];
  const tx=async fn=>{assert.equal(inTransaction,false);await client.query('BEGIN');inTransaction=true;try{await client.query('SET LOCAL search_path TO pg_temp');const value=await fn();await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{inTransaction=false;}};
  const complete=async options=>{
    assert.equal(inTransaction,false,'Nunca se llama al modelo con una transacción abierta.');
    if(halt) return {ok:false,reason:'evaluation_stopped'};
    const pause=minPauseMs-(Date.now()-lastCompleted);if(pause>0) await delay(pause);
    report.wireCalls++;console.log(`LLM ${report.wireCalls}: ${provider.id}/${provider.models[0]}`);
    lastModelOutput=undefined;
    try{
      const body={model:provider.models[0],temperature:options.temperature??0,max_tokens:Math.min(options.maxTokens??6000,6000),messages:options.messages,...(provider.supportsJsonObject?{response_format:{type:'json_object'}}:{}),...(provider.reasoningEffort?{reasoning_effort:options.reasoningEffort??provider.reasoningEffort}:{})};
      report.reasoningEffort=body.reasoning_effort??null;
      const response=await fetch(provider.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${provider.apiKey}`},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
      if(!response.ok){
        halt=true;
        const errorText=await response.text();
        report.providerFailure={kind:'http',status:response.status,...(/reasoning_effort|thinking[_ ](?:level|budget)/i.test(errorText)?{parameter:'reasoning_effort'}:{}),...(/^\d+$/.test(response.headers.get('retry-after')??'')?{retryAfterSeconds:Number(response.headers.get('retry-after'))}:{})};
        return {ok:false,provider:provider.id,model:provider.models[0],reason:`http_${response.status}`};
      }
      const payload=await response.json(),parsed=parseModelJsonContent(extractChatContent(payload));
      if(parsed.ok) lastModelOutput=parsed.json;
      report.usage.promptTokens+=Number(payload.usage?.prompt_tokens??0);report.usage.completionTokens+=Number(payload.usage?.completion_tokens??0);
      return parsed.ok?{ok:true,json:parsed.json,provider:provider.id,model:provider.models[0]}:{ok:false,reason:'invalid_model_json'};
    }catch(error){halt=true;report.providerFailure={kind:'network',code:error.cause?.code??error.name};return {ok:false,reason:'network',networkCode:error.cause?.code??error.name};}
    finally{lastCompleted=Date.now();}
  };
  const snapshotSql=`SELECT jsonb_build_object(${domainTables.map(table=>`'${table}',COALESCE((SELECT jsonb_agg(snapshot_row) FROM (SELECT * FROM pg_temp.${table} ORDER BY 1,2) snapshot_row),'[]'::jsonb)`).join(',')}) AS snapshot`;
  const snapshot=async()=>(await client.query(snapshotSql)).rows[0].snapshot;
  const catalog=async()=>({products:(await client.query("SELECT * FROM pg_temp.products WHERE inventory_status='active' ORDER BY id")).rows.map(inventoryRowToProduct),clients:(await client.query('SELECT * FROM pg_temp.clients ORDER BY id')).rows.map(row=>partyRowToEntity(row,true)),proveedores:(await client.query('SELECT * FROM pg_temp.proveedores ORDER BY id')).rows.map(row=>partyRowToEntity(row,false)),pedidos:(await client.query('SELECT * FROM pg_temp.pedidos ORDER BY id')).rows.map(orderRowToPedido),familySchemas:await loadProductFamilySchemas(client,[owner])});
  const saveReport=async()=>{report.finishedAt=new Date().toISOString();report.passed=report.cases.filter(c=>c.passed).length;report.failed=report.cases.filter(c=>!c.passed).length;await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,JSON.stringify(report,null,2));};
  try{
    await client.connect();await client.query("SET statement_timeout='15s'");await client.query("SET lock_timeout='2s'");
    await client.query('BEGIN READ ONLY');inTransaction=true;
    const scope=(await client.query("SELECT owner_phone FROM public.products WHERE owner_phone<>'__default__' GROUP BY owner_phone ORDER BY COUNT(*) DESC LIMIT 1")).rows[0]?.owner_phone;
    assert.ok(scope,'Falta un catálogo real para copiar.');
    const products=(await client.query("SELECT * FROM public.products WHERE owner_phone=$1 AND inventory_status='active' ORDER BY id",[scope])).rows;
    const families=(await client.query('SELECT * FROM public.product_family_schemas WHERE owner_phone=$1',[scope])).rows;
    await client.query('COMMIT');inTransaction=false;
    report.productionSnapshot={businessFingerprint:hash(scope).slice(0,12),activeProducts:products.length,copiedAt:new Date().toISOString(),rawSnapshotHash:hash(products)};
    // Temporary relations shadow every permanent relation used by the executor.
    // The copied tables have production columns, defaults, CHECKs and indexes;
    // PostgreSQL LIKE does not copy foreign keys, RLS policies or triggers.
    for(const table of tables){
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT PRESERVE ROWS`);
      createdTables.push(table);
      assert.ok((await client.query('SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1::regclass',[table])).rows[0].nspname.startsWith('pg_temp_'));
    }
    // No fallback to public is allowed if a temporary relation disappears.
    await client.query('SET search_path TO pg_temp');
    const sequenceDefaults=(await client.query("SELECT column_default FROM information_schema.columns WHERE table_schema LIKE 'pg_temp_%' AND column_default LIKE '%nextval(%'")).rows;
    assert.equal(sequenceDefaults.length,0,'Una tabla temporal no debe consumir secuencias permanentes.');
    const insertRow=async(table,row)=>{const keys=Object.keys(row);assert.ok(keys.every(k=>/^[a-z_]+$/.test(k)));await client.query(`INSERT INTO pg_temp.${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(k=>row[k]));};
    for(const row of products) await insertRow('products',{...row,owner_phone:owner});
    for(const row of families) await insertRow('product_family_schemas',{...row,owner_phone:owner});
    for(const p of testProducts) await client.query('INSERT INTO pg_temp.products(id,owner_phone,name,product_type,product_model,size,stock_available,stock_reserved,price,price_currency,inventory_unit,attributes_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)',[ids[p.key],owner,p.name,p.productType,p.productModel,p.size,p.stockAvailable,p.stockReserved,p.price,p.priceCurrency,p.unit,'{}']);
    await client.query('INSERT INTO pg_temp.clients(id,owner_phone,name,debt) VALUES($1,$2,$3,$4),($5,$2,$6,$7)',[ids.mica,owner,'Mica Rojas',10000,ids.bauti,'Bauti Pérez',30000]);
    await client.query('INSERT INTO pg_temp.proveedores(id,owner_phone,name) VALUES($1,$2,$3)',[ids.textil,owner,'Textil Sur']);
    await client.query('INSERT INTO pg_temp.pedidos(id,owner_phone,cliente_id,producto,talle,qty,estado,product_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ids.calza,owner,ids.mica,'Calza ciclista negra','M',1,'pendiente',ids['calza-m']]);
    const fixtures=argentineCases(ids,products.map(inventoryRowToProduct).find(p=>p.name&&p.size)),filterIndex=process.argv.indexOf('--only');
    const selected=filterIndex>=0?fixtures.filter(test=>process.argv[filterIndex+1].split(',').includes(test.id)):fixtures;
    report.plannedCases=selected.length;report.syntheticProducts=testProducts.length;
    for(const test of selected){
      if(halt){report.stoppedReason='Proveedor no disponible o límite HTTP; no se reintentó ni se continuó enviando solicitudes.';break;}
      const row={id:test.id,category:test.category,text:test.text,expected:test.expected,turns:[],passed:false};report.cases.push(row);
      const before=await snapshot(),draftId=`${runId}:${test.id}`,operationId=`draft-operation:${draftId}`;
      let text=test.text,clarifications=[],previous,preview,latestResult;
      try{
        for(let turn=0;turn<(test.reply?2:1);turn++){
          const reply=turn?test.reply:null;
          if(reply){text+=`\n${reply}`;if(previous.kind==='clarification') clarifications.push({question:previous.question,answer:reply});}
          const offered=await catalog();
          latestResult=await interpretUniversalIntent({sourceText:text,catalog:offered,clarifications,context,operationId,channel:'whatsapp',complete,...(reply&&previous.plan?{revision:{plan:previous.plan,evidence:previous.evidence,replyText:reply}}:{})});
          row.turns.push({text:reply??test.text,kind:latestResult.kind,reason:latestResult.reason,question:latestResult.question,actions:latestResult.plan?.actions,...(latestResult.kind==='invalid'?{modelOutput:lastModelOutput}:{}),queries:latestResult.queries,querySummary:latestResult.answer?.items.map(item=>({type:item.type,count:item.rows.length,summary:item.summary})),trace:latestResult.trace});
          checkInterpretation(turn?test.finalExpected:test.expected,latestResult,ids);
          assert.equal(hash(await snapshot()),hash(before),'Interpretar no puede escribir datos de negocio.');
          const interpreted=latestResult.plan?{...latestResult,review:buildUniversalOperationReview(latestResult.plan,offered)}:latestResult;
          const request={requestId:`${runId}:${test.id}:${turn}`,text:reply??test.text,...(turn?{version:preview.version}:{})};
          preview=await tx(()=>persistUniversalInterpretation(client,request,interpreted,context,{draftId,reply:Boolean(turn)}));
          // Verify the actual WhatsApp review can be rendered in full.
          row.previewChars=universalMetaPreviewReply(preview).length;
          previous=latestResult;
        }
        if(latestResult.kind==='answer'){row.queryVerified=true;}
        else if(latestResult.kind==='clarification'){
          assert.equal(hash(await snapshot()),hash(before));row.clarificationWithoutEffects=true;
        }
        else if(test.cancel){
          const cancelled=await tx(()=>cancelUniversalDraftInTransaction(client,draftId,{version:preview.version,digest:preview.digest},context));
          assert.equal(cancelled.status,'cancelled');assert.equal(hash(await snapshot()),hash(before));row.cancelledWithoutEffects=true;
        }else{
          await client.query('BEGIN');inTransaction=true;
          try{
            await client.query('SET LOCAL search_path TO pg_temp');
            let applied;
            try{applied=await confirmUniversalDraftInTransaction(client,draftId,{version:preview.version,digest:preview.digest},context,persistInventoryTransactions);}
            catch(error){if(!test.executionError) throw error;assert.equal(error.code,test.executionError);row.expectedRejection=error.code;}
            if(!test.executionError){
              assert.equal(applied?.status,'applied');
              const after=await snapshot();checkPersistedEffects(test.finalExpected??test.expected,before,after,ids);row.persistedEffectsVerified=true;
              row.persisted={newProducts:after.products.filter(p=>!before.products.some(b=>b.id===p.id)).map(p=>({name:p.name,size:p.size,unit:p.inventory_unit,available:Number(p.stock_available),reserved:Number(p.stock_reserved),price:Number(p.price),currency:p.price_currency})),productChanges:after.products.filter(p=>{const old=before.products.find(b=>b.id===p.id);return old&&hash(old)!==hash(p);}).map(p=>({name:p.name,size:p.size,unit:p.inventory_unit,available:Number(p.stock_available),reserved:Number(p.stock_reserved),price:Number(p.price)})),accountChanges:after.clients.filter(p=>{const old=before.clients.find(b=>b.id===p.id);return old&&Number(old.debt)!==Number(p.debt);}).map(p=>({name:p.name,balance:Number(p.debt)})),transactions:after.transactions.length-before.transactions.length};
              const replay=await confirmUniversalDraftInTransaction(client,draftId,{version:preview.version,digest:preview.digest},context,persistInventoryTransactions);
              assert.deepEqual(replay,applied);assert.equal(hash(await snapshot()),hash(after));row.confirmed=true;row.replayWithoutDuplicateEffects=true;
            }else assert.ok(row.expectedRejection,'Se aplicó una operación que debía rechazarse.');
          }finally{await client.query('ROLLBACK');inTransaction=false;}
          assert.equal(hash(await snapshot()),hash(before),'Rollback debe restaurar stock, cuentas e historial del escenario.');row.rollbackVerified=true;
        }
        row.passed=true;
      }catch(error){
        if(inTransaction){await client.query('ROLLBACK');inTransaction=false;}
        row.error={code:safeCode(error),message:String(error.message).slice(0,1600)};
      }
      console.log(`${row.passed?'PASS':'FAIL'} ${row.id}${row.error?`: ${row.error.message}`:''}`);await saveReport();
    }
    report.tempTableIsolationVerified=true;report.completed=report.cases.length===report.plannedCases;await saveReport();
    console.log(JSON.stringify({report:out,passed:report.passed,failed:report.failed,cases:report.cases.length,wireCalls:report.wireCalls,completed:report.completed},null,2));
    if(report.failed||!report.completed) process.exitCode=1;
  }finally{
    if(inTransaction) await client.query('ROLLBACK').catch(()=>{});
    try{
      if(createdTables.length) await client.query(`DROP TABLE ${createdTables.map(table=>`pg_temp.${table}`).join(',')}`);
      await client.query('RESET ALL');report.temporaryTablesRemoved=true;
    }catch(error){report.cleanupError=safeCode(error);}
    await client.end();await saveReport();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(JSON.stringify({code:safeCode(error),message:String(error.message).slice(0,700)}));process.exitCode=1;});
