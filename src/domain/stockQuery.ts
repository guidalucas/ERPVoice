import type { Product } from './types';

const normalizeText = (value: string) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const normalizeNullableString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const normalizeTextList = (value: string) =>
  normalizeText(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter(
      (token) =>
        token.length > 2 &&
        !['para', 'con', 'del', 'las', 'los', 'una', 'uno', 'por', 'les', 'de', 'el', 'la', 'y', 's', 'm', 'l', 'xl', 'xxl', 'titular', 'suplente', 'camiseta', 'talle'].includes(
          token,
        ),
    );

const MATCH_STOPWORDS = new Set([
  'para',
  'con',
  'del',
  'las',
  'los',
  'una',
  'uno',
  'por',
  'les',
  'de',
  'el',
  'la',
  'y',
  'en',
  'un',
  'the',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'camiseta',
  'camisetas',
  'talle',
  'talles',
  'version',
  'producto',
  'productos',
]);

const queryTokensFrom = (value: string) =>
  normalizeText(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 1 && !MATCH_STOPWORDS.has(token));

const productContainsAllTokens = (product: Product, tokens: string[]) => {
  if (!tokens.length) {
    return false;
  }

  const hay = normalizeText(
    [product.name, product.productType, product.productModel, product.size].filter(Boolean).join(' '),
  );
  const hayTokens = hay
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);

  return tokens.every(
    (token) =>
      hay.includes(token) ||
      hayTokens.some(
        (part) => part === token || (token.length >= 3 && part.length >= 3 && (part.includes(token) || token.includes(part))),
      ),
  );
};

const filterByExplicitSize = (products: Product[], action: StockQueryAction) => {
  const explicitSize = normalizeNullableString(action.size);
  if (!explicitSize || explicitSize === '*') {
    return products;
  }
  return products.filter((product) => {
    const productSize = normalizeNullableString(product.size);
    return Boolean(productSize && (productSize === explicitSize || includesNormalized(productSize, explicitSize)));
  });
};

const includesNormalized = (candidate: string, query: string) => {
  const candidateNorm = normalizeText(candidate).replace(/\s+/g, ' ').trim();
  const queryNorm = normalizeText(query).replace(/\s+/g, ' ').trim();
  if (!candidateNorm || !queryNorm) {
    return false;
  }
  return candidateNorm.includes(queryNorm) || queryNorm.includes(candidateNorm);
};

const scoreNameMatch = (candidateName: string, queryName: string) => {
  const candidate = normalizeText(candidateName).replace(/\bde\b/g, ' ').replace(/\s+/g, ' ').trim();
  const query = normalizeText(queryName).replace(/\bde\b/g, ' ').replace(/\s+/g, ' ').trim();

  if (!candidate || !query) {
    return 0;
  }

  if (candidate === query || candidate.includes(query) || query.includes(candidate)) {
    return 100;
  }

  const candidateTokens = candidate.split(/\s+/).filter((token) => token.length > 1);
  const queryTokens = query.split(/\s+/).filter((token) => token.length > 1);
  if (!queryTokens.length) {
    return 0;
  }

  const matches = queryTokens.filter((token) => candidateTokens.some((part) => part.includes(token) || token.includes(part)));
  return matches.length;
};

export type StockQueryAction = {
  productName: string;
  productType?: string;
  productModel?: string;
  size?: string;
  groupBy?: 'size';
};

const LIST_ALL_STOCK_NAMES = new Set([
  '*',
  'all',
  'todo',
  'todos',
  'todas',
  'inventario',
  'productos',
  'stock',
  'todos los productos',
  'todas los productos',
  'todo el stock',
  'todo el inventario',
  'el inventario',
  'el stock',
  'stock completo',
  'inventario completo',
]);

const MAX_STOCK_REPLY_CHARS = 3800;
const SIZE_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];

export const isListAllStockQuery = (action: StockQueryAction | null | undefined): boolean => {
  if (!action || action.productType || action.productModel) {
    return false;
  }
  const name = normalizeText(String(action.productName ?? '')).replace(/\s+/g, ' ').trim();
  return LIST_ALL_STOCK_NAMES.has(name);
};

const truncateStockReply = (text: string) => {
  if (text.length <= MAX_STOCK_REPLY_CHARS) {
    return text;
  }
  return `${text.slice(0, Math.max(0, MAX_STOCK_REPLY_CHARS - 22)).trim()}\n… (listado recortado)`;
};

