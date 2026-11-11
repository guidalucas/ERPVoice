import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { command, pendingOperations, query, retryOperation } from './api';
import { moneyLabel, type Candidate } from './types';
import { ExistingProductPicker } from './ExistingProductPicker';

const selectionLimit = 100;
const syncRoute = '/inventory-candidates/sync';
type SyncResult = { created: number; linkedSkus: number; needsReview: number };
const sizeOrder = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
function compareSizes(a: Candidate, b: Candidate) {
  const left = sizeOrder.indexOf(a.size?.toUpperCase()), right = sizeOrder.indexOf(b.size?.toUpperCase());
  return left >= 0 && right >= 0 ? left - right : (a.size || a.label || '').localeCompare(b.size || b.label || '', 'es', { numeric: true });
}

function PendingProduct({ items, selectedIds, busy, onSelect }: {
  items: Candidate[]; selectedIds: Set<string>; busy: boolean; onSelect: (items: Candidate[], checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false), detailsId = useId(), checkbox = useRef<HTMLInputElement>(null);
  const count = items.filter(item => selectedIds.has(item.skuId)).length;
  const allSelected = count === items.length, partial = count > 0 && !allSelected;
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = partial; }, [partial]);
  const name = items[0].name, hasSizes = items.every(item => item.size);
  const prices = new Set(items.map(item => moneyLabel(item.price)));
  const stock = items.reduce((total, item) => total + item.stockAvailable, 0);
  return <article className={`pending-product${count ? ' has-selection' : ''}`}>
    <div className="pending-product-heading">
      <label className="pending-product-select"><input ref={checkbox} type="checkbox" checked={allSelected} disabled={busy}
        aria-label={`Seleccionar todos los ${hasSizes ? 'talles' : 'SKU'} de ${name}`} onChange={event => onSelect(items, event.target.checked)}/></label>
      <button type="button" className="pending-product-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
        <span className="pending-product-info"><strong>{name}</strong><small>{prices.size === 1 ? [...prices][0] : `Precios por ${hasSizes ? 'talle' : 'variante'}`}</small></span>
        <span className="pending-product-summary"><span>{items.length} {hasSizes ? (items.length === 1 ? 'talle' : 'talles') : (items.length === 1 ? 'variante' : 'variantes')} · {stock} disponibles</span><small>{count ? `${count} de ${items.length} seleccionados` : (expanded ? 'Ocultar detalle' : hasSizes ? 'Ver talles' : 'Ver variantes')}</small></span>
        <span className="pending-product-chevron" aria-hidden="true">⌄</span>
      </button>
    </div>
    <div id={detailsId} hidden={!expanded} className="pending-product-variants">
      {expanded && items.map(item => <label className="pending-variant" key={item.skuId}>
        <input type="checkbox" aria-label={`Seleccionar ${item.name} ${item.size || item.label || item.skuId}`} disabled={busy || (selectedIds.size >= selectionLimit && !selectedIds.has(item.skuId))}
          checked={selectedIds.has(item.skuId)} onChange={event => onSelect([item], event.target.checked)}/>
        <span className="size-tag">{item.size || item.label || item.productModel || item.name}</span>
        <small>{moneyLabel(item.price)}</small><span className="pending-variant-stock">{item.stockAvailable} disponibles</span>
      </label>)}
    </div>
  </article>;
}

