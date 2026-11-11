import { useEffect, useRef, useState } from 'react';
import { imageBlob, query } from './api';
import { readBatchJob } from './batchJob';
import { useNearViewport } from './useNearViewport';
type Entry = { snapshotId: string; productId: string; title: string; templateId: string; imageId: string; imageAlt: string; preparedAt: string; expiresAt: string; expired: boolean;
  lastExport: { kind: string; filename: string; mimeType: string; sizeBytes: number; reportedAt: string } | null };
const templates: Record<string, string> = { arrival: 'Nuevo ingreso', available: 'Stock disponible', last_unit: 'Última unidad', promo: 'Promoción', matchday: 'Día de fútbol' };
function LibraryImage({ entry }: { entry: Entry }) {
  const [url, setUrl] = useState('');
  const { placeholder, shouldLoad } = useNearViewport<HTMLSpanElement>();
  useEffect(() => {
    if (!shouldLoad) return;
    let active = true, local = '';
    imageBlob(entry.productId, entry.imageId, true).then(blob => { if (active) { local = URL.createObjectURL(blob); setUrl(local); } }).catch(() => {});
    return () => { active = false; if (local) URL.revokeObjectURL(local); };
  }, [entry.productId, entry.imageId, shouldLoad]);
  return url ? <img src={url} alt={entry.imageAlt || entry.title} decoding="async"/> : <span ref={placeholder} className="library-fm">S／</span>;
}
export function ContentLibrary({ onOpen, onResumeBatch }: { onOpen: (id: string) => void; onResumeBatch: () => void }) {
  const [items, setItems] = useState<Entry[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const batch = readBatchJob();
  const request = useRef<AbortController | null>(null);
  const load = async (next?: string) => {
    request.current?.abort();
    const attempt = new AbortController();
    request.current = attempt;
    setBusy(true);
    try {
      const result = await query<{ items: Entry[]; nextCursor: string | null }>(`/content-library${next ? '?cursor=' + encodeURIComponent(next) : ''}`, attempt.signal);
      if (attempt.signal.aborted) return;
      setItems(previous => next ? [...previous, ...result.items] : result.items);
      setCursor(result.nextCursor);
      setError('');
    } catch (cause) {
      if (!attempt.signal.aborted) setError(cause instanceof Error ? cause.message : 'No pude consultar la biblioteca.');
    } finally {
      if (!attempt.signal.aborted) { request.current = null; setBusy(false); }
    }
  };
  useEffect(() => { void load(); return () => request.current?.abort(); }, []);
  return <section className="page-section content-library"><div className="section-heading"><div><p className="eyebrow dark">TU CONTENIDO, EN UN SOLO LUGAR</p><h1>Biblioteca de historias</h1></div>{batch && <button onClick={onResumeBatch}>Retomar lote guardado ↗</button>}</div><p>Historial de historias preparadas y solicitudes de descarga. Abrí la ficha para generar otra con datos actuales.</p>{error && <div className="notice" role="status">{error}<button onClick={() => void load()}>Reintentar</button></div>}<div className="library-grid">{items.map(entry => <article className="library-card" key={entry.snapshotId}><div className="library-image"><LibraryImage entry={entry}/><span>{templates[entry.templateId] ?? 'Historia'}</span></div><div className="library-card-body"><small>{new Date(entry.preparedAt).toLocaleString('es-UY')}</small><h2>{entry.title}</h2><p>{entry.lastExport?.kind === 'download_requested' ? 'Descarga solicitada' : entry.lastExport?.kind === 'share_requested' ? 'Compartir solicitado' : entry.lastExport?.kind === 'generated' ? 'Archivo generado' : 'Historia preparada'}</p><small>{entry.expired ? 'Snapshot vencido · generá con datos actuales' : 'Requiere revisar datos antes de otra exportación'}</small><button onClick={() => onOpen(entry.productId)}>Abrir ficha y generar ↗</button></div></article>)}</div>{!busy && !error && !items.length && <div className="empty-state"><h3>Tu contenido empieza acá.</h3><p>Las historias que prepares desde una ficha aparecerán en esta biblioteca.</p></div>}{busy && <p role="status">Cargando biblioteca…</p>}{cursor && <button disabled={busy} onClick={() => void load(cursor)}>Ver más historias ↓</button>}<p className="library-note">La biblioteca conserva los datos del diseño. Los archivos se generan en tu navegador; una solicitud de descarga no confirma su guardado ni una publicación en redes.</p></section>;
}
