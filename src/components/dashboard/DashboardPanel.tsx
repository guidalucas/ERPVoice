import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { ChartBar, ClipboardText, Package, Warning } from '@phosphor-icons/react';
import { useInventory } from '../../hooks/useInventory';
import { useAuth } from '../../store/AuthStore';
import type { ParsedActionUnion, Transaction } from '../../domain/types';
import { ClientesPanel } from './ClientesPanel';
import { DashboardShell } from './DashboardShell';
import { EquipoPanel } from './EquipoPanel';
import { LOW_STOCK_THRESHOLD, type DashboardSection } from './dashboardTypes';
import { MetaMessagesPanel } from './MetaMessagesPanel';
import { PedidosPanel } from './PedidosPanel';
import { ProductsAbmPanel } from './ProductsAbmPanel';
import { ProveedoresPanel } from './ProveedoresPanel';
import { EmptyState } from './EmptyState';
import { StockMovementModal, type StockMovementMode } from './StockMovementModal';
import { VentasPanel } from './VentasPanel';
import { VoiceQuote } from '../ui/VoiceQuote';

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

const SALES_PERIOD_DAYS = 7;

type SummaryCardProps = {
  title: string;
  value: string;
  subtitle: string;
  icon: ReactNode;
  variant?: 'default' | 'hero' | 'alert';
  className?: string;
  onClick?: () => void;
};

function SummaryCard({ title, value, subtitle, icon, variant = 'default', className = '', onClick }: SummaryCardProps) {
  const valueClass =
    variant === 'hero'
      ? 'type-metric-strong text-[2.35rem] leading-none sm:text-[2.75rem] erp-brand-gradient-text'
      : variant === 'alert'
        ? 'type-metric-strong text-[2.15rem] leading-none text-[color:var(--warning)]'
        : 'type-metric-strong text-[2rem] leading-none text-[color:var(--text)]';

  const content = (
    <div className="relative flex h-full flex-col justify-between gap-5">
      <p className="text-sm type-subtitle text-[color:var(--muted)]">{title}</p>
      <div className="space-y-2">
        <p className={valueClass}>{value}</p>
        <p className="text-sm text-[color:var(--muted)]">{subtitle}</p>
      </div>
      <span className="pointer-events-none absolute right-0 top-0 text-[color:var(--muted)] opacity-50" aria-hidden="true">
        {icon}
      </span>
    </div>
  );

  const cardClass = `kpi-card w-full ${variant === 'hero' ? 'kpi-card-hero' : ''} ${variant === 'alert' ? 'kpi-card-alert' : ''} ${className}`;

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cardClass}>
        {content}
      </button>
    );
  }

  return <article className={cardClass}>{content}</article>;
}

function InventoryIcon() {
  return <Package size={18} weight="regular" />;
}

function AlertIcon() {
  return <Warning size={18} weight="regular" />;
}

function SalesIcon() {
  return <ChartBar size={18} weight="regular" />;
}

