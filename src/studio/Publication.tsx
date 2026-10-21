import { useEffect, useRef, useState } from 'react';
import { command, query } from './api';
import type { Product } from './types';
type Catalog = { slug: string; publicEnabled: boolean; revision: number; path: string };
type Publication = { status: 'hidden' | 'published'; revision: number; publishedAt: string | null };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'No pude consultar la publicación.';
const publicUrl = (path: string) => `${String(import.meta.env.VITE_CATALOG_ORIGIN ?? (import.meta.env.DEV ? '' : import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_META_API_BASE ?? '')).replace(/\/$/, '')}${path}`;

export function CatalogSettings() {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [slug, setSlug] = useState(''), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    query<Catalog | null>('/catalog').then(value => { if (active) { setCatalog(value); setSlug(value?.slug ?? ''); setEnabled(value?.publicEnabled ?? false); } })
      .catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  return <form className="panel catalog-settings" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { setCatalog(await command('/catalog', 'PUT', { expectedRevision: catalog?.revision ?? 0, slug, publicEnabled: enabled })); setSaved(true); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }}><h2>Catálogo público</h2><p>El catálogo y cada ficha se publican de forma independiente. Preparar una ficha todavía la mantiene privada.</p><label className="field"><span>Identificador público · enlace estable</span><input required minLength={3} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" readOnly={Boolean(catalog)} disabled={busy} value={slug} onChange={event => setSlug(event.target.value)} placeholder="fullmatch-casacas"/></label><label className="checkbox-field"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)}/> Habilitar acceso público al catálogo</label>{error && <div className="notice" role="status">{error}</div>}{saved && <div className="notice" role="status">Configuración del catálogo guardada.</div>}<button className="primary" disabled={busy}>{busy ? 'Cargando…' : 'Guardar catálogo'}</button>{catalog?.publicEnabled && <a className="catalog-preview" href={publicUrl(catalog.path)} target="_blank" rel="noopener noreferrer">Abrir catálogo ↗</a>}</form>;
}
export function PublicationPanel({ product, disabled }: { product: Product; disabled: boolean }) {
  const generation = useRef(0);
  const [publication, setPublication] = useState<Publication | null>(null), [catalog, setCatalog] = useState<Catalog | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = async () => { const attempt = ++generation.current; setBusy(true); try { const [state, config] = await Promise.all([query<Publication>(`/products/${product.id}/publication`), query<Catalog | null>('/catalog')]); if (attempt === generation.current) { setPublication(state); setCatalog(config); setError(''); } } catch (cause) { if (attempt === generation.current) setError(errorText(cause)); } finally { if (attempt === generation.current) setBusy(false); } };
  useEffect(() => { void load(); return () => { generation.current++; }; }, [product.id, product.revision]);
  const change = async (status: Publication['status']) => { if (!publication) return; generation.current++; setBusy(true); setError(''); try { setPublication(await command(`/products/${product.id}/publication`, 'PUT', { expectedRevision: publication.revision,
    expectedProductRevision: product.revision, status, reason: 'Publicación revisada explícitamente en Studio' })); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <div className="publication-panel"><hr/><h4>En el catálogo público</h4>{error ? <><p>{error}</p><button onClick={() => void load()} disabled={busy}>Consultar publicación</button></> : <><p>{publication?.status === 'published' ? catalog?.publicEnabled ? 'Publicada' : 'Publicada · catálogo deshabilitado' : 'Oculta para clientes'}</p>{!catalog && <p>Configurá el catálogo para publicar fichas.</p>}{publication?.status === 'published' ? <><a className="catalog-preview" href={publicUrl(`${catalog?.path}/p/${product.slug}`)} target="_blank" rel="noopener noreferrer">Ver ficha pública ↗</a><button disabled={busy || disabled} onClick={() => void change('hidden')}>Ocultar del catálogo</button></> : <button disabled={busy || disabled || !catalog || product.status !== 'ready' || !product.readiness.canPrepare} onClick={() => void change('published')}>Publicar en catálogo</button>}</>}</div>;
}
