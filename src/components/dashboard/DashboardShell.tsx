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

const sectionCopy: Record<DashboardSection, string> = {
  inicio: 'Alertas, una acción y lo último que pasó.',
  productos: 'Stock, precios y movimientos por modelo.',
  pedidos: 'Qué te pidieron, agrupado para armar el pedido.',
  ventas: 'Historial de ventas y stock descontado.',
  clientes: 'Quién te pide, qué debe y qué queda pendiente.',
  proveedores: 'A quién le pedís mercadería.',
  actividad: 'Cargas por voz y movimientos recientes.',
};

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
      <aside className="dashboard-sidebar">
        <div className="px-2 pb-6">
          <StockyLogo size="md" withWordmark subtitle={displayBusinessName} />
        </div>

        <DashboardNav activeSection={activeSection} onSectionChange={onSectionChange} variant="sidebar" />

        <div className="mt-auto space-y-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          {(businessName || phoneNumber) && (
            <div className="rounded-[0.875rem] px-3 py-3" style={{ background: 'var(--overlay-soft)' }}>
              <div className="flex items-center gap-2.5">
                <div className="erp-brand-gradient flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.75rem] text-xs font-bold text-white">
                  {accountInitials(businessName, phoneNumber)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm type-subtitle text-[color:var(--text)]">
                    {businessName?.trim() || 'Sin nombre'}
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-[color:var(--muted)]">{roleLabel}</p>
                  {phoneNumber && (
                    <p className="mt-0.5 truncate text-[12px] text-[color:var(--muted)]">{formatPhoneDisplay(phoneNumber)}</p>
                  )}
                </div>
              </div>
              <button type="button" className="erp-button-secondary mt-3 w-full text-sm" onClick={onOpenTeam}>
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

      <div className="dashboard-main">
        <header className="mb-4 flex items-center justify-between gap-3 lg:hidden">
          <div className="flex min-w-0 items-center gap-3">
            <StockyLogo size="sm" />
            <div className="min-w-0">
              <p className="truncate text-[12px] text-[color:var(--muted)]">{displayBusinessName}</p>
              <h2 className="type-title text-xl text-[color:var(--text)]">{sectionTitles[activeSection]}</h2>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="erp-button-secondary min-h-11 shrink-0 px-3 text-sm" onClick={onOpenTeam}>
              Equipo
            </button>
            <ThemeToggle />
          </div>
        </header>

        <header className="mb-6 hidden lg:block">
          <h2 className="type-title text-[2rem] leading-none text-[color:var(--text)]">{sectionTitles[activeSection]}</h2>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--muted)]">{sectionCopy[activeSection]}</p>
        </header>

        <div key={activeSection} className="animate-fade-in-up">
          {children}
        </div>
      </div>

      <DashboardNav
        activeSection={activeSection}
        onSectionChange={onSectionChange}
        variant="bottom"
        onLogout={onLogout}
      />
    </div>
  );
}
