import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useInventory } from '../../hooks/useInventory';
import { useAuth } from '../../store/AuthStore';
import type { ParsedActionUnion, Transaction } from '../../domain/types';
import { ClientesPanel } from './ClientesPanel';
import { DashboardShell } from './DashboardShell';
import { LOW_STOCK_THRESHOLD, type DashboardSection } from './dashboardTypes';
import { MetaMessagesPanel } from './MetaMessagesPanel';
import { PedidosPanel } from './PedidosPanel';
import { ProductsAbmPanel } from './ProductsAbmPanel';
import { EmptyState } from './EmptyState';
import { StockMovementModal, type StockMovementMode } from './StockMovementModal';

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

const SALES_PERIOD_DAYS = 7;

type SummaryCardProps = {
  title: string;
  value: string;
  subtitle: string;
  icon: ReactNode;
  accentClassName?: string;
  onClick?: () => void;
};

function SummaryCard({ title, value, subtitle, icon, accentClassName, onClick }: SummaryCardProps) {
  const content = (
    <div className="flex h-full flex-col justify-between gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] font-medium text-slate-600 dark:text-slate-400">{title}</p>
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-xl border text-slate-600 dark:text-slate-300 ${accentClassName ?? ''}`}
          style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
        >
          {icon}
        </div>
      </div>
      <div className="space-y-1">
        <p className={`font-display text-[2rem] font-bold tracking-tight ${accentClassName ?? 'text-slate-900 dark:text-white'}`}>{value}</p>
        <p className="text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
      </div>
    </div>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="erp-card min-h-[158px] w-full p-5 text-left transition hover:border-emerald-500/30">
        {content}
      </button>
    );
  }

  return <article className="erp-card min-h-[158px] p-5 transition hover:border-emerald-500/30">{content}</article>;
}

function InventoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M12 3 4 7l8 4 8-4-8-4Z" />
      <path d="M4 7v10l8 4 8-4V7" />
      <path d="m12 11 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function SalesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M4 19h16" />
      <path d="M7 16V9" />
      <path d="M12 16V5" />
      <path d="M17 16v-7" />
    </svg>
  );
}

function OrdersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

type ActivityKind = 'ingreso' | 'venta' | 'pedido' | 'mixto';

type ActivityGroup = {
  id: string;
  sourceText: string;
  timestamp: string;
  items: Transaction[];
  kind: ActivityKind;
};

const actionKinds = (actions: ParsedActionUnion[]): ActivityKind[] => {
  const kinds = new Set<ActivityKind>();
  for (const action of actions) {
    if (action.type === 'add_stock') kinds.add('ingreso');
    else if (action.type === 'sell') kinds.add('venta');
    else if (action.type === 'client_order') kinds.add('pedido');
  }
  return [...kinds];
};

const resolveGroupKind = (items: Transaction[]): ActivityKind => {
  const kinds = new Set<ActivityKind>();
  for (const item of items) {
    for (const kind of actionKinds(item.actions)) {
      kinds.add(kind);
    }
  }
  if (kinds.size === 1) {
    return [...kinds][0]!;
  }
  if (kinds.size === 0) {
    return 'mixto';
  }
  return 'mixto';
};

const kindMeta: Record<ActivityKind, { tag: string; label: string; className: string }> = {
  ingreso: { tag: '+', label: 'Ingreso', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200' },
  venta: { tag: '−', label: 'Venta', className: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200' },
  pedido: { tag: 'P', label: 'Pedido', className: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200' },
  mixto: { tag: '•', label: 'Movimiento', className: 'border-[color:var(--border)] bg-[color:var(--overlay-soft)] text-slate-700 dark:text-slate-300' },
};

type ActivityFilter = 'all' | 'ingresos' | 'ventas' | 'pedidos' | 'voz';

const ACTIVITY_FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'ingresos', label: 'Ingresos' },
  { id: 'ventas', label: 'Ventas' },
  { id: 'pedidos', label: 'Pedidos' },
  { id: 'voz', label: 'Voz' },
];

const PAGE_SIZE = 8;

const groupTransactions = (transactions: Transaction[]): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];

  for (const transaction of transactions) {
    const ts = new Date(transaction.timestamp).getTime();
    const last = groups[groups.length - 1];
    const kind = resolveGroupKind([transaction]);
    const canMergeWithLast =
      last &&
      last.sourceText === transaction.sourceText &&
      Math.abs(new Date(last.timestamp).getTime() - ts) <= 5000 &&
      last.kind === 'ingreso' &&
      kind === 'ingreso';

    if (canMergeWithLast) {
      last.items.push(transaction);
      continue;
    }

    groups.push({
      id: transaction.id,
      sourceText: transaction.sourceText,
      timestamp: transaction.timestamp,
      items: [transaction],
      kind,
    });
  }

  return groups;
};

const matchesActivityFilter = (transaction: Transaction, filter: ActivityFilter): boolean => {
  if (filter === 'all') {
    return true;
  }

  const actionTypes = transaction.actions.map((action) => action.type);

  if (filter === 'ingresos') {
    return actionTypes.includes('add_stock');
  }

  if (filter === 'ventas') {
    return actionTypes.includes('sell');
  }

  if (filter === 'pedidos') {
    return actionTypes.includes('client_order') || actionTypes.includes('reserve_stock');
  }

  if (filter === 'voz') {
    return Boolean(transaction.sourceText?.trim());
  }

  return true;
};

function ActivityFeed({ transactions, showFilters = true }: { transactions: Transaction[]; showFilters?: boolean }) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const filteredTransactions = useMemo(
    () => transactions.filter((transaction) => matchesActivityFilter(transaction, filter)),
    [transactions, filter],
  );

  const groups = useMemo(() => groupTransactions(filteredTransactions), [filteredTransactions]);
  const visibleGroups = groups.slice(0, visibleCount);
  const hasMore = groups.length > visibleCount;

  if (transactions.length === 0) {
    return <EmptyState title="Sin actividad" description="Las cargas por voz, ventas y pedidos aparecen acá." />;
  }

  return (
    <div className="space-y-3">
      {showFilters && (
        <div className="flex flex-wrap gap-2">
          {ACTIVITY_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="activity-filter-chip"
              aria-pressed={filter === item.id}
              onClick={() => {
                setFilter(item.id);
                setVisibleCount(PAGE_SIZE);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyState title="Sin resultados" description="No hay actividad para este filtro." />
      ) : (
        <>
          {visibleGroups.map((group) => {
            const isExpanded = Boolean(expandedIds[group.id]);
            const meta = kindMeta[group.kind];
            const title =
              group.items.length > 1 && group.kind === 'ingreso'
                ? `Carga por voz — ${group.items.length} items`
                : group.items[0]?.summary ?? group.sourceText;

            return (
              <div key={group.id} className="rounded-2xl border" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
                  onClick={() => setExpandedIds((current) => ({ ...current, [group.id]: !current[group.id] }))}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.className}`}>
                        <span aria-hidden="true">{meta.tag}</span>
                        {meta.label}
                      </span>
                      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{new Date(group.timestamp).toLocaleString('es-AR')}</p>
                    {group.sourceText && (
                      <p className="mt-1.5 line-clamp-2 text-sm text-slate-600 dark:text-slate-300">“{group.sourceText}”</p>
                    )}
                  </div>
                  {group.items.length > 1 && (
                    <span className="shrink-0 text-xs font-semibold text-emerald-700 dark:text-emerald-300">{isExpanded ? 'Ocultar' : 'Ver'}</span>
                  )}
                </button>
                {(isExpanded || group.items.length === 1) && group.items.length > 1 && (
                  <div className="space-y-2 border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                    {group.items.map((item) => (
                      <p key={item.id} className="text-sm text-slate-700 dark:text-slate-300">
                        {item.summary}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {hasMore && (
            <button
              type="button"
              className="erp-button-secondary w-full text-sm"
              onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
            >
              Cargar más ({groups.length - visibleCount} restantes)
            </button>
          )}
        </>
      )}
    </div>
  );
}

