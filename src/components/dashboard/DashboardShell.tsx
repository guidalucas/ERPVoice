import type { ReactNode } from 'react';
import { DashboardNav, sectionTitles } from './DashboardNav';
import type { DashboardSection } from './dashboardTypes';
import { ThemeToggle } from './ThemeToggle';

type DashboardShellProps = {
  activeSection: DashboardSection;
  onSectionChange: (section: DashboardSection) => void;
  phoneNumber?: string | null;
  onLogout: () => void;
  children: ReactNode;
};

function formatPhoneDisplay(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');

  if (digits.length === 13 && digits.startsWith('54')) {
    const area = digits.slice(2, 4);
    const local = digits.slice(4);
    return `+54 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length === 12 && digits.startsWith('54')) {
    const area = digits.slice(2, 4);
    const local = digits.slice(4);
    return `+54 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length >= 10) {
    return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -6)} ${digits.slice(-6, -4)}-${digits.slice(-4)}`.trim();
  }

  return phoneNumber;
}

function phoneInitials(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length >= 2) {
    return digits.slice(-2);
  }
  return 'U';
}

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
            <p className="text-[10px] uppercase tracking-[0.35em] text-emerald-600 dark:text-emerald-300">Stocky</p>
            <p className="font-display text-sm font-bold text-slate-900 dark:text-white">FullMatch</p>
          </div>
        </div>

        <DashboardNav activeSection={activeSection} onSectionChange={onSectionChange} variant="sidebar" />

        <div className="mt-auto space-y-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          {phoneNumber && (
            <div className="rounded-2xl border px-3 py-2.5" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                  {phoneInitials(phoneNumber)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Cuenta</p>
                  <p className="mt-0.5 truncate text-sm font-semibold text-slate-800 dark:text-slate-200">{formatPhoneDisplay(phoneNumber)}</p>
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button type="button" className="erp-button-secondary flex-1 text-sm" onClick={onLogout}>
              Salir
            </button>
          </div>
        </div>
      </aside>

      <div className="dashboard-main min-w-0 flex-1">
        <header className="mb-4 flex items-center justify-between gap-3 lg:hidden">
          <div>
            <p className="text-[10px] uppercase tracking-[0.35em] text-emerald-600 dark:text-emerald-300">Stocky</p>
            <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">{sectionTitles[activeSection]}</h2>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button type="button" className="erp-button-secondary shrink-0 px-3 py-1.5 text-xs" onClick={onLogout}>
              Salir
            </button>
          </div>
        </header>

        <header className="mb-5 hidden lg:block">
          <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">{sectionTitles[activeSection]}</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
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
