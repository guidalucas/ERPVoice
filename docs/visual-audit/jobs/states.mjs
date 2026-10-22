import fs from 'node:fs/promises';
export default async function({context,page,capture,evidence}){
 const s=JSON.parse(await fs.readFile(new URL('../../../.fullmatch-runtime/fixture-session.json',import.meta.url),'utf8'));
 await context.addInitScript(({token,owner,origin})=>{if(location.origin===origin){localStorage.setItem('erpvoice.auth.token',token);localStorage.setItem('erpvoice.auth.phoneNumber',owner);}}, {...s,origin:new URL(s.url).origin});
 await page.goto(s.url+'#/products/'+s.products[0].id,{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'02 SKU vinculados',exact:true}).click();await capture('local-studio-editor-skus-1440x900');
 await page.getByRole('button',{name:'03 Fotografías',exact:true}).click();await capture('local-studio-editor-photos-1440x900');
 await page.getByText('Descripción y enfoque',{exact:true}).click();await capture('local-studio-photo-details-1440x900');
 await page.setViewportSize({width:390,height:844});await capture('local-studio-editor-photos-390x844');
 await page.goto(s.url,{waitUntil:'networkidle'});await page.getByRole('button',{name:/Pendientes/}).click();await page.waitForTimeout(250);await capture('local-studio-pending-390x844');
 await page.setViewportSize({width:1440,height:900});await page.goto(s.url+'#/batch',{waitUntil:'networkidle'});await capture('local-studio-batch-empty-1440x900');
 await page.goto(s.url,{waitUntil:'networkidle'});await page.getByRole('button',{name:'Recuperar intentos',exact:true}).first().click();await capture('local-studio-recovery-empty-1440x900');
 await page.getByRole('button',{name:'Cerrar sesión',exact:true}).first().click();await page.getByRole('heading',{name:'Entrá a Studio'}).waitFor();await capture('local-studio-login-1440x900');await page.setViewportSize({width:390,height:844});await capture('local-studio-login-390x844');
 const base='https://erpvoice.onrender.com/c/fullmatch-casacas';await page.goto(base,{waitUntil:'networkidle'});await page.locator('.catalog-filters input').focus();await capture('prod-public-search-focus-390x844');
 await page.locator('.catalog-filters select[name=team]').selectOption({index:1});await page.locator('.catalog-filters button').click();await page.waitForLoadState('networkidle');await capture('prod-public-filter-active-390x844');
 await page.locator('.catalog-card a').first().click();await page.waitForLoadState('networkidle');await page.locator('[data-add-inquiry] select').selectOption({index:1});await page.locator('[data-add-inquiry] button').click();await capture('prod-public-product-added-390x844');
 await page.goto(base+'/consulta',{waitUntil:'networkidle'});await capture('prod-public-inquiry-filled-390x844');
 await page.setViewportSize({width:1440,height:900});await page.goto(base,{waitUntil:'networkidle'});await page.locator('.catalog-card a').first().hover();await capture('prod-public-card-hover-1440x900');
 await page.goto(base+'/producto-auditoria-inexistente',{waitUntil:'networkidle'});await capture('prod-public-error404-1440x900');
}
