import { useEffect, useRef, useState } from 'react';
import { query } from './api';
import { moneyLabel, type Candidate, type Product } from './types';

export function PendingInventory({ onCreate, onLink }: { onCreate: (items: Candidate[]) => void; onLink: (id: string, items: Candidate[]) => void }) {
  const [items, setItems] = useState<Candidate[]>([]), [selected, setSelected] = useState<Candidate[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false), [targets, setTargets] = useState<Product[]>([]), [targetQuery, setTargetQuery] = useState(''), [targetCursor, setTargetCursor] = useState<string | null>(null);
  const generation = useRef(0), targetGeneration = useRef(0);
  const load = async (next?: string) => {
    const current = ++generation.current; setBusy(true); setError('');
    try { const result = await query<{ items: Candidate[]; nextCursor: string | null }>(`/inventory-candidates?${new URLSearchParams({ q, ...(next ? { cursor: next } : {}) })}`);
      if (current !== generation.current) return;
      setItems(rows => next ? [...rows, ...result.items] : result.items); setCursor(result.nextCursor);
      // A new search requires reviewing the selection again.
      if (!next) setSelected([]);
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
  return <section className="page-section"><p className="eyebrow dark">DEL STOCK A TU CATÁLOGO</p><h1>Pendientes de catalogar</h1><p>Seleccioná los SKU que pertenecen a un mismo producto. Revisá su identidad, presentación y unidad antes de crear o vincular la ficha.</p>
    {error && <div className="notice" role="alert">{error}</div>}
    <form className="filters" onSubmit={event => { event.preventDefault(); void load(); }}><input aria-label="Buscar variantes pendientes" value={q} onChange={event => setQ(event.target.value)} placeholder="Buscá un producto…"/><button disabled={busy}>Buscar</button><button type="button" disabled={busy} onClick={() => void load()}>Actualizar pendientes</button></form>
    <div className="selection-toolbar"><strong>{selected.length} variantes seleccionadas (máximo 100)</strong><button className="primary" disabled={busy || !selected.length} onClick={() => onCreate(selected)}>Crear ficha y vincular</button><button disabled={busy || !selected.length} onClick={() => { setChoosing(true); void findTargets(); }}>Vincular a una ficha existente</button></div>
    <div className="variant-list">{items.map(item => <label className="variant-row" key={item.skuId}><input type="checkbox" aria-label={`Seleccionar ${item.name} ${item.size}`} disabled={busy || (selected.length >= 100 && !selected.some(row => row.skuId === item.skuId))} checked={selected.some(row => row.skuId === item.skuId)} onChange={event => { setChoosing(false); setSelected(rows => event.target.checked ? [...rows, item] : rows.filter(row => row.skuId !== item.skuId)); }}/><span className="size-tag">{item.size || item.productModel || item.name}</span><div><strong>{item.name}</strong><small>{moneyLabel(item.price)}</small></div><span>{item.stockAvailable} disponibles</span></label>)}</div>
    {!items.length && !busy && !error && <p>No hay variantes pendientes para esta búsqueda. <a href="/?section=productos">Cargar productos en Stocky</a></p>}{cursor && <button disabled={busy} onClick={() => void load(cursor)}>Cargar más</button>}
    {choosing && <div className="panel"><h2>Elegí la ficha que recibirá los SKU</h2><p>En el siguiente paso podrás revisar todos los vínculos antes de guardarlos.</p><form className="filters" onSubmit={event => { event.preventDefault(); void findTargets(); }}><input aria-label="Buscar ficha existente" value={targetQuery} onChange={event => setTargetQuery(event.target.value)}/><button disabled={busy}>Buscar ficha</button></form>{targets.filter(item => item.status !== 'archived').map(item => <button className="target-product" key={item.id} disabled={busy} onClick={() => onLink(item.id, selected)}>{item.title} · {item.variants.length} SKU vinculados →</button>)}{targetCursor && <button disabled={busy} onClick={() => void findTargets(targetCursor)}>Más fichas</button>}<button onClick={() => setChoosing(false)}>Cancelar</button></div>}
  </section>;
}
