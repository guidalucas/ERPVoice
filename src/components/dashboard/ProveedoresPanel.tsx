import { useMemo, useState } from 'react';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { useInventory } from '../../hooks/useInventory';
import { EmptyState } from './EmptyState';

export function ProveedoresPanel() {
  const preset = useBusinessCategoryPreset();
  const {
    proveedores,
    pedidos,
    createProveedorRecord,
    updateProveedorRecord,
    deleteProveedorRecord,
    mergeProveedorRecords,
  } = useInventory();
  const [name, setName] = useState('');
  const [notas, setNotas] = useState('');
  const [saving, setSaving] = useState(false);
  const [mergeKeepId, setMergeKeepId] = useState('');
  const [mergeOtherId, setMergeOtherId] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editNotas, setEditNotas] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);

  const pedidosByProveedor = useMemo(() => {
    const map: Record<string, typeof pedidos> = {};
    for (const pedido of pedidos) {
      if (!pedido.proveedorId) {
        continue;
      }
      map[pedido.proveedorId] = map[pedido.proveedorId] ?? [];
      map[pedido.proveedorId]!.push(pedido);
    }
    return map;
  }, [pedidos]);

  const handleCreate = async () => {
    if (!name.trim()) {
      return;
    }
    setSaving(true);
    try {
      await createProveedorRecord({ name: name.trim(), notas: notas.trim() || null });
      setName('');
      setNotas('');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (proveedorId: string) => {
    const proveedor = proveedores.find((entry) => entry.id === proveedorId);
    if (!proveedor) {
      return;
    }
    setEditingId(proveedorId);
    setEditName(proveedor.name);
    setEditNotas(proveedor.notas ?? '');
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) {
      return;
    }
    setSaving(true);
    try {
      await updateProveedorRecord(editingId, { name: editName.trim(), notas: editNotas.trim() || null });
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleMerge = async () => {
    if (!mergeKeepId || !mergeOtherId || mergeKeepId === mergeOtherId) {
      return;
    }
    setSaving(true);
    try {
      await mergeProveedorRecords(mergeKeepId, mergeOtherId);
      setMergeKeepId('');
      setMergeOtherId('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <article className="erp-panel">
        <h3 className="type-title text-xl text-[color:var(--text)]">Nuevo proveedor</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <input className="erp-input min-h-11" placeholder="Nombre" value={name} onChange={(event) => setName(event.target.value)} />
          <input className="erp-input min-h-11" placeholder="Notas (opcional)" value={notas} onChange={(event) => setNotas(event.target.value)} />
          <button type="button" className="erp-button-primary min-h-11" disabled={saving || !name.trim()} onClick={() => void handleCreate()}>
            Agregar
          </button>
        </div>
      </article>

      <article className="erp-panel">
        <h3 className="type-title text-xl text-[color:var(--text)]">Proveedores</h3>
        {proveedores.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Sin proveedores"
              description="Agregalos acá o mencioná el nombre al cargar un pedido (ej. “pedido del proveedor Acme”)."
            />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {proveedores.map((proveedor) => {
              const proveedorPedidos = pedidosByProveedor[proveedor.id] ?? [];
              const pendientes = proveedorPedidos.filter((pedido) => pedido.estado === 'pendiente').length;
              const isExpanded = expandedId === proveedor.id;
              const isEditing = editingId === proveedor.id;

              return (
                <div key={proveedor.id} className="inventory-row p-0">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpandedId(isExpanded ? null : proveedor.id)}>
                      <p className="type-subtitle text-[color:var(--text)]">{proveedor.name}</p>
                      <p className="mt-0.5 text-xs text-[color:var(--muted)]">
                        {proveedorPedidos.length} pedido{proveedorPedidos.length === 1 ? '' : 's'}
                        {pendientes > 0 ? ` · ${pendientes} pendiente${pendientes === 1 ? '' : 's'}` : ''}
                        {proveedor.notas ? ` · ${proveedor.notas}` : ''}
                      </p>
                    </button>
                    <div className="flex gap-2">
                      <button type="button" className="erp-button-secondary min-h-11 px-3 text-sm" onClick={() => startEdit(proveedor.id)}>
                        Editar
                      </button>
                      <button
                        type="button"
                        className="erp-button-danger min-h-11 px-3 text-sm"
                        onClick={() => void deleteProveedorRecord(proveedor.id)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="border-t border-[color:var(--border)] px-4 py-3">
                      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
                        <input className="erp-input min-h-11" value={editName} onChange={(event) => setEditName(event.target.value)} />
                        <input className="erp-input min-h-11" value={editNotas} onChange={(event) => setEditNotas(event.target.value)} placeholder="Notas" />
                        <button type="button" className="erp-button-primary min-h-11" disabled={saving} onClick={() => void saveEdit()}>
                          Guardar
                        </button>
                        <button type="button" className="erp-button-secondary min-h-11" onClick={() => setEditingId(null)}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}

                  {isExpanded && (
                    <div className="space-y-2 border-t border-[color:var(--border)] px-4 py-3">
                      {proveedorPedidos.length === 0 ? (
                        <p className="text-sm text-[color:var(--muted)]">Sin pedidos asociados.</p>
                      ) : (
                        proveedorPedidos.map((pedido) => (
                          <div key={pedido.id} className="flex items-center justify-between gap-3 text-sm">
                            <p className="text-[color:var(--text)]">
                              {pedido.producto}
                              {preset.useVariants && pedido.talle ? ` — ${pedido.talle}` : ''}{' '}
                              <span className="text-[color:var(--muted)]">x{pedido.qty}</span>
                            </p>
                            <span className="text-xs uppercase tracking-wide text-[color:var(--muted)]">{pedido.estado}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </article>

      {proveedores.length > 1 && (
        <article className="erp-panel">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 text-left"
            onClick={() => setMergeOpen((open) => !open)}
            aria-expanded={mergeOpen}
          >
            <div>
              <h3 className="type-title text-lg text-[color:var(--text)]">Fusionar duplicados</h3>
              <p className="mt-1 text-sm text-[color:var(--muted)]">Opcional · los pedidos del segundo pasan al que conservás.</p>
            </div>
            <span className="erp-toggle-link text-sm">{mergeOpen ? 'Ocultar' : 'Mostrar'}</span>
          </button>
          {mergeOpen && (
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <select className="erp-input min-h-11" value={mergeKeepId} onChange={(event) => setMergeKeepId(event.target.value)}>
                <option value="">Conservar…</option>
                {proveedores.map((proveedor) => (
                  <option key={proveedor.id} value={proveedor.id}>
                    {proveedor.name}
                  </option>
                ))}
              </select>
              <select className="erp-input min-h-11" value={mergeOtherId} onChange={(event) => setMergeOtherId(event.target.value)}>
                <option value="">Fusionar y eliminar…</option>
                {proveedores
                  .filter((proveedor) => proveedor.id !== mergeKeepId)
                  .map((proveedor) => (
                    <option key={proveedor.id} value={proveedor.id}>
                      {proveedor.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="erp-button-secondary min-h-11"
                disabled={saving || !mergeKeepId || !mergeOtherId}
                onClick={() => void handleMerge()}
              >
                Fusionar
              </button>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
