import type { ReactNode } from 'react';
import type { DashboardSection } from './dashboardTypes';

type NavItem = {
  id: DashboardSection;
  label: string;
  icon: ReactNode;
};

const navItems: NavItem[] = [
  {
    id: 'inicio',
    label: 'Inicio',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.8]">
        <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" />
      </svg>
    ),
  },
  {
    id: 'productos',
    label: 'Inventario',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.8]">
        <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" />
        <path d="M12 21v-8" />
      </svg>
    ),
  },
  {
    id: 'pedidos',
    label: 'Pedidos',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.8]">
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
        <path d="M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v0Z" />
        <path d="M9 12h6" />
        <path d="M9 16h4" />
      </svg>
    ),
  },
  {
    id: 'clientes',
    label: 'Clientes',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.8]">
        <path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    id: 'actividad',
    label: 'Actividad',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.8]">
        <path d="M12 8v4l3 2" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
];

type DashboardNavProps = {
  activeSection: DashboardSection;
  onSectionChange: (section: DashboardSection) => void;
  variant: 'sidebar' | 'bottom';
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
  variant: 'sidebar' | 'bottom';
}) {
  const baseClass = variant === 'sidebar' ? 'dashboard-nav-item w-full relative' : 'dashboard-bottom-nav-item flex-1 min-w-0 relative';
  const activeClass = isActive
    ? 'border-transparent bg-[color:var(--card-hover)] text-[color:var(--text)]'
    : 'border-transparent text-[color:var(--muted)] hover:bg-[color:var(--card-hover)] hover:text-[color:var(--text)]';
  const iconClass = isActive ? 'text-[color:var(--accent)]' : '';

  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      className={`${baseClass} ${activeClass}`}
      onClick={onClick}
    >
      {isActive && variant === 'sidebar' && (
        <span
          aria-hidden="true"
          className="absolute left-0.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[color:var(--accent)]"
        />
      )}
      <span className={`shrink-0 ${iconClass}`}>{item.icon}</span>
      <span className={variant === 'bottom' ? 'truncate text-[11px] font-semibold' : 'font-semibold'}>{item.label}</span>
    </button>
  );
}

export function DashboardNav({ activeSection, onSectionChange, variant }: DashboardNavProps) {
  const containerClass = variant === 'sidebar' ? 'dashboard-nav' : 'dashboard-bottom-nav';

  return (
    <nav className={containerClass} aria-label="Navegación del panel">
      {navItems.map((item) => (
        <NavButton
          key={item.id}
          item={item}
          isActive={activeSection === item.id}
          onClick={() => onSectionChange(item.id)}
          variant={variant}
        />
      ))}
    </nav>
  );
}

export const sectionTitles: Record<DashboardSection, string> = {
  inicio: 'Inicio',
  productos: 'Inventario',
  pedidos: 'Pedidos',
  clientes: 'Clientes',
  actividad: 'Actividad',
};
