import { useMemo, useState } from 'react';
import { useInventory } from '../../hooks/useInventory';
import type { PedidoEstado } from '../../domain/types';
import { EmptyState } from './EmptyState';

const estadoLabel: Record<PedidoEstado, string> = {
  pendiente: 'Pendiente',
  conseguido: 'Conseguido',
  descartado: 'Descartado',
};

const estadoClass: Record<PedidoEstado, string> = {
  pendiente: 'border-amber-400/30 bg-amber-400/10 text-amber-800 dark:text-amber-200',
  conseguido: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-800 dark:text-emerald-200',
  descartado: 'border-slate-400/30 bg-slate-400/10 text-slate-700 dark:text-slate-300',
};

export function PedidosPanel() {
  const { pedidos, clients, updatePedidoRecord } = useInventory();
  const [estadoFilter, setEstadoFilter] = useState<PedidoEstado | 'todos'>('pendiente');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const clientsById = useMemo(() => Object.fromEntries(clients.map((client) => [client.id, client])), [clients]);

  const filtered = useMemo(
    () => (estadoFilter === 'todos' ? pedidos : pedidos.filter((pedido) => pedido.estado === estadoFilter)),
    [pedidos, estadoFilter],
  );

  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        producto: string;
        talle: string;
        pedidos: typeof filtered;
        totalQty: number;
      }
    >();

    for (const pedido of filtered) {
      const producto = pedido.producto.trim() || 'Sin producto';
      const talle = (pedido.talle ?? '').trim() || '-';
      const key = `${producto.toLowerCase()}||${talle.toLowerCase()}`;
      const current = map.get(key) ?? { key, producto, talle, pedidos: [], totalQty: 0 };
      current.pedidos.push(pedido);
      current.totalQty += pedido.qty;
      map.set(key, current);
    }

    return [...map.values()].sort((a, b) => a.producto.localeCompare(b.producto, 'es') || a.talle.localeCompare(b.talle, 'es'));
  }, [filtered]);

  const changeEstado = async (pedidoId: string, estado: PedidoEstado) => {
    setUpdatingId(pedidoId);
    try {
      await updatePedidoRecord(pedidoId, { estado });
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <article className="erp-panel space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">Pedidos para proveedor</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Agrupados por producto y talle. Cambiar estado no mueve stock.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(['pendiente', 'conseguido', 'descartado', 'todos'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setEstadoFilter(value)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                estadoFilter === value
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-600 hover:bg-slate-900/5 dark:text-slate-300 dark:hover:bg-white/10'
              }`}
              style={estadoFilter === value ? undefined : { background: 'var(--overlay-soft)' }}
            >
              {value === 'todos' ? 'Todos' : estadoLabel[value]}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title="Sin pedidos"
          description="Cuando anotes por voz algo como “Juan me pidió una camiseta de Boca talle M”, aparece acá agrupado para armar el pedido al proveedor."
        />
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const names = group.pedidos
              .map((pedido) => clientsById[pedido.clienteId]?.name ?? 'Cliente')
              .filter((name, index, arr) => arr.indexOf(name) === index);

            return (
              <div key={group.key} className="rounded-2xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-display text-lg font-bold text-slate-900 dark:text-white">
                      {group.producto}
                      <span className="ml-2 text-base font-semibold text-emerald-700 dark:text-emerald-300">— {group.talle}</span>
                    </p>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                      {group.totalQty} pedido{group.totalQty === 1 ? '' : 's'} ({names.join(', ')})
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {group.pedidos.map((pedido) => (
                    <div
                      key={pedido.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2.5"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface-elevated)' }}
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{clientsById[pedido.clienteId]?.name ?? 'Cliente'}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          x{pedido.qty} · {new Date(pedido.fechaPedido).toLocaleString('es-AR')}
                          {pedido.notas ? ` · ${pedido.notas}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${estadoClass[pedido.estado]}`}>
                          {estadoLabel[pedido.estado]}
                        </span>
                        {(['pendiente', 'conseguido', 'descartado'] as PedidoEstado[])
                          .filter((estado) => estado !== pedido.estado)
                          .map((estado) => (
                            <button
                              key={estado}
                              type="button"
                              disabled={updatingId === pedido.id}
                              onClick={() => void changeEstado(pedido.id, estado)}
                              className="rounded-full border px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-900/5 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-white/10"
                              style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
                            >
                              {estadoLabel[estado]}
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
