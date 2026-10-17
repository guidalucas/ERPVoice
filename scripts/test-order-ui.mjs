import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? {channel:'msedge',headless:true} : {headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const product = {id:'sku-order',name:'Producto pedido UI',unit:'box',stockAvailable:10,stockReserved:0,price:20,revision:0};
const pedidos = [], attempts = [], receipts = new Map();
let mode = 'ok', failRefresh = false, release;
const snapshot = () => ({products:[product],clients:[{id:'client-order',name:'Cliente UI',debt:0}],proveedores:[],pedidos,transactions:[]});
await page.addInitScript(() => {
  localStorage.setItem('erpvoice.auth.token','local-order-ui');
  localStorage.setItem('erpvoice.auth.phoneNumber','5491100000000');
});
await page.route('**/api/**',async(route) => {
  const request = route.request(), path = new URL(request.url()).pathname;
  const json = (body,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if (path==='/api/auth/me') return json({phoneNumber:'5491100000000',tenantPhone:'5491100000000',role:'owner',businessName:'Pedidos UI',businessCategory:'general',needsOnboarding:false,hasOwnBusiness:true});
  if (path==='/api/state') { if(failRefresh){failRefresh=false;return json({error:'No pude refrescar pedidos.'},503);}return json(snapshot()); }
  if (path.startsWith('/api/pedidos') && ['POST','PUT'].includes(request.method())) {
    const input=request.postDataJSON(); attempts.push({path,input});
    assert.equal(typeof input.operationId,'string');
    if(receipts.has(input.operationId)) {const prior=receipts.get(input.operationId);assert.deepEqual({path,input},prior.request);return json(prior.result);}
    if(mode==='hold') await new Promise((resolve)=>{release=resolve;});
    if(mode==='conflict') return json({error:'El pedido cambió. Revisá su estado.',code:'ORDER_REVISION_MISMATCH'},409);
    let pedido;
    if(request.method()==='POST'){
      assert.equal(input.productId,product.id);
      pedido={...input,id:`order-${pedidos.length+1}`,revision:0,stockPosting:null,fechaPedido:new Date().toISOString()};pedidos.push(pedido);
    }else{
      pedido=pedidos.find((p)=>p.id===path.split('/').at(-1));assert.ok(pedido);
      if(input.expectedRevision!==pedido.revision)return json({error:'Revisión obsoleta',code:'ORDER_REVISION_MISMATCH'},409);
      if(input.estado==='conseguido' && pedido.estado!=='conseguido'){
        assert.equal(input.productId,product.id);product.stockAvailable+=pedido.qty;pedido.stockPosting={skuId:product.id,quantity:pedido.qty,unit:'box'};
      }else if(input.estado!=='conseguido' && pedido.estado==='conseguido'){
        if(product.stockAvailable<pedido.qty)return json({error:'Stock insuficiente para revertir.',code:'INSUFFICIENT_STOCK'},409);
        product.stockAvailable-=pedido.qty;pedido.stockPosting=null;
      }
      Object.assign(pedido,input,{revision:pedido.revision+1});
    }
    const result=structuredClone(pedido);receipts.set(input.operationId,{request:{path,input},result});
    if(mode==='lost'){mode='ok';return json({error:'Resultado incierto del pedido.'},503);}
    if(mode==='refresh'){mode='ok';failRefresh=true;}
    return json(result,request.method()==='POST'?201:200);
  }
  return json({});
});
await page.route('http://127.0.0.1:5173/**',async(route)=>{
  const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/'))return route.fallback();
  const root=resolve('dist'),file=resolve(root,`.${path==='/'?'/index.html':path}`);if(!file.startsWith(`${root}${sep}`))return route.abort();
  try{return route.fulfill({status:200,body:await readFile(file),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
});
const statusGroup=(name)=>page.getByText(name,{exact:true}).first().locator('xpath=../..').getByRole('group',{name:'Estado del pedido'});
const retry=()=>page.getByRole('button',{name:'Reintentar cambio de pedido',exact:true});
try{
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('navigation',{name:'Navegación del panel'}).getByRole('button',{name:'Pedidos',exact:true}).click();
  await page.getByRole('button',{name:'+ Nuevo pedido',exact:true}).first().click();
  await page.getByLabel('Cliente existente').selectOption('client-order');
  await page.getByLabel(/^Producto/).selectOption(product.id);
  await page.getByLabel('Cantidad',{exact:true}).fill('3');
  mode='lost'; await page.getByRole('button',{name:'Crear pedido',exact:true}).click();
  await page.getByText('Resultado incierto del pedido.',{exact:true}).waitFor();assert.equal(pedidos.length,1);
  await page.getByRole('button',{name:'Crear pedido',exact:true}).click();
  await page.getByText('Cargar pedido manual',{exact:true}).waitFor({state:'hidden'});
  assert.deepEqual(attempts[0],attempts[1]);assert.equal(pedidos.length,1);assert.equal(product.stockAvailable,10);
  await page.getByRole('button',{name:'Todos',exact:true}).click();
  mode='refresh';const start=attempts.length;
  await statusGroup(product.name).getByRole('button',{name:'Conseguido',exact:true}).click();
  await page.getByText('No pude refrescar pedidos.',{exact:true}).first().waitFor();
  // Background hydration can now show conseguido; the retained retry must remain reachable.
  await page.waitForFunction(()=>document.querySelector('[data-estado="conseguido"][aria-pressed="true"]'),{},{timeout:12000});
  await retry().click();await retry().waitFor({state:'hidden'});
  assert.deepEqual(attempts[start],attempts[start+1]);assert.equal(product.stockAvailable,13);
  mode='lost';const exit=attempts.length;
  await statusGroup(product.name).getByRole('button',{name:'Pendiente',exact:true}).click();
  await retry().waitFor();await retry().click();await retry().waitFor({state:'hidden'});
  assert.deepEqual(attempts[exit],attempts[exit+1]);assert.equal(product.stockAvailable,10);
  mode='conflict';const conflict=attempts.length;
  await statusGroup(product.name).getByRole('button',{name:'Conseguido',exact:true}).click();await retry().waitFor();
  mode='ok';await page.getByRole('button',{name:'Revisar pedido actual',exact:true}).click();
  await statusGroup(product.name).getByRole('button',{name:'Conseguido',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-estado="conseguido"][aria-pressed="true"]'));
  assert.notEqual(attempts[conflict].input.operationId,attempts[conflict+1].input.operationId);
  assert.equal(product.stockAvailable,13);
  mode='hold';await statusGroup(product.name).getByRole('button',{name:'Pendiente',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-estado="pendiente"]')?.disabled);
  assert.equal(await page.getByRole('button',{name:'+ Nuevo pedido',exact:true}).isDisabled(),true);
  assert.equal(await statusGroup(product.name).getByRole('button',{name:'Descartado',exact:true}).isDisabled(),true);
  mode='ok';release();await page.waitForFunction(()=>document.querySelector('[data-estado="pendiente"][aria-pressed="true"]'));
  // Legacy pending order has no binding: only explicit selection authorizes an ingreso.
  pedidos.push({id:'unlinked-order',clienteId:'client-order',producto:'Pedido sin SKU',qty:2,estado:'pendiente',revision:0,productId:null,fechaPedido:new Date().toISOString()});
  await page.getByLabel('SKU para Pedido sin SKU').waitFor({timeout:12000});
  const before=attempts.length;await statusGroup('Pedido sin SKU').getByRole('button',{name:'Conseguido',exact:true}).click();
  assert.equal(attempts.length,before);
  await page.getByLabel('SKU para Pedido sin SKU').selectOption(product.id);
  await statusGroup('Pedido sin SKU').getByRole('button',{name:'Conseguido',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-estado="conseguido"][aria-pressed="true"]')).length===1);
  assert.equal(attempts.at(-1).input.productId,product.id);assert.equal(product.stockAvailable,12);
  console.log('Order UI passed: explicit SKU, create/transition applied503 retries, frozen revision after failed refresh/hydration, conflict review, reversal and in-flight controls.');
}finally{await browser.close();}
