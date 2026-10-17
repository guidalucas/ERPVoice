/** Compatibility projections use authoritative receipt facts, never name matching. */
export const inventoryResultActions = (result, originalActions = []) => result.items.map((item, index) => {
  const original = originalActions[index] ?? {};
  const action = { ...original,
    type: { 'stock.receive': 'add_stock', 'stock.sell': 'sell', 'stock.reserve': 'reserve_stock' }[item.type],
    productId: item.skuId, resolvedProductId: item.skuId,
    productName: item.skuName ?? original.productName ?? item.skuId,
    productType: item.productType ?? undefined, productModel: item.productModel ?? undefined, size: item.size ?? undefined,
    qty: item.quantity.value, unit: item.quantity.unit,
  };
  delete action.price;
  delete action.priceCurrency;
  if (item.price !== null && item.price !== undefined) {
    action.price = item.price; action.priceCurrency = item.currency;
  }
  if (item.type !== 'stock.receive') action.salePriceKnown = item.price !== null && item.price !== undefined;
  return action;
});

export const inventoryResultReply = (result) => result.items.map((item) => {
  const verb = { 'stock.receive': 'Ingreso aplicado', 'stock.sell': 'Venta registrada', 'stock.reserve': 'Reserva registrada' }[item.type];
  const price = item.type === 'stock.sell' ? item.price === null
    ? '; precio de venta no informado' : `; precio de venta ${item.currency} ${item.price} c/u` : '';
  return `${verb}: ${item.quantity.value} ${item.quantity.unit} de ${item.skuName ?? item.skuId}${item.size ? ` (${item.size})` : ''}. Disponible: ${item.stockAvailable}; reservado: ${item.stockReserved}${price}.`;
}).join('\n');
