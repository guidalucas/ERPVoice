// Existing fichas follow Stocky's name unless a title is explicitly customized.
export function inventoryTitle(skus) {
  const source = skus.find(sku => sku.status === 'active' && sku.name?.trim()) ?? skus.find(sku => sku.name?.trim());
  return source ? Array.from(source.name.normalize('NFC').trim()).slice(0, 120).join('') : null;
}

export function applyProductTitle(product, skus) {
  const stockyTitle = inventoryTitle(skus);
  return { ...product, inventoryTitle: stockyTitle,
    title: product.titleSource === 'inventory' ? stockyTitle || product.title : product.title };
}

// Use the same source/order for search as for list, detail and stories.
export const productTitleSql = (alias = 'p') => `CASE WHEN COALESCE(to_jsonb(${alias})->>'title_source','custom')='inventory' THEN
  COALESCE((SELECT left(btrim(normalize(i.name,NFC)),120) FROM commercial_product_skus tl
    JOIN products i ON i.owner_phone=tl.owner_phone AND i.id=tl.sku_id
    WHERE tl.owner_phone=${alias}.owner_phone AND tl.commercial_product_id=${alias}.id AND btrim(i.name)<>''
    ORDER BY (i.inventory_status='active') DESC,tl.sort_order,i.id LIMIT 1),${alias}.title)
  ELSE ${alias}.title END`;