const compareSizes = (left: string | null | undefined, right: string | null | undefined) => {
  const leftSize = normalizeText(left ?? '');
  const rightSize = normalizeText(right ?? '');
  const leftIndex = SIZE_ORDER.indexOf(leftSize);
  const rightIndex = SIZE_ORDER.indexOf(rightSize);
  if (leftIndex >= 0 && rightIndex >= 0) {
    return leftIndex - rightIndex;
  }
  if (leftIndex >= 0) {
    return -1;
  }
  if (rightIndex >= 0) {
    return 1;
  }
  return String(left ?? '').localeCompare(String(right ?? ''), 'es', { numeric: true });
};

export const matchProductsForQuery = (products: Product[], action: StockQueryAction): Product[] => {
  if (!Array.isArray(products) || !products.length || !action) {
    return [];
  }

  const actionType = normalizeNullableString(action.productType);
  const actionModel = normalizeNullableString(action.productModel);
  const actionName = String(action.productName ?? '').trim();

  if (isListAllStockQuery(action)) {
    return filterByExplicitSize(products.slice(), action);
  }

  const matchesType = (product: Product) => {
    const productType = normalizeNullableString(product.productType);
    const productName = String(product.name ?? '');
    return (
      !actionType ||
      (productType && includesNormalized(productType, actionType)) ||
      includesNormalized(productName, actionType)
    );
  };

  if (actionType || actionModel) {
    const modelTokens = actionModel ? queryTokensFrom(actionModel) : [];
    const filtered = products.filter((product) => {
      if (!matchesType(product)) {
        return false;
      }
      if (!actionModel) {
        return true;
      }
      if (modelTokens.length) {
        return productContainsAllTokens(product, modelTokens);
      }
      const productModel = normalizeNullableString(product.productModel);
      const productName = String(product.name ?? '');
      return (productModel && includesNormalized(productModel, actionModel)) || includesNormalized(productName, actionModel);
    });
    return filterByExplicitSize(filtered, action);
  }

  if (!actionName) {
    return [];
  }

  const nameTokens = queryTokensFrom(actionName);
  if (nameTokens.length) {
    const subset = products.filter((product) => productContainsAllTokens(product, nameTokens));
    if (subset.length) {
      return filterByExplicitSize(subset, action);
    }
  }

  const actionTokens = normalizeTextList(actionName);
  const scored: { product: Product; score: number }[] = [];

  for (const product of products) {
    const score = Math.max(
      scoreNameMatch(product.name, actionName),
      scoreNameMatch([product.productType, product.productModel, product.size].filter(Boolean).join(' '), actionName),
      actionTokens.length ? actionTokens.filter((token) => normalizeTextList(product.name).includes(token)).length : 0,
    );

    if (score >= 1) {
      scored.push({ product, score });
    }
  }

  if (!scored.length) {
    return [];
  }

  const bestScore = Math.max(...scored.map((entry) => entry.score));
  return filterByExplicitSize(
    scored.filter((entry) => entry.score === bestScore).map((entry) => entry.product),
    action,
  );
};

const titleCase = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

const singularizeProductType = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length <= 3) {
    return titleCase(trimmed);
  }
  if (trimmed.endsWith('es')) {
    return titleCase(trimmed.slice(0, -2));
  }
  if (trimmed.endsWith('s')) {
    return titleCase(trimmed.slice(0, -1));
  }
  return titleCase(trimmed);
};

const composeProductName = (parts: { productType?: string; productModel?: string; size?: string; fallback?: string }) => {
  const values = [parts.productType, parts.productModel, parts.size]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (values.length) {
    return values.join(' ');
  }
  return parts.fallback?.trim() ?? '';
};

const parseProductDescriptor = (value: string) => {
  const normalized = normalizeText(value).replace(/\s+/g, ' ').trim();
  const sizeMatch = normalized.match(
    /(?:,\s*|\s+)(?:talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes)\s+([a-z0-9\/]+)\b/i,
  );
  const size = sizeMatch ? sizeMatch[1]!.toUpperCase() : undefined;
  const withoutSize = normalized
    .replace(/(?:,\s*|\s+)(?:talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes)\s+[a-z0-9\/]+\b/i, '')
    .trim();
  const descriptorParts = withoutSize.split(/\s+de\s+/i);
  const rawProductType = descriptorParts[0] ?? withoutSize;
  const rawProductModel = descriptorParts.slice(1).join(' de ') || undefined;

  const productType = rawProductType ? singularizeProductType(rawProductType) : undefined;
  const productModel = rawProductModel ? titleCase(rawProductModel) : undefined;

  return {
    productType,
    productModel,
    size,
    productName: composeProductName({ productType, productModel, size, fallback: value }),
  };
};

