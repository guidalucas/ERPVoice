import { useMemo, useState } from 'react';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { useInventory } from '../../hooks/useInventory';
import type { ParsedActionSell, Product, Transaction } from '../../domain/types';
import { EmptyState } from './EmptyState';

type PeriodFilter = 'hoy' | '7d' | '30d' | 'todo';

type SaleRow = {
  id: string;
  timestamp: string;
  productName: string;
  productType?: string;
  productModel?: string;
  size?: string;
  qty: number;
  unitPrice: number;
  subtotal: number;
  sourceText: string;
  summary: string;
};

const PERIOD_OPTIONS: { id: PeriodFilter; label: string }[] = [
  { id: 'hoy', label: 'Hoy' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
  { id: 'todo', label: 'Todo' },
];

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

const startOfTodayMs = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

const periodSinceMs = (filter: PeriodFilter): number | null => {
  if (filter === 'todo') {
    return null;
  }
  if (filter === 'hoy') {
    return startOfTodayMs();
  }
  const days = filter === '7d' ? 7 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
};

const normalizeText = (value: string) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const resolveUnitPrice = (action: ParsedActionSell, products: Product[]): number => {
  if (typeof action.price === 'number' && Number.isFinite(action.price) && action.price > 0) {
    return action.price;
  }

  const actionName = normalizeText(action.productName);
  const actionType = normalizeText(action.productType ?? '');
  const actionModel = normalizeText(action.productModel ?? '');
  const actionSize = normalizeText(action.size ?? '');

  let best: Product | null = null;
  let bestScore = 0;

  for (const product of products) {
    let score = 0;
    const productName = normalizeText(product.name);
    if (actionName && (productName.includes(actionName) || actionName.includes(productName))) {
      score += 3;
    }
    if (actionType && normalizeText(product.productType ?? '') === actionType) {
      score += 2;
    }
    if (actionModel && normalizeText(product.productModel ?? '') === actionModel) {
      score += 2;
    }
    if (actionSize && normalizeText(product.size ?? '') === actionSize) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }

  return best && best.price > 0 ? best.price : 0;
};

const flattenSales = (transactions: Transaction[], products: Product[]): SaleRow[] => {
  const rows: SaleRow[] = [];

  for (const transaction of transactions) {
    transaction.actions.forEach((action, index) => {
      if (action.type !== 'sell') {
        return;
      }

      const sell = action as ParsedActionSell;
      const unitPrice = resolveUnitPrice(sell, products);
      const qty = Math.max(0, Number(sell.qty) || 0);

      rows.push({
        id: `${transaction.id}-sell-${index}`,
        timestamp: transaction.timestamp,
        productName: sell.productName,
        productType: sell.productType,
        productModel: sell.productModel,
        size: sell.size,
        qty,
        unitPrice,
        subtotal: qty * unitPrice,
        sourceText: transaction.sourceText,
        summary: transaction.summary,
      });
    });
  }

  return rows.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
};

const productLabel = (
  row: SaleRow,
  useVariants: boolean,
): string => {
  const parts = [row.productType, row.productModel, useVariants ? row.size : undefined].filter(Boolean);
  if (parts.length) {
    return parts.join(' ');
  }
  return row.productName;
};

export function VentasPanel() {
  const { transactions, products } = useInventory();
  const preset = useBusinessCategoryPreset();
  const [period, setPeriod] = useState<PeriodFilter>('7d');

  const allSales = useMemo(() => flattenSales(transactions, products), [transactions, products]);

  const filteredSales = useMemo(() => {
    const sinceMs = periodSinceMs(period);
    if (sinceMs === null) {
      return allSales;
    }
    return allSales.filter((sale) => {
      const ts = new Date(sale.timestamp).getTime();
      return !Number.isNaN(ts) && ts >= sinceMs;
    });
  }, [allSales, period]);

  const totals = useMemo(() => {
    let units = 0;
    let amount = 0;
    for (const sale of filteredSales) {
      units += sale.qty;
      amount += sale.subtotal;
    }
    return { units, amount };
  }, [filteredSales]);

  return (
    <article className="erp-panel space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="type-title text-xl text-[color:var(--text)]">Ventas detalladas</h3>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            Cada venta descuenta stock automáticamente. Registradas por voz o desde el panel.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
          <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--muted)]">Unidades</p>
          <p className="mt-2 type-metric-strong text-2xl text-[color:var(--text)]">{totals.units}</p>
        </div>
        <div className="rounded-2xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
          <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--muted)]">Total facturado</p>
          <p className="mt-2 type-metric-strong text-2xl text-[color:var(--text)]">
            {totals.amount > 0 ? formatCurrency(totals.amount) : '—'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.map((option) => {
          const isActive = period === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setPeriod(option.id)}
              className={`min-h-10 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                isActive
                  ? 'bg-rose-500 text-white'
                  : 'text-[color:var(--muted)] hover:bg-slate-900/5 dark:hover:bg-white/10'
              }`}
              style={isActive ? undefined : { background: 'var(--overlay-soft)' }}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {filteredSales.length === 0 ? (
        <EmptyState
          title="Sin ventas"
          description={
            period === 'todo'
              ? 'Todavía no hay ventas registradas. Decí “vendí una camiseta…” o usá − Registrar venta.'
              : 'No hay ventas en este período. Probá ampliar el filtro.'
          }
        />
      ) : (
        <div className="space-y-3">
          {filteredSales.map((sale) => (
            <div
              key={sale.id}
              className="rounded-2xl border px-4 py-3"
              style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-200">
                      Venta
                    </span>
                    <p className="type-subtitle text-sm text-[color:var(--text)]">
                      {productLabel(sale, preset.useVariants)}
                      {preset.useVariants && sale.size && !sale.productType ? (
                        <span className="text-[color:var(--muted)]"> · {sale.size}</span>
                      ) : null}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-[color:var(--muted)]">
                    {new Date(sale.timestamp).toLocaleString('es-AR')}
                  </p>
                  {sale.sourceText ? (
                    <p className="mt-1.5 line-clamp-2 text-sm text-[color:var(--muted)]">“{sale.sourceText}”</p>
                  ) : null}
                </div>
                <div className="text-right">
                  <p className="type-subtitle text-sm text-[color:var(--text)]">
                    ×{sale.qty}
                    {sale.unitPrice > 0 ? ` · ${formatCurrency(sale.unitPrice)}` : ''}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-rose-700 dark:text-rose-200">
                    {sale.subtotal > 0 ? formatCurrency(sale.subtotal) : sale.summary}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
