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
};

export const matchProductsForQuery = (products: Product[], action: StockQueryAction): Product[] => {
  if (!Array.isArray(products) || !products.length || !action) {
    return [];
  }

  const actionType = normalizeNullableString(action.productType);
  const actionModel = normalizeNullableString(action.productModel);
  const actionName = String(action.productName ?? '').trim();

  if (actionType || actionModel) {
    return products.filter((product) => {
      const productType = normalizeNullableString(product.productType);
      const productModel = normalizeNullableString(product.productModel);
      const productName = String(product.name ?? '');

      const typeOk =
        !actionType || (productType && includesNormalized(productType, actionType)) || includesNormalized(productName, actionType);

      if (!typeOk) {
        return false;
      }

      if (!actionModel) {
        return true;
      }

      return (productModel && includesNormalized(productModel, actionModel)) || includesNormalized(productName, actionModel);
    });
  }

  if (!actionName) {
    return [];
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
  return scored.filter((entry) => entry.score === bestScore).map((entry) => entry.product);
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
  const label = String(action?.productName ?? 'producto').trim() || 'producto';
  const matches = matchProductsForQuery(products, action);
  const variantWord =
    typeof options.variantLabel === 'string' && options.variantLabel.trim()
      ? options.variantLabel.trim().toLowerCase()
      : 'variante';
  const missingVariant = `sin ${variantWord}`;

  if (!matches.length) {
    return `No encontré stock de "${label}" en tu inventario.`;
  }

  const totalAvailable = matches.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
  const totalReserved = matches.reduce((sum, product) => sum + Number(product.stockReserved ?? 0), 0);

  const groups = new Map<string, Product[]>();

  for (const product of matches) {
    const groupKey =
      normalizeNullableString(product.productModel) || normalizeNullableString(product.productType) || product.name || 'Producto';
    const existing = groups.get(groupKey) ?? [];
    existing.push(product);
    groups.set(groupKey, existing);
  }

  const lines: string[] = [];
  const sizeOrder = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];

  for (const [groupName, groupProducts] of groups.entries()) {
    const groupTotal = groupProducts.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
    const sizeParts = groupProducts
      .slice()
      .sort((left, right) => {
        const leftSize = normalizeText(left.size ?? '');
        const rightSize = normalizeText(right.size ?? '');
        const leftIndex = sizeOrder.indexOf(leftSize);
        const rightIndex = sizeOrder.indexOf(rightSize);
        if (leftIndex >= 0 && rightIndex >= 0) {
          return leftIndex - rightIndex;
        }
        if (leftIndex >= 0) {
          return -1;
        }
        if (rightIndex >= 0) {
          return 1;
        }
        return String(left.size ?? '').localeCompare(String(right.size ?? ''), 'es', { numeric: true });
      })
      .map((product) => {
        const sizeLabel = normalizeNullableString(product.size) || missingVariant;
        return `${sizeLabel}: ${Number(product.stockAvailable ?? 0)}`;
      });

    lines.push(`${groupName}: ${sizeParts.join(', ')} (total ${groupTotal})`);
  }

  const header = `Tenés ${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'} de ${label}:`;
  const reservedLine =
    totalReserved > 0
      ? `\nAdemás hay ${totalReserved} unidad${totalReserved === 1 ? '' : 'es'} reservada${totalReserved === 1 ? '' : 's'}.`
      : '';

  return `${header}\n${lines.join('\n')}${reservedLine}`;
};
