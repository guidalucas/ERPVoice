import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {chromium} from 'playwright';

const browser=await chromium.launch(process.platform==='win32'?{channel:'msedge',headless:true}:{headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const clients=[{id:'keep',name:'Cliente conservado',debt:5,accountRevision:1,metadataRevision:0},{id:'source',name:'Cliente fusionado',debt:7,accountRevision:2,metadataRevision:0}];
const attempts=[],receipts=new Map(),pageErrors=[];
let mode='lost',release;
page.on('pageerror',(error)=>pageErrors.push(error.message));
const snapshot=()=>({products:[],clients,pedidos:[],proveedores:[],transactions:[]});
await page.addInitScript(()=>{localStorage.setItem('erpvoice.auth.token','local-account-ui');localStorage.setItem('erpvoice.auth.phoneNumber','5491100000000');});
await page.route('**/api/**',async(route)=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/auth/me')return json({phoneNumber:'5491100000000',tenantPhone:'5491100000000',role:'owner',businessName:'Cuentas UI',businessCategory:'general',needsOnboarding:false,hasOwnBusiness:true});
  if(path==='/api/state')return json(snapshot());
  if(path==='/api/clients/merge'){
    const input=request.postDataJSON();attempts.push(input);
    if(receipts.has(input.operationId)){const prior=receipts.get(input.operationId);assert.deepEqual(input,prior.input);return json({...snapshot(),operationResult:prior.result});}
    if(mode==='conflict')return json({error:'La cuenta cambió. Revisá el saldo actual.',code:'ACCOUNT_REVISION_MISMATCH'},409);
    if(mode==='hold')await new Promise((resolve)=>{release=resolve;});
    const keep=clients.find((c)=>c.id===input.keepId),source=clients.find((c)=>c.id===input.mergeId);assert.ok(keep&&source);
    assert.equal(input.expectedKeepRevision,keep.accountRevision);assert.equal(input.expectedMergeRevision,source.accountRevision);
    keep.debt+=source.debt;keep.accountRevision++;clients.splice(clients.indexOf(source),1);
    const result={client:structuredClone(keep),removedClientId:source.id};receipts.set(input.operationId,{input,result});
    if(mode==='lost'){mode='ok';return json({error:'Resultado incierto de la fusión.'},503);}
    return json({...snapshot(),operationResult:result});
  }
  if(path.startsWith('/api/clients/')&&request.method()==='DELETE')return json({error:'El cliente tiene saldo. Resolvé la deuda antes de eliminarlo.',code:'CLIENT_HAS_BALANCE'},409);
  return json({});
});
await page.route('http://127.0.0.1:5173/**',async(route)=>{
  const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/'))return route.fallback();
  const root=resolve('dist'),file=resolve(root,`.${path==='/'?'/index.html':path}`);if(!file.startsWith(`${root}${sep}`))return route.abort();
  try{return route.fulfill({body:await readFile(file),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
});
try{
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('navigation',{name:'Navegación del panel'}).getByRole('button',{name:'Clientes',exact:true}).click();
  await page.getByRole('button',{name:/Fusionar duplicados/}).click();
  await page.getByLabel('Cliente que se conserva').selectOption('keep');await page.getByLabel('Cliente que se fusiona').selectOption('source');
  await page.getByRole('button',{name:'Fusionar',exact:true}).click();await page.getByRole('alert').getByText('Resultado incierto de la fusión.',{exact:true}).waitFor();
  assert.equal(clients.length,1);assert.equal(clients[0].debt,12);
  await page.getByRole('heading',{name:'Fusionar duplicados'}).waitFor({state:'hidden',timeout:12000});
  await page.getByRole('button',{name:'Reintentar fusión',exact:true}).click();
  await page.getByRole('button',{name:'Reintentar fusión',exact:true}).waitFor({state:'hidden'});
  assert.deepEqual(attempts[0],attempts[1]);assert.equal(clients[0].debt,12);
  await page.getByRole('button',{name:'Eliminar',exact:true}).click();await page.getByRole('alert').getByText(/El cliente tiene saldo/).waitFor();
  clients.push({id:'second',name:'Segundo cliente',debt:4,accountRevision:0,metadataRevision:0});
  await page.getByRole('heading',{name:'Fusionar duplicados'}).waitFor({timeout:12000});
  if(await page.getByRole('button',{name:/Fusionar duplicados/}).getAttribute('aria-expanded')==='false')await page.getByRole('button',{name:/Fusionar duplicados/}).click();
  await page.getByLabel('Cliente que se conserva').selectOption('keep');await page.getByLabel('Cliente que se fusiona').selectOption('second');
  mode='conflict';await page.getByRole('button',{name:'Fusionar',exact:true}).click();await page.getByRole('button',{name:'Revisar clientes actuales',exact:true}).click();
  mode='hold';await page.getByLabel('Cliente que se conserva').selectOption('keep');await page.getByLabel('Cliente que se fusiona').selectOption('second');
  await page.getByRole('button',{name:'Fusionar',exact:true}).click();
  assert.equal(await page.getByLabel('Cliente que se conserva').isDisabled(),true);assert.equal(await page.getByLabel('Cliente que se fusiona').isDisabled(),true);
  const deadline=Date.now()+5000;while(!release&&Date.now()<deadline)await page.waitForTimeout(20);assert.ok(release);mode='ok';release();
  await page.getByRole('heading',{name:'Fusionar duplicados'}).waitFor({state:'hidden'});
  assert.notEqual(attempts[2].operationId,attempts[3].operationId);assert.equal(clients[0].debt,16);assert.equal(clients.length,1);assert.deepEqual(pageErrors,[]);
  console.log('Client account UI passed: exact revisions, applied503 merge retry after source disappears, balance guard, conflict review and disabled in-flight selections.');
}finally{await browser.close();}
