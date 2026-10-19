import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../store/AuthStore';
import { useInventory } from '../../hooks/useInventory';
import type { InventoryAttribute, InventoryAttributes, Product } from '../../domain/types';
import { fetchPersistedState, updateProduct, type ProductAdjustment } from '../../services/productService';
import { fetchProductFamilies, type ProductFamily } from '../../services/productFamilyService';
import { toUserFacingError } from '../../services/apiClient';

type Field = { omit: boolean; state: InventoryAttribute['state']; value: string };
type Draft = { before?: Product; family?: ProductFamily; fields: Record<string, Field>; removed: string[]; reason: string };
type Attempt = { before: Product; family: ProductFamily; attributes: InventoryAttributes; adjustment: ProductAdjustment; status: 'pending' | 'conflict' | 'rejected' | 'complete' };
type Saved = { draft: Draft; attempt?: Attempt };
const fresh = (): Saved => ({ draft: { fields: {}, removed: [], reason: '' } });
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([, v]) => v !== undefined).map(([k, v]) => [k, JSON.parse(canonical(v))])) : value);
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const states = { known: 'Conocido', unknown: 'Desconocido', not_applicable: 'No aplica', missing: 'Faltante' };
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const attributeValid = (v: unknown): v is InventoryAttribute => object(v) && Object.keys(v).every(k => ['type', 'state', 'value', 'unit'].includes(k)) && ['text', 'number', 'boolean'].includes(String(v.type)) && hasOwn(states, String(v.state)) && (v.unit === undefined || typeof v.unit === 'string') && (v.state === 'known' ? typeof v.value === String(v.type).replace('text', 'string') && (v.type !== 'number' || Number.isFinite(v.value)) : v.value === undefined);
const productValid = (v: unknown): v is Product => object(v) && typeof v.id === 'string' && Boolean(v.id) && typeof v.name === 'string' && Number.isSafeInteger(v.revision) && Number(v.revision) >= 0 && typeof v.identityFingerprint === 'string' && Boolean(v.identityFingerprint) && typeof v.unit === 'string' && [v.stockAvailable, v.stockReserved, v.price].every(n => typeof n === 'number' && Number.isFinite(n)) && (v.family === undefined || object(v.family) && typeof v.family.id === 'string' && Number.isSafeInteger(v.family.version) && Number(v.family.version) > 0) && (v.attributes === undefined || object(v.attributes) && Object.values(v.attributes).every(attributeValid));
const familyValid = (v: unknown): v is ProductFamily => object(v) && typeof v.familyId === 'string' && Boolean(v.familyId) && Number.isSafeInteger(v.version) && Number(v.version) > 0 && object(v.schema) && typeof v.schema.name === 'string' && typeof v.schema.unit === 'string' && typeof v.schema.allowAdditionalAttributes === 'boolean' && object(v.schema.attributes) && Object.values(v.schema.attributes).every(a => object(a) && ['text', 'number', 'boolean'].includes(String(a.type)) && typeof a.required === 'boolean' && Array.isArray(a.allowedStates) && a.allowedStates.length > 0 && a.allowedStates.every(s => hasOwn(states, String(s))) && (a.unit === undefined || a.type === 'number' && typeof a.unit === 'string') && (a.values === undefined || Array.isArray(a.values) && a.values.every(n => typeof n === String(a.type).replace('text', 'string') && (a.type !== 'number' || Number.isFinite(n)))));
function attributesFor(d: Draft): InventoryAttributes {
  if (!d.before || !d.family) throw new Error('Seleccioná un SKU y una familia con versión.');
  if (d.before.unit !== d.family.schema.unit) throw new Error('La unidad del SKU debe ser idéntica a la unidad de la familia.');
  const result: InventoryAttributes = Object.fromEntries(Object.entries(d.before.attributes ?? {}).filter(([key]) => !hasOwn(d.family!.schema.attributes, key) && !d.removed.includes(key)));
  if (!d.family.schema.allowAdditionalAttributes && Object.keys(result).length) throw new Error('Quitá explícitamente cada atributo fuera del esquema para continuar.');
  for (const [key, schema] of Object.entries(d.family.schema.attributes)) {
    const field = d.fields[key];
    if (!field) throw new Error(`Revisá “${key}”.`);
    if (field.omit) { if (schema.required) throw new Error(`“${key}” es requerido.`); continue; }
    if (!schema.allowedStates.includes(field.state) || schema.required && field.state !== 'known') throw new Error(`Estado inválido para “${key}”.`);
    const unit = schema.unit === undefined ? {} : { unit: schema.unit };
    if (field.state !== 'known') { result[key] = { type: schema.type, state: field.state, ...unit }; continue; }
    if (field.value.trim() === '') throw new Error(`Ingresá un valor para “${key}” o elegí omitirlo explícitamente.`);
    const value = schema.type === 'number' ? Number(field.value) : schema.type === 'boolean' ? field.value === 'true' : field.value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
    if (schema.type === 'number' && !Number.isFinite(value) || schema.type === 'boolean' && !['true', 'false'].includes(field.value) || schema.values && !schema.values.includes(value)) throw new Error(`Valor inválido para “${key}”.`);
    result[key] = { state: 'known', type: schema.type, value, ...unit } as InventoryAttribute;
  }
  return result;
}
function savedValid(v: unknown): v is Saved {
  if (!object(v) || !object(v.draft)) return false;
  const d = v.draft;
  if (!(d.before === undefined || productValid(d.before)) || !(d.family === undefined || familyValid(d.family)) || !object(d.fields) || !Object.values(d.fields).every(f => object(f) && typeof f.omit === 'boolean' && hasOwn(states, String(f.state)) && typeof f.value === 'string') || !Array.isArray(d.removed) || !d.removed.every(k => typeof k === 'string') || typeof d.reason !== 'string') return false;
  if (v.attempt === undefined) return true;
  const a = v.attempt;
  if (!object(a) || !productValid(a.before) || !familyValid(a.family) || !object(a.attributes) || !Object.values(a.attributes).every(attributeValid) || !object(a.adjustment) || Object.keys(a.adjustment).sort().join(',') !== 'expectedFingerprint,expectedRevision,operationId,reason' || typeof a.adjustment.operationId !== 'string' || !a.adjustment.operationId || !['pending', 'conflict', 'rejected', 'complete'].includes(String(a.status)) || a.adjustment.expectedRevision !== a.before.revision || a.adjustment.expectedFingerprint !== a.before.identityFingerprint || typeof a.adjustment.reason !== 'string' || !a.adjustment.reason.trim()) return false;
  try { return canonical(attributesFor(d as Draft)) === canonical(a.attributes) && canonical(d.before) === canonical(a.before) && canonical(d.family) === canonical(a.family) && d.reason.trim() === a.adjustment.reason; } catch { return false; }
}
const display = (attr?: InventoryAttribute) => !attr ? 'Omitido / ausente' : `${attr.state === 'known' ? typeof attr.value === 'boolean' ? attr.value ? 'Sí (true)' : 'No (false)' : String(attr.value) : states[attr.state]}${attr.unit ? ` ${attr.unit}` : ''} (${attr.type})`;
const button = 'rounded-xl border border-sky-500/30 px-4 py-2 text-sm disabled:opacity-40';

