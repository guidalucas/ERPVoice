import { productMatchKey } from './productIdentity.js';
import { bindStockConsumptionAction } from './stockOperationAdapter.js';
import { VARIANT_KEYWORD_ALT } from './businessCategories.js';

const MAX_CATALOG_PRODUCTS = 30;
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
  'todo',
  'toda',
  'todos',
  'todas',
  'esto',
  'esa',
  'ese',
  'mas',
]);

const QUERY_EXTRA_STOPWORDS = new Set([
  'tengo',
  'tenes',
  'tenemos',
  'tiene',
  'tenia',
  'queda',
  'quedan',
  'quedo',
  'hay',
  'cuanto',
  'cuanta',
  'cuantos',
  'cuantas',
  'disponible',
  'disponibles',
  'unidad',
  'unidades',
  'no',
  'me',
  'mi',
  'mis',
  'te',
  'vos',
  'mostrame',
  'mostrar',
  'decime',
  'che',
  'hola',
  'sin',
  'stock',
  'borra',
  'borrar',
  'elimina',
  'eliminar',
  'saca',
  'sacar',
  'quita',
  'quitar',
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

const tokenizeQueryText = (value) =>
  normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token) && !QUERY_EXTRA_STOPWORDS.has(token));

const titleCase = (value) =>
  String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

const tokenMatchesHay = (token, hayTokens) =>
  hayTokens.some((part) => {
    if (part === token) {
      return true;
    }
    return token.length >= 3 && part.length >= 3 && (part.includes(token) || token.includes(part));
  });

const productHasQueryTokens = (product, tokens) => {
  if (!tokens.length) {
    return false;
  }
  const hayTokens = tokenize(productHaystack(product));
  return tokens.every((token) => tokenMatchesHay(token, hayTokens));
};

const catalogTokensFromText = (text, products) =>
  tokenizeQueryText(text).filter((token) =>
    products.some((product) => tokenMatchesHay(token, tokenize(productHaystack(product)))),
  );

const sharedField = (products, key) => {
  const normalized = products.map((product) => normalizeText(String(product?.[key] ?? '').trim()));
  const filled = normalized.filter(Boolean);
  if (!filled.length || filled.length !== products.length) {
    return null;
  }
  const values = [...new Set(filled)];
  if (values.length !== 1) {
    return null;
  }
  const sample = products.find((product) => normalizeText(String(product?.[key] ?? '').trim()) === values[0]);
  return sample?.[key] || null;
};

const productHaystack = (product) =>
  normalizeText([product?.name, product?.productType, product?.productModel, product?.size].filter(Boolean).join(' '));

const distinctiveCatalogTokens = (text, products) => {
  const tokens = tokenize(text);
  if (products.length < 2) return tokens;
  const productTokens = products.map((product) => tokenize(productHaystack(product)));
  return tokens.filter((token) =>
    productTokens.filter((hay) => tokenMatchesHay(token, hay)).length / products.length <= 0.7,
  );
};

export const scoreProductAgainstQuery = (product, query) => {
  const hay = productHaystack(product);
  const q = normalizeText(query);
  if (!hay || !q) {
    return 0;
  }

  if (hay === q || hay.includes(q) || (q.length >= 6 && hay.length >= 6 && q.includes(hay))) {
    return 100;
  }

  const queryTokens = tokenize(q);
  if (!queryTokens.length) {
    return 0;
  }

  const hayTokens = tokenize(hay);
  const meaningful = queryTokens.filter((token) =>
    hayTokens.some((part) => {
      if (part === token) {
        return true;
      }
      return token.length >= 4 && part.length >= 4 && (part.includes(token) || token.includes(part));
    }),
  );
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
  ...(action.type === 'delete_product' && product.id ? { productId: product.id } : {}),
});

export const hasBulkSelection = (sourceText) => /\b(?:todos?|todas?)\b/.test(normalizeText(sourceText || ''));

