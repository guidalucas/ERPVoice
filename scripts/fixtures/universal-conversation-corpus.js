// Public synthetic conversations. Golden actions describe semantics; action
// references use zero-based indexes so arbitrary model IDs cannot mask errors.
const context={businessId:'public-conversation-tests',actorId:'public-actor',internalConversationOperation:true,permissions:[
  'clients:create','suppliers:create','orders:create','accounts:charge','inventory:receive','inventory:reserve']};
const catalog={products:[],clients:[{id:'existing-client',name:'Emiliano',debt:0,accountRevision:0,metadataRevision:0}],proveedores:[],pedidos:[]};
const orderData=(extra={})=>({proveedorId:null,productType:null,productModel:null,talle:null,notas:null,productId:null,qty:1,estado:'pendiente',...extra});
const customer={type:'client.create',name:'Emiliano',notas:null};
const linkedOrder={type:'order.create',clientRef:0,order:orderData({producto:'Camiseta blanca',talle:'L'})};
const existingOrder={type:'order.create',order:orderData({clienteId:'existing-client',producto:'Camiseta blanca',talle:'L'})};
const edited=(edits,text)=>({contractVersion:1,kind:'edit',edits,evidence:edits.map(edit=>({itemId:edit.itemId??edit.action.itemId,quote:text}))});
const ready=actions=>({kind:'ready',actions});
const switchText='Me equivoqué: Emiliano ya existía. Usá el cliente guardado, sin darlo de alta otra vez.';
const addText='Agregá también dos camisetas azules talle M para Emiliano.';
const removeText='Sacá la camiseta blanca, dejá solamente las dos azules.';
const blueOrder={type:'order.create',order:orderData({clienteId:'existing-client',producto:'Camiseta azul',talle:'M',qty:2})};
const cancelText='Sacá todas las operaciones de esta propuesta, tanto el alta como el pedido.';

export const universalConversationCorpus=[
  {id:'dependency-new-client-charge',sourceText:'Creá como cliente nuevo a Cliente Nuevo y anotale 5000 de fiado.',
    expected:ready([{type:'client.create',name:'Cliente Nuevo',notas:null},{type:'account.charge',createdItem:0,amount:{value:5000,unit:'legacy-money'},reasonAnyOf:['fiado','cargo','cuenta']}])},
  {id:'dependency-new-supplier-order',sourceText:'Creá como proveedor nuevo a Textil Prueba y anotale a Emiliano un pedido pendiente de una camiseta blanca talle L con ese proveedor.',
    expected:ready([{type:'supplier.create',name:'Textil Prueba',notas:null},{...existingOrder,supplierRef:0,order:Object.fromEntries(Object.entries(existingOrder.order).filter(([key])=>key!=='proveedorId'))}])},
  {id:'dependency-new-product-reservation',sourceText:'Ingresá cinco cajas de Producto Nuevo, un producto nuevo del inventario, y reservá dos de esas mismas cajas.',
    expected:ready([{type:'stock.receive',newSku:{name:'Producto Nuevo',unit:'caja',attributes:{}},quantity:{value:5,unit:'caja'}},{type:'stock.reserve',createdItem:0,quantity:{value:2,unit:'caja'}}])},
  {id:'conversation-switch-new-to-existing-client',sourceText:'Creá como cliente nuevo a Emiliano y anotale un pedido pendiente de una camiseta blanca talle L.',
    catalog:{clients:[]},expected:ready([customer,linkedOrder]),turns:[{text:switchText,catalog,expected:ready([existingOrder]),modelResponse:edited([
      {op:'remove',itemId:'sim-item-1'},{op:'replace',itemId:'sim-item-2',action:{itemId:'sim-item-2',type:'order.create',order:{clienteId:'existing-client',producto:'Camiseta blanca',talle:'L',qty:1,estado:'pendiente'}}},
    ],switchText)}]},
  {id:'conversation-add-and-remove-order',sourceText:'Anotale a Emiliano un pedido pendiente de una camiseta blanca talle L.',expected:ready([existingOrder]),turns:[
    {text:addText,expected:ready([existingOrder,blueOrder]),modelResponse:edited([{op:'add',afterItemId:'sim-item-1',action:{itemId:'added-order',type:'order.create',order:{clienteId:'existing-client',producto:'Camiseta azul',talle:'M',qty:2,estado:'pendiente'}}}],addText)},
    {text:removeText,expected:ready([blueOrder]),modelResponse:edited([{op:'remove',itemId:'sim-item-1'}],removeText)},
  ]},
  {id:'conversation-remove-all-operations',sourceText:'Creá como cliente nuevo a Emiliano y anotale un pedido pendiente de una camiseta blanca talle L.',catalog:{clients:[]},expected:ready([customer,linkedOrder]),turns:[
    {text:cancelText,expected:{kind:'cancelled'},modelResponse:edited([{op:'remove',itemId:'sim-item-2'},{op:'remove',itemId:'sim-item-1'}],cancelText)},
  ]},
].map(fixture=>({...fixture,context,catalog:{...catalog,...fixture.catalog}}));
