// Presentation of a normalized proposal and its backend snapshot. This module
// neither predicts effects nor resolves identities or authorizes execution.
import { InventoryOperationError } from './inventoryOperations.js';

/** A review must cover every normalized action exactly once, in plan order. */
export function validateUniversalOperationReview(plan, review) {
  const invalid = () => { throw new InventoryOperationError('INVALID_DRAFT_REQUEST','La revisión completa de la operación no es válida.'); };
  if (!plan || !Array.isArray(plan.actions) || !plan.actions.length || !Array.isArray(review)) invalid();
  const ids=plan.actions.map(action=>action?.itemId);
  if (ids.some(id=>typeof id!=='string' || !id) || new Set(ids).size!==ids.length || review.length!==ids.length) invalid();
  for (let index=0;index<review.length;index++) {
    const item=review[index];
    if (!item || typeof item!=='object' || item.itemId!==ids[index]
      || typeof item.title!=='string' || !item.title.trim() || !Array.isArray(item.details)
      || item.details.some(line=>typeof line!=='string' || !line.trim())) invalid();
  }
  return review;
}

const labels={name:'Nombre',productType:'Tipo',productModel:'Modelo',size:'Variante',talle:'Variante',unit:'Unidad',
  price:'Precio',priceCurrency:'Moneda',notas:'Notas',producto:'Descripción',qty:'Cantidad',estado:'Estado',
  clienteId:'Cliente',proveedorId:'Proveedor',productId:'Producto',reason:'Motivo',available:'Disponible',reserved:'Reservado',
  quantity:'Cantidad ya incorporada',confirmed:'Declaración de stock histórico revisada'};
const verbs={'stock.receive':'Ingreso de existencias','stock.sell':'Venta','stock.reserve':'Reserva','stock.withdraw':'Retiro de existencias',
  'stock.adjust':'Ajuste de existencias','sku.create':'Alta de producto','sku.update':'Cambio de producto','sku.deactivate':'Baja de producto',
  'account.charge':'Cargo a cuenta','account.payment':'Pago recibido','account.adjust':'Ajuste de saldo','account.transfer':'Transferencia de saldo',
  'client.create':'Alta de cliente','client.update':'Cambio de cliente','client.delete':'Baja de cliente',
  'supplier.create':'Alta de proveedor','supplier.update':'Cambio de proveedor','supplier.delete':'Baja de proveedor','supplier.merge':'Unión de proveedores',
  'order.create':'Alta de pedido','order.update':'Cambio de pedido','order.delete':'Baja de pedido','order.reconcile':'Conciliación de pedido histórico'};
const valueText=value=>value===null ? 'Sin valor' : typeof value==='boolean' ? value ? 'Sí' : 'No' : String(value);
const attributeLines=attributes=>Object.entries(attributes).map(([key,value])=>`${key}: ${value.state==='known' ? valueText(value.value) : ({unknown:'Desconocido',not_applicable:'No corresponde',missing:'Falta informar'}[value.state])}${value.unit ? ` ${value.unit}` : ''} (${value.type})`);
export function buildUniversalOperationReview(plan,catalog) {
  const maps=Object.fromEntries(['products','clients','proveedores','pedidos'].map(key=>[key,new Map(catalog[key].map(row=>[row.id,row]))]));
  const refs={clienteId:'clients',proveedorId:'proveedores',productId:'products'};
  const fields=(input)=>Object.entries(input).flatMap(([key,value])=>{
    if (key==='family') {
      const definition=catalog.familySchemas?.find(row=>row.familyId===value.id && row.version===value.version);
      return [`Familia: ${definition?.schema.name ?? value.id}; versión ${value.version}.`];
    }
    if (key==='attributes') return attributeLines(value).map(line=>`Atributo ${line}`);
    if (refs[key]) return [`${labels[key]}: ${value===null ? 'Sin asignar' : maps[refs[key]].get(value)?.name ?? value}`];
    return [`${labels[key] ?? key}: ${valueText(value)}`];
  });
  return plan.actions.map(action=>{
    const details=[]; let name='';
    if (action.type.startsWith('stock.') || action.type.startsWith('sku.')) {
      const current=action.target.kind==='existing' ? maps.products.get(action.target.skuId) : action.target.sku;
      name=current.name;
      details.push(...fields(Object.fromEntries(['productType','productModel','size','unit','family'].filter(key=>current[key]!=null).map(key=>[key,current[key]]))));
      details.push(...attributeLines(current.attributes ?? {}).map(line=>`Atributo ${line}`));
      if (action.target.kind==='existing') details.push(`Existencias observadas: ${current.stockAvailable} disponibles; ${current.stockReserved} reservadas.`,`Precio de catálogo observado: ${current.price} ${current.priceCurrency}.`);
      if (action.quantity) details.push(`Cantidad: ${action.quantity.value} ${action.quantity.unit}.`);
      if (action.initialStock) details.push(`Existencias iniciales: ${action.initialStock.available} disponibles; ${action.initialStock.reserved} reservadas.`);
      if (action.balances) details.push(...fields(action.balances).map(line=>`Saldo solicitado · ${line}`));
      if (action.changes) details.push(...fields(action.changes).map(line=>`Cambio · ${line}`));
      if (action.price) details.push(`Precio solicitado: ${action.price.amount} ${action.price.currency}; política: ${{initialize:'inicializar',set:'reemplazar',preserve:'conservar'}[action.price.policy]}.`);
      if (action.salePrice) details.push(`Precio unitario de la operación: ${action.salePrice.amount} ${action.salePrice.currency}.`);
    } else if (action.type.startsWith('account.')) {
      const current=maps.clients.get(action.target.clientId);name=current.name;
      details.push(`Saldo observado: ${current.debt}.`,`Importe: ${action.amount.value} en unidades monetarias de la cuenta.`);
      if (action.destination) {const destination=maps.clients.get(action.destination.clientId);details.push(`Destino: ${destination.name}; saldo observado: ${destination.debt}.`);}
    } else if (action.type.startsWith('client.') || action.type.startsWith('supplier.')) {
      const map=action.type.startsWith('client.') ? maps.clients : maps.proveedores,current=action.target ? map.get(action.target.partyId) : null;
      name=current?.name ?? action.name;
      if (action.changes) details.push(...fields(action.changes));
      if (Object.hasOwn(action,'notas')) details.push(...fields({notas:action.notas}));
      if (current?.debt!==undefined) details.push(`Saldo observado: ${current.debt}.`);
      if (action.destination) details.push(`Destino: ${map.get(action.destination.partyId).name}.`);
    } else if (action.type.startsWith('order.')) {
      const current=action.target ? maps.pedidos.get(action.target.pedidoId) : null;name=current?.producto ?? action.order.producto;
      if (current) details.push(`Pedido observado: ${current.qty}; estado ${current.estado}.`);
      if (action.order) details.push(...fields(action.order));
      if (action.changes) details.push(...fields(action.changes).map(line=>`Cambio · ${line}`));
      if (action.reconciliation) details.push(...fields(Object.fromEntries(Object.entries(action.reconciliation).filter(([key])=>!['expectedProductRevision','expectedFingerprint'].includes(key)))));
    }
    if (action.reason) details.push(`Motivo: ${action.reason}`);
    return {itemId:action.itemId,title:`${verbs[action.type]} · ${name}`,details};
  });
}
