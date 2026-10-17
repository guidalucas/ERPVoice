/** Compatibility projections use authoritative receipt facts, never name matching. */
export const inventoryResultActions = (result, originalActions = []) => result.items.map((item, index) => {
  const sourceIndex = /^item-(\d+)(?:-(?:adjust|update))?$/.exec(item.itemId);
  const original = originalActions[sourceIndex ? Number(sourceIndex[1]) - 1 : index] ?? {};
  const action = { ...original,
    type: { 'stock.receive': 'add_stock', 'stock.sell': 'sell', 'stock.reserve': 'reserve_stock', 'stock.adjust': 'update_product', 'sku.update': 'update_product', 'sku.deactivate': 'delete_product', 'sku.create': 'create_product' }[item.type],
    productId: item.skuId, resolvedProductId: item.skuId,
    productName: item.skuName ?? original.productName ?? item.skuId,
    productType: item.productType ?? undefined, productModel: item.productModel ?? undefined, size: item.size ?? undefined,
    ...(item.quantity ? { qty: item.quantity.value, unit: item.quantity.unit } : { unit: item.unit }),
  };
  delete action.price;
  delete action.priceCurrency;
  if (item.type === 'sku.deactivate') {
    delete action.qty; delete action.stockAvailable; delete action.stockReserved;
    action.status = item.status; action.revision = item.revision; action.reason = item.reason;
    return action;
  }
  if (item.price !== null && item.price !== undefined) {
    action.price = item.price; action.priceCurrency = item.currency;
  }
  if (item.type === 'sku.create') {
    delete action.qty;
    Object.assign(action, { stockAvailable: item.stockAvailable, stockReserved: item.stockReserved, reason: item.reason, revision: item.revision });
    return action;
  }
  if (item.type === 'stock.sell' || item.type === 'stock.reserve') action.salePriceKnown = item.price !== null && item.price !== undefined;
  if (item.type === 'stock.adjust' || item.type === 'sku.update') {
    delete action.qty;
    action.reason = item.reason;
    action.revision = item.revision;
    if (item.type === 'stock.adjust') {
      delete action.price; delete action.priceCurrency;
      if (Object.hasOwn(item.balances, 'available')) action.stockAvailable = item.stockAvailable;
      if (Object.hasOwn(item.balances, 'reserved')) action.stockReserved = item.stockReserved;
    } else {
      delete action.stockAvailable; delete action.stockReserved;
      action.changes = item.changes;
    }
  }
  return action;
});

export const inventoryResultReply = (result) => result.items.map((item) => {
  if (item.type === 'sku.create') return `SKU creado: ${item.skuName ?? item.skuId}${item.size ? ` (${item.size})` : ''}. Disponible: ${item.stockAvailable}; reservado: ${item.stockReserved}; precio: ${item.currency} ${item.price}.`;
  if (item.type === 'sku.deactivate') return `SKU desactivado: ${item.skuName ?? item.skuId}${item.size ? ` (${item.size})` : ''}. Stock conservado: ${item.stockAvailable}; reservado: ${item.stockReserved}. Historial conservado.`;
  if (item.type === 'stock.adjust' || item.type === 'sku.update') {
    const changes = item.changes ? ` Cambios: ${Object.entries(item.changes).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join(', ')}.` : '';
    return `${item.type === 'stock.adjust' ? 'Ajuste aplicado' : 'SKU actualizado'}: ${item.skuName ?? item.skuId}${item.size ? ` (${item.size})` : ''}. Disponible: ${item.stockAvailable}; reservado: ${item.stockReserved}; revisión: ${item.revision}.${changes}`;
  }
  const verb = { 'stock.receive': 'Ingreso aplicado', 'stock.sell': 'Venta registrada', 'stock.reserve': 'Reserva registrada' }[item.type];
  const price = item.type === 'stock.sell' ? item.price === null
    ? '; precio de venta no informado' : `; precio de venta ${item.currency} ${item.price} c/u` : '';
  return `${verb}: ${item.quantity.value} ${item.quantity.unit} de ${item.skuName ?? item.skuId}${item.size ? ` (${item.size})` : ''}. Disponible: ${item.stockAvailable}; reservado: ${item.stockReserved}${price}.`;
}).join('\n');
