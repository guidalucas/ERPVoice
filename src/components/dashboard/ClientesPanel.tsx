import { useMemo, useState } from 'react';
import { useInventory } from '../../hooks/useInventory';
import { EmptyState } from './EmptyState';

export function ClientesPanel() {
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
        <h3 className="font-display text-xl font-bold text-slate-100">Nuevo cliente</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <input className="erp-input" placeholder="Nombre" value={name} onChange={(event) => setName(event.target.value)} />
          <input className="erp-input" placeholder="Notas (opcional)" value={notas} onChange={(event) => setNotas(event.target.value)} />
          <button type="button" className="erp-button-primary" disabled={saving || !name.trim()} onClick={() => void handleCreate()}>
            Agregar
          </button>
        </div>
      </article>

      {clients.length > 1 && (
        <article className="erp-panel">
          <h3 className="font-display text-lg font-bold text-slate-100">Fusionar duplicados</h3>
          <p className="mt-1 text-sm text-slate-400">Los pedidos del segundo cliente pasan al que conservás.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <select className="erp-input" value={mergeKeepId} onChange={(event) => setMergeKeepId(event.target.value)}>
              <option value="">Conservar…</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <select className="erp-input" value={mergeOtherId} onChange={(event) => setMergeOtherId(event.target.value)}>
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
              className="erp-button-secondary"
              disabled={saving || !mergeKeepId || !mergeOtherId}
              onClick={() => void handleMerge()}
            >
              Fusionar
            </button>
          </div>
        </article>
      )}

      <article className="erp-panel">
        <h3 className="font-display text-xl font-bold text-slate-100">Clientes</h3>
        {clients.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="Sin clientes" description="Se crean solos cuando registrás un pedido por voz, o podés agregarlos acá." />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {clients.map((client) => {
              const clientPedidos = pedidosByClient[client.id] ?? [];
              const pendientes = clientPedidos.filter((pedido) => pedido.estado === 'pendiente').length;
              const isExpanded = expandedId === client.id;
              const isEditing = editingId === client.id;

              return (
                <div key={client.id} className="rounded-2xl border border-white/10 bg-white/[0.03]">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpandedId(isExpanded ? null : client.id)}>
                      <p className="font-semibold text-slate-100">{client.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {clientPedidos.length} pedido{clientPedidos.length === 1 ? '' : 's'}
                        {pendientes > 0 ? ` · ${pendientes} pendiente${pendientes === 1 ? '' : 's'}` : ''}
                        {client.notas ? ` · ${client.notas}` : ''}
                      </p>
                    </button>
                    <div className="flex gap-2">
                      <button type="button" className="erp-button-secondary px-3 py-1.5 text-xs" onClick={() => startEdit(client.id)}>
                        Editar
                      </button>
                      <button
                        type="button"
                        className="erp-button-danger px-3 py-1.5 text-xs"
                        onClick={() => void deleteClientRecord(client.id)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="border-t border-white/10 px-4 py-3">
                      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
                        <input className="erp-input" value={editName} onChange={(event) => setEditName(event.target.value)} />
                        <input className="erp-input" value={editNotas} onChange={(event) => setEditNotas(event.target.value)} placeholder="Notas" />
                        <button type="button" className="erp-button-primary" disabled={saving} onClick={() => void saveEdit()}>
                          Guardar
                        </button>
                        <button type="button" className="erp-button-secondary" onClick={() => setEditingId(null)}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}

                  {isExpanded && (
                    <div className="space-y-2 border-t border-white/10 px-4 py-3">
                      {clientPedidos.length === 0 ? (
                        <p className="text-sm text-slate-500">Sin pedidos asociados.</p>
                      ) : (
                        clientPedidos.map((pedido) => (
                          <div key={pedido.id} className="flex items-center justify-between gap-3 text-sm">
                            <p className="text-slate-200">
                              {pedido.producto}
                              {pedido.talle ? ` — ${pedido.talle}` : ''} <span className="text-slate-500">x{pedido.qty}</span>
                            </p>
                            <span className="text-xs uppercase tracking-wide text-slate-400">{pedido.estado}</span>
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
    </div>
  );
}