/** Match all variants for update/delete. Without size → every talle of that model. */
export const matchProductsForUpdate = (products: Product[], action: StockQueryAction): Product[] => {
  if (!Array.isArray(products) || !products.length || !action) {
    return [];
  }

  const descriptor = parseProductDescriptor(String(action.productName ?? ''));
  const productType = normalizeNullableString(action.productType) || descriptor.productType || undefined;
  const productModel = normalizeNullableString(action.productModel) || descriptor.productModel || undefined;
  const explicitSize = normalizeNullableString(action.size) || descriptor.size || null;
  const productName = composeProductName({
    productType,
    productModel,
    fallback: action.productName,
  });

  let matches = matchProductsForQuery(products, {
    productName,
    productType,
    productModel,
  });

  if (explicitSize) {
    matches = matches.filter((product) => {
      const productSize = normalizeNullableString(product.size);
      return Boolean(productSize && (productSize === explicitSize || includesNormalized(productSize, explicitSize)));
    });
  }

  return matches;
};

export const answerStockQuery = (
  products: Product[],
  action: StockQueryAction,
  options: { variantLabel?: string | null } = {},
): string => {
  const listAll = isListAllStockQuery(action);
  const label = listAll ? 'inventario' : String(action?.productName ?? 'producto').trim() || 'producto';
  const matches = matchProductsForQuery(products, action);
  const variantWord =
    typeof options.variantLabel === 'string' && options.variantLabel.trim()
      ? options.variantLabel.trim().toLowerCase()
      : 'variante';
  const missingVariant = `sin ${variantWord}`;

  if (!matches.length) {
    return listAll
      ? 'No hay productos cargados en tu inventario.'
      : `No encontré stock de "${label}" en tu inventario.`;
  }

  const totalAvailable = matches.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
  const totalReserved = matches.reduce((sum, product) => sum + Number(product.stockReserved ?? 0), 0);
  const reservedLine =
    totalReserved > 0
      ? `\nAdemás hay ${totalReserved} unidad${totalReserved === 1 ? '' : 'es'} reservada${totalReserved === 1 ? '' : 's'}.`
      : '';
  const productLabel = (product: Product) => {
    const model = normalizeNullableString(product.productModel);
    if (model && !/^\d{2,4}$/.test(normalizeText(model))) {
      return model;
    }
    const name = String(product.name ?? '').trim();
    const size = normalizeNullableString(product.size);
    const withoutSize =
      size && name.toLowerCase().endsWith(` ${size.toLowerCase()}`)
        ? name.slice(0, name.length - size.length).trim()
        : name;
    return withoutSize || name || model || normalizeNullableString(product.productType) || 'Producto';
  };

  if (action.groupBy === 'size') {
    const groups = new Map<string, Product[]>();
    for (const product of matches) {
      const groupKey = normalizeNullableString(product.size) || missingVariant;
      const existing = groups.get(groupKey) ?? [];
      existing.push(product);
      groups.set(groupKey, existing);
    }

    const lines: string[] = [];
    const sortedKeys = [...groups.keys()].sort((left, right) => {
      if (left === missingVariant) {
        return 1;
      }
      if (right === missingVariant) {
        return -1;
      }
      return compareSizes(left, right);
    });

    for (const sizeLabel of sortedKeys) {
      const groupProducts = (groups.get(sizeLabel) ?? []).slice().sort((left, right) =>
        productLabel(left).localeCompare(productLabel(right), 'es'),
      );
      const items = groupProducts.map((product) => `- ${productLabel(product)}: ${Number(product.stockAvailable ?? 0)}`);
      const heading = sizeLabel === missingVariant ? sizeLabel : `${titleCase(variantWord)} ${sizeLabel}`;
      lines.push(`${heading}:\n${items.join('\n')}`);
    }

    const header = `Inventario por ${variantWord} (${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'}):`;
    return truncateStockReply(`${header}\n\n${lines.join('\n\n')}${reservedLine}`);
  }

  const groups = new Map<string, Product[]>();

  for (const product of matches) {
    const groupKey = productLabel(product);
    const existing = groups.get(groupKey) ?? [];
    existing.push(product);
    groups.set(groupKey, existing);
  }

  const lines: string[] = [];

  for (const [groupName, groupProducts] of groups.entries()) {
    const groupTotal = groupProducts.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
    const sizeParts = groupProducts
      .slice()
      .sort((left, right) => compareSizes(left.size, right.size))
      .map((product) => {
        const sizeLabel = normalizeNullableString(product.size) || missingVariant;
        return `${sizeLabel}: ${Number(product.stockAvailable ?? 0)}`;
      });

    lines.push(`${groupName}: ${sizeParts.join(', ')} (total ${groupTotal})`);
  }

  const header = listAll
    ? `Inventario: ${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'}:`
    : `Tenés ${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'} de ${label}:`;

  return truncateStockReply(`${header}\n${lines.join('\n')}${reservedLine}`);
};
