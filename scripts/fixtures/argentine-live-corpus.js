// Synthetic customers and garments; production inventory is supplied separately.
export const garments = [
  ['remera-l','Remera oversize negra','Remera','Oversize negra','L',8,0,25000],
  ['remera-m','Remera oversize negra','Remera','Oversize negra','M',5,0,25000],
  ['short-m','Short running azul','Short','Running azul','M',7,0,22000],
  ['short-l','Short running azul','Short','Running azul','L',6,0,22000],
  ['buzo-xl','Buzo frisa gris','Buzo','Frisa gris','XL',6,0,45000],
  ['campera-m','Campera rompeviento negra','Campera','Rompeviento negra','M',4,0,48000],
  ['cargo-42','Pantalón cargo verde','Pantalón','Cargo verde','42',5,0,42000],
  ['cargo-44','Pantalón cargo verde','Pantalón','Cargo verde','44',3,0,42000],
  ['musculosa-s','Musculosa deportiva blanca','Musculosa','Deportiva blanca','S',5,0,18000],
  ['calza-m','Calza ciclista negra','Calza','Ciclista negra','M',6,0,20000],
  ['camiseta-l','Camiseta Barrio Norte titular 2026','Camiseta','Barrio Norte titular 2026','L',3,0,65000],
].map(([key,name,productType,productModel,size,stockAvailable,stockReserved,price])=>({key,name,productType,productModel,size,stockAvailable,stockReserved,price,priceCurrency:'ARS',unit:'unit'}));

export const sectorProducts = [
  ['tornillo-6','Tornillo zincado','Tornillo','Zincado','6 mm','kg',10,4500],
  ['tornillo-8','Tornillo zincado','Tornillo','Zincado','8 mm','kg',8,5200],
  ['cable-25','Cable unipolar 2,5 mm²','Cable','Unipolar','2,5 mm²','metro',100,1400],
  ['cinta-48','Cinta de embalar transparente 48 mm','Cinta','Transparente','48 mm','rollo',10,1800],
  ['agua-15','Agua mineral sin gas 1,5 litros','Bebida','Agua mineral sin gas','1,5 litros','botella',24,1500],
  ['gaseosa-225','Gaseosa cola 2,25 litros','Bebida','Cola','2,25 litros','botella',12,3500],
  ['yerba-500','Yerba suave 500 gramos','Yerba','Suave','500 gramos','paquete',15,2800],
  ['alfajor-triple','Alfajor triple de chocolate','Alfajor','Triple chocolate','','unit',30,1600],
].map(([key,name,productType,productModel,size,unit,stockAvailable,price])=>({key,name,productType,productModel,size,unit,stockAvailable,stockReserved:0,price,priceCurrency:'ARS'}));

export const testProducts = [...garments,...sectorProducts];

