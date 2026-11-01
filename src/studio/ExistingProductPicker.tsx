import { useEffect, useId, useRef, useState } from 'react';
import { query } from './api';
import type { Product } from './types';

export function ExistingProductPicker({ onChoose, onCancel }: { onChoose: (id: string) => void; onCancel: () => void }) {
  const [items, setItems] = useState<Product[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState(''), [publication, setPublication] = useState('published');
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const generation = useRef(0), heading = useRef<HTMLHeadingElement>(null), headingId = useId();
  const applied = useRef({ q: '', publication: 'published' });
  const load = async (next?: string) => {
    const current = ++generation.current; setBusy(true); setError('');
    const filters = next ? applied.current : { q, publication };
    try {
      const result = await query<{ items: Product[]; nextCursor: string | null }>(`/products?${new URLSearchParams({ q: filters.q, ...(filters.publication ? { publication: filters.publication } : {}), ...(next ? { cursor: next } : {}) })}`);
      if (current !== generation.current) return;
      applied.current = filters;
      setItems(rows => next ? [...rows, ...result.items] : result.items); setCursor(result.nextCursor);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'No pude buscar productos.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  useEffect(() => { heading.current?.focus(); void load(); return () => { generation.current++; }; }, []);
  const targets = items.filter(item => item.status !== 'archived');
  return <section className="panel" aria-labelledby={headingId} aria-busy={busy}>
    <h2 id={headingId} ref={heading} tabIndex={-1}>Adjuntar a un producto existente</h2>
    <p>Elegí el producto que ya tiene la publicación, aunque su nombre sea distinto. Después revisá los talles y guardá los vínculos. Se conservan sus fotos y descripción.</p>
    <form className="filters" onSubmit={event => { event.preventDefault(); void load(); }}>
      <input aria-label="Buscar ficha existente" placeholder="Nombre de la publicación…" value={q} onChange={event => setQ(event.target.value)}/>
      <select aria-label="Publicación de destino" value={publication} onChange={event => setPublication(event.target.value)}><option value="published">Publicados</option><option value="">Todas las fichas</option></select>
      <button disabled={busy}>Buscar ficha</button>
    </form>
    {error && <div className="notice" role="alert">{error}</div>}
    {busy && <p role="status">Buscando productos…</p>}
    {targets.map(item => <button type="button" className="target-product" key={item.id} disabled={busy} onClick={() => onChoose(item.id)}>{item.title} · {item.variants.filter(variant => variant.active).map(variant => variant.label || variant.size || variant.name).join(', ')} · Adjuntar a este producto →</button>)}
    {!busy && !error && !targets.length && <p>No encontramos productos con estos filtros. Buscá otro nombre o elegí Todas las fichas.</p>}
    {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>Más fichas</button>}
    <button type="button" onClick={onCancel}>Cancelar</button>
  </section>;
}