export const missingVariantSelectionFromText = (sourceText) => {
  const text = normalizeText(sourceText || '');
  const variant = `(?:${VARIANT_KEYWORD_ALT})`;
  const missing = new RegExp(`\\b(?:sin\\s+${variant}|no\\s+(?:tiene|tienen|posee|poseen)\\s+${variant}|${variant}\\s+(?:sin\\s+definir|no\\s+definid[ao]s?))\\b`);
  return missing.test(text) ? { field: 'size', operator: 'missing' } : null;
};

const isBulkDelete = (action, sourceText) => action?.type === 'delete_product' &&
  action.productName !== '*' &&
  (action.selection?.operator === 'missing' || action.allMatches === true || hasBulkSelection(sourceText));

const groundBulkDelete = (action, products, sourceText) => {
  const selection = action.selection?.field === 'size' && action.selection?.operator === 'missing'
    ? action.selection : missingVariantSelectionFromText(sourceText);
  const normalizedSource = normalizeText(sourceText);
  const mentionsValue = (value) => new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u',
  ).test(normalizedSource);
  const mentionedSizes = [...new Set(products.map((product) => normalizeText(product.size || '')).filter((size) =>
    size && mentionsValue(size),
  ))];
  const parsedSize = normalizeText(action.size || '');
  const specifiedSize = parsedSize && mentionsValue(parsedSize) ? parsedSize : null;
  const size = selection ? null : specifiedSize || (mentionedSizes.length === 1 ? mentionedSizes[0] : null);
  const sizeTokens = new Set(products.map((product) => normalizeText(product.size || '')).filter(Boolean));
  const tokens = catalogTokensFromText(sourceText, products).filter((token) => !sizeTokens.has(token));
  const withinSize = products.filter((product) =>
    (!size || sizeOf(product) === size) && (!selection || !sizeOf(product)),
  );
  if ((!tokens.length && !selection) || (!selection && !specifiedSize && mentionedSizes.length > 1)) {
    return { actions: [], ambiguous: true, candidates: withinSize.map((product) => product.name) };
  }

  const matching = withinSize.filter((product) => !tokens.length || productHasQueryTokens(product, tokens));
  if (!matching.length) return { actions: [], ambiguous: false, noMatch: true };
  if (selection && matching.some((product) => !product.id)) {
    return { actions: [], ambiguous: true, candidates: matching.map((product) => product.name) };
  }
  const names = matching.map((product) => normalizeText(product.name));
  if (new Set(names).size !== names.length && matching.some((product) => !product.id)) {
    return { actions: [], ambiguous: true, candidates: matching.map((product) => product.name) };
  }
  return {
    actions: matching.map((product) => ({
      type: 'delete_product',
      productName: product.name,
      ...(product.id ? { productId: product.id } : {}),
      ...(selection ? { selection } : {}),
      productType: product.productType || undefined,
      productModel: product.productModel || undefined,
      size: product.size || undefined,
    })),
    ambiguous: false,
  };
};

