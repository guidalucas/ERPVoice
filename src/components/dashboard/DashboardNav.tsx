import { useState, type ReactNode } from 'react';
import { ChartBar, ClipboardText, House, List, Package, Users, Warehouse, Waveform } from '@phosphor-icons/react';
import type { DashboardSection } from './dashboardTypes';

type NavItem = {
  id: DashboardSection;
  label: string;
  icon: ReactNode;
};

const iconProps = { size: 20, weight: 'regular' as const };

const navItems: NavItem[] = [
  { id: 'inicio', label: 'Inicio', icon: <House {...iconProps} /> },
  { id: 'productos', label: 'Inventario', icon: <Package {...iconProps} /> },
  { id: 'pedidos', label: 'Pedidos', icon: <ClipboardText {...iconProps} /> },
  { id: 'ventas', label: 'Ventas', icon: <ChartBar {...iconProps} /> },
  { id: 'clientes', label: 'Clientes', icon: <Users {...iconProps} /> },
  { id: 'proveedores', label: 'Proveedores', icon: <Warehouse {...iconProps} /> },
  { id: 'actividad', label: 'Actividad', icon: <Waveform {...iconProps} /> },
];

const PRIMARY_SECTIONS: DashboardSection[] = ['inicio', 'productos', 'pedidos', 'actividad'];
const MORE_SECTIONS: DashboardSection[] = ['ventas', 'clientes', 'proveedores'];

type DashboardNavProps = {
  activeSection: DashboardSection;
  onSectionChange: (section: DashboardSection) => void;
  variant: 'sidebar' | 'bottom';
  onLogout?: () => void;
};

function NavButton({
  item,
  isActive,
  onClick,
  variant,
}: {
  item: NavItem;
  isActive: boolean;
  onClick: () => void;
  variant: 'sidebar' | 'bottom' | 'sheet';
}) {
  const baseClass =
    variant === 'sidebar'
      ? 'dashboard-nav-item w-full'
      : variant === 'sheet'
        ? 'dashboard-nav-item w-full'
        : 'dashboard-bottom-nav-item';
  const idleClass = isActive ? '' : 'text-[color:var(--muted)] hover:bg-[color:var(--card-hover)] hover:text-[color:var(--text)]';
  const iconClass = isActive ? 'text-[color:var(--accent)]' : '';

  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      className={`${baseClass} ${idleClass}`}
      onClick={onClick}
    >
      {isActive && variant === 'sidebar' && (
        <span aria-hidden="true" className="erp-brand-gradient absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full" />
      )}
      <span className={`shrink-0 ${iconClass}`}>{item.icon}</span>
      <span className={variant === 'bottom' ? 'truncate text-[11px] font-semibold' : 'font-semibold'}>{item.label}</span>
    </button>
  );
}

export function DashboardNav({ activeSection, onSectionChange, variant, onLogout }: DashboardNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const itemsById = Object.fromEntries(navItems.map((item) => [item.id, item])) as Record<DashboardSection, NavItem>;

  if (variant === 'sidebar') {
    return (
      <nav className="dashboard-nav" aria-label="Navegación del panel">
        {navItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            isActive={activeSection === item.id}
            onClick={() => onSectionChange(item.id)}
            variant="sidebar"
          />
        ))}
      </nav>
    );
  }

  const moreActive = MORE_SECTIONS.includes(activeSection);

  return (
    <>
      {moreOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            aria-label="Cerrar menú"
            onClick={() => setMoreOpen(false)}
          />
          <div className="dashboard-more-sheet" role="menu" aria-label="Más secciones">
            {MORE_SECTIONS.map((id) => (
              <NavButton
                key={id}
                item={itemsById[id]}
                isActive={activeSection === id}
                onClick={() => {
                  onSectionChange(id);
                  setMoreOpen(false);
                }}
                variant="sheet"
              />
            ))}
            {onLogout && (
              <button
                type="button"
                className="dashboard-nav-item w-full text-[color:var(--muted)] hover:bg-[color:var(--card-hover)] hover:text-[color:var(--text)]"
                onClick={() => {
                  setMoreOpen(false);
                  onLogout();
                }}
              >
                Salir
              </button>
            )}
          </div>
        </>
      )}

      <nav className="dashboard-bottom-nav" aria-label="Navegación del panel">
        {PRIMARY_SECTIONS.map((id) => (
          <NavButton
            key={id}
            item={itemsById[id]}
            isActive={activeSection === id}
            onClick={() => {
              setMoreOpen(false);
              onSectionChange(id);
            }}
            variant="bottom"
          />
        ))}
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-current={moreActive ? 'page' : undefined}
          className={`dashboard-bottom-nav-item ${
            moreActive || moreOpen ? '' : 'text-[color:var(--muted)] hover:bg-[color:var(--card-hover)] hover:text-[color:var(--text)]'
          }`}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <span className={`shrink-0 ${moreActive || moreOpen ? 'text-[color:var(--accent)]' : ''}`} aria-hidden="true">
            <List size={20} weight="regular" />
          </span>
          <span className="truncate text-[11px] font-semibold">Más</span>
        </button>
      </nav>
    </>
  );
}

export const sectionTitles: Record<DashboardSection, string> = {
  inicio: 'Inicio',
  productos: 'Inventario',
  pedidos: 'Pedidos',
  ventas: 'Ventas',
  clientes: 'Clientes',
  proveedores: 'Proveedores',
  actividad: 'Actividad',
};
