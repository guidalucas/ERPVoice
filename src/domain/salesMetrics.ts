import type { ParsedActionSell, Product, Transaction } from './types';

export type SaleRow = {
  id: string;
  timestamp: string;
  productName: string;
  productType?: string;
  productModel?: string;
  size?: string;
  qty: number;
  unitPrice: number | null;
  subtotal: number | null;
  priceCurrency: string;
  historical: boolean;
  sourceText: string;
};

const normalizeText = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

const resolveUnitPrice = (action: ParsedActionSell, products: Product[]): number | null => {
  if (action.salePriceKnown === false) return null;
  if (typeof action.price === 'number' && Number.isSafeInteger(action.price) && action.price >= 0) return action.price;
  if (action.salePriceKnown !== undefined) return null;
  // Only unmarked historical records retain the previous catalog estimate.
  let best: Product | null = null;
  let bestScore = 0;
  for (const product of products) {
    const name = normalizeText(product.name);
    const actionName = normalizeText(action.productName);
    let score = actionName && (name.includes(actionName) || actionName.includes(name)) ? 3 : 0;
    if (action.productType && normalizeText(product.productType ?? '') === normalizeText(action.productType)) score += 2;
    if (action.productModel && normalizeText(product.productModel ?? '') === normalizeText(action.productModel)) score += 2;
    if (action.size && normalizeText(product.size ?? '') === normalizeText(action.size)) score += 1;
    if (score > bestScore) { best = product; bestScore = score; }
  }
  return best && Number.isSafeInteger(best.price) && best.price >= 0 ? best.price : null;
};

export const flattenSales = (transactions: Transaction[], products: Product[]): SaleRow[] => transactions.flatMap((transaction) =>
  transaction.actions.flatMap((action, index): SaleRow[] => {
    if (action.type !== 'sell') return [];
    const unitPrice = resolveUnitPrice(action, products);
    const qty = Math.max(0, Number(action.qty) || 0);
    const subtotal = unitPrice === null ? null : unitPrice * qty;
    return [{
      id: `${transaction.id}-sell-${index}`, timestamp: transaction.timestamp,
      productName: action.productName, productType: action.productType, productModel: action.productModel,
      size: action.size, qty, unitPrice,
      subtotal: subtotal !== null && Number.isSafeInteger(subtotal) ? subtotal : null,
      priceCurrency: action.priceCurrency?.trim().toUpperCase() || 'XXX',
      historical: action.salePriceKnown === undefined,
      sourceText: transaction.sourceText,
    }];
  }),
).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

export const formatSaleAmount = (amount: number, currency: string) =>
  `${currency === 'XXX' ? 'Moneda sin especificar' : currency} ${amount.toLocaleString('es-AR')}`;

export const summarizeSales = (sales: SaleRow[]) => {
  const groups = new Map<string, { id: string; currency: string; historical: boolean; amount: number }>();
  let units = 0;
  let unknown = 0;
  let historical = 0;
  for (const sale of sales) {
    units += sale.qty;
    if (sale.historical) historical += 1;
    if (sale.subtotal === null) { unknown += 1; continue; }
    // Unspecified currencies cannot safely be combined even with each other.
    const key = `${sale.priceCurrency}:${sale.historical}:${sale.priceCurrency === 'XXX' ? sale.id : ''}`;
    const group = groups.get(key) ?? { id: key, currency: sale.priceCurrency, historical: sale.historical, amount: 0 };
    if (!Number.isSafeInteger(group.amount + sale.subtotal)) { unknown += 1; continue; }
    group.amount += sale.subtotal;
    groups.set(key, group);
  }
  return { units, unknown, historical, groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)) };
};

export const formatSalesGroup = (group: { amount: number; currency: string; historical: boolean }) =>
  `${formatSaleAmount(group.amount, group.currency)}${group.historical ? ' · histórico (estimado)' : ''}`;