export const selectCatalogForPrompt = (catalog, text) => {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  const clients = Array.isArray(catalog?.clients) ? catalog.clients : [];
  const pedidos = Array.isArray(catalog?.pedidos) ? catalog.pedidos : [];
  const tokens = distinctiveCatalogTokens(text, products);

  let selectedProducts = products;
  if (products.length > MAX_CATALOG_PRODUCTS) {
    const ranked = products
      .map((product) => {
        const hay = productHaystack(product);
        const hayTokens = tokenize(hay);
        const overlap = tokens.filter((token) => tokenMatchesHay(token, hayTokens)).length;
        return { product, overlap };
      })
      .sort((left, right) => right.overlap - left.overlap);
    const picked = [];
    const seen = new Set();
    for (const entry of ranked) {
      if (picked.length >= MAX_CATALOG_PRODUCTS) {
        break;
      }
      if (tokens.length && entry.overlap === 0) {
        break;
      }
      const id = entry.product.id || entry.product.name;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      picked.push(entry.product);
    }
    selectedProducts = picked.length ? picked : products.slice(0, 8);
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
- delete / venta / reserva / pedido: usá el productName EXACTO de la lista si hay un match único.
- query_stock de una familia ("los de esta marca", "no tengo más de X"): productName GENÉRICO de esa familia. NUNCA elijas un SKU puntual; el sistema lista todos los que matchean.
- query_stock de un SKU puntual con modelo y variante explícitos: ahí sí usá el nombre exacto.
- Si pide todo el inventario / todos los productos: query_stock con productName "*" y, si agrupó por talle, groupBy "size". No inventes un producto llamado all.
- "la de X" o un nombre parcial se resuelve contra esta lista, no se inventa.
- Si hay varios SKUs posibles (mismo modelo en dos talles/números, o dos modelos parecidos) y el usuario NO dijo la variante, NO ejecutes: missingFields ["productMatch"] y suggestedPhrases con cada candidato. Aplica a delete_product, sell, add_stock y client_order.
- En add_stock, si el usuario sí dijo el talle/variante y solo existen otros talles, es una variante nueva: conservá el nombre y talle pedidos, sin pedir aclaración.
- Ingresos nuevos (add_stock de algo que no está): copiá el estilo de nombre del inventario. Un ítem dictado = una acción. Nunca juntes dos productos en un productName.
- Si el mismo producto se menciona otra vez ("otra más"), sumá las unidades: no descartes la repetición.
`.trim();
};

const compactProductType = (value) => {
  const parts = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) {
    return null;
  }
  if (parts.length > 2) {
    return parts[0];
  }
  return parts.join(' ');
};

const pickFamilyProductType = (matching, action) => {
  const shared = compactProductType(sharedField(matching, 'productType'));
  if (shared) {
    return shared;
  }
  const fromCatalog = matching
    .map((product) => compactProductType(product.productType))
    .find(Boolean);
  return fromCatalog || compactProductType(action.productType) || undefined;
};

const isYearToken = (value) => /^\d{2,4}$/.test(normalizeText(String(value ?? '')).replace(/\s+/g, ''));

const familyQueryStockAction = (action, matching, familyTokens) => {
  const sharedType = pickFamilyProductType(matching, action);
  const sharedModel = sharedField(matching, 'productModel');
  const usableSharedModel = sharedModel && !isYearToken(sharedModel) ? sharedModel : null;
  // Query labels already show the catalog type separately. Exclude only its
  // exact singular/plural tokens from the model; do not change stored identity
  // or the candidate selection, and never restore an unrequested model/year.
  const typeTokens = tokenizeQueryText(sharedType ?? '');
  const sameTypeToken = (token, type) => token === type || token === `${type}s` || token === `${type}es` || type === `${token}s` || type === `${token}es`;
  const modelTokens = familyTokens.filter(token => !typeTokens.some(type => sameTypeToken(token,type)));
  const genericModel = usableSharedModel || titleCase(modelTokens.join(' ')) || undefined;
  const next = {
    ...action,
    productName: [sharedType, genericModel].filter(Boolean).join(' ') || action.productName,
    productType: sharedType || compactProductType(action.productType) || action.productType,
    productModel: genericModel,
  };
  if (!action.size) {
    delete next.size;
  }
  return { actions: [next], ambiguous: false };
};

const groundQueryStockAction = (action, products, sourceText) => {
  const userRaw = tokenizeQueryText(sourceText || '');
  const fromUser = catalogTokensFromText(sourceText || '', products);
  const fromAction = catalogTokensFromText(
    [action.productName, action.productType, action.productModel].filter(Boolean).join(' '),
    products,
  );
  const withoutHallucinatedYears = (tokens) =>
    tokens.filter((token) => !isYearToken(token) || userRaw.includes(token));

  let familyTokens = withoutHallucinatedYears(fromUser.length ? fromUser : fromAction);
  if (!familyTokens.length && fromUser.length) {
    familyTokens = fromUser.filter((token) => !isYearToken(token));
  }

  if (familyTokens.length) {
    let matching = products.filter((product) => productHasQueryTokens(product, familyTokens));
    if (action.size) {
      const wanted = normalizeText(action.size);
      const sized = matching.filter((product) => sizeOf(product) === wanted);
      if (sized.length) {
        matching = sized;
      }
    }

    if (matching.length > 1) {
      return familyQueryStockAction(action, matching, familyTokens);
    }

    if (matching.length === 1) {
      const userAskedSpecificSku = familyTokens.some((token) => isYearToken(token)) || Boolean(action.size);
      if (!userAskedSpecificSku) {
        return familyQueryStockAction(action, matching, familyTokens);
      }
      const canonical = cloneActionWithProduct(action, matching[0]);
      if (!action.size) {
        delete canonical.size;
      }
      return { actions: [canonical], ambiguous: false };
    }
  }

  const query = [action.productName, action.productType, action.productModel, action.size].filter(Boolean).join(' ');
  const ranked = rankProducts(products, query);
  if (!ranked.length || ranked[0].score < 16) {
    return { actions: [action], ambiguous: false };
  }

  const best = ranked[0];
  const close = ranked.filter((entry) => entry.score >= Math.max(16, best.score - 8));
  if (close.length > 1) {
    if (fromUser.length) {
      return familyQueryStockAction(
        action,
        close.map((entry) => entry.product),
        fromUser,
      );
    }
    return { actions: [action], ambiguous: false };
  }

  if (fromUser.length && !fromUser.some((token) => isYearToken(token)) && !action.size) {
    const userMatches = products.filter((product) => productHasQueryTokens(product, fromUser));
    if (userMatches.length) {
      return familyQueryStockAction(action, userMatches, fromUser);
    }
  }

  const canonical = cloneActionWithProduct(action, best.product);
  if (!action.size) {
    delete canonical.size;
  }
  return { actions: [canonical], ambiguous: false };
};

const groundOneAction = (action, products, sourceText, bulkDelete = false) => {
  if (action.type === 'sell' || action.type === 'reserve_stock' || action.type === 'update_product') {
    const bound = bindStockConsumptionAction(action, products);
    return bound ? { actions: [bound], ambiguous: false }
      : { actions: [action], ambiguous: true, candidates: rankProducts(products,
        [action.productName, action.size].filter(Boolean).join(' ')).slice(0, 5).map((entry) => entry.product.name) };
  }
  if (bulkDelete) return groundBulkDelete(action, products, sourceText);
  if (action.type === 'query_stock') {
    return groundQueryStockAction(action, products, sourceText);
  }

  if (action.type === 'delete_product') {
    const wantedName = normalizeText(action.productName).replace(/\s+/g, ' ').trim();
    const exact = products.filter((product) =>
      normalizeText(product.name).replace(/\s+/g, ' ').trim() === wantedName,
    );
    if (exact.length === 1) {
      return { actions: [cloneActionWithProduct(action, exact[0])], ambiguous: false };
    }
    if (exact.length > 1) {
      return { actions: [action], ambiguous: true, candidates: exact.map((product) => product.name) };
    }
  }

  const garmentKey = productMatchKey(action);
  if (garmentKey && action.size && action.type === 'add_stock') {
    const exactGarments = products.filter((product) =>
      sizeOf(product) === normalizeText(action.size) && productMatchKey(product) === garmentKey,
    );
    if (exactGarments.length === 1) {
      return { actions: [cloneActionWithProduct(action, exactGarments[0])], ambiguous: false };
    }
    if (exactGarments.length > 1) {
      return { actions: [action], ambiguous: true, candidates: exactGarments.map((product) => product.name) };
    }
  }

  const query = [action.productName, action.productType, action.productModel, action.size].filter(Boolean).join(' ');
  const ranked = rankProducts(products, query);
  if (!ranked.length) {
    return { actions: [action], ambiguous: false };
  }

  // Un ingreso de talle nuevo no debe confundirse con SKUs existentes de otro talle.
  // El backend puede crear la variante nueva si no hay una coincidencia exacta.
  const sizeMatches = action.size
    ? ranked.filter((entry) => sizeOf(entry.product) === normalizeText(action.size))
    : ranked;
  const distinctiveTokens = action.type === 'add_stock'
    ? distinctiveCatalogTokens(action.productName, products).filter((token) =>
        token !== normalizeText(action.size),
      )
    : [];
  const addStockMatches = distinctiveTokens.length
    ? sizeMatches.filter((entry) => productHasQueryTokens(entry.product, distinctiveTokens))
    : sizeMatches;
  if (action.type === 'add_stock' && action.size && !addStockMatches.length) {
    return { actions: [action], ambiguous: false };
  }
  if (garmentKey && action.type === 'add_stock' && action.size && addStockMatches.length) {
    return {
      actions: [action],
      ambiguous: true,
      candidates: addStockMatches.map((entry) => entry.product.name),
    };
  }
  const candidates = action.type === 'add_stock' && action.size ? addStockMatches : ranked;

  const best = candidates[0];
  const close = candidates.filter((entry) => entry.score >= Math.max(16, best.score - 8));

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

  if (action.type === 'update_product') {
    if (close.length > 1) {
      return { actions: [action], ambiguous: false };
    }
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

export const groundActionsAgainstCatalog = (actions, catalog, sourceText) => {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  if (!Array.isArray(actions) || !actions.length) {
    return {
      actions: actions || [],
      requiresConfirmation: false,
      missingFields: [],
      suggestedPhrases: [],
    };
  }

  if (!products.length) {
    if (actions.some((action) => action.type === 'sell' || action.type === 'reserve_stock' || action.type === 'update_product')) {
      return { actions, requiresConfirmation: true, missingFields: ['productMatch'], suggestedPhrases: [] };
    }
    return actions.some((action) => isBulkDelete(action, sourceText))
      ? { actions: [], requiresConfirmation: false, missingFields: ['scopeNotFound'], suggestedPhrases: [] }
      : { actions, requiresConfirmation: false, missingFields: [], suggestedPhrases: [] };
  }

  const next = [];
  const missingFields = [];
  const suggestedPhrases = [];
  let requiresConfirmation = false;

  for (const action of actions) {
    if (!action || !MATCH_ACTIONS.has(action.type) || (!action.productName && !action.selection)) {
      next.push(action);
      continue;
    }

    const listAllName = String(action.productName ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      action.type === 'query_stock' &&
      ['*', 'all', 'todo', 'todos', 'todas', 'inventario', 'productos', 'stock', 'todos los productos', 'todo el stock', 'todo el inventario'].includes(listAllName)
    ) {
      next.push({ ...action, productName: '*' });
      continue;
    }

    if (action.type === 'delete_product' && listAllName === '*') {
      next.push({ type: 'delete_product', productName: '*' });
      continue;
    }

    const grounded = groundOneAction(
      action, products, sourceText,
      isBulkDelete(action, sourceText) && (actions.length === 1 || action.allMatches === true),
    );
    if (grounded.noMatch) {
      missingFields.push('scopeNotFound');
      continue;
    }
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

  const seen = new Map();
  const deduped = [];
  for (const action of next) {
    if (action.type === 'sell' || action.type === 'reserve_stock' || action.type === 'update_product') {
      // Each proposed effect is a distinct operation item. Deduplicating by SKU
      // and quantity can silently discard a second legitimate sale/reservation.
      deduped.push(action);
      continue;
    }
    const key = JSON.stringify({
      type: action.type,
      productId: action.productId,
      productName: action.productName,
      size: action.size,
      qty: action.type === 'add_stock' ? undefined : action.qty,
      price: action.type === 'add_stock' ? action.price : undefined,
      clientName: action.clientName,
    });
    if (seen.has(key)) {
      if (action.type === 'add_stock') {
        const previous = deduped[seen.get(key)];
        previous.qty += action.qty;
      }
      continue;
    }
    seen.set(key, deduped.length);
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
