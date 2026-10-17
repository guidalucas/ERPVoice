import { useMemo, useState } from 'react';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { useInventory } from '../../hooks/useInventory';
import { flattenSales, formatSaleAmount, formatSalesGroup, summarizeSales, type SaleRow } from '../../domain/salesMetrics';
import { EmptyState } from './EmptyState';
import { VoiceQuote } from '../ui/VoiceQuote';

type PeriodFilter = 'hoy' | '7d' | '30d' | 'todo';

const PERIOD_OPTIONS: { id: PeriodFilter; label: string }[] = [
  { id: 'hoy', label: 'Hoy' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
  { id: 'todo', label: 'Todo' },
];

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

  const totals = useMemo(() => summarizeSales(filteredSales), [filteredSales]);

  const trend = useMemo(() => {
    const dayCount = period === 'hoy' ? 1 : period === '7d' ? 7 : 14;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (dayCount - 1));

    const buckets = Array.from({ length: dayCount }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return {
        key: day.toISOString().slice(0, 10),
        label: day.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }),
        units: 0,
      };
    });
    const byKey = Object.fromEntries(buckets.map((bucket) => [bucket.key, bucket]));

    for (const sale of filteredSales) {
      const key = new Date(sale.timestamp).toISOString().slice(0, 10);
      if (byKey[key]) {
        byKey[key].units += sale.qty;
      }
    }

    const max = Math.max(1, ...buckets.map((bucket) => bucket.units));
    return { buckets, max };
  }, [filteredSales, period]);

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

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="kpi-card kpi-card-hero">
          <p className="text-sm type-subtitle text-[color:var(--muted)]">{totals.unknown || totals.historical ? 'Importes parciales por moneda' : 'Total por moneda'}</p>
          <p className="mt-5 type-metric-strong text-[2rem] leading-none erp-brand-gradient-text">
            {totals.groups.length ? totals.groups.map((group) => <span key={group.id} className="block text-2xl">{formatSalesGroup(group)}</span>) : '—'}
          </p>
          {totals.unknown > 0 && <p className="mt-2 text-xs text-[color:var(--muted)]">{totals.unknown} {totals.unknown === 1 ? 'venta sin precio registrado' : 'ventas sin precio registrado'}</p>}
        </div>
        <div className="kpi-card">
          <p className="text-sm type-subtitle text-[color:var(--muted)]">Unidades</p>
          <p className="mt-5 type-metric-strong text-[2rem] leading-none text-[color:var(--text)]">{totals.units}</p>
        </div>
        <div className="kpi-card">
          <p className="text-sm type-subtitle text-[color:var(--muted)]">Tendencia</p>
          <div className="mt-4 flex h-16 items-end gap-1" role="img" aria-label="Unidades vendidas por día">
            {trend.buckets.map((bucket) => (
              <div
                key={bucket.key}
                className="flex h-full min-w-0 flex-1 items-end rounded-sm"
                style={{ background: 'var(--overlay-soft)' }}
                title={`${bucket.label}: ${bucket.units}`}
              >
                <div
                  className="w-full rounded-sm erp-brand-gradient"
                  style={{ height: bucket.units > 0 ? `${Math.max(22, (bucket.units / trend.max) * 100)}%` : '2px' }}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-[color:var(--muted)]">
            {period === 'hoy' ? 'Hoy' : period === '7d' ? 'Últimos 7 días' : 'Últimos 14 días'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setPeriod(option.id)}
            className="activity-filter-chip"
            aria-pressed={period === option.id}
          >
            {option.label}
          </button>
        ))}
      </div>

      {filteredSales.length === 0 ? (
        <EmptyState
          title="Sin ventas"
          description={
            period === 'todo'
              ? 'Todavía no hay ventas registradas. Decí “vendí un producto…” o usá Registrar venta.'
              : 'No hay ventas en este período. Probá ampliar el filtro.'
          }
        />
      ) : (
        <div className="space-y-3">
          {filteredSales.map((sale) => (
            <div key={sale.id} className="inventory-row">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
                  {sale.historical && <p className="mt-1 text-xs text-[color:var(--muted)]">Registro histórico · importe estimado</p>}{sale.sourceText ? <VoiceQuote text={sale.sourceText} /> : null}
                </div>
                <div className="text-right">
                  <p className="type-subtitle text-sm text-[color:var(--text)]">
                    ×{sale.qty}
                    {sale.unitPrice !== null ? ` · ${formatSaleAmount(sale.unitPrice, sale.priceCurrency)}` : ''}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-rose-700 dark:text-rose-200">
                    {sale.subtotal !== null ? formatSaleAmount(sale.subtotal, sale.priceCurrency) : 'Importe desconocido · Sin precio registrado'}
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
