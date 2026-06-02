import type { ReactNode } from 'react';
import { useState } from 'react';
import { useInventory } from '../../hooks/useInventory';
import { useAuth } from '../../store/AuthStore';
import { ProductsAbmPanel } from './ProductsAbmPanel';
import { RealStockPanel } from './RealStockPanel';
import { MetaMessagesPanel } from './MetaMessagesPanel';

const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;

type SummaryCardProps = {
  title: string;
  value: string;
  subtitle: string;
  icon: ReactNode;
  accentClassName?: string;
};

function SummaryCard({ title, value, subtitle, icon, accentClassName }: SummaryCardProps) {
  return (
    <article className="erp-card min-h-[178px] p-5 transition hover:border-white/20 hover:bg-white/[0.065]">
      <div className="flex h-full flex-col justify-between gap-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[15px] font-medium text-slate-400">{title}</p>
          <div className={`flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-300 ${accentClassName ?? ''}`}>
            {icon}
          </div>
        </div>

        <div className="space-y-1">
          <p className={`font-display text-[2rem] font-bold tracking-tight ${accentClassName ?? 'text-white'}`}>{value}</p>
          <p className="text-sm text-slate-400">{subtitle}</p>
        </div>
      </div>
    </article>
  );
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

function ProductsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="m12 3 8 4.5" />
      <path d="M12 21v-8" />
      <path d="M4 7.5 12 12l8-4.5" />
    </svg>
  );
}

function DebtIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M4 16 9 11l4 4 7-7" />
      <path d="m15 8 5 0v5" />
    </svg>
  );
}

function ClientsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5 fill-none stroke-current stroke-[1.8]">
      <path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function DashboardPanel() {
  const { products, clients, transactions } = useInventory();
  const [activeTab, setActiveTab] = useState<'resumen' | 'stock' | 'abm' | 'whatsapp'>('resumen');
  const { session, logout } = useAuth();

  const tabButtonClass = (tab: typeof activeTab) =>
    `rounded-full px-4 py-2 text-sm font-semibold transition ${activeTab === tab ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/25' : 'bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'}`;

  return (
    <section className="erp-shell flex h-full flex-col gap-4 p-5">
      <header className="rounded-[1.5rem] border border-white/10 bg-slate-900/70 px-6 py-5 text-white shadow-lg shadow-black/20 backdrop-blur-xl">
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-300">Dashboard Web</p>
        <h2 className="font-display text-2xl font-bold">Estado en tiempo real</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="erp-chip text-emerald-300">{session?.phoneNumber ?? 'Sesión desconocida'}</span>
          <button type="button" className="erp-button-secondary px-3 py-1.5 text-xs" onClick={logout}>
            Salir
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 rounded-3xl border border-white/10 bg-white/5 p-2">
          <button type="button" className={tabButtonClass('resumen')} onClick={() => setActiveTab('resumen')}>
            Resumen
          </button>
          <button type="button" className={tabButtonClass('stock')} onClick={() => setActiveTab('stock')}>
            Stock real
          </button>
          <button type="button" className={tabButtonClass('abm')} onClick={() => setActiveTab('abm')}>
            ABM productos
          </button>
          <button type="button" className={tabButtonClass('whatsapp')} onClick={() => setActiveTab('whatsapp')}>
            WhatsApp / Meta
          </button>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-4">
        {activeTab === 'resumen' && (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:col-span-4 xl:grid-cols-4">
              <SummaryCard
                title="Valor Inventario"
                value={formatCurrency(products.reduce((total, product) => total + (product.stockAvailable + product.stockReserved) * product.price, 0))}
                subtitle={`${products.reduce((total, product) => total + product.stockAvailable + product.stockReserved, 0)} unidades totales`}
                icon={<InventoryIcon />}
              />
              <SummaryCard
                title="Productos"
                value={String(products.length)}
                subtitle="SKUs en catálogo"
                icon={<ProductsIcon />}
              />
              <SummaryCard
                title="Deuda Total"
                value={formatCurrency(clients.reduce((total, client) => total + Math.max(0, -client.debt), 0))}
                subtitle={`${clients.filter((client) => client.debt < 0).length} clientes con deuda`}
                icon={<DebtIcon />}
                accentClassName="text-rose-400"
              />
              <SummaryCard
                title="Clientes"
                value={String(clients.length)}
                subtitle="Cuentas corrientes"
                icon={<ClientsIcon />}
              />
            </div>

            <article className="erp-panel xl:col-span-2">
              <h3 className="font-display text-lg font-bold text-slate-100">Últimas Transacciones</h3>
              <div className="mt-4 space-y-3">
                {transactions.length === 0 ? (
                  <div className="erp-card-soft text-sm text-slate-400">Todavía no hay transacciones confirmadas.</div>
                ) : (
                  transactions.map((transaction) => (
                    <div key={transaction.id} className="flex items-center justify-between border-b border-white/10 pb-3 last:border-0 last:pb-0">
                      <div>
                        <p className="text-sm font-semibold text-slate-100">{transaction.summary}</p>
                        <p className="mt-1 text-xs text-slate-400">{new Date(transaction.timestamp).toLocaleString('es-AR')}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article className="erp-panel xl:col-span-2">
              <h3 className="font-display text-lg font-bold text-slate-100">Cuentas Corrientes</h3>
              <div className="mt-4 space-y-3">
                {clients.map((client) => (
                  <div key={client.id} className="flex items-center justify-between border-b border-white/10 pb-3 last:border-0 last:pb-0">
                    <div>
                      <p className="font-semibold text-slate-100">{client.name}</p>
                      <p className="mt-1 text-xs text-slate-400">Actualizado: {new Date().toLocaleString('es-AR')}</p>
                    </div>
                    <p className={`text-sm font-mono font-semibold ${client.debt < 0 ? 'text-rose-500' : 'text-emerald-400'}`}>
                      {client.debt < 0 ? `-$ ${Math.abs(client.debt).toLocaleString('es-AR')}` : `$ ${client.debt.toLocaleString('es-AR')}`}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </>
        )}

        {activeTab === 'stock' && (
          <div className="xl:col-span-4">
            <RealStockPanel />
          </div>
        )}

        {activeTab === 'abm' && (
          <div className="xl:col-span-4">
            <ProductsAbmPanel />
          </div>
        )}

        {activeTab === 'whatsapp' && (
          <div className="xl:col-span-4">
            <MetaMessagesPanel />
          </div>
        )}
      </div>
    </section>
  );
}