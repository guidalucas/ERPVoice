import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const output = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const evidence = [];
async function capture(name, fullPage = true) {
  if (name.startsWith('local-') && !name.includes('-loading-')) {
    await page.getByRole('heading', { name: 'Cargando ficha…', exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('Cargando colección…', { exact: true }).waitFor({ state: 'hidden' });
    await page.waitForLoadState('networkidle');
    await page.getByText('Cargando foto…', { exact: true }).first().waitFor({ state: 'hidden' });
  }
  await page.evaluate(() => Promise.all([...document.images].map(img => img.decode().catch(() => {}))));
  await page.evaluate(() => scrollTo(0,0));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, 'screenshots', name + '.png'), fullPage });
  const metrics = await page.evaluate(() => {
    const box = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { x:r.x,y:r.y,width:r.width,height:r.height,font:s.fontFamily,size:s.fontSize,color:s.color,background:s.backgroundColor }; };
    return { width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,hero:box('.catalog-hero'),grid:box('.catalog-grid'),card:box('.catalog-card'),h1:box('h1'),preview:box('.canvas-frame'),controls:box('.story-controls'),smallTargets:[...document.querySelectorAll('button,a,input,select')].map(el=>({text:(el.innerText||el.getAttribute('aria-label')||el.name||'').slice(0,80),r:el.getBoundingClientRect()})).filter(x=>x.r.width>0&&x.r.height>0&&x.r.height<44).map(x=>({text:x.text,width:x.r.width,height:x.r.height})),brokenImages:[...document.images].filter(el=>!el.complete||el.naturalWidth===0).map(el=>el.src) };
  });
  evidence.push({ name,url:page.url(),text:await page.locator('body').innerText(),metrics });
  console.log(name);
}
try {
  const job = process.argv[2] || 'production';
  if (job === 'production') {
    const base='https://erpvoice.onrender.com/c/fullmatch-casacas';
    for(const [width,height] of [[375,812],[390,844],[430,932],[768,1024],[1440,900],[1920,1080]]) {
      await page.setViewportSize({width,height}); await page.goto(base,{waitUntil:'networkidle'}); await capture(`prod-fullmatch-home-${width}x${height}`);
    }
    const product = await page.locator('.catalog-card a').first().getAttribute('href');
    for(const [width,height] of [[390,844],[1440,900]]) {
      await page.setViewportSize({width,height}); await page.goto(new URL(product,base).href,{waitUntil:'networkidle'}); await capture(`prod-fullmatch-product-${width}x${height}`);
    }
    await page.goto(base+'/consulta',{waitUntil:'networkidle'}); await capture('prod-fullmatch-inquiry-empty-1440x900');
    await page.setViewportSize({width:390,height:844}); await page.goto(base+'?q=auditoria-sin-resultados',{waitUntil:'networkidle'}); await capture('prod-fullmatch-search-empty-390x844');
    await page.goto('https://erpvoice.onrender.com/studio.html',{waitUntil:'networkidle'}); await capture('prod-studio-access-390x844');
  } else {
    const run = await import('./jobs/'+job+'.mjs'); await run.default({browser,context,page,capture,output,evidence});
  }
} finally {
  await fs.mkdir(path.join(output,'evidence'),{recursive:true});
  await fs.writeFile(path.join(output,'evidence', (process.argv[2]||'production')+'.json'),JSON.stringify(evidence,null,2));
  await browser.close();
}
