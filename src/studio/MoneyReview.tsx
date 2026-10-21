import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store/AuthStore';
import { requestJson } from '../services/apiClient';
import { confirmInventorySelection } from '../services/productService';
import { query } from './api';

type Row = { skuId: string; name: string; size: string | null; price: string; currency: string; revision: number; canConfirm: boolean };
type Review = { currency: string; items: Row[]; nextCursor: string | null };
type Request = { requestId: string; selector: { kind: 'ids'; skuIds: string[] }; mutation: { type: 'sku.update'; changes: { priceCurrency: string }; reason: string } };
type Preview = { selectionId: string; digest: string; members: { skuId: string; name: string; size: string | null; price: number; priceCurrency: string; revision: number }[]; mutation: Request['mutation'] };

export function MoneyReview() {
  const { session } = useAuth(), key = `fullmatch.money-review.${session?.tenantPhone}.${session?.phoneNumber}`;
  const [review, setReview] = useState<Review | null>(null), [selected, setSelected] = useState<string[]>([]), [reason, setReason] = useState('Confirmación de moneda histórica; importes cargados en unidades enteras');
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false), [preview, setPreview] = useState<Preview | null>(null);
  const pending = useRef<Request | null>(null), generation = useRef(0);
  const load = async (cursor?: string) => {
    const current = ++generation.current;
    try { const result = await query<Review>(`/money-review${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`); if (current === generation.current) { setReview(result); setSelected([]); } }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'No pude consultar el inventario.'); }
  };
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(key) ?? 'null'); if (saved?.requestId && Array.isArray(saved.selector?.skuIds) && saved.mutation?.type === 'sku.update') { pending.current = saved; setSelected(saved.selector.skuIds); setSuccess('Hay una revisión guardada. Recuperá la vista previa para continuar con el mismo intento.'); } } catch { /* Invalid local state is ignored. */ }
    void load(); return () => { generation.current++; };
  }, [key]);
  const run = async () => {
    if (busy || !review) return; setBusy(true); setError(''); setSuccess('');
    try {
      if (preview) {
        await confirmInventorySelection(preview);
        localStorage.removeItem(key); pending.current = null; setPreview(null); await load(); setSuccess('Moneda confirmada. Los precios y saldos se conservaron; el inventario guardó su recibo.');
      } else {
        pending.current ??= { requestId: crypto.randomUUID(), selector: { kind: 'ids', skuIds: selected }, mutation: { type: 'sku.update', changes: { priceCurrency: review.currency }, reason: reason.trim() } };
        localStorage.setItem(key, JSON.stringify(pending.current));
        const input = pending.current;
        const result = await requestJson<Preview>('/api/inventory/selections', { method: 'POST', body: JSON.stringify(input) });
        if (!result.selectionId || !result.digest || !Array.isArray(result.members) || result.members.length !== input.selector.skuIds.length
          || new Set(result.members.map(row => row.skuId)).size !== input.selector.skuIds.length
          || result.members.some(row => !input.selector.skuIds.includes(row.skuId) || row.priceCurrency !== 'XXX' || !Number.isSafeInteger(row.price) || row.price < 0)
          || result.mutation?.type !== 'sku.update' || Object.keys(result.mutation.changes ?? {}).join(',') !== 'priceCurrency'
          || result.mutation.changes.priceCurrency !== input.mutation.changes.priceCurrency || result.mutation.reason !== input.mutation.reason) throw new Error('La vista previa no coincide con la selección. No se aplicaron cambios.');
        setPreview(result);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No pude confirmar la revisión.'); }
    finally { setBusy(false); }
  };
  return <div className="panel money-review"><h2>Revisar moneda del inventario anterior</h2><p>Elegí solamente variantes cuyos importes ya estén cargados en {review?.currency ?? 'la moneda del negocio'}. Confirmar la moneda conserva el precio numérico y el stock. No realiza una conversión.</p>
    {error && <div className="notice" role="alert">{error}</div>}{success && <p role="status">{success}</p>}
    {preview ? <><h3>Revisá antes de confirmar</h3><div className="variant-list">{preview.members.map(row => <div className="variant-row" key={row.skuId}><span>{row.name} · {row.size}</span><strong>{row.price} {row.priceCurrency} → {pending.current?.mutation.changes.priceCurrency}</strong></div>)}</div><p>Se actualizarán {preview.members.length} variantes con sus revisiones verificadas.</p></> : <fieldset disabled={busy || Boolean(pending.current)}><label className="field"><span>Motivo de la confirmación</span><input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)}/></label><div className="variant-list">{review?.items.map(row => <label className="variant-row" key={row.skuId}><input type="checkbox" disabled={!row.canConfirm} checked={selected.includes(row.skuId)} onChange={event => setSelected(ids => event.target.checked ? [...ids, row.skuId] : ids.filter(id => id !== row.skuId))}/><span>{row.name} · {row.size || 'Sin presentación'}<small> · {row.price} {row.currency}{!row.canConfirm && ' · Revisá moneda e importe en Stocky'}</small></span></label>)}</div></fieldset>}
    {!review?.items.length && !preview && <p>No hay variantes con otra moneda.</p>}
    <div className="gallery-actions"><button className="primary" disabled={busy || (!preview && !pending.current && (!selected.length || !reason.trim()))} onClick={() => void run()}>{busy ? 'Consultando…' : preview ? 'Confirmar moneda de estas variantes' : pending.current ? 'Recuperar revisión guardada' : `Revisar selección (${selected.length})`}</button>
      <button disabled={busy} onClick={() => { pending.current = null; localStorage.removeItem(key); setPreview(null); setError(''); void load(); }}>Iniciar una nueva revisión</button>
      {review?.nextCursor && !preview && !pending.current && <button disabled={busy} onClick={() => void load(review.nextCursor!)}>Ver siguientes variantes</button>}</div>
  </div>;
}
