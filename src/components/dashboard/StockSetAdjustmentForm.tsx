import { useRef, useState } from 'react';
import { useInventory } from '../../hooks/useInventory';
import { toUserFacingError } from '../../services/apiClient';
import type { InventorySelectionPreview, InventorySelectionRequest } from '../../services/productService';

export function StockSetAdjustmentForm({ onClose }: { onClose: () => void }) {
  const { products, previewInventorySelection, confirmInventorySelectionRecord } = useInventory();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [available, setAvailable] = useState('');
  const [reserved, setReserved] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<InventorySelectionPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<InventorySelectionRequest | null>(null);
  const busyRef = useRef(false);

  const invalidate = () => {
    requestRef.current = null;
    setPreview(null); setConsent(false); setStale(false); setError(null);
  };

  const review = async (fresh = false) => {
    if (busyRef.current) return;
    if (selectedIds.length < 1 || selectedIds.length > 100) {
      setError('Seleccioná entre 1 y 100 SKU explícitos.'); return;
    }
    if ((!available.trim() && !reserved.trim()) || [available, reserved].some(value => value.trim() && (!Number.isSafeInteger(Number(value)) || Number(value) < 0))) {
      setError('Ingresá al menos un saldo entero mayor o igual a cero.'); return;
    }
    if (!reason.trim()) { setError('Ingresá el motivo del ajuste.'); return; }
    if (fresh) { requestRef.current = null; setPreview(null); setConsent(false); setStale(false); }
    requestRef.current ??= {
      requestId: crypto.randomUUID(), selector: { kind: 'ids', skuIds: [...selectedIds] },
      mutation: { type: 'stock.adjust', reason: reason.trim(), balances: {
        ...(available.trim() ? { available: Number(available) } : {}),
        ...(reserved.trim() ? { reserved: Number(reserved) } : {}),
      } },
    };
    busyRef.current = true; setBusy(true); setError(null);
    try {
      setPreview(await previewInventorySelection(requestRef.current));
      setConsent(false); setStale(false);
    } catch (error) { setError(toUserFacingError(error, 'No pude revisar el ajuste.')); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const confirm = async () => {
    if (busyRef.current || !preview || !consent || stale) return;
    const reference = { selectionId: preview.selectionId, digest: preview.digest };
    busyRef.current = true; setBusy(true); setError(null);
    try {
      await confirmInventorySelectionRecord(reference);
      onClose();
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
        setStale(true); setConsent(false);
        setError('El inventario cambió. Revisá una selección actualizada y confirmá sus saldos antes de enviar otro ajuste.');
      } else setError(toUserFacingError(error, 'No pude confirmar el ajuste. Reintentá con la misma vista previa.'));
    } finally { busyRef.current = false; setBusy(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
    <div role="dialog" aria-modal="true" aria-label="Ajustar conjunto" className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-elevated)] p-6 text-[color:var(--text)] shadow-2xl">
      <h4 className="type-title text-xl">Ajustar conjunto</h4>
      <p className="mt-2 text-sm">Cada saldo es absoluto: se fija ese valor en cada SKU seleccionado. Los campos en blanco conservan el saldo actual; no se suman ni restan unidades.</p>
      <fieldset disabled={busy} className="mt-4 space-y-4">
        <legend className="text-sm font-semibold">SKU explícitos · {selectedIds.length}/100</legend>
        <div className="max-h-52 space-y-2 overflow-y-auto rounded-xl border border-[color:var(--border)] p-3">
          {products.map(product => <label key={product.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" aria-label={`Seleccionar SKU ${product.id}`} checked={selectedIds.includes(product.id)} disabled={!selectedIds.includes(product.id) && selectedIds.length >= 100}
              onChange={event => { invalidate(); setSelectedIds(current => event.target.checked ? [...current, product.id] : current.filter(id => id !== product.id)); }} />
            <span>{product.name} · Variante: {product.size || 'Sin definir'} · SKU: {product.id}</span>
          </label>)}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">Disponible absoluto (opcional)
            <input className="erp-input" type="number" min="0" step="1" value={available} onChange={event => { invalidate(); setAvailable(event.target.value); }} />
          </label>
          <label className="block text-sm">Reservado absoluto (opcional)
            <input className="erp-input" type="number" min="0" step="1" value={reserved} onChange={event => { invalidate(); setReserved(event.target.value); }} />
          </label>
        </div>
        <label className="block text-sm">Motivo del ajuste
          <input className="erp-input" required value={reason} onChange={event => { invalidate(); setReason(event.target.value); }} />
        </label>
      </fieldset>
      {preview && <section aria-label="Vista previa del ajuste" className="mt-4 space-y-3 text-sm">
        <p>{preview.members.length} SKU revisados · Motivo: {preview.mutation.reason}</p>
        <ul className="space-y-2">{preview.members.map(member => <li key={member.skuId} className="rounded-xl border border-[color:var(--border)] p-3">
          <strong>{member.name}</strong> · Variante: {member.size || 'Sin definir'}
          <p>SKU: {member.skuId} · Unidad: {member.unit}</p>
          <p>Disponible: {member.stockAvailable} → {member.finalAvailable} · Reservado: {member.stockReserved} → {member.finalReserved}</p>
        </li>)}</ul>
        <p>Vence: {new Date(preview.expiresAt).toLocaleString('es-AR')}</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" disabled={busy || stale} checked={consent} onChange={event => setConsent(event.target.checked)} />
          Confirmo los saldos finales de cada SKU revisado.
        </label>
      </section>}
      {error && <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-200">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" className="erp-button-secondary" disabled={busy} onClick={() => { if (!busyRef.current) onClose(); }}>Cancelar</button>
        {preview ? <>
          <button type="button" className="erp-button-secondary" disabled={busy} onClick={() => void review(true)}>Revisar selección actualizada</button>
          <button type="button" className="erp-button-primary" disabled={busy || !consent || stale} onClick={() => void confirm()}>Confirmar ajuste</button>
        </> : <button type="button" className="erp-button-primary" disabled={busy} onClick={() => void review()}>{requestRef.current ? 'Reintentar vista previa' : 'Revisar ajuste'}</button>}
      </div>
    </div>
  </div>;
}
