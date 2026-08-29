import { useMemo, useState } from 'react';
import { useBusinessCategoryPreset } from '../../hooks/useBusinessCategoryPreset';
import { useInventory } from '../../hooks/useInventory';
import { EmptyState } from './EmptyState';

export function ClientesPanel() {
  const preset = useBusinessCategoryPreset();
  const { clients, pedidos, createClientRecord, updateClientRecord, deleteClientRecord, mergeClientRecords } = useInventory();
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
  const [formOpen, setFormOpen] = useState(false);

  const formatCurrency = (value: number) => `$${value.toLocaleString('es-AR')}`;
  const outstandingDebt = clients.reduce((total, client) => total + (Number.isFinite(client.debt) ? client.debt : 0), 0);

  const pedidosByClient = useMemo(() => {
    const map: Record<string, typeof pedidos> = {};
    for (const pedido of pedidos) {
      map[pedido.clienteId] = map[pedido.clienteId] ?? [];
      map[pedido.clienteId]!.push(pedido);
    }
    return map;
  }, [pedidos]);

  const handleCreate = async () => {
    if (!name.trim()) {
      return;
    }
    setSaving(true);
    try {
      await createClientRecord({ name: name.trim(), notas: notas.trim() || null });
      setName('');
      setNotas('');
      setFormOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (clientId: string) => {
    const client = clients.find((entry) => entry.id === clientId);
    if (!client) {
      return;
    }
    setEditingId(clientId);
    setEditName(client.name);
    setEditNotas(client.notas ?? '');
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) {
      return;
    }
    setSaving(true);
    try {
      await updateClientRecord(editingId, { name: editName.trim(), notas: editNotas.trim() || null });
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
      await mergeClientRecords(mergeKeepId, mergeOtherId);
      setMergeKeepId('');
      setMergeOtherId('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <article className="erp-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="type-title text-xl text-[color:var(--text)]">Clientes</h3>
            {outstandingDebt > 0 && (
              <p className="mt-1 text-sm text-[color:var(--warning)]">Deuda total {formatCurrency(outstandingDebt)}</p>
            )}
          </div>
          <button type="button" className="erp-button-primary min-h-11" onClick={() => setFormOpen((open) => !open)}>
            {formOpen ? 'Cerrar' : 'Nuevo cliente'}
          </button>
        </div>

        {formOpen && (
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <input className="erp-input min-h-11" placeholder="Nombre" value={name} onChange={(event) => setName(event.target.value)} />
            <input className="erp-input min-h-11" placeholder="Notas (opcional)" value={notas} onChange={(event) => setNotas(event.target.value)} />
            <button type="button" className="erp-button-primary min-h-11" disabled={saving || !name.trim()} onClick={() => void handleCreate()}>
              Agregar
            </button>
          </div>
        )}

        {clients.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Sin clientes"
              description="Se crean solos cuando registrás un pedido por voz, o podés agregarlos acá."
              actionLabel={formOpen ? undefined : 'Nuevo cliente'}
              onAction={formOpen ? undefined : () => setFormOpen(true)}
            />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {clients.map((client) => {
              const clientPedidos = pedidosByClient[client.id] ?? [];
              const pendientes = clientPedidos.filter((pedido) => pedido.estado === 'pendiente').length;
              const isExpanded = expandedId === client.id;
              const isEditing = editingId === client.id;
              const debt = Number.isFinite(client.debt) ? client.debt : 0;

              return (
                <div key={client.id} className="inventory-row p-0">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpandedId(isExpanded ? null : client.id)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="type-subtitle text-[color:var(--text)]">{client.name}</p>
                        {debt > 0 && (
                          <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-[color:var(--warning)]" style={{ background: 'var(--warning-soft)' }}>
                            Debe {formatCurrency(debt)}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-[color:var(--muted)]">
                        {clientPedidos.length} pedido{clientPedidos.length === 1 ? '' : 's'}
                        {pendientes > 0 ? ` · ${pendientes} pendiente${pendientes === 1 ? '' : 's'}` : ''}
                        {client.notas ? ` · ${client.notas}` : ''}
                      </p>
                    </button>
                    <div className="flex gap-2">
                      <button type="button" className="erp-button-secondary min-h-11 px-3 text-sm" onClick={() => startEdit(client.id)}>
                        Editar
                      </button>
                      <button
                        type="button"
                        className="erp-button-danger min-h-11 px-3 text-sm"
                        onClick={() => void deleteClientRecord(client.id)}
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
                      {clientPedidos.length === 0 ? (
                        <p className="text-sm text-[color:var(--muted)]">Sin pedidos asociados.</p>
                      ) : (
                        clientPedidos.map((pedido) => (
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

      {clients.length > 1 && (
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
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
              <select className="erp-input min-h-11" value={mergeOtherId} onChange={(event) => setMergeOtherId(event.target.value)}>
                <option value="">Fusionar y eliminar…</option>
                {clients
                  .filter((client) => client.id !== mergeKeepId)
                  .map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
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