export function ProductFamilyAssignmentPanel({ onClose }: { onClose: () => void }) {
  const { session } = useAuth();
  const { refreshState } = useInventory();
  const key = session ? `product-family-assignment:${JSON.stringify([session.tenantPhone, session.phoneNumber])}` : null;
  const scope = useRef(key); scope.current = key;
  const generation = useRef(0), lock = useRef(false), refresh = useRef(refreshState); refresh.current = refreshState;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<Saved>(fresh), [products, setProducts] = useState<Product[]>([]), [families, setFamilies] = useState<ProductFamily[]>([]);
  const [busy, setBusy] = useState(true), [blocked, setBlocked] = useState(false), [consent, setConsent] = useState(false), [error, setError] = useState(''), [readError, setReadError] = useState('');
  const draft = saved.draft, attempt = saved.attempt;
  const persist = (next: Saved) => { if (!key || key !== scope.current) throw new Error('La sesión cambió.'); localStorage.setItem(key, JSON.stringify(next)); setSaved(next); };
  const guard = (id: number, expectedKey: string | null) => generation.current === id && scope.current === expectedKey;
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialogRef.current?.focus(); return () => previous?.focus(); }, []);
  async function read(id: number, expectedKey: string | null) {
    const [state, catalog] = await Promise.all([fetchPersistedState(), fetchProductFamilies()]);
    if (!guard(id, expectedKey)) return;
    if (!state || !Array.isArray(state.products) || !state.products.every(productValid) || new Set(state.products.map(p => p.id)).size !== state.products.length || !catalog || !Array.isArray(catalog.families) || !catalog.families.every(familyValid) || new Set(catalog.families.map(f => `${f.familyId}@${f.version}`)).size !== catalog.families.length) throw new Error('El inventario o catálogo no contiene referencias completas y válidas.');
    setProducts(state.products); setFamilies(catalog.families); setReadError('');
    return { products: state.products, families: catalog.families };
  }
  useEffect(() => {
    const id = ++generation.current; lock.current = true; setBusy(true); setConsent(false); setBlocked(false); setError(''); setReadError(''); setProducts([]); setFamilies([]);
    void (async () => {
      try { if (!key) throw new Error('Iniciá sesión.'); const raw = localStorage.getItem(key); const restored: unknown = raw ? JSON.parse(raw) : fresh(); if (!savedValid(restored)) throw new Error('El borrador guardado está corrupto. Se bloqueó el envío y se conservó el registro.'); if (guard(id, key)) setSaved(restored); }
      catch (e) { if (guard(id, key)) { setBlocked(true); setError(toUserFacingError(e)); } return; }
      try { await read(id, key); } catch (e) { if (guard(id, key)) setReadError(toUserFacingError(e)); }
      finally { if (guard(id, key)) { lock.current = false; setBusy(false); } }
    })();
    return () => { generation.current++; };
  }, [key]);
  const edit = (next: Draft) => { if (lock.current || busy || blocked || attempt) return; setConsent(false); try { persist({ draft: next }); setError(''); } catch (e) { setBlocked(true); setError(toUserFacingError(e)); } };
  const selectFamily = (family: ProductFamily | undefined, before = draft.before) => {
    const fields: Record<string, Field> = Object.create(null);
    for (const [name, schema] of Object.entries(family?.schema.attributes ?? {})) { const old = before?.attributes?.[name]; const compatible = old?.type === schema.type && old?.unit === schema.unit; fields[name] = { omit: false, state: compatible ? old!.state : 'known', value: compatible && old?.state === 'known' ? String(old.value) : '' }; }
    edit({ ...draft, before, family, fields, removed: [] });
  };
  let attributes: InventoryAttributes | undefined, validation = '';
  try { attributes = attributesFor(draft); if (!draft.reason.trim()) validation = 'El motivo es obligatorio.'; if (draft.before?.family && !families.some(f => f.familyId === draft.before!.family!.id && f.version === draft.before!.family!.version)) validation = 'La familia anterior no está disponible en el catálogo. Releé las familias para revisar su nombre y versión.'; } catch (e) { validation = toUserFacingError(e); }
  const familyLabel = (reference?: Product['family']) => { if (!reference) return 'Sin familia'; const family = families.find(f => f.familyId === reference.id && f.version === reference.version) ?? (draft.family?.familyId === reference.id && draft.family.version === reference.version ? draft.family : undefined); return family ? `${family.schema.name} · versión ${reference.version}` : `Familia no disponible · versión ${reference.version}`; };
  async function reload() {
    if (lock.current || busy || blocked) return;
    lock.current = true; setBusy(true); setConsent(false); const id = generation.current, expectedKey = key;
    try {
      const loaded = await read(id, expectedKey); if (!loaded || !guard(id, expectedKey)) return;
      if (attempt && ['conflict', 'rejected'].includes(attempt.status)) {
        const before = loaded.products.find(p => p.id === attempt.before.id), family = loaded.families.find(f => f.familyId === attempt.family.familyId && f.version === attempt.family.version);
        if (!before || !family) throw new Error('El SKU o la versión elegida ya no está disponible.');
        persist({ draft: { ...draft, before, family } });
      } else if (!attempt && draft.before) { const before = loaded.products.find(p => p.id === draft.before!.id); if (!before) throw new Error('El SKU seleccionado ya no está disponible.'); persist({ draft: { ...draft, before } }); }
      if (attempt?.status === 'complete') await refresh.current();
    } catch (e) { if (guard(id, expectedKey)) setReadError(toUserFacingError(e)); }
    finally { if (guard(id, expectedKey)) { lock.current = false; setBusy(false); } }
  }
  async function prepareAnother() {
    if (lock.current || busy || blocked || !attempt || !['complete', 'conflict', 'rejected'].includes(attempt.status)) return;
    lock.current = true; setBusy(true); setConsent(false); const id = generation.current, expectedKey = key;
    try { const loaded = await read(id, expectedKey); if (loaded && guard(id, expectedKey)) { persist(fresh()); if (attempt.status === 'complete') setError(''); else setError(error || 'El intento anterior fue rechazado y descartado explícitamente. Revisá y autorizá el nuevo cambio.'); } }
    catch (e) { if (guard(id, expectedKey)) setReadError(toUserFacingError(e)); }
    finally { if (guard(id, expectedKey)) { lock.current = false; setBusy(false); } }
  }
  async function submit() {
    if (lock.current || busy || blocked || !consent || readError || attempt && attempt.status !== 'pending') return;
    if (!attempt && (validation || !attributes || !draft.before || !draft.family)) return;
    lock.current = true; setBusy(true); setError(''); const id = generation.current, expectedKey = key;
    const next: Attempt = attempt ?? { before: structuredClone(draft.before!), family: structuredClone(draft.family!), attributes: attributes!, adjustment: { operationId: crypto.randomUUID(), expectedRevision: draft.before!.revision!, expectedFingerprint: draft.before!.identityFingerprint!, reason: draft.reason.trim() }, status: 'pending' };
    try { persist({ draft, attempt: next }); } catch (e) { setBlocked(true); setError(`No pudimos guardar la operación: ${toUserFacingError(e)}`); lock.current = false; setBusy(false); return; }
    try {
      const { operationId, expectedRevision, expectedFingerprint, reason } = next.adjustment;
      const result = await updateProduct(next.before.id, { family: { id: next.family.familyId, version: next.family.version }, attributes: next.attributes }, { operationId, expectedRevision, expectedFingerprint, reason });
      if (!guard(id, expectedKey)) return;
      if (!productValid(result) || result.id !== next.before.id || result.revision !== next.adjustment.expectedRevision + 1 || canonical(result.family) !== canonical({ id: next.family.familyId, version: next.family.version }) || canonical(result.attributes ?? {}) !== canonical(next.attributes) || ['name', 'stockAvailable', 'stockReserved', 'price', 'unit', 'priceCurrency'].some(k => canonical(result[k as keyof Product]) !== canonical(next.before[k as keyof Product]))) throw new Error('Respuesta incierta: no coincide con el cambio solicitado. Conservamos el intento para reintentar.');
      try { persist({ draft, attempt: { ...next, status: 'complete' } }); } catch (e) { setBlocked(true); throw new Error(`El servidor confirmó el cambio, pero no pudimos guardar el comprobante. Conservamos el intento original. ${toUserFacingError(e)}`); }
      setConsent(false);
      try { await read(id, expectedKey); if (guard(id, expectedKey)) await refresh.current(); } catch (e) { if (guard(id, expectedKey)) setReadError(`Cambio aplicado. Falló la lectura posterior: ${toUserFacingError(e)}`); }
    } catch (e) {
      if (!guard(id, expectedKey)) return;
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500) { try { persist({ draft, attempt: { ...next, status: status === 409 ? 'conflict' : 'rejected' } }); } catch { setBlocked(true); } setConsent(false); }
      setError(toUserFacingError(e));
    } finally { if (guard(id, expectedKey)) { lock.current = false; setBusy(false); } }
  }
  const immutable = busy || blocked || Boolean(attempt);
  const keys = [...new Set([...Object.keys(draft.before?.attributes ?? {}), ...Object.keys(draft.family?.schema.attributes ?? {})])].sort();
  return <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Familia de SKU existente" onKeyDown={e => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    if (e.key !== 'Tab') return;
    const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])];
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { e.preventDefault(); first?.focus(); }
  }} className="fixed inset-0 z-50 overflow-auto bg-slate-950/95 p-6 text-slate-100"><div className="mx-auto max-w-4xl space-y-5">
    <div className="flex justify-between"><h2 className="text-xl font-bold">Familia de SKU existente</h2><button className={button} onClick={onClose}>Cerrar</button></div>
    <p>Asociá un SKU, cambiá su versión o reasignalo explícitamente a otra familia. Publicar versiones no migra SKU. Se conserva la unidad, el nombre, stock y precio.</p>
    <p>Los valores de texto se guardan en minúsculas, con espacios normalizados. La revisión muestra el valor que se enviará.</p>
    {error && <p role="alert">{error}</p>}{readError && <p role="alert">{readError}</p>}
    {attempt?.status === 'complete' && <p role="status">Cambio aplicado y comprobante guardado. Las lecturas posteriores no vuelven a enviar el cambio.</p>}
    {attempt?.status === 'complete' && <button className={button} disabled={busy || blocked} onClick={() => void prepareAnother()}>Preparar otro cambio</button>}
    {attempt && ['conflict', 'rejected'].includes(attempt.status) && <button className={button} disabled={busy || blocked} onClick={() => void prepareAnother()}>Descartar intento rechazado y preparar otro cambio</button>}
    {attempt?.status === 'pending' && <p>Hay un intento guardado con resultado pendiente o incierto. Reintentá exactamente la misma operación.</p>}
    {attempt && ['conflict', 'rejected'].includes(attempt.status) && <p>El intento fue rechazado. Releé el estado y la revisión; revisá y autorizá nuevamente para crear una operación nueva.</p>}
    <button className={button} disabled={busy || blocked} onClick={() => void reload()}>Releer estado y familias</button>
    <label className="block">SKU existente<select aria-label="SKU existente" className="block bg-slate-800 p-2" disabled={immutable || Boolean(readError)} value={draft.before?.id ?? ''} onChange={e => edit({ ...draft, before: products.find(p => p.id === e.target.value), family: undefined, fields: {}, removed: [] })}><option value="">Seleccionar SKU explícitamente</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}{p.size ? ` · ${p.size}` : ''} · unidad {p.unit}</option>)}</select></label>
    <label className="block">Familia y versión<select aria-label="Familia y versión" className="block bg-slate-800 p-2" disabled={immutable || !draft.before || Boolean(readError)} value={draft.family ? `${draft.family.familyId}@${draft.family.version}` : ''} onChange={e => selectFamily(families.find(f => `${f.familyId}@${f.version}` === e.target.value))}><option value="">Seleccionar familia y versión</option>{families.map(f => <option key={`${f.familyId}@${f.version}`} value={`${f.familyId}@${f.version}`}>{f.schema.name} · versión {f.version} · unidad {f.schema.unit}</option>)}</select></label>
    {Object.entries(draft.family?.schema.attributes ?? {}).map(([name, schema]) => { const field = draft.fields[name]; if (!field) return null; const change = (value: Partial<Field>) => edit({ ...draft, fields: { ...draft.fields, [name]: { ...field, ...value } } }); return <fieldset key={name} disabled={immutable} className="rounded-xl border border-slate-600 p-3"><legend>{name} · {schema.type}{schema.unit ? ` · ${schema.unit}` : ''}{schema.required ? ' · requerido' : ' · opcional'}</legend>{!schema.required && <label><input type="checkbox" checked={field.omit} onChange={e => change({ omit: e.target.checked })} />Omitir explícitamente {name}</label>}<label className="block">Estado de {name}<select aria-label={`Estado de ${name}`} disabled={field.omit} className="bg-slate-800 p-2" value={field.state} onChange={e => change({ state: e.target.value as Field['state'] })}>{schema.allowedStates.map(s => <option key={s} value={s}>{states[s]}</option>)}</select></label>{field.state === 'known' && <label className="block">Valor de {name}{schema.values || schema.type === 'boolean' ? <select aria-label={`Valor de ${name}`} className="bg-slate-800 p-2" disabled={field.omit} value={field.value} onChange={e => change({ value: e.target.value })}><option value="">Seleccionar valor</option>{(schema.values ?? [true, false]).map(v => <option key={String(v)} value={String(v)}>{typeof v === 'boolean' ? v ? 'Sí (true)' : 'No (false)' : String(v)}</option>)}</select> : <input aria-label={`Valor de ${name}`} className="bg-slate-800 p-2" type={schema.type === 'number' ? 'number' : 'text'} step="any" disabled={field.omit} value={field.value} onChange={e => change({ value: e.target.value })} />}</label>}</fieldset>; })}
    {draft.family && Object.keys(draft.before?.attributes ?? {}).filter(k => !hasOwn(draft.family!.schema.attributes, k)).map(k => <div key={k}><p>{k}: {display(draft.before!.attributes![k])} · fuera del esquema, conservado por defecto</p><label><input type="checkbox" disabled={immutable} checked={draft.removed.includes(k)} onChange={e => edit({ ...draft, removed: e.target.checked ? [...draft.removed, k] : draft.removed.filter(v => v !== k) })} />Quitar explícitamente {k}</label></div>)}
    <label className="block">Motivo obligatorio<textarea aria-label="Motivo obligatorio" className="block w-full bg-slate-800 p-2" disabled={immutable} value={draft.reason} onChange={e => edit({ ...draft, reason: e.target.value })} /></label>
    {draft.before && <section aria-label="Revisión antes y después" className="space-y-2 rounded-xl border border-sky-500 p-4"><h3>Revisión ANTES / DESPUÉS</h3><p>SKU: {draft.before.name}{draft.before.size ? ` · ${draft.before.size}` : ''}</p><p>Familia ANTES: {familyLabel(draft.before.family)}</p><p>Familia DESPUÉS: {draft.family ? `${draft.family.schema.name} · versión ${draft.family.version}` : 'Sin seleccionar'}</p><p>Unidad ANTES: {draft.before.unit} / DESPUÉS: {draft.family?.schema.unit ?? 'Sin seleccionar'}</p><p>Stock disponible: {draft.before.stockAvailable} / {draft.before.stockAvailable} · reservado: {draft.before.stockReserved} / {draft.before.stockReserved} · precio: {draft.before.price} {draft.before.priceCurrency} / {draft.before.price} {draft.before.priceCurrency}</p>{keys.map(k => <p key={k}>{k} — ANTES: {display(draft.before!.attributes?.[k])} / DESPUÉS: {attributes ? display(attributes[k]) : draft.removed.includes(k) || draft.fields[k]?.omit ? 'Omitido explícitamente' : 'Requiere completar validación'}{draft.family && !hasOwn(draft.family.schema.attributes, k) ? ' · atributo fuera del esquema' : ''}</p>)}<p>Motivo: {draft.reason || 'Sin completar'}</p></section>}
    {validation && !attempt && <p>{validation}</p>}
    <label className="block"><input type="checkbox" checked={consent} disabled={busy || blocked || Boolean(readError) || Boolean(attempt && attempt.status !== 'pending') || !attempt && Boolean(validation)} onChange={e => setConsent(e.target.checked)} />Revisé el antes y después y autorizo cambiar la familia y atributos de este SKU.</label>
    <button className={button} disabled={busy || blocked || !consent || Boolean(readError) || Boolean(attempt && attempt.status !== 'pending') || !attempt && Boolean(validation)} onClick={() => void submit()}>{attempt?.status === 'pending' ? 'Reintentar la misma operación' : 'Confirmar familia del SKU'}</button>
  </div></div>;
}