const sumSellMetrics = (transactions: Transaction[], sinceMs: number) => {
  let units = 0;
  let amount = 0;

  for (const transaction of transactions) {
    const ts = new Date(transaction.timestamp).getTime();
    if (Number.isNaN(ts) || ts < sinceMs) {
      continue;
    }

    for (const action of transaction.actions) {
      if (action.type !== 'sell') {
        continue;
      }
      units += action.qty;
      if (typeof action.price === 'number' && Number.isFinite(action.price)) {
        amount += action.qty * action.price;
      }
    }
  }

  return { units, amount };
};

export function DashboardPanel() {
  const { products, transactions, pedidos, applyActions } = useInventory();
  const [activeSection, setActiveSection] = useState<DashboardSection>('inicio');
  const [movementMode, setMovementMode] = useState<StockMovementMode | null>(null);
  const { session, logout } = useAuth();

  const totalUnits = products.reduce((total, product) => total + product.stockAvailable + product.stockReserved, 0);
  const inventoryValue = products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0);
  const lowStockProducts = products.filter((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD);
  const pendingPedidos = pedidos.filter((pedido) => pedido.estado === 'pendiente').length;

  const salesPeriod = useMemo(() => {
    const sinceMs = Date.now() - SALES_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    return sumSellMetrics(transactions, sinceMs);
  }, [transactions]);

  return (
    <DashboardShell
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      phoneNumber={session?.phoneNumber}
      onLogout={logout}
    >
      {activeSection === 'inicio' && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              title="Valor inventario"
              value={formatCurrency(inventoryValue)}
              subtitle={`${totalUnits} unidades totales`}
              icon={<InventoryIcon />}
            />
            <SummaryCard
              title="Stock bajo / agotado"
              value={String(lowStockProducts.length)}
              subtitle={lowStockProducts.length ? `≤ ${LOW_STOCK_THRESHOLD} u. disponibles` : 'Todo en orden'}
              icon={<AlertIcon />}
              accentClassName={lowStockProducts.length ? 'text-amber-600 dark:text-amber-300' : undefined}
              onClick={() => setActiveSection('productos')}
            />
            <SummaryCard
              title="Ventas del período"
              value={String(salesPeriod.units)}
              subtitle={
                salesPeriod.amount > 0
                  ? `${formatCurrency(salesPeriod.amount)} · últimos ${SALES_PERIOD_DAYS} días`
                  : `Unidades · últimos ${SALES_PERIOD_DAYS} días`
              }
              icon={<SalesIcon />}
            />
            <SummaryCard
              title="Pedidos pendientes"
              value={String(pendingPedidos)}
              subtitle={pendingPedidos ? 'Abrir módulo de pedidos' : 'Sin pedidos en cola'}
              icon={<OrdersIcon />}
              accentClassName={pendingPedidos ? 'text-emerald-700 dark:text-emerald-300' : undefined}
              onClick={() => setActiveSection('pedidos')}
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <button type="button" className="erp-button-primary" onClick={() => setMovementMode('ingreso')}>
              + Registrar ingreso
            </button>
            <button type="button" className="erp-button-danger" onClick={() => setMovementMode('venta')}>
              − Registrar venta
            </button>
          </div>

          <article className="erp-panel">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100">Actividad reciente</h3>
              <button type="button" className="text-xs font-semibold text-emerald-700 dark:text-emerald-300" onClick={() => setActiveSection('actividad')}>
                Ver todo
              </button>
            </div>
            <ActivityFeed transactions={transactions} />
          </article>
        </div>
      )}

      {activeSection === 'productos' && <ProductsAbmPanel />}
      {activeSection === 'pedidos' && <PedidosPanel />}
      {activeSection === 'clientes' && <ClientesPanel />}

      {activeSection === 'actividad' && (
        <div className="space-y-4">
          <article className="erp-panel">
            <h3 className="mb-4 font-display text-lg font-bold text-slate-900 dark:text-slate-100">Movimientos</h3>
            <ActivityFeed transactions={transactions} />
          </article>
          <MetaMessagesPanel />
        </div>
      )}

      {movementMode && (
        <StockMovementModal mode={movementMode} products={products} onClose={() => setMovementMode(null)} onSubmit={applyActions} />
      )}
    </DashboardShell>
  );
}
