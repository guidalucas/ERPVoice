import { useMemo, useState } from 'react';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { useInventory } from '../../hooks/useInventory';
import type { PedidoEstado } from '../../domain/types';
import { toUserFacingError } from '../../services/apiClient';
import { EmptyState } from './EmptyState';

const estadoLabel: Record<PedidoEstado, string> = {
  pendiente: 'Pendiente',
  conseguido: 'Conseguido',
  descartado: 'Descartado',
};

const estadoClass: Record<PedidoEstado, string> = {
  pendiente: 'border-amber-400/30 bg-amber-400/10 text-amber-800 dark:text-amber-200',
  conseguido: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-800 dark:text-emerald-200',
  descartado: 'border-slate-400/30 bg-slate-400/10 text-[color:var(--muted)]',
};

const productOptionLabel = (
  product: { name: string; productType?: string | null; productModel?: string | null; size?: string | null },
  includeSize: boolean,
) => {
  const parts = includeSize
    ? [product.productType, product.productModel, product.size]
    : [product.productType, product.productModel];
  const meta = parts.filter(Boolean).join(' ');
  return meta || product.name;
};

export function PedidosPanel() {
  const preset = useBusinessCategoryPreset();
  const { pedidos, clients, products, createPedidoRecord, createClientRecord, updatePedidoRecord } = useInventory();
  const [estadoFilter, setEstadoFilter] = useState<PedidoEstado | 'todos'>('pendiente');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [clienteId, setClienteId] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [productId, setProductId] = useState('');
  const [qtyText, setQtyText] = useState('1');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const clientsById = useMemo(() => Object.fromEntries(clients.map((client) => [client.id, client])), [clients]);

  const sortedProducts = useMemo(
    () =>
      [...products].sort((a, b) =>
        productOptionLabel(a, preset.useVariants).localeCompare(productOptionLabel(b, preset.useVariants), 'es', {
          sensitivity: 'base',
        }),
      ),
    [products, preset.useVariants],
  );

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
      const talle = preset.useVariants ? (pedido.talle ?? '').trim() || '-' : '';
      const key = preset.useVariants ? `${producto.toLowerCase()}||${talle.toLowerCase()}` : producto.toLowerCase();
      const current = map.get(key) ?? { key, producto, talle, pedidos: [], totalQty: 0 };
      current.pedidos.push(pedido);
      current.totalQty += pedido.qty;
      map.set(key, current);
    }

    return [...map.values()].sort(
      (a, b) => a.producto.localeCompare(b.producto, 'es') || a.talle.localeCompare(b.talle, 'es'),
    );
  }, [filtered, preset.useVariants]);

  const changeEstado = async (pedidoId: string, estado: PedidoEstado) => {
    setUpdatingId(pedidoId);
    try {
      await updatePedidoRecord(pedidoId, { estado });
    } finally {
      setUpdatingId(null);
    }
  };

  const resetForm = () => {
    setClienteId('');
    setNewClientName('');
    setProductId('');
    setQtyText('1');
    setFormError(null);
  };

  const handleCreatePedido = async () => {
    setFormError(null);
    const qty = Number(qtyText);
    if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
      setFormError('Ingresá una cantidad entera mayor a 0.');
      return;
    }

    const selectedProduct = products.find((product) => product.id === productId);
    if (!selectedProduct) {
      setFormError('Elegí un producto.');
      return;
    }

    setSaving(true);
    try {
      let resolvedClientId = clienteId;
      if (!resolvedClientId) {
        const name = newClientName.trim();
        if (!name) {
          setFormError('Elegí un cliente o escribí un nombre nuevo.');
          return;
        }
        const created = await createClientRecord({ name });
        resolvedClientId = created.id;
      }

      await createPedidoRecord({
        clienteId: resolvedClientId,
        producto: selectedProduct.name,
        productType: selectedProduct.productType,
        productModel: selectedProduct.productModel,
        talle: preset.useVariants ? selectedProduct.size : null,
        qty,
        estado: 'pendiente',
        notas: 'Pedido manual',
      });

      resetForm();
      setFormOpen(false);
      setEstadoFilter('pendiente');
    } catch (error) {
      setFormError(toUserFacingError(error, 'No se pudo crear el pedido.'));
    } finally {
      setSaving(false);
    }
  };

  const filterActiveClass = (value: PedidoEstado | 'todos') => {
    if (estadoFilter !== value) {
      return 'text-[color:var(--muted)] hover:bg-slate-900/5 dark:hover:bg-white/10';
    }
    if (value === 'pendiente') {
      return 'bg-amber-400 text-slate-950';
    }
    if (value === 'conseguido') {
      return 'bg-emerald-500 text-slate-950';
    }
    return 'bg-slate-500 text-white';
  };

  const productFieldLabel =
    preset.useVariants && preset.variantLabel
      ? `Producto + ${preset.variantLabel.toLowerCase()}`
      : 'Producto';

  return (
    <article className="erp-panel space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="type-title text-xl text-[color:var(--text)]">Pedidos para proveedor</h3>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            {preset.useVariants && preset.variantLabel
              ? `Agrupados por producto y ${preset.variantLabel.toLowerCase()}. Cambiar estado no mueve stock.`
              : 'Agrupados por producto. Cambiar estado no mueve stock.'}
          </p>
        </div>
        <button type="button" className="erp-button-primary min-h-11" onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? 'Cerrar formulario' : '+ Nuevo pedido'}
        </button>
      </div>

      {formOpen && (
        <div className="rounded-2xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
          <p className="text-sm type-subtitle text-[color:var(--text)]">Cargar pedido manual</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
              Cliente existente
              <select
                className="erp-input min-h-11"
                value={clienteId}
                onChange={(event) => {
                  setClienteId(event.target.value);
                  if (event.target.value) {
                    setNewClientName('');
                  }
                }}
              >
                <option value="">Elegir…</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
              O nuevo cliente
              <input
                className="erp-input min-h-11"
                value={newClientName}
                disabled={Boolean(clienteId)}
                onChange={(event) => setNewClientName(event.target.value)}
                placeholder="Nombre"
              />
            </label>
            <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)] sm:col-span-2">
              {productFieldLabel}
              <select className="erp-input min-h-11" value={productId} onChange={(event) => setProductId(event.target.value)}>
                <option value="">Elegir…</option>
                {sortedProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {productOptionLabel(product, preset.useVariants)} · {product.stockAvailable} disp.
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
              Cantidad
              <input
                className="erp-input min-h-11"
                type="number"
                min={1}
                step={1}
                value={qtyText}
                onChange={(event) => setQtyText(event.target.value)}
              />
            </label>
          </div>
          {formError && <p className="mt-3 text-sm text-rose-700 dark:text-rose-200">{formError}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="erp-button-primary min-h-11" disabled={saving} onClick={() => void handleCreatePedido()}>
              {saving ? 'Guardando…' : 'Crear pedido'}
            </button>
            <button
              type="button"
              className="erp-button-secondary min-h-11"
              disabled={saving}
              onClick={() => {
                resetForm();
                setFormOpen(false);
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(['pendiente', 'conseguido', 'descartado', 'todos'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setEstadoFilter(value)}
            className={`min-h-10 rounded-full px-3 py-1.5 text-xs font-semibold transition ${filterActiveClass(value)}`}
            style={estadoFilter === value ? undefined : { background: 'var(--overlay-soft)' }}
          >
            {value === 'todos' ? 'Todos' : estadoLabel[value]}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title="Sin pedidos"
          description="Cargá un pedido manual o anotá por voz algo como “Juan me pidió 2 unidades de este producto”."
          actionLabel="+ Nuevo pedido"
          onAction={() => setFormOpen(true)}
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
                    <p className="type-title text-lg text-[color:var(--text)]">
                      {group.producto}
                      {preset.useVariants && group.talle ? (
                        <span className="type-subtitle ml-2 text-base text-[color:var(--muted)]">— {group.talle}</span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-sm text-[color:var(--muted)]">
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
                        <p className="text-sm type-subtitle text-[color:var(--text)]">{clientsById[pedido.clienteId]?.name ?? 'Cliente'}</p>
                        <p className="text-xs text-[color:var(--muted)]">
                          x{pedido.qty} · {new Date(pedido.fechaPedido).toLocaleString('es-AR')}
                          {pedido.notas ? ` · ${pedido.notas}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`rounded-full border px-2.5 py-1.5 text-[11px] font-semibold ${estadoClass[pedido.estado]}`}>
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
                              className="min-h-10 rounded-full border px-3 py-1.5 text-[11px] font-semibold text-[color:var(--muted)] transition hover:bg-slate-900/5 disabled:opacity-50 dark:hover:bg-white/10"
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