export function PendingInventory({ onCreate, onLink, onPhotos }: {
  onCreate: (items: Candidate[]) => void; onLink: (id: string, items: Candidate[]) => void; onPhotos: () => void;
}) {
  const [items, setItems] = useState<Candidate[]>([]), [selected, setSelected] = useState<Candidate[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const [syncing, setSyncing] = useState(false), [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const syncInProgress = useRef(false);
  const working = busy || syncing;
  const selectedIds = useMemo(() => new Set(selected.map(item => item.skuId)), [selected]);
  const groups = useMemo(() => {
    const result = new Map<string, Candidate[]>();
    for (const item of items) {
      const key = JSON.stringify([item.name, item.productModel ?? null, item.productType ?? null, item.unit ?? null]);
      const group = result.get(key) ?? []; group.push(item); result.set(key, group);
    }
    return [...result].map(([key, variants]) => ({ key, items: variants.sort(compareSizes) }));
  }, [items]);
  const select = (variants: Candidate[], checked: boolean) => {
    const additions = variants.filter(item => !selectedIds.has(item.skuId));
    if (checked && selected.length + additions.length > selectionLimit) {
      setSelectionError('Podés seleccionar hasta 100 variantes. Desplegá el producto para elegir talles o quitá otros productos de la selección.'); return;
    }
    setSelectionError(''); setChoosing(false);
    const ids = new Set(variants.map(item => item.skuId));
    setSelected(rows => checked ? [...rows, ...additions] : rows.filter(item => !ids.has(item.skuId)));
  };
  const request = useRef<AbortController | null>(null);
  const load = async (next?: string, search = q) => {
    request.current?.abort();
    const attempt = new AbortController();
    request.current = attempt;
    setBusy(true); setError('');
    try { const result = await query<{ items: Candidate[]; nextCursor: string | null }>(`/inventory-candidates?${new URLSearchParams({ q: search, grouped: 'true', ...(next ? { cursor: next } : {}) })}`, attempt.signal);
      if (attempt.signal.aborted) return;
      setItems(rows => next ? [...rows, ...result.items] : result.items); setCursor(result.nextCursor);
      // A new search requires reviewing the selection again.
      if (!next) { setSelected([]); setSelectionError(''); setChoosing(false); }
    } catch (cause) { if (!attempt.signal.aborted) setError(cause instanceof Error ? cause.message : 'No pude cargar las variantes.'); }
    finally { if (!attempt.signal.aborted) { request.current = null; setBusy(false); } }
  };
  const latestLoad = useRef(load); latestLoad.current = load;
  useEffect(() => {
    void latestLoad.current();
    const focus = () => { if (!document.hidden && !syncInProgress.current && !request.current) void latestLoad.current(); };
    addEventListener('focus', focus);
    return () => { request.current?.abort(); removeEventListener('focus', focus); };
  }, []);
  const sync = async () => {
    if (working || syncInProgress.current) return;
    syncInProgress.current = true;
    setSyncing(true); setSyncResult(null); setError(''); setChoosing(false);
    try {
      const previous = pendingOperations().find(item => item.route === syncRoute);
      const result = previous ? await retryOperation<SyncResult>(previous) : await command<SyncResult>(syncRoute, 'POST', {});
      setSyncResult(result);
      setQ('');
      await latestLoad.current(undefined, '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No pude sincronizar el catálogo.'); }
    finally { syncInProgress.current = false; setSyncing(false); }
  };
  return <section className="page-section pending-inventory"><p className="eyebrow dark">DEL STOCK A TU CATÁLOGO</p><h1>Pendientes de catalogar</h1><p>Sincronizá todos los pendientes de Stocky para crear una ficha en borrador por producto con sus talles o variantes. Después podés agregarle las fotos.</p>
    <button type="button" className="primary" disabled={working} onClick={() => void sync()}>{syncing ? 'Sincronizando…' : 'Sincronizar con Stocky'}</button>
    {syncResult && <div className="notice">
      <span role="status">{syncResult.created ? `${syncResult.created} ${syncResult.created === 1 ? 'ficha creada' : 'fichas creadas'} · ${syncResult.linkedSkus} ${syncResult.linkedSkus === 1 ? 'variante vinculada' : 'variantes vinculadas'}.` : 'No hay fichas nuevas para crear.'}
        {syncResult.needsReview > 0 && ` ${syncResult.needsReview} ${syncResult.needsReview === 1 ? 'grupo requiere' : 'grupos requieren'} revisión manual. Podés revisarlos en la lista de pendientes.`}</span>
      {syncResult.created > 0 && <button type="button" onClick={onPhotos}>Ver fichas sin fotos</button>}
    </div>}
    {error && <div className="notice" role="alert">{error}</div>}
    <p>Para revisar una ficha por separado, desplegá el producto y elegí sus variantes antes de crearla o vincularla.</p>
    <form className="filters" onSubmit={event => { event.preventDefault(); if (!working) void load(); }}><input aria-label="Buscar variantes pendientes" value={q} onChange={event => setQ(event.target.value)} disabled={syncing} placeholder="Buscá un producto…"/><button disabled={working}>Buscar</button><button type="button" disabled={working} onClick={() => void load()}>Actualizar pendientes</button></form>
    <div className="selection-toolbar"><strong aria-live="polite" aria-atomic="true">{selected.length} variantes seleccionadas (máximo 100)</strong><button disabled={working || !selected.length} onClick={() => onCreate(selected)}>Crear ficha y vincular</button><button disabled={working || !selected.length} onClick={() => setChoosing(true)}>Vincular a una ficha existente</button></div>
    {choosing && <ExistingProductPicker onChoose={id => onLink(id, selected)} onCancel={() => setChoosing(false)}/>}
    {selectionError && <div className="notice" role="alert">{selectionError}</div>}
    <div className="pending-product-list" aria-busy={working}>{groups.map(group => <PendingProduct key={group.key} items={group.items} selectedIds={selectedIds} busy={working} onSelect={select}/>)}</div>
    {!items.length && !working && !error && <p>No hay variantes pendientes para esta búsqueda. <a href="/?section=productos">Cargar productos en Stocky</a></p>}{cursor && <button disabled={working} onClick={() => void load(cursor)}>Cargar más</button>}
  </section>;
}
