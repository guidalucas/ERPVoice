import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useInventory } from '../../hooks/useInventory';
import { useAuth } from '../../store/AuthStore';
import type { Transaction } from '../../domain/types';
import { ClientesPanel } from './ClientesPanel';
import { DashboardShell } from './DashboardShell';
import { LOW_STOCK_THRESHOLD, type DashboardSection } from './dashboardTypes';
import { MetaMessagesPanel } from './MetaMessagesPanel';
import { PedidosPanel } from './PedidosPanel';
import { ProductsAbmPanel } from './ProductsAbmPanel';
import { RealStockPanel } from './RealStockPanel';
import { EmptyState } from './EmptyState';

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

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

function StockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="M12 21v-8" />
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

type ActivityGroup = {
  id: string;
  sourceText: string;
  timestamp: string;
  items: Transaction[];
};

type ActivityFilter = 'all' | 'ingresos' | 'pedidos' | 'voz';

const ACTIVITY_FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'ingresos', label: 'Ingresos' },
  { id: 'pedidos', label: 'Pedidos' },
  { id: 'voz', label: 'Voz' },
];

const PAGE_SIZE = 8;

const groupTransactions = (transactions: Transaction[]): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];

  for (const transaction of transactions) {
    const ts = new Date(transaction.timestamp).getTime();
    const last = groups[groups.length - 1];

    if (last && last.sourceText === transaction.sourceText && Math.abs(new Date(last.timestamp).getTime() - ts) <= 5000) {
      last.items.push(transaction);
      continue;
    }

    groups.push({
      id: transaction.id,
      sourceText: transaction.sourceText,
      timestamp: transaction.timestamp,
      items: [transaction],
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
    return <EmptyState title="Sin actividad" description="Las cargas por voz y WhatsApp aparecen acá agrupadas por sesión." />;
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
            const isVoiceLoad = group.items.every((item) => item.actions.some((action) => action.type === 'add_stock'));
            const title =
              group.items.length > 1
                ? `${isVoiceLoad ? 'Carga por voz' : 'Sesión'} — ${group.items.length} items`
                : group.items[0]?.summary ?? group.sourceText;

            return (
              <div key={group.id} className="rounded-2xl border" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
                  onClick={() => setExpandedIds((current) => ({ ...current, [group.id]: !current[group.id] }))}
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
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

export function DashboardPanel() {
  const { products, transactions, pedidos } = useInventory();
  const [activeSection, setActiveSection] = useState<DashboardSection>('inicio');
  const [filterLowStock, setFilterLowStock] = useState(false);
  const { session, logout } = useAuth();

  const totalUnits = products.reduce((total, product) => total + product.stockAvailable + product.stockReserved, 0);
  const inventoryValue = products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0);
  const lowStockProducts = products.filter((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD);
  const pendingPedidos = pedidos.filter((pedido) => pedido.estado === 'pendiente').length;

  const goToLowStock = () => {
    setFilterLowStock(true);
    setActiveSection('stock');
  };

  return (
    <DashboardShell
      activeSection={activeSection}
      onSectionChange={(section) => {
        if (section !== 'stock') {
          setFilterLowStock(false);
        }
        setActiveSection(section);
      }}
      phoneNumber={session?.phoneNumber}
      onLogout={logout}
    >
      {activeSection === 'inicio' && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <SummaryCard
              title="Valor inventario"
              value={formatCurrency(inventoryValue)}
              subtitle={`${totalUnits} unidades totales`}
              icon={<InventoryIcon />}
            />
            <SummaryCard
              title="Stock disponible"
              value={String(products.reduce((total, product) => total + product.stockAvailable, 0))}
              subtitle={`${products.length} variantes en catálogo`}
              icon={<StockIcon />}
              onClick={() => setActiveSection('stock')}
            />
            <SummaryCard
              title="Stock bajo / agotado"
              value={String(lowStockProducts.length)}
              subtitle={lowStockProducts.length ? 'Ver productos con poco stock' : 'Todo en orden'}
              icon={<AlertIcon />}
              accentClassName={lowStockProducts.length ? 'text-amber-600 dark:text-amber-300' : undefined}
              onClick={goToLowStock}
            />
          </div>

          {pendingPedidos > 0 && (
            <button
              type="button"
              onClick={() => setActiveSection('pedidos')}
              className="w-full rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-left transition hover:bg-emerald-500/15"
            >
              <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                {pendingPedidos} pedido{pendingPedidos === 1 ? '' : 's'} pendiente{pendingPedidos === 1 ? '' : 's'}
              </p>
              <p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-200/70">Abrir vista agrupada para armar el pedido al proveedor</p>
            </button>
          )}

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

      {activeSection === 'stock' && (
        <div className="space-y-3">
          {filterLowStock && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3">
              <p className="text-sm text-amber-900 dark:text-amber-100">
                Mostrando {lowStockProducts.length} producto{lowStockProducts.length === 1 ? '' : 's'} con stock ≤ {LOW_STOCK_THRESHOLD}
              </p>
              <button type="button" className="text-xs font-semibold text-amber-900 dark:text-amber-100" onClick={() => setFilterLowStock(false)}>
                Quitar filtro
              </button>
            </div>
          )}
          <RealStockPanel filterProductIds={filterLowStock ? lowStockProducts.map((product) => product.id) : undefined} />
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
    </DashboardShell>
  );
}
