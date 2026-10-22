import fs from 'node:fs/promises';import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
export default async function({context,page,capture,evidence}){
 const s=JSON.parse(await fs.readFile(new URL('../../../.fullmatch-runtime/fixture-session.json',import.meta.url),'utf8'));
 const base=new URL(s.url).origin;
 const api=async(route,method='GET',body,type='application/json')=>{const r=await fetch(base+'/api/commerce/v1'+route,{method,headers:{Authorization:'Bearer '+s.token,'Content-Type':type},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw Error(route+' '+JSON.stringify(v));return v;};
 await context.addInitScript(({token,owner,origin})=>{if(location.origin===origin){localStorage.setItem('erpvoice.auth.token',token);localStorage.setItem('erpvoice.auth.phoneNumber',owner);}}, {...s,origin:base});
 const profile=await api('/profile');
 try{
 const bytes=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#d8e6e3"/><rect x="60" y="60" width="1480" height="780" fill="none" stroke="#496b64" stroke-width="8"/><text x="800" y="450" font-family="Arial" font-size="60" text-anchor="middle" fill="#31554c">PORTADA DE PRUEBA · 1600 × 900</text></svg>')).png().toBuffer();
 const asset=await api('/brand-assets/cover','POST',bytes,'image/png');
 await api('/profile','PUT',{operationId:randomUUID(),expectedRevision:profile.revision,brandName:profile.brandName,salesWhatsapp:profile.salesWhatsapp,appearance:{...profile.appearance,coverId:asset.id,primaryColor:'#001A4D',accentColor:'#FFFF00',preset:'technical'}});
 await page.goto(s.url+'#/settings',{waitUntil:'networkidle'});await capture('local-branding-cover-preview-1440x900');
 const p=await page.locator('.preview-cta').evaluate(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}));
 await page.goto(base+'/c/fullmatch-demo',{waitUntil:'networkidle'});await capture('local-branding-cover-public-1440x900');const q=await page.locator('.catalog-hero .primary').evaluate(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}));evidence.push({name:'preview-public-accent-colors',preview:p,public:q});
 await page.setViewportSize({width:390,height:844});await capture('local-branding-cover-public-390x844');
 }finally{const p=await api('/profile');await api('/profile','PUT',{operationId:randomUUID(),expectedRevision:p.revision,brandName:p.brandName,salesWhatsapp:p.salesWhatsapp,appearance:profile.appearance});}
 await page.setViewportSize({width:1440,height:900});await page.goto(s.url+'#/products/'+s.products[0].id,{waitUntil:'networkidle'});await page.getByRole('button',{name:'Generar historia ↗'}).click();
 const help=await page.locator('.control-help').first().evaluate(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,font:getComputedStyle(e).fontSize}));
 const btn=page.getByRole('button',{name:'Generar previsualización',exact:true});const normal=await btn.evaluate(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,font:getComputedStyle(e).fontSize}));await btn.hover();await page.waitForTimeout(300);const hover=await btn.evaluate(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}));evidence.push({name:'studio-help-and-action-colors',help,normal,hover});await capture('local-story-action-hover-1440x900');
}
