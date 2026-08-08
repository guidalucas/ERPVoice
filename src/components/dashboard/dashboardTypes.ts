export type DashboardSection = 'inicio' | 'stock' | 'productos' | 'pedidos' | 'clientes' | 'actividad';

export type NavigateOptions = {
  openProductCreate?: boolean;
  filterLowStock?: boolean;
};

export const LOW_STOCK_THRESHOLD = 2;