export function argentineCases(ids, productionProduct) {
  const receive=(key,quantity)=>({type:'stock.receive',key,quantity});
  const sell=(key,quantity,salePrice)=>({type:'stock.sell',key,quantity,...(salePrice===undefined?{}:{salePrice})});
  const ready=(id,category,text,actions,extra={})=>({id,category,text,expected:{kind:'ready',actions},...extra});
  const cases=[
    ready('01-remeras-coloquial','Ingreso','Che, entraron tres remeras oversize negras talle L. Sumalas nomás.',[receive('remera-l',3)]),
    ready('02-short-y-buzo','Ingreso','Me llegaron 2 shorts running azules M y 1 buzo frisa gris XL, metelos al stock.',[receive('short-m',2),receive('buzo-xl',1)]),
    ready('03-polleras-y-tops-nuevos','Productos nuevos','Cargame como productos nuevos dos polleras plisadas beige talle 2 y tres tops acanalados chocolate talle único. Las polleras van a 32 lucas pesos argentinos y los tops a 18 lucas pesos argentinos.',[
      {type:'new',quantity:2,terms:['poller','plisad','beige'],size:'2',price:32000},
      {type:'new',quantity:3,terms:['top','acanalad','chocolate'],size:'único',price:18000},
    ]),
    ready('04-campera-jean','Productos nuevos','Agregá al inventario una campera de jean nueva, azul, talle S, a 58.500 pesos argentinos.',[
      {type:'new',quantity:1,terms:['campera','jean','azul'],size:'S',price:58500},
    ]),
    ready('05-medias-por-par','Productos nuevos','Entraron 4 pares de medias lisas negras talle único, nuevas, y cada par sale 4 lucas pesos argentinos. Cargalas al stock.',[
      {type:'new',quantity:4,terms:['media','negra'],size:'único',price:4000,units:['par','pares','pair','pairs']},
    ]),
    ready('06-venta-lucas','Venta','Se fueron dos remeras oversize negras L, cobré 25 lucas pesos argentinos cada una. Registrá la venta.',[sell('remera-l',2,25000)]),
    ready('07-reserva-sin-venta','Reserva','Guardame un short running azul talle M para mañana. Reservalo nomás, todavía no lo vendí.',[{type:'stock.reserve',key:'short-m',quantity:1}]),
    ready('08-fiado-mica','Cuenta corriente','A Mica Rojas anotale 35 lucas en la cuenta por las prendas que se llevó fiadas.',[{type:'account.charge',client:'mica',amount:35000}]),
    ready('09-pago-bauti','Cuenta corriente','Bauti Pérez me pasó 12 lucas, descontáselas de lo que debe.',[{type:'account.payment',client:'bauti',amount:12000}]),
    ready('10-venta-y-fiado','Operación mixta','Se vendió una campera rompeviento negra M y a Mica Rojas sumale 48 lucas que quedó debiendo.',[sell('campera-m',1),{type:'account.charge',client:'mica',amount:48000}]),
    ready('11-pedido-cargo','Pedido','Anotale a Bauti Pérez un pedido de dos pantalones cargo verdes talle 44 con Textil Sur; dejalo pendiente.',[
      {type:'order.create',client:'bauti',supplier:'textil',quantity:2,size:'44',terms:['cargo'],estado:'pendiente'},
    ]),
    ready('12-corregir-pedido','Pedido','El pedido pendiente de Mica Rojas por la calza ciclista negra M dejalo en tres, que me pidió dos más.',[{type:'order.update',order:'calza',changes:{qty:3}}]),
    {id:'13-consulta-variantes',category:'Consulta',text:'¿Cuántas remeras oversize negras talle L me quedan? Decime también las M.',expected:{kind:'answer',queryTypes:['inventory.query'],productKeys:['remera-l','remera-m']}},
    {id:'14-venta-ambigua-y-respuesta',category:'Aclaración',text:'Vendí una remera oversize negra.',expected:{kind:'clarification'},reply:'La L',finalExpected:{kind:'ready',actions:[sell('remera-l',1)]}},
    {id:'15-talle-para-grupo',category:'Aclaración grupal',text:'Entraron dos shorts running azules y dos remeras oversize negras. Sumalos al stock.',expected:{kind:'clarification'},reply:'talle L',finalExpected:{kind:'ready',actions:[receive('short-l',2),receive('remera-l',2)]}},
    {id:'16-conservar-talle-previo',category:'Aclaración parcial',text:'Sumá una remera oversize negra M y un short running azul.',expected:{kind:'clarification'},reply:'La L',finalExpected:{kind:'ready',actions:[receive('remera-m',1),receive('short-l',1)]}},
    ready('17-rectificar-cantidad','Corrección','Vendí dos buzos frisa grises XL.',[sell('buzo-xl',2)],{reply:'Pará, fue uno solo. Me confundí.',finalExpected:{kind:'ready',actions:[sell('buzo-xl',1)]}}),
    ready('18-no-pedir-precio-opcional','Ingreso','Me llegaron dos musculosas deportivas blancas S y no sé a cuánto venderlas todavía. Sumalas.',[receive('musculosa-s',2)]),
    ready('19-precio-cero','Precio','La calza ciclista negra M va gratis en la promo, dejale el precio en cero pesos argentinos.',[{type:'sku.update',key:'calza-m',changes:{price:0,priceCurrency:'ARS'}}]),
    ready('20-stock-insuficiente','Validación','Vendí 99 camisetas Barrio Norte titular 2026 talle L.',[sell('camiseta-l',99)],{executionError:'INSUFFICIENT_STOCK'}),
    ready('21-mixta-sin-stock-atomica','Atomicidad','Vendí 99 camisetas Barrio Norte titular 2026 talle L y a Mica Rojas sumale 5 lucas a su cuenta por esa compra fiada.',[sell('camiseta-l',99),{type:'account.charge',client:'mica',amount:5000}],{executionError:'INSUFFICIENT_STOCK'}),
    ready('22-alta-clienta','Cliente','Dame de alta a Cami Fernández como clienta, dejá anotado que retira por el local.',[{type:'client.create',name:'Cami Fernández',noteTerms:['retira','local']}]),
    ready('23-cancelar-carga','Cancelación','Che, entraron tres remeras oversize negras talle L.',[receive('remera-l',3)],{cancel:true}),
  ];
  if(productionProduct) cases.push({id:'24-consulta-catalogo-produccion',category:'Catálogo real',text:`Decime cuánto stock disponible y reservado tengo del producto "${productionProduct.name}"${productionProduct.size?`, talle ${productionProduct.size}`:''}.`,expected:{kind:'answer',queryTypes:['inventory.query'],productionProductId:productionProduct.id}});
  cases.push(
    ready('25-ferreteria-cable-metros','Ferretería · ingreso','Che, llegaron siete metros de cable unipolar de 2,5 mm². Sumalos al stock.',[{...receive('cable-25',7),unit:'metro'}]),
    ready('26-ferreteria-tornillos-kilos','Ferretería · venta','Vendí dos kilos de tornillos zincados de 6 mm, sin anotar precio por ahora.',[{...sell('tornillo-6',2),unit:'kg'}]),
    ready('27-ferreteria-cajas-nuevas','Ferretería · alta','Cargá como producto nuevo 4 cajas de tarugos de nylon de 8 mm. Cada caja va a 12 lucas pesos argentinos.',[{type:'new',quantity:4,terms:['tarugo','nylon','8'],units:['caja'],price:12000}]),
    {id:'28-ferreteria-aclarar-medida',category:'Ferretería · aclaración',text:'Sumá dos kilos de tornillos zincados.',expected:{kind:'clarification'},reply:'Los de 8 mm',finalExpected:{kind:'ready',actions:[{...receive('tornillo-8',2),unit:'kg'}]}},
    ready('29-ferreteria-merma','Ferretería · merma','Sacá del stock dos rollos de cinta de embalar transparente de 48 mm porque se arruinaron con el agua. No fue una venta.',[{type:'stock.withdraw',key:'cinta-48',quantity:2,unit:'rollo'}]),
    ready('30-kiosco-yerba-paquetes','Kiosco · ingreso','Me dejaron cinco paquetes de yerba suave de medio kilo. Cargalos al stock.',[{...receive('yerba-500',5),unit:'paquete'}]),
    ready('31-kiosco-venta-botellas','Kiosco · venta','Se vendieron tres botellas de agua mineral sin gas de un litro y medio, a 1.500 pesos argentinos cada una.',[{...sell('agua-15',3,1500),unit:'botella'}]),
    ready('32-kiosco-caramelos-nuevos','Kiosco · alta','Dame de alta dos cajas de caramelos frutales, producto nuevo. Las vendo a 3 lucas pesos argentinos la caja.',[{type:'new',quantity:2,terms:['caramelo','frutal'],units:['caja'],price:3000}]),
    ready('33-kiosco-rollback-cargo-previo','Kiosco · atomicidad','A Mica Rojas sumale 5 lucas a su cuenta y registrá la venta de 99 botellas de gaseosa cola de 2,25 litros.',[{type:'account.charge',client:'mica',amount:5000},{...sell('gaseosa-225',99),unit:'botella'}],{executionError:'INSUFFICIENT_STOCK'}),
    ready('34-kiosco-ingreso-mixto','Kiosco · varias unidades','Ingresá dos paquetes de yerba suave de 500 gramos y seis alfajores triples de chocolate.',[{...receive('yerba-500',2),unit:'paquete'},receive('alfajor-triple',6)]),
    {id:'35-kiosco-consulta-bebidas',category:'Kiosco · consulta',text:'¿Cuántas botellas me quedan de agua mineral sin gas de 1,5 litros y de gaseosa cola de 2,25 litros?',expected:{kind:'answer',queryTypes:['inventory.query'],productKeys:['agua-15','gaseosa-225']}},
    {id:'36-kiosco-no-inventar-conversion',category:'Kiosco · unidad ambigua',text:'Vendí una caja de agua mineral sin gas de 1,5 litros. Registrala.',expected:{kind:'clarification'}},
    ready('37-almacen-alta-sin-precio','Almacén · alta sin precio','Dame de alta 3 paquetes nuevos de fideos tirabuzón marca Molino Chico, todavía no tengo el precio de venta.',[{type:'new',quantity:3,terms:['fideo','tirabuz','molino','chico'],units:['paquete']}]),
    ready('38-ferreteria-corregir-cantidad','Ferretería · corrección','Vendí diez metros de cable unipolar de 2,5 mm².',[{...sell('cable-25',10),unit:'metro'}],{reply:'Pará, fueron ocho metros, corregilo.',finalExpected:{kind:'ready',actions:[{...sell('cable-25',8),unit:'metro'}]}}),
  );
  return cases.map(test=>({...test,ids}));
}
