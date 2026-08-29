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

function PedidoStatusControls({
  estado,
  disabled,
  onChange,
}: {
  estado: PedidoEstado;
  disabled: boolean;
  onChange: (estado: PedidoEstado) => void;
}) {
  return (
    <div className="pedido-status-bar w-full sm:w-auto sm:min-w-[18rem]" role="group" aria-label="Estado del pedido">
      {(['pendiente', 'conseguido', 'descartado'] as PedidoEstado[]).map((value) => (
        <button
          key={value}
          type="button"
          data-estado={value}
          aria-pressed={estado === value}
          disabled={disabled || estado === value}
          onClick={() => onChange(value)}
          className="pedido-status-btn"
        >
          {estadoLabel[value]}
        </button>
      ))}
    </div>
  );
}

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
  const {
    pedidos,
    clients,
    proveedores,
    products,
    createPedidoRecord,
    createClientRecord,
    createProveedorRecord,
    updatePedidoRecord,
  } = useInventory();
  const [estadoFilter, setEstadoFilter] = useState<PedidoEstado | 'todos'>('pendiente');
  const [groupBy, setGroupBy] = useState<'cliente' | 'proveedor' | 'producto'>('cliente');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [clienteId, setClienteId] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [proveedorId, setProveedorId] = useState('');
  const [newProveedorName, setNewProveedorName] = useState('');
  const [productId, setProductId] = useState('');
  const [qtyText, setQtyText] = useState('1');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const clientsById = useMemo(() => Object.fromEntries(clients.map((client) => [client.id, client])), [clients]);
  const proveedoresById = useMemo(
    () => Object.fromEntries(proveedores.map((proveedor) => [proveedor.id, proveedor])),
    [proveedores],
  );

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

  const productGroups = useMemo(() => {
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

  const clientGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        clienteId: string;
        clienteName: string;
        pedidos: typeof filtered;
        totalQty: number;
      }
    >();

    for (const pedido of filtered) {
      const clienteId = pedido.clienteId || 'sin-cliente';
      const clienteName = clientsById[pedido.clienteId]?.name ?? 'Cliente';
      const current = map.get(clienteId) ?? { key: clienteId, clienteId, clienteName, pedidos: [], totalQty: 0 };
      current.pedidos.push(pedido);
      current.totalQty += pedido.qty;
      map.set(clienteId, current);
    }

    return [...map.values()].sort((a, b) => a.clienteName.localeCompare(b.clienteName, 'es'));
  }, [filtered, clientsById]);

  const proveedorGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        proveedorName: string;
        pedidos: typeof filtered;
        totalQty: number;
      }
    >();

    for (const pedido of filtered) {
      const proveedorId = pedido.proveedorId || 'sin-proveedor';
      const proveedorName = pedido.proveedorId ? proveedoresById[pedido.proveedorId]?.name ?? 'Proveedor' : 'Sin proveedor';
      const current = map.get(proveedorId) ?? { key: proveedorId, proveedorName, pedidos: [], totalQty: 0 };
      current.pedidos.push(pedido);
      current.totalQty += pedido.qty;
      map.set(proveedorId, current);
    }

    return [...map.values()].sort((a, b) => {
      if (a.key === 'sin-proveedor') {
        return 1;
      }
      if (b.key === 'sin-proveedor') {
        return -1;
      }
      return a.proveedorName.localeCompare(b.proveedorName, 'es');
    });
  }, [filtered, proveedoresById]);

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
    setProveedorId('');
    setNewProveedorName('');
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

      let resolvedProveedorId: string | null = proveedorId || null;
      if (!resolvedProveedorId && newProveedorName.trim()) {
        const created = await createProveedorRecord({ name: newProveedorName.trim() });
        resolvedProveedorId = created.id;
      }

      await createPedidoRecord({
        clienteId: resolvedClientId,
        proveedorId: resolvedProveedorId,
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

  const productFieldLabel =
    preset.useVariants && preset.variantLabel
      ? `Producto + ${preset.variantLabel.toLowerCase()}`
      : 'Producto';

  return (
    <article className="erp-panel space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="type-title text-xl text-[color:var(--text)]">Pedidos para proveedor</h3>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            {groupBy === 'cliente'
              ? 'Agrupados por cliente, con el listado de productos. Marcar como conseguido suma stock; revertirlo lo resta.'
              : groupBy === 'proveedor'
                ? 'Agrupados por proveedor, con el listado de productos. Marcar como conseguido suma stock; revertirlo lo resta.'
                : preset.useVariants && preset.variantLabel
                  ? `Agrupados por producto y ${preset.variantLabel.toLowerCase()}. Marcar como conseguido suma stock; revertirlo lo resta.`
                  : 'Agrupados por producto. Marcar como conseguido suma stock; revertirlo lo resta.'}
          </p>
        </div>
        <button type="button" className="erp-button-primary min-h-11" onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? 'Cerrar formulario' : '+ Nuevo pedido'}
        </button>
      </div>

      {formOpen && (
        <div className="inventory-row p-4">
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
            <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
              Proveedor (opcional)
              <select
                className="erp-input min-h-11"
                value={proveedorId}
                onChange={(event) => {
                  setProveedorId(event.target.value);
                  if (event.target.value) {
                    setNewProveedorName('');
                  }
                }}
              >
                <option value="">Sin proveedor…</option>
                {proveedores.map((proveedor) => (
                  <option key={proveedor.id} value={proveedor.id}>
                    {proveedor.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-sm type-subtitle text-[color:var(--text)]">
              O nuevo proveedor
              <input
                className="erp-input min-h-11"
                value={newProveedorName}
                disabled={Boolean(proveedorId)}
                onChange={(event) => setNewProveedorName(event.target.value)}
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

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {(['pendiente', 'conseguido', 'descartado', 'todos'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setEstadoFilter(value)}
              className="activity-filter-chip"
              aria-pressed={estadoFilter === value}
              style={
                estadoFilter === value && value === 'pendiente'
                  ? { background: 'var(--warning)', borderColor: 'transparent', color: '#0b0b10' }
                  : estadoFilter === value && value === 'conseguido'
                    ? { background: '#34d399', borderColor: 'transparent', color: '#0b0b10' }
                    : undefined
              }
            >
              {value === 'todos' ? 'Todos' : estadoLabel[value]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {([
            { id: 'cliente', label: 'Por cliente' },
            { id: 'proveedor', label: 'Por proveedor' },
            { id: 'producto', label: 'Por producto' },
          ] as const).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setGroupBy(option.id)}
              className="activity-filter-chip"
              aria-pressed={groupBy === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Sin pedidos"
          description="Cargá un pedido manual o anotá por voz algo como “Juan me pidió 2 unidades de este producto”."
          actionLabel="+ Nuevo pedido"
          onAction={() => setFormOpen(true)}
        />
      ) : (
        <div className="space-y-3">
          {groupBy === 'cliente'
            ? clientGroups.map((group) => {
                const proveedorNames = group.pedidos
                  .map((pedido) => (pedido.proveedorId ? proveedoresById[pedido.proveedorId]?.name : null))
                  .filter((name): name is string => Boolean(name))
                  .filter((name, index, arr) => arr.indexOf(name) === index);

                return (
                  <div key={group.key} className="inventory-row space-y-4 p-4">
                    <div>
                      <p className="type-title text-xl text-[color:var(--text)]">{group.clienteName}</p>
                      <p className="mt-1.5 text-sm text-[color:var(--muted)]">
                        {group.pedidos.length} producto{group.pedidos.length === 1 ? '' : 's'}
                        {' · '}
                        {group.totalQty} unidad{group.totalQty === 1 ? '' : 'es'}
                        {proveedorNames.length > 0 ? ` · ${proveedorNames.join(', ')}` : ''}
                      </p>
                    </div>
                    <div className="space-y-2">
                      {group.pedidos.map((pedido) => (
                        <div key={pedido.id} className="flex flex-col gap-3 rounded-[0.875rem] border px-3 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                          <div className="min-w-0">
                            <p className="text-sm type-subtitle text-[color:var(--text)]">
                              {pedido.producto}
                              {preset.useVariants && pedido.talle ? (
                                <span className="text-[color:var(--muted)]"> · {pedido.talle}</span>
                              ) : null}
                            </p>
                            <p className="mt-1 text-xs text-[color:var(--muted)]">
                              x{pedido.qty} · {new Date(pedido.fechaPedido).toLocaleString('es-AR')}
                              {pedido.proveedorId ? ` · ${proveedoresById[pedido.proveedorId]?.name ?? 'Proveedor'}` : ''}
                              {pedido.notas ? ` · ${pedido.notas}` : ''}
                            </p>
                          </div>
                          <PedidoStatusControls
                            estado={pedido.estado}
                            disabled={updatingId === pedido.id}
                            onChange={(estado) => void changeEstado(pedido.id, estado)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            : groupBy === 'proveedor'
              ? proveedorGroups.map((group) => {
                  const clientNames = group.pedidos
                    .map((pedido) => clientsById[pedido.clienteId]?.name ?? 'Cliente')
                    .filter((name, index, arr) => arr.indexOf(name) === index);

                  return (
                    <div key={group.key} className="inventory-row space-y-4 p-4">
                      <div>
                        <p className="type-title text-xl text-[color:var(--text)]">{group.proveedorName}</p>
                        <p className="mt-1.5 text-sm text-[color:var(--muted)]">
                          {group.pedidos.length} producto{group.pedidos.length === 1 ? '' : 's'}
                          {' · '}
                          {group.totalQty} unidad{group.totalQty === 1 ? '' : 'es'}
                          {clientNames.length > 0 ? ` · ${clientNames.join(', ')}` : ''}
                        </p>
                      </div>
                      <div className="space-y-2">
                        {group.pedidos.map((pedido) => (
                          <div key={pedido.id} className="flex flex-col gap-3 rounded-[0.875rem] border px-3 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                            <div className="min-w-0">
                              <p className="text-sm type-subtitle text-[color:var(--text)]">
                                {pedido.producto}
                                {preset.useVariants && pedido.talle ? (
                                  <span className="text-[color:var(--muted)]"> · {pedido.talle}</span>
                                ) : null}
                              </p>
                              <p className="mt-1 text-xs text-[color:var(--muted)]">
                                x{pedido.qty} · {clientsById[pedido.clienteId]?.name ?? 'Cliente'} ·{' '}
                                {new Date(pedido.fechaPedido).toLocaleString('es-AR')}
                                {pedido.notas ? ` · ${pedido.notas}` : ''}
                              </p>
                            </div>
                            <PedidoStatusControls
                              estado={pedido.estado}
                              disabled={updatingId === pedido.id}
                              onChange={(next) => void changeEstado(pedido.id, next)}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
            : productGroups.map((group) => {
                const names = group.pedidos
                  .map((pedido) => clientsById[pedido.clienteId]?.name ?? 'Cliente')
                  .filter((name, index, arr) => arr.indexOf(name) === index);
                const proveedorNames = group.pedidos
                  .map((pedido) => (pedido.proveedorId ? proveedoresById[pedido.proveedorId]?.name : null))
                  .filter((name): name is string => Boolean(name))
                  .filter((name, index, arr) => arr.indexOf(name) === index);

                return (
                  <div key={group.key} className="inventory-row space-y-4 p-4">
                    <div>
                      <p className="type-title text-xl text-[color:var(--text)]">
                        {group.producto}
                        {preset.useVariants && group.talle ? (
                          <span className="type-subtitle ml-2 text-base text-[color:var(--muted)]">· {group.talle}</span>
                        ) : null}
                      </p>
                      <p className="mt-1.5 text-sm text-[color:var(--muted)]">
                        {group.totalQty} pedido{group.totalQty === 1 ? '' : 's'} ({names.join(', ')})
                        {proveedorNames.length > 0 ? ` · ${proveedorNames.join(', ')}` : ''}
                      </p>
                    </div>
                    <div className="space-y-2">
                      {group.pedidos.map((pedido) => (
                        <div key={pedido.id} className="flex flex-col gap-3 rounded-[0.875rem] border px-3 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                          <div className="min-w-0">
                            <p className="text-sm type-subtitle text-[color:var(--text)]">{clientsById[pedido.clienteId]?.name ?? 'Cliente'}</p>
                            <p className="mt-1 text-xs text-[color:var(--muted)]">
                              x{pedido.qty} · {new Date(pedido.fechaPedido).toLocaleString('es-AR')}
                              {pedido.proveedorId ? ` · ${proveedoresById[pedido.proveedorId]?.name ?? 'Proveedor'}` : ''}
                              {pedido.notas ? ` · ${pedido.notas}` : ''}
                            </p>
                          </div>
                          <PedidoStatusControls
                            estado={pedido.estado}
                            disabled={updatingId === pedido.id}
                            onChange={(next) => void changeEstado(pedido.id, next)}
                          />
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
