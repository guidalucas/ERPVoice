import { useMemo, useRef, useState } from 'react';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { useInventory } from '../../hooks/useInventory';
import { EmptyState } from './EmptyState';
import { toUserFacingError } from '../../services/apiClient';

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
  const editRevisionRef = useRef<number | null>(null);
  const editAttemptRef = useRef<{ id: string; body: Parameters<typeof updateProveedorRecord>[1] } | null>(null);
  const [editReviewRequired, setEditReviewRequired] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

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

  const createAttemptRef = useRef<Parameters<typeof createProveedorRecord>[0] | null>(null);

  const handleCreate = async () => {
    if (busyRef.current) return;
    if (!name.trim()) {
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const attempt = createAttemptRef.current ?? { operationId: crypto.randomUUID(), name: name.trim(), notas: notas.trim() || null };
      createAttemptRef.current = attempt;
      await createProveedorRecord(attempt);
      createAttemptRef.current = null;
      setName('');
      setNotas('');
      setFormOpen(false);
    } catch (error) {
      setError(toUserFacingError(error, 'No pude crear el proveedor.'));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const discardEdit = () => {
    if (busyRef.current) return;
    editAttemptRef.current = null;
    editRevisionRef.current = null;
    setEditReviewRequired(false); setEditingId(null); setError(null);
  };

  const startEdit = (proveedorId: string) => {
    if (busyRef.current || editAttemptRef.current) return;
    const proveedor = proveedores.find((entry) => entry.id === proveedorId);
    if (!proveedor) return;
    if (typeof proveedor.metadataRevision !== 'number' || !Number.isSafeInteger(proveedor.metadataRevision) || proveedor.metadataRevision < 0) {
      setError('Falta la revisión. Actualizá la página y volvé a abrir la edición.');
      return;
    }
    editRevisionRef.current = proveedor.metadataRevision;
    setEditReviewRequired(false); setError(null);
    setEditingId(proveedorId);
    setEditName(proveedor.name);
    setEditNotas(proveedor.notas ?? '');
  };

  const changeEdit = (field: 'name' | 'notas', value: string) => {
    editAttemptRef.current = null;
    const current = proveedores.find((entry) => entry.id === editingId);
    if (!current || current.metadataRevision !== editRevisionRef.current) {
      setEditReviewRequired(true);
      setError('El registro cambió. Revisá los proveedores actuales y volvé a abrir la edición.');
    }
    if (field === 'name') setEditName(value); else setEditNotas(value);
  };

  const submitEdit = async (attempt: NonNullable<typeof editAttemptRef.current>) => {
    if (busyRef.current) return;
    busyRef.current = true; setSaving(true); setError(null);
    try {
      await updateProveedorRecord(attempt.id, attempt.body);
      editAttemptRef.current = null; editRevisionRef.current = null;
      setEditReviewRequired(false); setEditingId(null);
    } catch (error) {
      setError(toUserFacingError(error, 'No pude guardar el proveedor.'));
    } finally {
      busyRef.current = false; setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (busyRef.current || editReviewRequired || !editingId || !editName.trim() || editRevisionRef.current === null) return;
    const attempt = editAttemptRef.current ?? { id: editingId, body: {
      operationId: crypto.randomUUID(), expectedRevision: editRevisionRef.current,
      name: editName.trim(), notas: editNotas.trim() || null,
    } };
    editAttemptRef.current = attempt;
    await submitEdit(attempt);
  };

  const handleMerge = async () => {
    if (busyRef.current) return;
    if (!mergeKeepId || !mergeOtherId || mergeKeepId === mergeOtherId) {
      return;
    }
    busyRef.current = true;
    setSaving(true); setError(null);
    try {
      await mergeProveedorRecords(mergeKeepId, mergeOtherId);
      setMergeKeepId('');
      setMergeOtherId('');
    } catch (error) {
      setError(toUserFacingError(error, 'No pude fusionar los proveedores.'));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const handleDelete = async (proveedorId: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setSaving(true); setError(null);
    try { await deleteProveedorRecord(proveedorId); }
    catch (error) { setError(toUserFacingError(error, 'No pude eliminar el proveedor.')); }
    finally { busyRef.current = false; setSaving(false); }
  };

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="erp-panel text-rose-700 dark:text-rose-200">{error}</p>}
      {(editAttemptRef.current || editReviewRequired) && (
        <div className="flex flex-wrap gap-2">
          {editAttemptRef.current && <button type="button" className="erp-button-primary" disabled={saving} onClick={() => {
            const attempt = editAttemptRef.current; if (attempt) void submitEdit(attempt);
          }}>Reintentar edición</button>}
          <button type="button" className="erp-button-secondary" disabled={saving} onClick={discardEdit}>Revisar proveedores actuales</button>
        </div>
      )}
      <article className="erp-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="type-title text-xl text-[color:var(--text)]">Proveedores</h3>
          <button type="button" className="erp-button-primary min-h-11" disabled={saving} onClick={() => setFormOpen((open) => !open)}>
            {formOpen ? 'Cerrar' : 'Nuevo proveedor'}
          </button>
        </div>

        {formOpen && (
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <input className="erp-input min-h-11" placeholder="Nombre" disabled={saving} value={name} onChange={(event) => { createAttemptRef.current = null; setName(event.target.value); }} />
            <input className="erp-input min-h-11" placeholder="Notas (opcional)" disabled={saving} value={notas} onChange={(event) => { createAttemptRef.current = null; setNotas(event.target.value); }} />
            <button type="button" className="erp-button-primary min-h-11" disabled={saving || !name.trim()} onClick={() => void handleCreate()}>
              Agregar
            </button>
          </div>
        )}

        {proveedores.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Sin proveedores"
              description="Agregalos acá o mencioná el nombre al cargar un pedido (ej. “pedido del proveedor Acme”)."
              actionLabel={formOpen ? undefined : 'Nuevo proveedor'}
              onAction={formOpen ? undefined : () => setFormOpen(true)}
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
                      <button type="button" className="erp-button-secondary min-h-11 px-3 text-sm" disabled={saving || Boolean(editAttemptRef.current)} onClick={() => startEdit(proveedor.id)}>
                        Editar
                      </button>
                      <button
                        type="button"
                        className="erp-button-danger min-h-11 px-3 text-sm"
                        disabled={saving} onClick={() => void handleDelete(proveedor.id)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="border-t border-[color:var(--border)] px-4 py-3">
                      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
                        <input className="erp-input min-h-11" aria-label="Nombre de edición" disabled={saving} value={editName} onChange={(event) => changeEdit('name', event.target.value)} />
                        <input className="erp-input min-h-11" aria-label="Notas de edición" disabled={saving} value={editNotas} onChange={(event) => changeEdit('notas', event.target.value)} placeholder="Notas" />
                        <button type="button" className="erp-button-primary min-h-11" disabled={saving || editReviewRequired} onClick={() => void saveEdit()}>
                          Guardar
                        </button>
                        <button type="button" className="erp-button-secondary min-h-11" disabled={saving} onClick={discardEdit}>
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
