import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser=await chromium.launch(process.platform==='win32' ? {channel:'msedge',headless:true} : {headless:true});
async function fixture() {
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],publications=[],creations=[];
  const families=[{familyId:'family-electrical-private-id',version:1,schema:{name:'Componentes',unit:'unit',allowAdditionalAttributes:false,attributes:{
    voltage:{type:'number',required:true,unit:'v',allowedStates:['known'],values:[0,12]},
    certified:{type:'boolean',required:true,allowedStates:['known'],values:[true,false]},
    length:{type:'number',required:false,unit:'mm',allowedStates:['known','unknown']},
  }}}],products=[],publishReceipts=new Map(),createReceipts=new Map();
  let mode='ok',published=0,created=0,failFamilyRead=false,failStateRead=false,release;
  let identity={phoneNumber:'5491100000000',tenantPhone:'5491100000000'};
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem('erpvoice.auth.token','family-ui');localStorage.setItem('erpvoice.auth.phoneNumber','5491100000000');});
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/auth/me') return json({...identity,role:'owner',businessName:'Family UI',businessCategory:'general',needsOnboarding:false,hasOwnBusiness:true});
    if(path==='/api/state') {
      if(failStateRead){failStateRead=false;return json({error:'Falló la lectura del inventario.'},503);}
      return json({products,clients:[],proveedores:[],pedidos:[],transactions:[]});
    }
    if(path==='/api/inventory/families'&&req.method()==='GET') {
      if(failFamilyRead){failFamilyRead=false;return json({error:'Falló la lectura de familias.'},503);}
      return json({families});
    }
    if(path==='/api/inventory/families'&&req.method()==='POST') {
      const body=req.postDataJSON();publications.push(body);
      assert.deepEqual(Object.keys(body).sort(),['expectedVersion','familyId','operationId','schema']);
      if(mode==='hold-publish') await new Promise(resolve=>{release=resolve;});
      if(mode==='publish409') return json({error:'La familia cambió.',code:'PRODUCT_SCHEMA_VERSION_MISMATCH'},409);
      if(!publishReceipts.has(body.operationId)) {
        const current=families.filter(f=>f.familyId===body.familyId).reduce((v,f)=>Math.max(v,f.version),0);
        assert.equal(body.expectedVersion,current);
        const family={familyId:body.familyId,version:current+1,schema:structuredClone(body.schema)};
        const result={operationId:body.operationId,businessId:identity.tenantPhone,status:'applied',family};
        families.push(family);publishReceipts.set(body.operationId,{body,result});published++;
      } else assert.deepEqual(body,publishReceipts.get(body.operationId).body);
      if(mode==='publish503'){mode='ok';return json({error:'Respuesta de publicación incierta.'},503);}
      if(mode==='publish-read503'){mode='ok';failFamilyRead=true;}
      return json(publishReceipts.get(body.operationId).result);
    }
    if(path==='/api/products'&&req.method()==='POST') {
      const body=req.postDataJSON();creations.push(body);
      if(mode==='hold-create') await new Promise(resolve=>{release=resolve;});
      if(!createReceipts.has(body.operationId)) {
        const {operationId,...input}=body,result={...input,id:`family-sku-${created+1}`,revision:0,identityFingerprint:'fixture-fingerprint'};
        createReceipts.set(operationId,{body,result});products.push(result);created++;
      } else assert.deepEqual(body,createReceipts.get(body.operationId).body);
      if(mode==='create503'){mode='ok';return json({error:'Respuesta de creación incierta.'},503);}
      if(mode==='create-read503'){mode='ok';failStateRead=true;}
      return json(createReceipts.get(body.operationId).result);
    }
    return json({});
  });
  await page.route('http://127.0.0.1:5173/**',async route=>{
    const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/'))return route.fallback();
    const root=resolve('dist'),file=resolve(root,`.${path==='/'?'/index.html':path}`);if(!file.startsWith(`${root}${sep}`))return route.abort();
    try{return route.fulfill({body:await readFile(file),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
  });
  const dialog=page.getByRole('dialog',{name:'Familias y atributos',exact:true});
  const button=name=>dialog.getByRole('button',{name,exact:true});
  const open=async()=>{
    await page.getByRole('navigation',{name:'Navegación del panel'}).getByRole('button',{name:'Inventario',exact:true}).click();
    await page.getByRole('button',{name:'Familias y atributos',exact:true}).click();await dialog.waitFor();
    await dialog.getByLabel('Nombre de familia',{exact:true}).waitFor();
  };
  const familyConsent=()=>dialog.getByRole('checkbox',{name:'Revisé esta familia y autorizo publicarla como una nueva versión inmutable.',exact:true});
  const skuConsent=()=>dialog.getByRole('checkbox',{name:'Revisé los datos del SKU y autorizo crearlo.',exact:true});
  const fillFamily=async()=>{
    await dialog.getByLabel('Nombre de familia',{exact:true}).fill('Herramientas');await dialog.getByLabel('Unidad base',{exact:true}).fill('box');
    const first=dialog.getByRole('group',{name:'Atributo 1',exact:true});
    await first.getByLabel('Clave',{exact:true}).fill('potencia');await first.getByLabel('Tipo',{exact:true}).selectOption('number');
    await first.getByLabel('Unidad',{exact:true}).fill('w');await first.getByLabel('Valores permitidos por línea',{exact:true}).fill('0\n12');
    await first.getByRole('checkbox',{name:'Requerido',exact:true}).check();
  };
  const fillSku=async()=>{
    await dialog.getByLabel('Familia y versión',{exact:true}).selectOption('family-electrical-private-id@1');
    await dialog.getByLabel('Nombre del SKU',{exact:true}).fill('Convertidor');
    await dialog.getByLabel('Valor de voltage',{exact:true}).selectOption('0');
    await dialog.getByLabel('Valor de certified',{exact:true}).selectOption('false');
    await dialog.getByLabel('Estado de length',{exact:true}).selectOption('unknown');
    await dialog.getByLabel('Stock disponible',{exact:true}).fill('0');await dialog.getByLabel('Stock reservado',{exact:true}).fill('0');await dialog.getByLabel('Precio',{exact:true}).fill('0');
  };
  const hold=async()=>{const deadline=Date.now()+5000;while(!release&&Date.now()<deadline)await page.waitForTimeout(20);assert.ok(release);};
  const addFamilyVersion=(familyId='family-electrical-private-id',schema={name:'Electrical version two',unit:'crate',allowAdditionalAttributes:false,attributes:{revision_marker:{type:'text',required:true,allowedStates:['known'],values:['v2']}}})=>{
    const current=families.filter(family=>family.familyId===familyId).reduce((version,family)=>Math.max(version,family.version),0);
    families.push({familyId,version:current+1,schema:structuredClone(schema)});
  };
  await page.goto('http://127.0.0.1:5173');await open();
  return {page,dialog,button,open,familyConsent,skuConsent,fillFamily,fillSku,families,publications,creations,errors,hold,
    setMode:value=>{mode=value;},release:()=>{mode='ok';release();release=undefined;},published:()=>published,created:()=>created,setIdentity:value=>{identity=value;},addFamilyVersion};
}
try {
  {
    const f=await fixture();await f.fillFamily();assert.equal(await f.button('Publicar familia').isDisabled(),true);
    await f.familyConsent().check();await f.dialog.getByLabel('Nombre de familia',{exact:true}).fill('Herramientas revisadas');assert.equal(await f.familyConsent().isChecked(),false);
    await f.familyConsent().check();f.setMode('hold-publish');await f.button('Publicar familia').evaluate(button=>{button.click();button.click();});await f.hold();assert.equal(f.publications.length,1);f.release();
    await f.dialog.getByRole('status').filter({hasText:/Publicación aplicada/}).waitFor();assert.equal(f.published(),1);assert.equal(f.publications[0].schema.attributes.potencia.values[0],0);
    assert.equal(await f.dialog.innerText().then(text=>text.includes(f.publications[0].operationId)),false);
    await f.page.reload();await f.open();await f.dialog.getByRole('status').filter({hasText:/Publicación aplicada/}).waitFor();assert.equal(f.publications.length,1);assert.deepEqual(f.errors,[]);await f.page.close();
  }
  {
    const f=await fixture();await f.fillFamily();await f.familyConsent().check();f.setMode('publish503');await f.button('Publicar familia').click();await f.dialog.getByText('Respuesta de publicación incierta.',{exact:true}).waitFor();
    assert.equal(f.published(),1);await f.page.reload();await f.open();
    const retryConsent=f.dialog.getByRole('checkbox',{name:'Confirmo que revisé y autorizo reintentar exactamente esta publicación.',exact:true});
    assert.equal(await retryConsent.isChecked(),false);await retryConsent.check();await f.button('Reintentar misma publicación').click();await f.dialog.getByRole('status').filter({hasText:/Publicación aplicada/}).waitFor();
    assert.deepEqual(f.publications[0],f.publications[1]);assert.equal(f.published(),1);await f.page.close();
  }
  {
    const f=await fixture();await f.fillSku();assert.equal(await f.button('Crear SKU').isDisabled(),true);
    const review=f.dialog.getByRole('region',{name:'Vista previa de SKU',exact:true});await review.waitFor();assert.match(await review.innerText(),/false|No/);assert.match(await review.innerText(),/Desconocido|desconocido/);
    await f.skuConsent().check();await f.dialog.getByLabel('Nombre del SKU',{exact:true}).fill('Convertidor revisado');assert.equal(await f.skuConsent().isChecked(),false);
    await f.skuConsent().check();f.setMode('hold-create');await f.button('Crear SKU').evaluate(button=>{button.click();button.click();});await f.hold();assert.equal(f.creations.length,1);f.release();
    await f.dialog.getByRole('status').filter({hasText:/SKU creado/}).waitFor();assert.equal(f.created(),1);
    assert.deepEqual(f.creations[0].family,{id:'family-electrical-private-id',version:1});assert.equal(f.creations[0].attributes.voltage.value,0);assert.equal(f.creations[0].attributes.certified.value,false);
    assert.deepEqual(f.creations[0].attributes.length,{state:'unknown',type:'number',unit:'mm'});assert.equal(f.creations[0].priceCurrency,'XXX');
    await f.page.reload();await f.open();await f.dialog.getByRole('status').filter({hasText:/SKU creado/}).waitFor();assert.equal(f.creations.length,1);assert.deepEqual(f.errors,[]);await f.page.close();
  }
  for(const mode of ['create503','create-read503']) {
    const f=await fixture();await f.fillSku();await f.skuConsent().check();f.setMode(mode);await f.button('Crear SKU').click();
    if(mode==='create503') {
      await f.dialog.getByText('Respuesta de creación incierta.',{exact:true}).waitFor();await f.page.reload();await f.open();await f.skuConsent().check();await f.button('Reintentar misma creación').click();
      assert.deepEqual(f.creations[0],f.creations[1]);
    } else {
      await f.dialog.getByText(/El SKU se creó, pero/).waitFor();await f.button('Actualizar familias e inventario').click();
    }
    await f.dialog.getByRole('status').filter({hasText:/SKU creado/}).waitFor();assert.equal(f.created(),1);assert.deepEqual(f.errors,[]);await f.page.close();
  }
  {
    const f=await fixture();await f.fillSku();await f.skuConsent().check();f.setMode('create503');await f.button('Crear SKU').click();
    await f.dialog.getByText('Respuesta de creación incierta.',{exact:true}).waitFor();assert.equal(f.created(),1);
    f.addFamilyVersion('family-electrical-private-id',{name:'Electrical version two',unit:'crate',allowAdditionalAttributes:false,attributes:{revision_marker:{type:'text',required:true,allowedStates:['known'],values:['v2']}}});
    await f.page.reload();await f.open();
    const review=f.dialog.getByRole('region',{name:'Vista previa de SKU',exact:true});await review.waitFor();
    assert.match(await review.innerText(),/Componentes v1/);assert.doesNotMatch(await review.innerText(),/Electrical version two|revision_marker/);
    await f.skuConsent().check();await f.button('Reintentar misma creación').click();
    assert.deepEqual(f.creations[0],f.creations[1]);assert.equal(f.creations[1].family.version,1);assert.equal(f.created(),1);await f.page.close();
  }
  {
    const f=await fixture();await f.dialog.getByLabel('Familia para publicar una versión nueva',{exact:true}).selectOption('family-electrical-private-id');
    await f.dialog.getByLabel('Nombre de familia',{exact:true}).fill('Family revision in progress');await f.dialog.getByLabel('Unidad base',{exact:true}).fill('unit');
    f.setMode('publish409');await f.familyConsent().check();await f.button('Publicar familia').click();
    await f.dialog.getByRole('button',{name:'Revisar respuesta y datos actuales',exact:true}).waitFor();assert.equal(f.publications.length,1);
    f.addFamilyVersion('family-electrical-private-id',{name:'Concurrent family version',unit:'pack',allowAdditionalAttributes:false,attributes:{concurrent_marker:{type:'text',required:true,allowedStates:['known'],values:['v2']}}});
    await f.dialog.getByRole('button',{name:'Revisar respuesta y datos actuales',exact:true}).click();
    await f.dialog.getByText(/Revisaste los datos actuales/).waitFor();assert.equal(f.publications.length,1);
    await f.dialog.getByLabel('Nombre de familia',{exact:true}).fill('Reviewed next version');await f.familyConsent().check();f.setMode('ok');await f.button('Publicar familia').click();
    await f.dialog.getByRole('status').filter({hasText:/Publicación aplicada/}).waitFor();assert.equal(f.publications.length,2);
    assert.equal(f.publications[0].expectedVersion,1);assert.equal(f.publications[1].expectedVersion,2);assert.equal(f.publications[1].familyId,'family-electrical-private-id');assert.notEqual(f.publications[0].operationId,f.publications[1].operationId);assert.equal(f.published(),1);await f.page.close();
  }
  {
    const f=await fixture();await f.fillFamily();await f.familyConsent().check();f.setMode('publish-read503');await f.button('Publicar familia').click();
    await f.dialog.getByRole('status').filter({hasText:/Publicación aplicada/}).waitFor();await f.dialog.getByText(/no pudimos actualizar la lista/).waitFor();
    assert.equal(f.publications.length,1);assert.equal(f.published(),1);await f.button('Actualizar familias e inventario').click();await f.dialog.getByRole('status').filter({hasText:/Publicación aplicada/}).waitFor();
    assert.equal(f.publications.length,1);assert.equal(f.published(),1);assert.deepEqual(f.errors,[]);await f.page.close();
  }
  {
    const f=await fixture();await f.fillSku();await f.dialog.getByLabel('Precio',{exact:true}).fill('0.5');await f.skuConsent().check();await f.button('Crear SKU').click();
    await f.dialog.getByRole('alert').waitFor();assert.equal(f.creations.length,0);
    await f.dialog.getByLabel('Precio',{exact:true}).fill('0');await f.dialog.getByLabel('Stock disponible',{exact:true}).fill('');await f.skuConsent().check();await f.button('Crear SKU').click();assert.equal(f.creations.length,0);await f.page.close();
  }
  for(const identity of [{phoneNumber:'5491100000001',tenantPhone:'5491100000000'},{phoneNumber:'5491100000000',tenantPhone:'5491100000001'}]) {
    const f=await fixture();await f.fillFamily();f.setIdentity(identity);await f.page.reload();await f.open();
    assert.equal(await f.dialog.getByLabel('Nombre de familia',{exact:true}).inputValue(),'');assert.equal(f.publications.length,0);await f.page.close();
  }
  console.log('Product family UI passed: complete consent, typed zero/false/unknown-unit values, immutable versions, stable retries and reload recovery, acknowledged success with read failure, validation and tenant/actor isolation.');
} finally {await browser.close();}
