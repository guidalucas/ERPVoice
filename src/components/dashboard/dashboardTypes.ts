export type DashboardSection = 'inicio' | 'productos' | 'pedidos' | 'clientes' | 'actividad';

/** Variantes con stockAvailable por debajo o igual a este umbral cuentan como stock bajo / agotado. */
export const LOW_STOCK_THRESHOLD = 1;
