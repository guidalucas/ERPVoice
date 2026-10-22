import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {Client} from 'pg';
import {startCommerceFixture} from '../../../scripts/fullmatch/fixtureRuntime.js';
import {inventoryRowToProduct} from '../../../server/inventoryPostgres.js';
import {inventoryProductFingerprint} from '../../../server/inventoryOperations.js';
export default async function({context,page,capture,evidence}) {
 const f=await startCommerceFixture(),sql=new Client({connectionString:f.connection});
 const api=async(s,route,method='GET',body,type='application/json')=>{const r=await fetch(f.apiUrl+'/api/commerce/v1'+route,{method,headers:{Authorization:'Bearer '+s.token,'Content-Type':type},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw Error(route+' '+JSON.stringify(v));return v;};
 const auth=async(s)=>{await context.addInitScript(({token,owner,origin})=>{if(location.origin===origin){localStorage.setItem('erpvoice.auth.token',token);localStorage.setItem('erpvoice.auth.phoneNumber',owner);}}, {...s,origin:new URL(f.url).origin});};
 try{
 await sql.connect();
 const shops=[{...f,slug:'fullmatch-demo',preset:'editorial',kind:'indumentaria',products:f.products},
 {...f.freshOwners[0],slug:'ferreteria-fixture',preset:'technical',kind:'ferreteria',title:'Ferretería · PRUEBA',names:['Taladro percutor profesional de 650 W con maletín, accesorios y selector de velocidad','Broca de acero 8 mm','Tornillo sin fotografía','Llave agotada'],spec:{potencia:{state:'known',type:'number',value:650,unit:'w'}},unit:'unit'},
 {...f.freshOwners[1],slug:'kiosco-fixture',preset:'local',kind:'kiosco',title:'Kiosco · PRUEBA',names:['Agua mineral 500 ml','Agua pack de seis botellas','Galletitas sin fotografía','Bebida sin stock'],spec:{presentacion:{state:'known',type:'text',value:'6 × 500 ml'}},unit:'pack'}];
 const art=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#e6e9ee"/><text x="300" y="380" text-anchor="middle" font-family="Arial" font-size="28" fill="#465568">IMAGEN DE PRUEBA</text><text x="300" y="430" text-anchor="middle" font-family="Arial" font-size="20" fill="#465568">FIXTURE AISLADO</text></svg>')).png().toBuffer();
 for(const s of shops){
 if(s.names){await api(s,'/setup','POST',{operationId:randomUUID(),expectedProfileRevision:0,expectedPolicyRevision:0,brandName:s.title,salesWhatsapp:s.owner,currency:'UYU',confirmedMajorInteger:true});await sql.query('UPDATE auth_users SET business_category=$2 WHERE phone_number=$1',[s.owner,s.kind]);await api(s,'/catalog','PUT',{operationId:randomUUID(),expectedRevision:0,slug:s.slug,publicEnabled:true});s.products=[];
 for(const [i,name] of s.names.entries()){
 const row=(await sql.query('INSERT INTO products(id,owner_phone,name,product_type,stock_available,price,price_currency,inventory_unit,attributes_json) VALUES($1,$2,$3,$4,$5,$6,\'UYU\',$7,$8::jsonb) RETURNING *',[randomUUID(),s.owner,name,s.kind==='kiosco'?'Bebidas':'Herramientas',i===3?0:3,i===0?123456789:150,s.unit,JSON.stringify(s.spec)])).rows[0];
 const sku=inventoryRowToProduct(row);let p=(await api(s,'/products','POST',{operationId:randomUUID(),product:{title:name,description:'Producto y datos ficticios en base temporal aislada para auditoría visual.'},skuLinks:[{skuId:sku.id,expectedRevision:sku.revision,expectedFingerprint:inventoryProductFingerprint(sku)}]})).result;
 if(i<2){const img=(await api(s,`/products/${p.id}/images`,'POST',{operationId:randomUUID(),expectedRevision:p.revision,sourceSha256:createHash('sha256').update(art).digest('hex'),sourceSizeBytes:art.length,altText:'Imagen de prueba aislada'})).result;p=await api(s,`/products/${p.id}/images/${img.imageId}/content`,'PUT',art,'image/png');}
 p=(await api(s,`/products/${p.id}/status`,'POST',{operationId:randomUUID(),expectedRevision:p.revision,status:'ready',reason:'Auditoría en fixture descartable'})).result;
 await api(s,`/products/${p.id}/publication`,'PUT',{operationId:randomUUID(),expectedRevision:0,expectedProductRevision:p.revision,status:'published',reason:'Fixture local'});s.products.push(p);
 }}
 const profile=await api(s,'/profile');await api(s,'/profile','PUT',{operationId:randomUUID(),expectedRevision:profile.revision,brandName:profile.brandName,salesWhatsapp:profile.salesWhatsapp,appearance:{...profile.appearance,preset:s.preset}});
 for(const [width,height] of [[390,844],[1440,900]]){await page.setViewportSize({width,height});await page.goto(f.apiUrl+'/c/'+s.slug,{waitUntil:'networkidle'});await capture(`local-${s.kind}-${s.preset}-catalog-${width}x${height}`);await page.locator('.catalog-card a').first().click();await page.waitForLoadState('networkidle');await capture(`local-${s.kind}-${s.preset}-product-${width}x${height}`);}
 if(s.names){await page.goto(f.apiUrl+'/c/'+s.slug,{waitUntil:'networkidle'});await page.locator('.catalog-card a').filter({hasText:s.names[2]}).click();await page.waitForLoadState('networkidle');await capture(`local-${s.kind}-no-photo-product-1440x900`);await page.goto(f.apiUrl+'/c/'+s.slug,{waitUntil:'networkidle'});await page.locator('.catalog-card a').filter({hasText:s.names[3]}).click();await page.waitForLoadState('networkidle');await capture(`local-${s.kind}-soldout-product-1440x900`);}
 await auth(s);await page.goto(f.url,{waitUntil:'networkidle'});await capture(`local-${s.kind}-studio-1440x900`);await page.goto(f.url+'#/products/'+s.products[0].id,{waitUntil:'networkidle'});await capture(`local-${s.kind}-editor-1440x900`);
 if(s.kind!=='indumentaria'){await page.getByRole('button',{name:'Generar historia ↗',exact:true}).click();await page.getByRole('button',{name:'Generar previsualización',exact:true}).click();await page.locator('.canvas-frame.ready').waitFor();await capture(`local-${s.kind}-story-1440x900`);}
 }
 const s=shops[1];
 for(const preset of ['classic','editorial','technical','local']){const p=await api(s,'/profile');await api(s,'/profile','PUT',{operationId:randomUUID(),expectedRevision:p.revision,brandName:p.brandName,salesWhatsapp:p.salesWhatsapp,appearance:{...p.appearance,preset}});await page.goto(f.apiUrl+'/c/'+s.slug,{waitUntil:'networkidle'});await capture(`local-same-content-preset-${preset}-1440x900`);}
 for(const [name,primaryColor,accentColor] of [['light','#FFFFFF','#FFFF00'],['dark','#111111','#222222']]){const p=await api(s,'/profile');await api(s,'/profile','PUT',{operationId:randomUUID(),expectedRevision:p.revision,brandName:p.brandName,salesWhatsapp:p.salesWhatsapp,appearance:{...p.appearance,primaryColor,accentColor}});await page.goto(f.apiUrl+'/c/'+s.slug,{waitUntil:'networkidle'});await capture(`local-custom-colors-${name}-1440x900`);}
 }finally{await sql.end().catch(()=>{});await f.stop();}
}
