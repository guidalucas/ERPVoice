import type { ReactNode } from 'react';
import { StockyLogo } from '../brand/StockyLogo';
import { DashboardNav, sectionTitles } from './DashboardNav';
import type { DashboardSection } from './dashboardTypes';
import { ThemeToggle } from './ThemeToggle';

type DashboardShellProps = {
  activeSection: DashboardSection;
  onSectionChange: (section: DashboardSection) => void;
  phoneNumber?: string | null;
  businessName?: string | null;
  onLogout: () => void;
  children: ReactNode;
};

function formatPhoneDisplay(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');

  // Argentina móvil: 54 + 9 + área (2) + local (8) → +54 9 11 0000-0000
  if (digits.length === 13 && digits.startsWith('549')) {
    const area = digits.slice(3, 5);
    const local = digits.slice(5);
    return `+54 9 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length === 12 && digits.startsWith('54')) {
    const area = digits.slice(2, 4);
    const local = digits.slice(4);
    return `+54 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length === 13 && digits.startsWith('54')) {
    const area = digits.slice(2, 4);
    const local = digits.slice(4);
    return `+54 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length >= 10) {
    return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -6)} ${digits.slice(-6, -4)}-${digits.slice(-4)}`.trim();
  }

  return phoneNumber;
}

function accountInitials(businessName: string | null | undefined, phoneNumber: string | null | undefined): string {
  const name = String(businessName ?? '').trim();
  if (name.length >= 2) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  const digits = String(phoneNumber ?? '').replace(/\D/g, '');
  if (digits.length >= 2) {
    return digits.slice(-2);
  }
  return 'U';
}

export function DashboardShell({
  activeSection,
  onSectionChange,
  phoneNumber,
  businessName,
  onLogout,
  children,
}: DashboardShellProps) {
  const displayBusinessName = businessName?.trim() || 'Stocky';

  return (
    <div className="dashboard-layout">
      <aside className="dashboard-sidebar hidden lg:flex">
        <div className="flex items-center gap-3 px-2 pb-6">
          <StockyLogo size="md" withWordmark subtitle={displayBusinessName} />
        </div>

        <DashboardNav activeSection={activeSection} onSectionChange={onSectionChange} variant="sidebar" />

        <div className="mt-auto space-y-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          {(businessName || phoneNumber) && (
            <div className="rounded-2xl border px-3 py-2.5" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                  {accountInitials(businessName, phoneNumber)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Cuenta</p>
                  <p className="mt-0.5 truncate text-sm font-semibold text-slate-800 dark:text-slate-200">
                    {businessName?.trim() || 'Sin nombre'}
                  </p>
                  {phoneNumber && (
                    <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{formatPhoneDisplay(phoneNumber)}</p>
                  )}
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
          <div className="flex min-w-0 items-center gap-3">
            <StockyLogo size="sm" />
            <div className="min-w-0">
              <p className="truncate text-[10px] uppercase tracking-[0.35em] text-emerald-600 dark:text-emerald-300">
                {displayBusinessName}
              </p>
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">{sectionTitles[activeSection]}</h2>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button type="button" className="erp-button-secondary min-h-11 shrink-0 px-3 py-2 text-sm" onClick={onLogout}>
              Salir
            </button>
          </div>
        </header>

        <header className="mb-5 hidden items-start justify-between gap-3 lg:flex">
          <div>
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">{sectionTitles[activeSection]}</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {activeSection === 'inicio' && 'Resumen de stock y actividad reciente'}
              {activeSection === 'productos' && 'Stock, precios y movimientos por modelo'}
              {activeSection === 'pedidos' && 'Qué te pidieron, agrupado para armar el pedido al proveedor'}
              {activeSection === 'clientes' && 'Clientes y sus pedidos'}
              {activeSection === 'actividad' && 'Cargas por voz y mensajes recientes'}
            </p>
          </div>
        </header>

        {children}
      </div>

      <DashboardNav activeSection={activeSection} onSectionChange={onSectionChange} variant="bottom" />
    </div>
  );
}