function OrdersIcon() {
  return <ClipboardText size={18} weight="regular" />;
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
    else if (action.type === 'client_order' || action.type === 'update_pedido' || action.type === 'delete_pedido') kinds.add('pedido');
    else if (action.type === 'update_product' || action.type === 'delete_product') kinds.add('ingreso');
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
  mixto: { tag: '•', label: 'Movimiento', className: 'border-[color:var(--border)] bg-[color:var(--overlay-soft)] text-[color:var(--muted)]' },
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
      ((last.kind === 'ingreso' && kind === 'ingreso') || (last.kind === 'pedido' && kind === 'pedido'));

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

const uniqueTrimmedNames = (values: Array<string | undefined | null>): string[] => {
  const names: string[] = [];
  for (const value of values) {
    const name = value?.trim();
    if (name && !names.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
      names.push(name);
    }
  }
  return names;
};

const pedidoPartyNames = (items: Transaction[]) => {
  const clients: string[] = [];
  const proveedores: string[] = [];

  for (const item of items) {
    for (const action of item.actions) {
      if (action.type !== 'client_order') {
        continue;
      }
      clients.push(action.clientName ?? '');
      proveedores.push(action.proveedorName ?? '');
    }
  }

  return {
    clients: uniqueTrimmedNames(clients),
    proveedores: uniqueTrimmedNames(proveedores),
  };
};

const pedidoGroupHeader = (items: Transaction[]): string => {
  const { clients, proveedores } = pedidoPartyNames(items);
  if (clients.length === 1 && proveedores.length === 1) {
    return `Pedido de ${clients[0]} · proveedor ${proveedores[0]}`;
  }
  if (clients.length === 1) {
    return `Pedido de ${clients[0]}`;
  }
  if (proveedores.length === 1) {
    return `Pedido al proveedor ${proveedores[0]}`;
  }
  if (clients.length > 1) {
    return `Pedidos (${clients.join(', ')})`;
  }
  if (proveedores.length > 1) {
    return `Pedidos a proveedores (${proveedores.join(', ')})`;
  }
  return 'Pedido';
};

const activityGroupTitle = (group: ActivityGroup): string => {
  if (group.items.length > 1 && group.kind === 'ingreso') {
    return `Carga por voz · ${group.items.length} items`;
  }

  if (group.kind === 'pedido') {
    const count = group.items.length;
    const productWord = count === 1 ? 'producto' : 'productos';
    const header = pedidoGroupHeader(group.items);

    if (count === 1) {
      return `${header}: ${group.items[0]?.summary ?? productWord}`;
    }

    return `${header} · ${count} ${productWord}`;
  }

  return group.items[0]?.summary ?? group.sourceText;
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
    return actionTypes.includes('client_order') || actionTypes.includes('reserve_stock') || actionTypes.includes('update_pedido') || actionTypes.includes('delete_pedido');
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
            const title = activityGroupTitle(group);

            return (
              <div key={group.id} className="inventory-row">
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => setExpandedIds((current) => ({ ...current, [group.id]: !current[group.id] }))}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.className}`}>
                        <span aria-hidden="true">{meta.tag}</span>
                        {meta.label}
                      </span>
                      <p className="text-sm type-subtitle text-[color:var(--text)]">{title}</p>
                    </div>
                    <p className="mt-1 text-xs text-[color:var(--muted)]">{new Date(group.timestamp).toLocaleString('es-AR')}</p>
                    {group.sourceText && <VoiceQuote text={group.sourceText} />}
                  </div>
                  {group.items.length > 1 && group.kind !== 'pedido' && (
                    <span className="erp-toggle-link shrink-0 text-sm">{isExpanded ? 'Ocultar' : 'Ver'}</span>
                  )}
                </button>
                {group.items.length > 1 && (isExpanded || group.kind === 'pedido') && (
                  <ul className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                    {group.items.map((item) => (
                      <li key={item.id} className="text-sm text-[color:var(--muted)]">
                        {item.summary}
                      </li>
                    ))}
                  </ul>
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
  const [productsStockFilter, setProductsStockFilter] = useState<'all' | 'low-stock'>('all');
  const [movementMode, setMovementMode] = useState<StockMovementMode | null>(null);
  const { session, logout } = useAuth();
  const [teamOpen, setTeamOpen] = useState(false);

  const totalUnits = products.reduce((total, product) => total + product.stockAvailable + product.stockReserved, 0);
  const inventoryValue = products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0);
  const lowStockProducts = products.filter((product) => product.stockAvailable <= LOW_STOCK_THRESHOLD);
  const pendingPedidos = pedidos.filter((pedido) => pedido.estado === 'pendiente').length;

  const salesPeriod = useMemo(() => {
    const sinceMs = Date.now() - SALES_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    return sumSellMetrics(transactions, sinceMs);
  }, [transactions]);

  const handleSectionChange = (section: DashboardSection) => {
    setActiveSection(section);
    if (section !== 'productos') {
      setProductsStockFilter('all');
    }
  };

  const openLowStockProducts = () => {
    setProductsStockFilter('low-stock');
    setActiveSection('productos');
  };

  return (
    <DashboardShell
      activeSection={activeSection}
      onSectionChange={handleSectionChange}
      phoneNumber={session?.phoneNumber}
      businessName={session?.businessName}
      role={session?.role}
      onOpenTeam={() => setTeamOpen(true)}
      onLogout={logout}
    >
      {activeSection === 'inicio' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-12">
            <SummaryCard
              title="Valor inventario"
              value={formatCurrency(inventoryValue)}
              subtitle={`${totalUnits} unidades en stock`}
              icon={<InventoryIcon />}
              variant="hero"
              className="sm:col-span-2 xl:col-span-5"
            />
            <SummaryCard
              title="Stock bajo / agotado"
              value={String(lowStockProducts.length)}
              subtitle={lowStockProducts.length ? `≤ ${LOW_STOCK_THRESHOLD} u. disponibles` : 'Todo en orden'}
              icon={<AlertIcon />}
              variant={lowStockProducts.length ? 'alert' : 'default'}
              className="xl:col-span-4"
              onClick={openLowStockProducts}
            />
            <SummaryCard
              title="Pedidos pendientes"
              value={String(pendingPedidos)}
              subtitle={pendingPedidos ? 'Para armar y marcar' : 'Nada en cola'}
              icon={<OrdersIcon />}
              variant={pendingPedidos ? 'alert' : 'default'}
              className="xl:col-span-3"
              onClick={() => handleSectionChange('pedidos')}
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
              className="xl:col-span-4"
              onClick={() => handleSectionChange('ventas')}
            />
            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2 xl:col-span-8">
              <button type="button" className="erp-button-primary min-h-14 text-base" onClick={() => setMovementMode('ingreso')}>
                Registrar ingreso
              </button>
              <button type="button" className="erp-button-danger min-h-14 text-base" onClick={() => setMovementMode('venta')}>
                Registrar venta
              </button>
            </div>
          </div>

          <article className="erp-panel">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="type-title text-lg text-[color:var(--text)]">Actividad reciente</h3>
              <button
                type="button"
                className="erp-accent-text inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold"
                onClick={() => handleSectionChange('actividad')}
              >
                Ver todo
              </button>
            </div>
            <ActivityFeed transactions={transactions} />
          </article>
        </div>
      )}

      {activeSection === 'productos' && (
        <ProductsAbmPanel stockFilter={productsStockFilter} onStockFilterChange={setProductsStockFilter} />
      )}
      {activeSection === 'pedidos' && <PedidosPanel />}
      {activeSection === 'ventas' && <VentasPanel />}
      {activeSection === 'clientes' && <ClientesPanel />}
      {activeSection === 'proveedores' && <ProveedoresPanel />}

      {activeSection === 'actividad' && (
        <div className="space-y-4">
          <article className="erp-panel">
            <h3 className="mb-4 type-title text-lg text-[color:var(--text)]">Movimientos</h3>
            <ActivityFeed transactions={transactions} />
          </article>
          <MetaMessagesPanel />
        </div>
      )}

      {movementMode && (
        <StockMovementModal mode={movementMode} products={products} onClose={() => setMovementMode(null)} onSubmit={applyActions} />
      )}
      {teamOpen && <EquipoPanel onClose={() => setTeamOpen(false)} />}
    </DashboardShell>
  );
}
