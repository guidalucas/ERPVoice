import type { ReactNode } from 'react';
import { StockyLogo } from '../brand/StockyLogo';
import { DashboardNav, sectionTitles } from './DashboardNav';
import type { DashboardSection } from './dashboardTypes';
import { ThemeToggle } from './ThemeToggle';
import { formatPhoneDisplay } from '../../services/phone';

type DashboardShellProps = {
  activeSection: DashboardSection;
  onSectionChange: (section: DashboardSection) => void;
  phoneNumber?: string | null;
  businessName?: string | null;
  role?: 'owner' | 'member' | null;
  onOpenTeam: () => void;
  onLogout: () => void;
  children: ReactNode;
};

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
  role,
  onOpenTeam,
  onLogout,
  children,
}: DashboardShellProps) {
  const displayBusinessName = businessName?.trim() || 'Stocky';
  const roleLabel = role === 'member' ? `Miembro de ${displayBusinessName}` : 'Dueño';

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
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-xs type-subtitle text-[color:var(--accent)]">
                  {accountInitials(businessName, phoneNumber)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--muted)]">Cuenta</p>
                  <p className="mt-0.5 truncate text-sm type-subtitle text-[color:var(--text)]">
                    {businessName?.trim() || 'Sin nombre'}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-[color:var(--muted)]">{roleLabel}</p>
                  {phoneNumber && (
                    <p className="mt-0.5 truncate text-xs text-[color:var(--muted)]">{formatPhoneDisplay(phoneNumber)}</p>
                  )}
                </div>
              </div>
              <button type="button" className="erp-button-secondary mt-2 w-full text-sm" onClick={onOpenTeam}>
                Equipo
              </button>
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
              <p className="erp-brand-gradient-text truncate text-[10px] uppercase tracking-[0.35em]">
                {displayBusinessName}
              </p>
              <h2 className="type-title text-xl text-[color:var(--text)]">{sectionTitles[activeSection]}</h2>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="erp-button-secondary min-h-11 shrink-0 px-3 py-2 text-sm" onClick={onOpenTeam}>
              Equipo
            </button>
            <ThemeToggle />
            <button type="button" className="erp-button-secondary min-h-11 shrink-0 px-3 py-2 text-sm" onClick={onLogout}>
              Salir
            </button>
          </div>
        </header>

        <header className="mb-5 hidden items-start justify-between gap-3 lg:flex">
          <div>
            <h2 className="type-title text-2xl text-[color:var(--text)]">{sectionTitles[activeSection]}</h2>
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              {activeSection === 'inicio' && 'Resumen de stock y actividad reciente'}
              {activeSection === 'productos' && 'Stock, precios y movimientos por modelo'}
              {activeSection === 'pedidos' && 'Qué te pidieron, agrupado para armar el pedido al proveedor'}
              {activeSection === 'ventas' && 'Historial detallado de ventas y stock descontado'}
              {activeSection === 'clientes' && 'Clientes y sus pedidos'}
              {activeSection === 'proveedores' && 'Proveedores a los que pedís mercadería'}
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
