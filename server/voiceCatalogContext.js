const MAX_CATALOG_PRODUCTS = 80;
const MAX_CATALOG_CLIENTS = 25;
const MAX_CATALOG_PEDIDOS = 20;

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'las',
  'los',
  'en',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'o',
  'a',
  'al',
  'con',
  'por',
  'para',
  'que',
  'se',
  'su',
  'the',
  'talle',
  'talles',
  'numero',
  'version',
  'producto',
  'productos',
  'camiseta',
  'camisetas',
  'todo',
  'toda',
  'todos',
  'todas',
  'esto',
  'esa',
  'ese',
  'mas',
]);

const MATCH_ACTIONS = new Set([
  'delete_product',
  'update_product',
  'query_stock',
  'sell',
  'reserve_stock',
  'add_stock',
  'client_order',
]);

const VARIANT_HOLD_TYPES = new Set(['delete_product', 'sell', 'add_stock', 'client_order']);

const normalizeText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const tokenize = (value) =>
  normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));

const productHaystack = (product) =>
  normalizeText([product?.name, product?.productType, product?.productModel, product?.size].filter(Boolean).join(' '));

export const scoreProductAgainstQuery = (product, query) => {
  const hay = productHaystack(product);
  const q = normalizeText(query);
  if (!hay || !q) {
    return 0;
  }

  if (hay === q || hay.includes(q) || q.includes(hay)) {
    return 100;
  }

  const queryTokens = tokenize(q);
  if (!queryTokens.length) {
    return 0;
  }

  const meaningful = queryTokens.filter((token) => hay.includes(token));
  if (!meaningful.length) {
    return 0;
  }

  const coverage = meaningful.length / queryTokens.length;
  return Math.round(meaningful.length * 12 + coverage * 20);
};

