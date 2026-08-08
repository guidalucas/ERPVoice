import type { ReactNode } from 'react';
import { DashboardNav, sectionTitles } from './DashboardNav';
import type { DashboardSection } from './dashboardTypes';

type DashboardShellProps = {
  activeSection: DashboardSection;
  onSectionChange: (section: DashboardSection) => void;
  phoneNumber?: string | null;
  onLogout: () => void;
  children: ReactNode;
};

export function DashboardShell({ activeSection, onSectionChange, phoneNumber, onLogout, children }: DashboardShellProps) {
  return (
    <div className="dashboard-layout">
      <aside className="dashboard-sidebar hidden lg:flex">
        <div className="flex items-center gap-3 px-2 pb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
              <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Zm5-3a1 1 0 1 0-2 0 3 3 0 0 1-6 0 1 1 0 1 0-2 0 5 5 0 0 0 4 4.9V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-3.1a5 5 0 0 0 4-4.9Z" />
            </svg>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.35em] text-emerald-300">Stocky</p>
            <p className="font-display text-sm font-bold text-white">FullMatch</p>
          </div>
        </div>

        <DashboardNav activeSection={activeSection} onSectionChange={onSectionChange} variant="sidebar" />

        <div className="mt-auto space-y-3 border-t border-white/10 pt-4">
          {phoneNumber && (
            <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Sesión</p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-200">{phoneNumber}</p>
            </div>
          )}
          <button type="button" className="erp-button-secondary w-full text-sm" onClick={onLogout}>
            Salir
          </button>
        </div>
      </aside>

      <div className="dashboard-main min-w-0 flex-1">
        <header className="mb-4 flex items-center justify-between gap-3 lg:hidden">
          <div>
            <p className="text-[10px] uppercase tracking-[0.35em] text-emerald-300">Stocky</p>
            <h2 className="font-display text-xl font-bold text-white">{sectionTitles[activeSection]}</h2>
          </div>
          <button type="button" className="erp-button-secondary shrink-0 px-3 py-1.5 text-xs" onClick={onLogout}>
            Salir
          </button>
        </header>

        <header className="mb-5 hidden lg:block">
          <h2 className="font-display text-2xl font-bold text-white">{sectionTitles[activeSection]}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {activeSection === 'inicio' && 'Resumen de stock y actividad reciente'}
            {activeSection === 'productos' && 'Catálogo, stock y precios por modelo'}
            {activeSection === 'pedidos' && 'Qué te pidieron, agrupado para armar el pedido al proveedor'}
            {activeSection === 'clientes' && 'Clientes y sus pedidos'}
            {activeSection === 'actividad' && 'Cargas por voz y mensajes recientes'}
          </p>
        </header>

        {children}
      </div>

      <DashboardNav activeSection={activeSection} onSectionChange={onSectionChange} variant="bottom" />
    </div>
  );
}
