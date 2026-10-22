import fs from 'node:fs/promises';
export default async function({context,page,capture,output}) {
 const s=JSON.parse(await fs.readFile(new URL('../../../.fullmatch-runtime/fixture-session.json',import.meta.url).href.replace('file:///',''),'utf8'));
 await context.addInitScript(({token,owner,origin})=>{if(location.origin===origin){localStorage.setItem('erpvoice.auth.token',token);localStorage.setItem('erpvoice.auth.phoneNumber',owner);}}, {...s,origin:new URL(s.url).origin});
 const go=async(hash='')=>{await page.goto(s.url+hash,{waitUntil:'networkidle'});};
 for(const [width,height] of [[390,844],[768,1024],[1440,900],[1920,1080]]){await page.setViewportSize({width,height});await go();await capture(`local-studio-products-${width}x${height}`);}
 await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:/02.*Pendientes/}).click();await page.waitForTimeout(350);await capture('local-studio-pending-1440x900');
 await page.getByRole('button',{name:/03.*Biblioteca/}).click();await page.waitForTimeout(350);await capture('local-studio-library-1440x900');
 await go('#/settings');await capture('local-studio-settings-1440x900');
 await page.setViewportSize({width:390,height:844});await capture('local-studio-settings-390x844');
 await page.setViewportSize({width:1440,height:900});await go('#/products/'+s.products[0].id);await capture('local-studio-editor-details-1440x900');
 console.log('EDITOR BUTTONS',await page.locator('button').allTextContents());
 for(const tab of ['Variantes','Fotografías']){const loc=page.getByRole('button',{name:tab,exact:true});if(await loc.count()){await loc.click();await page.waitForTimeout(250);await capture('local-studio-editor-'+tab.toLowerCase()+'-1440x900');}}
 await page.getByRole('button',{name:'Generar historia ↗',exact:true}).click();await capture('local-studio-story-before-1440x900');
 await page.getByRole('button',{name:'Generar previsualización',exact:true}).click();await page.locator('.canvas-frame.ready').waitFor();await capture('local-studio-story-ready-1440x900');
 await page.setViewportSize({width:390,height:844});await capture('local-studio-story-ready-390x844');
 await page.setViewportSize({width:1440,height:900});
 for(const value of ['arrival','last_unit','promo']){await page.getByLabel('Plantilla',{exact:true}).selectOption(value);await capture(`local-studio-story-template-${value}-1440x900`);}
 await go();await page.getByRole('button',{name:'＋ Nueva ficha comercial',exact:true}).click();await capture('local-studio-editor-new-1440x900');
 await page.getByLabel('Título comercial',{exact:true}).fill('Producto de prueba con título comercial extenso para revisar jerarquía, saltos de línea y legibilidad');await capture('local-studio-editor-unsaved-long-title-1440x900');
 await go();await page.getByLabel('Buscar productos',{exact:true}).fill('auditoria-sin-resultados');await page.getByRole('button',{name:'Buscar',exact:true}).click();await page.waitForTimeout(300);await capture('local-studio-search-empty-1440x900');
 await page.route('**/api/commerce/v1/products?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'AUDIT_LOCAL_SIMULATED_ERROR'})}));await go();await capture('local-studio-error-simulated-1440x900');
}