const rankProducts = (products, query) => {
  const scored = (products || [])
    .map((product) => ({ product, score: scoreProductAgainstQuery(product, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  return scored;
};

const sizeOf = (product) => normalizeText(product?.size || '');

const closeMatchesForAction = (action, close) => {
  if (!action?.size) {
    return close;
  }
  const wanted = normalizeText(action.size);
  const sized = close.filter((entry) => sizeOf(entry.product) === wanted);
  return sized.length ? sized : close;
};

const isAmbiguousClose = (action, close) => closeMatchesForAction(action, close).length > 1;

const holdLabelForAction = (actionType) => {
  if (actionType === 'delete_product') {
    return 'Eliminar';
  }
  if (actionType === 'sell') {
    return 'Vender';
  }
  if (actionType === 'add_stock') {
    return 'Cargar';
  }
  if (actionType === 'client_order') {
    return 'Anotar pedido de';
  }
  return 'Usar';
};

const cloneActionWithProduct = (action, product) => ({
  ...action,
  productName: product.name,
  productType: product.productType || action.productType,
  productModel: product.productModel || action.productModel,
  size: product.size || action.size,
});

export const selectCatalogForPrompt = (catalog, text) => {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  const clients = Array.isArray(catalog?.clients) ? catalog.clients : [];
  const pedidos = Array.isArray(catalog?.pedidos) ? catalog.pedidos : [];
  const tokens = tokenize(text);

  let selectedProducts = products;
  if (products.length > MAX_CATALOG_PRODUCTS) {
    const ranked = products
      .map((product) => {
        const hay = productHaystack(product);
        const overlap = tokens.filter((token) => hay.includes(token)).length;
        return { product, overlap };
      })
      .sort((left, right) => right.overlap - left.overlap);
    const picked = [];
    const seen = new Set();
    for (const entry of ranked) {
      if (picked.length >= MAX_CATALOG_PRODUCTS) {
        break;
      }
      const id = entry.product.id || entry.product.name;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      picked.push(entry.product);
    }
    selectedProducts = picked;
  }

  return {
    products: selectedProducts,
    clients: clients.slice(0, MAX_CATALOG_CLIENTS),
    pedidos: pedidos.filter((pedido) => pedido.estado === 'pendiente').slice(0, MAX_CATALOG_PEDIDOS),
  };
};

const inferNamingStyle = (products) => {
  if (!products.length) {
    return '';
  }

  const samples = [...products]
    .slice(0, 8)
    .map((product) => product.name)
    .filter(Boolean);
  const types = [...new Set(products.map((product) => product.productType).filter(Boolean))].slice(0, 8);
  const withSize = products.filter((product) => String(product.size || '').trim()).length;
  const lines = [];
  if (samples.length) {
    lines.push(`Estilo de nombres ya usados: ${samples.map((name) => `"${name}"`).join(', ')}.`);
  }
  if (types.length) {
    lines.push(`Tipos frecuentes: ${types.join(', ')}.`);
  }
  if (withSize > products.length / 3) {
    lines.push('La variante va en "size" y también al final de productName, como en el inventario.');
  }
  return lines.join(' ');
};

export const formatCatalogPromptSection = (catalog, text) => {
  const selected = selectCatalogForPrompt(catalog, text);
  if (!selected.products.length && !selected.clients.length && !selected.pedidos.length) {
    return '';
  }

  const productLines = selected.products.map((product) => {
    const bits = [
      `"${product.name}"`,
      product.productType ? `tipo=${product.productType}` : null,
      product.productModel ? `modelo=${product.productModel}` : null,
      product.size ? `variante=${product.size}` : null,
      Number.isFinite(product.stockAvailable) ? `stock=${product.stockAvailable}` : null,
    ].filter(Boolean);
    return `- ${bits.join(' · ')}`;
  });

  const clientLines = selected.clients.map((client) => `- ${client.name}`);
  const pedidoLines = selected.pedidos.map((pedido) => {
    const size = pedido.talle ? ` ${pedido.talle}` : '';
    return `- ${pedido.producto}${size} x${pedido.qty || 1} (${pedido.estado || 'pendiente'})`;
  });

  return `
Inventario REAL de este negocio (fuente de verdad para nombres):
${productLines.join('\n') || '- (sin productos todavía)'}
${inferNamingStyle(selected.products)}
${clientLines.length ? `\nClientes: \n${clientLines.join('\n')}` : ''}
${pedidoLines.length ? `\nPedidos pendientes:\n${pedidoLines.join('\n')}` : ''}
Reglas contra este inventario:
- delete / update / query / venta / reserva / pedido: usá el productName EXACTO de la lista si hay match.
- "la de X" o un nombre parcial se resuelve contra esta lista, no se inventa.
- Si hay varios SKUs posibles (mismo modelo en dos talles/números, o dos modelos parecidos) y el usuario NO dijo la variante, NO ejecutes: missingFields ["productMatch"] y suggestedPhrases con cada candidato. Aplica a delete_product, sell, add_stock y client_order.
- Ingresos nuevos (add_stock de algo que no está): copiá el estilo de nombre del inventario. Un ítem dictado = una acción. Nunca juntes dos productos en un productName.
`.trim();
};

const groundOneAction = (action, products) => {
  const query = [action.productName, action.productType, action.productModel, action.size].filter(Boolean).join(' ');
  const ranked = rankProducts(products, query);
  if (!ranked.length) {
    return { actions: [action], ambiguous: false };
  }

  const best = ranked[0];
  const close = ranked.filter((entry) => entry.score >= Math.max(16, best.score - 8));

  if (VARIANT_HOLD_TYPES.has(action.type) && isAmbiguousClose(action, close)) {
    return {
      actions: [action],
      ambiguous: true,
      candidates: closeMatchesForAction(action, close).map((entry) => entry.product.name),
    };
  }

  if (action.type === 'add_stock') {
    if (best.score >= 100) {
      return { actions: [cloneActionWithProduct(action, best.product)], ambiguous: false };
    }
    return { actions: [action], ambiguous: false };
  }

  if (action.type === 'query_stock' || action.type === 'update_product') {
    if (best.score >= 16) {
      const canonical = cloneActionWithProduct(action, best.product);
      if (!action.size) {
        delete canonical.size;
      }
      return { actions: [canonical], ambiguous: false };
    }
    return { actions: [action], ambiguous: false };
  }

  if (best.score >= 16) {
    return { actions: [cloneActionWithProduct(action, best.product)], ambiguous: false };
  }

  return { actions: [action], ambiguous: false };
};

export const groundActionsAgainstCatalog = (actions, catalog) => {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  if (!products.length || !Array.isArray(actions) || !actions.length) {
    return {
      actions: actions || [],
      requiresConfirmation: false,
      missingFields: [],
      suggestedPhrases: [],
    };
  }

  const next = [];
  const missingFields = [];
  const suggestedPhrases = [];
  let requiresConfirmation = false;

  for (const action of actions) {
    if (!action || !MATCH_ACTIONS.has(action.type) || !action.productName) {
      next.push(action);
      continue;
    }

    const grounded = groundOneAction(action, products);
    if (grounded.ambiguous) {
      requiresConfirmation = true;
      missingFields.push('productMatch');
      if (grounded.candidates?.length) {
        suggestedPhrases.push(
          ...grounded.candidates.map((name) => `¿${holdLabelForAction(action.type)} ${name}?`),
        );
      }
      next.push(action);
      continue;
    }
    next.push(...grounded.actions);
  }

  const seen = new Set();
  const deduped = [];
  for (const action of next) {
    const key = JSON.stringify({
      type: action.type,
      productName: action.productName,
      size: action.size,
      qty: action.qty,
      clientName: action.clientName,
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(action);
  }

  return {
    actions: deduped,
    requiresConfirmation,
    missingFields: [...new Set(missingFields)],
    suggestedPhrases: [...new Set(suggestedPhrases)],
  };
};

export const hasProductMatchHold = (parsed) =>
  Array.isArray(parsed?.missingFields) && parsed.missingFields.includes('productMatch');
