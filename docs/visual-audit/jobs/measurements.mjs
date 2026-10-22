import fs from 'node:fs/promises';
export default async function({context,page,capture,evidence,output}){
 const s=JSON.parse(await fs.readFile(new URL('../../../.fullmatch-runtime/fixture-session.json',import.meta.url),'utf8'));
 await context.addInitScript(({token,owner,origin})=>{if(location.origin===origin){localStorage.setItem('erpvoice.auth.token',token);localStorage.setItem('erpvoice.auth.phoneNumber',owner);}}, {...s,origin:new URL(s.url).origin});
 await page.goto(s.url+'#/products/'+s.products[0].id,{waitUntil:'networkidle'});await page.getByRole('button',{name:'Generar historia ↗'}).click();await page.getByRole('button',{name:'Generar previsualización',exact:true}).click();await page.locator('.canvas-frame.ready').waitFor();await page.evaluate(()=>scrollTo(0,0));await capture('local-story-initial-viewport-1440x900',false);
 await page.setViewportSize({width:390,height:844});await capture('local-story-initial-viewport-390x844',false);
 await page.getByLabel('Mensaje secundario',{exact:true}).fill('Texto de prueba');await capture('local-story-edited-invalidated-390x844');
 await page.setViewportSize({width:1440,height:900});await page.goto(s.url+'#/settings',{waitUntil:'networkidle'});await page.getByLabel('Diseño del catálogo · opcional').selectOption('editorial');await capture('local-preset-preview-editorial-unsaved-1440x900');
 await page.goto(s.url,{waitUntil:'networkidle'});await page.getByRole('button',{name:/Pendientes/}).hover();await capture('local-studio-navigation-hover-1440x900',false);
 await page.setViewportSize({width:390,height:844});await page.goto(s.url,{waitUntil:'networkidle'});await page.getByLabel('Buscar productos',{exact:true}).focus();await capture('local-studio-search-focus-390x844',false);
 const samples=await page.locator('.control-help,.brand,.status,.card-body h3,.card-bottom strong,.filters input,.filters select,.sidebar nav button,.collection-stats').evaluateAll(els=>els.map(el=>{const st=getComputedStyle(el),r=el.getBoundingClientRect();return {text:el.textContent?.slice(0,100),font:st.fontFamily,size:st.fontSize,color:st.color,background:st.backgroundColor,width:r.width,height:r.height};}));
 evidence.push({name:'studio-type-samples',samples});
 const base='https://erpvoice.onrender.com/c/fullmatch-casacas';await page.goto(base+'/p/auditoria-inexistente',{waitUntil:'networkidle'});await capture('prod-public-product-error404-390x844');
 await page.goto('https://erpvoice.onrender.com/studio/',{waitUntil:'networkidle'});await capture('prod-studio-route-access-390x844');
 await page.goto(base,{waitUntil:'networkidle'});evidence.push({name:'production-hero-structure',html:await page.locator('.catalog-hero').evaluate(el=>el.outerHTML),fonts:await page.evaluate(()=>[...document.fonts].map(f=>({family:f.family,status:f.status}))),type:await page.locator('.catalog-card h2,.product-meta,.catalog-card strong').evaluateAll(es=>es.map(e=>({text:e.textContent,size:getComputedStyle(e).fontSize,color:getComputedStyle(e).color})))});
}
