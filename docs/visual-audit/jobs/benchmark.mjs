export default async function({page,capture,evidence}) {
 const sources=[
 ['nike-list','https://www.nike.com/es/w/zapatillas-6xge1za99xszy7ok'],
 ['zara-home','https://www.zara.com/es/'],
 ['adidas-home','https://www.adidas.es/'],
 ['leroy-home','https://www.leroymerlin.es/'],
 ['homedepot-home','https://www.homedepot.com/'],
 ['carrefour-home','https://www.carrefour.com.ar/'],
 ['shopify-media-doc','https://help.shopify.com/en/manual/products/product-media/add-media'],
 ['tiendanube-design-doc','https://ayuda.tiendanube.com/diseno/guia-personalizar-el-diseno-de-tu-tiendanube'],
 ['woocommerce-products-doc','https://woocommerce.com/document/managing-products/'],
 ['wix-options-doc','https://support.wix.com/en/article/wix-stores-adding-product-options'],
 ['linear-home','https://linear.app/'],
 ];
 for(const [name,url] of sources){try{
  await page.setViewportSize({width:1440,height:900});await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});await page.waitForTimeout(1800);await capture('ref-'+name+'-1440x900',false);
  console.log(name,(await page.locator('body').innerText()).slice(0,250));
  if(['nike-list','leroy-home','carrefour-home'].includes(name)){await page.setViewportSize({width:390,height:844});await capture('ref-'+name+'-390x844',false);}
 }catch(error){evidence.push({name,url,error:error.message.slice(0,300)});console.log('LIMITATION',name,error.message.slice(0,80));}}
}
