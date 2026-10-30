import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { query } from './api';
import { moneyLabel, type Candidate, type Product } from './types';

const selectionLimit = 100;
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
      {items.map(item => <label className="pending-variant" key={item.skuId}>
        <input type="checkbox" aria-label={`Seleccionar ${item.name} ${item.size || item.label || item.skuId}`} disabled={busy || (selectedIds.size >= selectionLimit && !selectedIds.has(item.skuId))}
          checked={selectedIds.has(item.skuId)} onChange={event => onSelect([item], event.target.checked)}/>
        <span className="size-tag">{item.size || item.label || item.productModel || item.name}</span>
        <small>{moneyLabel(item.price)}</small><span className="pending-variant-stock">{item.stockAvailable} disponibles</span>
      </label>)}
    </div>
  </article>;
}

export function PendingInventory({ onCreate, onLink }: { onCreate: (items: Candidate[]) => void; onLink: (id: string, items: Candidate[]) => void }) {
  const [items, setItems] = useState<Candidate[]>([]), [selected, setSelected] = useState<Candidate[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false), [targets, setTargets] = useState<Product[]>([]), [targetQuery, setTargetQuery] = useState(''), [targetCursor, setTargetCursor] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState('');
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
  const generation = useRef(0), targetGeneration = useRef(0);
  const load = async (next?: string) => {
    const current = ++generation.current; setBusy(true); setError('');
    try { const result = await query<{ items: Candidate[]; nextCursor: string | null }>(`/inventory-candidates?${new URLSearchParams({ q, grouped: 'true', ...(next ? { cursor: next } : {}) })}`);
      if (current !== generation.current) return;
      setItems(rows => next ? [...rows, ...result.items] : result.items); setCursor(result.nextCursor);
      // A new search requires reviewing the selection again.
      if (!next) { setSelected([]); setSelectionError(''); setChoosing(false); }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'No pude cargar las variantes.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const findTargets = async (next?: string) => {
    const current = ++targetGeneration.current; setBusy(true); setError('');
    try { const result = await query<{ items: Product[]; nextCursor: string | null }>(`/products?${new URLSearchParams({ q: targetQuery, ...(next ? { cursor: next } : {}) })}`);
      if (current === targetGeneration.current) { setTargets(rows => next ? [...rows, ...result.items] : result.items); setTargetCursor(result.nextCursor); }
    } catch (cause) { if (current === targetGeneration.current) setError(cause instanceof Error ? cause.message : 'No pude buscar fichas.'); }
    finally { if (current === targetGeneration.current) setBusy(false); }
  };
  const latestLoad = useRef(load); latestLoad.current = load;
  useEffect(() => { void latestLoad.current(); const focus = () => { if (!document.hidden) void latestLoad.current(); }; addEventListener('focus', focus); return () => { generation.current++; targetGeneration.current++; removeEventListener('focus', focus); }; }, []);
  return <section className="page-section pending-inventory"><p className="eyebrow dark">DEL STOCK A TU CATÁLOGO</p><h1>Pendientes de catalogar</h1><p>Seleccioná un producto para incluir todas sus variantes. Desplegalo para revisar los talles o elegirlos de a uno antes de crear o vincular la ficha.</p>
    {error && <div className="notice" role="alert">{error}</div>}
    <form className="filters" onSubmit={event => { event.preventDefault(); void load(); }}><input aria-label="Buscar variantes pendientes" value={q} onChange={event => setQ(event.target.value)} placeholder="Buscá un producto…"/><button disabled={busy}>Buscar</button><button type="button" disabled={busy} onClick={() => void load()}>Actualizar pendientes</button></form>
    <div className="selection-toolbar"><strong aria-live="polite" aria-atomic="true">{selected.length} variantes seleccionadas (máximo 100)</strong><button className="primary" disabled={busy || !selected.length} onClick={() => onCreate(selected)}>Crear ficha y vincular</button><button disabled={busy || !selected.length} onClick={() => { setChoosing(true); void findTargets(); }}>Vincular a una ficha existente</button></div>
    {selectionError && <div className="notice" role="alert">{selectionError}</div>}
    <div className="pending-product-list" aria-busy={busy}>{groups.map(group => <PendingProduct key={group.key} items={group.items} selectedIds={selectedIds} busy={busy} onSelect={select}/>)}</div>
    {!items.length && !busy && !error && <p>No hay variantes pendientes para esta búsqueda. <a href="/?section=productos">Cargar productos en Stocky</a></p>}{cursor && <button disabled={busy} onClick={() => void load(cursor)}>Cargar más</button>}
    {choosing && <div className="panel"><h2>Elegí la ficha que recibirá los SKU</h2><p>En el siguiente paso podrás revisar todos los vínculos antes de guardarlos.</p><form className="filters" onSubmit={event => { event.preventDefault(); void findTargets(); }}><input aria-label="Buscar ficha existente" value={targetQuery} onChange={event => setTargetQuery(event.target.value)}/><button disabled={busy}>Buscar ficha</button></form>{targets.filter(item => item.status !== 'archived').map(item => <button className="target-product" key={item.id} disabled={busy} onClick={() => onLink(item.id, selected)}>{item.title} · {item.variants.length} SKU vinculados →</button>)}{targetCursor && <button disabled={busy} onClick={() => void findTargets(targetCursor)}>Más fichas</button>}<button onClick={() => setChoosing(false)}>Cancelar</button></div>}
  </section>;
}
