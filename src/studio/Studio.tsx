import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../store/AuthStore';
import { createWhatsAppLogin, pollWhatsAppLogin, type WhatsAppLoginChallenge } from '../services/authService';
import { command, imageBlob, pendingOperations, query, recoverOperation, retryOperation, studioFetch, uploadPhoto } from './api';
import { defaultAppearance, brandInitials, moneyLabel, priceLabel, type Candidate, type CommercialFields, type Product, type Profile, type Photo } from './types';
import { StoryEditor } from './StoryEditor';
import { CatalogSettings, PublicationPanel } from './Publication';
import { ContentLibrary } from './ContentLibrary';
import { BatchStudio } from './BatchStudio';
import { createBatchJob, readBatchJob } from './batchJob';
import { BusinessOnboarding, type SetupStatus } from './BusinessOnboarding';
import { MoneyReview } from './MoneyReview';
import { PendingInventory } from './PendingInventory';
import { AppearanceFields, BrandImage } from './Branding';
import { StockyLogo } from '../components/brand/StockyLogo';
import { ThemeToggle } from '../components/dashboard/ThemeToggle';

const message = (error: unknown) => error instanceof Error ? error.message : 'No pude completar la operación.';
const statusLabel = { draft: 'Borrador', ready: 'Preparada', archived: 'Archivada' };
const blockerLabels: Record<string, string> = { COVER_REQUIRED: 'Elegí una foto de portada', NO_ACTIVE_SKU: 'Vinculá al menos un SKU activo',
  IDENTITY_INCOMPLETE: 'Completá el nombre del producto', MONEY_UNCONFIRMED: 'Confirmá moneda y escala en la preparación de Stocky',
  SKU_IDENTITY_CHANGED: 'Revisá los vínculos: cambió una variante', INVALID_VARIANT: 'Revisá la presentación y la unidad en Stocky',
  DUPLICATE_SIZE: 'Hay variantes con la misma presentación', PRICE_NOT_READY: 'Revisá los precios en Stocky', INVENTORY_INVALID: 'Revisá los saldos en Stocky' };
const emptyFields: CommercialFields = { title: '', description: '', teamKey: null, teamName: null, teamKind: null, season: null, kitKey: null, versionKey: null, sleeveKey: null };
const fieldKeys = Object.keys(emptyFields) as (keyof CommercialFields)[];
const identityLabels: Record<string, string> = { teamKey: 'identificador del equipo', teamName: 'equipo', teamKind: 'tipo de equipo', season: 'temporada', kitKey: 'equipación', versionKey: 'versión', sleeveKey: 'manga' };
const productFields = (product: Product) => Object.fromEntries(fieldKeys.map(key => [key, product[key]])) as CommercialFields;
const linkOf = (item: Candidate | Product['variants'][number]) => ({ skuId: item.skuId, expectedRevision: item.revision, expectedFingerprint: item.identityFingerprint });
function Brand() { return <a className="studio-brand" href="/" aria-label="Stocky · ir al inventario"><StockyLogo size="md" className="studio-brand-logo"/><span className="studio-brand-copy"><strong>Stocky</strong><span>Studio</span></span></a>; }
function AccessFrame({ children }: { children: ReactNode }) { return <div className="studio-access"><header className="studio-access-header"><Brand/><ThemeToggle/></header>{children}</div>; }
function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) { return <div role="status" className="notice">{children}{action}</div>; }
function PreparationBlockers({ product, onTab }: { product: Product; onTab: (tab: 'details' | 'variants' | 'photos') => void }) {
  return <ul className="checklist">{product.readiness.blockers.map(code => <li key={code}>{code === 'IDENTITY_INCOMPLETE' ? <button onClick={() => onTab('details')}>Completá: {(product.readiness.missingFields ?? []).map(key => identityLabels[key] ?? key).join(', ') || 'nombre del producto'}</button>
    : code === 'MONEY_UNCONFIRMED' ? <><a href="#/settings">Revisar moneda en Configuración</a><ul>{product.readiness.moneyIssues?.map(issue => <li key={issue.skuId}>{product.variants.find(item => item.skuId === issue.skuId)?.name}: {issue.cause === 'POLICY_MISSING' ? 'falta confirmar la moneda del negocio' : issue.cause === 'CURRENCY_MISMATCH' ? 'la moneda de esta variante no coincide; revisala sin convertir su precio' : 'importe inválido; corregilo en Stocky'}</li>)}</ul></>
    : code === 'COVER_REQUIRED' ? <button onClick={() => onTab('photos')}>{blockerLabels[code]}</button>
    : ['NO_ACTIVE_SKU', 'SKU_IDENTITY_CHANGED', 'DUPLICATE_SIZE'].includes(code) ? <button onClick={() => onTab('variants')}>{blockerLabels[code]}</button>
    : <a href="/?section=productos">{blockerLabels[code] ?? code} ↗</a>}</li>)}</ul>;
}

export function PrivatePhoto({ product, imageId, thumbnail = true }: { product: Product; imageId?: string | null; thumbnail?: boolean }) {
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(''); setFailed(false); if (!imageId) return;
    let active = true, objectUrl = '';
    imageBlob(product.id, imageId, thumbnail).then(blob => { if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [product.id, imageId, thumbnail, product.revision]);
  return url ? <img src={url} alt={product.images.find(image => image.id === imageId)?.altText || product.title}/> : <div className="photo-empty"><span className="shirt">◇</span><small>{failed ? 'Foto no disponible' : imageId ? 'Cargando foto…' : 'Fotografía pendiente'}</small></div>;
}

function Login() {
  const { completeWhatsAppLogin } = useAuth();
  const [challenge, setChallenge] = useState<WhatsAppLoginChallenge | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!challenge) return; let active = true, checking = false;
    const timer = setInterval(async () => {
      if (checking) return; checking = true;
      try { const result = await pollWhatsAppLogin(challenge); if (!active) return;
        if (result.status === 'authenticated') { clearInterval(timer); await completeWhatsAppLogin(result); }
        else if (result.status !== 'pending') { setChallenge(null); setError('El acceso venció. Generá un nuevo enlace.'); }
      } catch (cause) { if (active) setError(message(cause)); } finally { checking = false; }
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [challenge, completeWhatsAppLogin]);
  const start = async () => { setBusy(true); setError(''); try { setChallenge(await createWhatsAppLogin()); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  return <div className="login"><div className="studio-login-tools"><ThemeToggle/></div><section className="login-brand"><Brand/><p className="eyebrow">TU NEGOCIO, BIEN PRESENTADO</p><h1>Tu catálogo.<br/>Tu marca.<br/><em>Tu próximo paso.</em></h1><p>Fichas, fotos y contenido para tu negocio, conectados a Stocky.</p><span className="pitch-line"/></section>
    <section className="login-form"><div><span className="eyebrow">ESPACIO PRIVADO</span><h2>Entrá a Studio</h2><p>Usá el mismo acceso de Stocky para gestionar tu catálogo comercial.</p>
      {error && <Notice>{error}</Notice>}{challenge ? <><a className="button primary" href={challenge.whatsappUrl} target="_blank" rel="noreferrer">Continuar en WhatsApp ↗</a><p>Enviá el mensaje de acceso. Esta pantalla continuará cuando quede validado.</p><button onClick={() => setChallenge(null)}>Generar otro enlace</button></> : <button className="primary" disabled={busy} onClick={start}>{busy ? 'Preparando acceso…' : 'Ingresar con WhatsApp ↗'}</button>}
      <small>Acceso para el propietario del negocio habilitado.</small></div></section></div>;
}

type View = 'products' | 'pending' | 'settings' | 'recovery' | 'library';
export function Studio() {
  const { session, isBootstrapping, logout } = useAuth();
  const [view, setView] = useState<View>('products'), [profile, setProfile] = useState<Profile | null>(null), [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null), [creating, setCreating] = useState(false), [version, setVersion] = useState(0);
  const [batchOpen, setBatchOpen] = useState(false);
  const [initialCandidates, setInitialCandidates] = useState<Candidate[]>([]);
  const [setupVersion, setSetupVersion] = useState(0);
  const [setup, setSetup] = useState<SetupStatus | null>(null), [setupLoading, setSetupLoading] = useState(true);
  useEffect(() => {
    let active = true; setSetupLoading(true); setError(''); setSetup(null); setProfile(null);
    if (!session || session.role !== 'owner') { setSetupLoading(false); return; }
    query<SetupStatus>('/setup').then(result => { if (active) { setSetup(result); setProfile(result.profile); } })
      .catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setSetupLoading(false); });
    return () => { active = false; };
  }, [session?.phoneNumber, session?.tenantPhone, setupVersion]);
  useEffect(() => {
    const sync = () => { const match = location.hash.match(/^#\/products\/([a-f0-9-]{36})$/); setSelectedId(match?.[1] ?? null); setBatchOpen(location.hash === '#/batch'); if (location.hash === '#/settings') { setCreating(false); setView('settings'); } };
    sync(); addEventListener('hashchange', sync); return () => removeEventListener('hashchange', sync);
  }, []);
  if (isBootstrapping) return <AccessFrame><div className="loading"><p>Preparando tu espacio…</p></div></AccessFrame>;
  if (!session) return <Login/>;
  if (session.role !== 'owner' || session.pendingInvite) return <AccessFrame><main className="onboarding panel"><h1>Acceso del propietario</h1><p>La configuración comercial está disponible para el propietario. Gestioná tu acceso o invitación desde Stocky.</p><a href="/">Abrir Stocky</a><button onClick={logout}>Cerrar sesión</button></main></AccessFrame>;
  if (setupLoading) return <AccessFrame><div className="loading"><p>Consultando la configuración del negocio…</p></div></AccessFrame>;
  if (!setup || !setup.enabled && setup.profile) return <AccessFrame><main className="onboarding panel"><h1>No pude abrir Studio</h1><Notice action={<button onClick={() => setSetupVersion(value => value + 1)}>Reintentar</button>}>{error || 'El acceso comercial está deshabilitado. Contactá al administrador.'}</Notice><a href="/">Volver a Stocky</a><button onClick={logout}>Cerrar sesión</button></main></AccessFrame>;
  if (setup.needsSetup || session.needsOnboarding) return <AccessFrame><BusinessOnboarding key={session.phoneNumber + setupVersion} status={setup} onDone={() => setSetupVersion(value => value + 1)} onRefresh={() => setSetupVersion(value => value + 1)}/></AccessFrame>;
  const open = (id: string) => { setCreating(false); setView('products'); location.hash = `/products/${id}`; setSelectedId(id); };
  const close = () => { location.hash = '/products'; setSelectedId(null); setCreating(false); setInitialCandidates([]); setBatchOpen(false); setVersion(value => value + 1); };
  const navigate = (next: View) => { close(); setView(next); };
  const resumeBatch = () => { setSelectedId(null); setCreating(false); setBatchOpen(true); location.hash = '/batch'; };
  const startBatch = (ids: string[]) => {
    if (readBatchJob()?.items.some(item => item.request) && !confirm('Hay un lote guardado. ¿Crear uno nuevo con esta selección?')) return;
    try { createBatchJob(ids); resumeBatch(); } catch (cause) { setError(message(cause)); }
  };
  return <div className="studio-shell"><aside className="sidebar"><Brand/><p className="nav-caption">TU ESPACIO COMERCIAL</p><nav aria-label="Navegación de Studio">
    {([['products', '01', 'Productos'], ['pending', '02', 'Pendientes'], ['library', '03', 'Biblioteca'], ['settings', '04', 'Configuración']] as const).map(([id, number, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><span>{number}</span>{label}<b>↗</b></button>)}
    </nav><div className="sidebar-bottom"><span className="connection-dot"/> Conectado con Stocky<p>El stock y los precios se mantienen en tu inventario.</p><button onClick={() => navigate('recovery')}>Recuperar intentos</button><a href="/?section=productos">Abrir Stocky ↗</a><button onClick={logout}>Cerrar sesión</button></div></aside>
    <main className="workspace"><header className="topbar"><span className="workspace-label"><a href="/">Stocky</a><span aria-hidden="true"> / </span>Studio</span><span className="account"><span className="avatar">{profile?.appearance?.logoId ? <BrandImage id={profile.appearance.logoId} alt={profile.brandName}/> : brandInitials(profile?.brandName ?? 'Stocky')}</span><span className="account-name">{profile?.brandName ?? 'Tu negocio'}</span></span><div className="studio-tools"><ThemeToggle/><details className="mobile-session"><summary>Cuenta</summary><div><button onClick={() => navigate('recovery')}>Recuperar intentos</button><button onClick={logout}>Cerrar sesión</button></div></details></div></header>
      {error && <Notice action={<button onClick={() => { setError(''); setVersion(value => value + 1); }}>Reintentar</button>}>{error}</Notice>}
      {batchOpen ? <BatchStudio onBack={close}/> : selectedId || creating ? <ProductEditor key={selectedId ?? 'new'} id={selectedId} initialCandidates={initialCandidates} onClose={close} onCreated={id => { setInitialCandidates([]); open(id); }}/>
        : view === 'products' ? <ProductList profile={profile} key={version} onOpen={open} onCreate={() => { setInitialCandidates([]); setCreating(true); }} onBatch={startBatch}/>
        : view === 'pending' ? <PendingInventory onCreate={items => { setInitialCandidates(items); setView('products'); setCreating(true); }} onLink={(id, items) => { setInitialCandidates(items); open(id); }}/>
        : view === 'library' ? <ContentLibrary onOpen={open} onResumeBatch={resumeBatch}/> : view === 'settings' ? profile && <><Settings profile={profile} onSaved={setProfile}/><MoneyReview/></> : <Recovery onRecovered={() => setVersion(value => value + 1)}/>}
      <footer>STOCKY STUDIO <span>Una ficha. Todas tus posibilidades.</span></footer>
    </main></div>;
}

function ProductList({ profile, onOpen, onCreate, onBatch }: { profile: Profile | null; onOpen: (id: string) => void; onCreate: () => void; onBatch: (ids: string[]) => void }) {
  const { session } = useAuth();
  const emptyFilters = { q: '', status: '', team: '', season: '', version: '', sleeve: '', photos: '', publication: '' };
  const [filters, setFilters] = useState(emptyFilters), [applied, setApplied] = useState(emptyFilters);
  const [products, setProducts] = useState<Product[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [hasSports, setHasSports] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ products: { status: string; count: number }[]; unlinkedSkus: number; withoutPhotos: number } | null>(null);
  const readGeneration = useRef(0);
  const load = async (next?: string, values = filters) => {
    const generation = ++readGeneration.current; setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ ...Object.fromEntries(Object.entries(values).filter(([, value]) => value)), ...(next ? { cursor: next } : {}) });
      const result = await query<{ items: Product[]; nextCursor: string | null }>(`/products?${params}`);
      if (generation !== readGeneration.current) return;
      setProducts(current => next ? [...current, ...result.items] : result.items);
      setCursor(result.nextCursor); setApplied(values);
      if (result.items.some(product => product.teamKey)) setHasSports(true);
    } catch (cause) { if (generation === readGeneration.current) setError(message(cause)); }
    finally { if (generation === readGeneration.current) setBusy(false); }
  };
  const listLoad = useRef(load); listLoad.current = load;
  useEffect(() => {
    let active = true;
    const refresh = () => { if (!document.hidden) { void listLoad.current(); void query<typeof summary>('/summary').then(value => { if (active) setSummary(value); }).catch(() => {}); } };
    refresh(); addEventListener('focus', refresh);
    return () => { active = false; readGeneration.current++; removeEventListener('focus', refresh); };
  }, []);
  const change = (key: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  const clear = () => { setFilters(emptyFilters); void load(undefined, emptyFilters); };
  const filtered = Object.values(applied).some(Boolean), extraCount = Object.entries(filters).filter(([key, value]) => !['q', 'status'].includes(key) && value).length;
  return <section className="product-list">
    <header className="products-heading">
      <div><h1>Productos comerciales <span className="count">{summary?.products.reduce((sum, item) => sum + item.count, 0) ?? products.length}{cursor && !summary ? '+' : ''}</span></h1>
        <p>Prepará y compartí el catálogo de {profile?.brandName ?? 'tu negocio'}.</p></div>
      <button className="primary" onClick={onCreate}>＋ Nueva ficha comercial</button>
    </header>
    {summary && <p className="collection-stats"><span>{summary.products.find(item => item.status === 'ready')?.count ?? 0} preparadas</span><span>{summary.withoutPhotos ?? 0} sin fotos</span><span>{summary.unlinkedSkus} variantes pendientes</span></p>}
    <form className="filters product-filters" onSubmit={event => { event.preventDefault(); void load(); }}>
      <div className="filter-primary">
        <label className="search"><span aria-hidden="true">⌕</span><input aria-label="Buscar productos" placeholder="Buscá por producto…" value={filters.q} onChange={event => change('q', event.target.value)}/></label>
        <label className="filter-field"><span>Estado</span><select aria-label="Filtrar estado" value={filters.status} onChange={event => change('status', event.target.value)}><option value="">Todos los estados</option><option value="draft">Borradores</option><option value="ready">Preparadas</option><option value="archived">Archivadas</option></select></label>
        <button className="primary" type="submit" disabled={busy}>Buscar</button>
      </div>
      <details className="product-filter-options"><summary>Más filtros{extraCount ? ` · ${extraCount} seleccionados` : ''}</summary>
        <div className="filter-fields">
          {(hasSports || session?.businessCategory === 'indumentaria') && <>
            <label className="filter-field"><span>Equipo</span><input aria-label="Filtrar equipo" placeholder="Identificador de equipo" value={filters.team} onChange={event => change('team', event.target.value)}/></label>
            <label className="filter-field"><span>Temporada</span><input aria-label="Filtrar temporada" placeholder="Temporada" value={filters.season} onChange={event => change('season', event.target.value)}/></label>
            <label className="filter-field"><span>Versión</span><select aria-label="Filtrar versión" value={filters.version} onChange={event => change('version', event.target.value)}><option value="">Todas las versiones</option><option value="player">Jugador</option><option value="fan">Hincha</option></select></label>
            <label className="filter-field"><span>Manga</span><select aria-label="Filtrar manga" value={filters.sleeve} onChange={event => change('sleeve', event.target.value)}><option value="">Todas las mangas</option><option value="short">Corta</option><option value="long">Larga</option><option value="sleeveless">Sin mangas</option></select></label>
          </>}
          <label className="filter-field"><span>Fotografías</span><select aria-label="Filtrar fotografías" value={filters.photos} onChange={event => change('photos', event.target.value)}><option value="">Con o sin fotos</option><option value="missing">Sin fotos listas</option><option value="ready">Con fotos listas</option></select></label>
          <label className="filter-field"><span>Publicación</span><select aria-label="Filtrar publicación" value={filters.publication} onChange={event => change('publication', event.target.value)}><option value="">Toda publicación</option><option value="published">Publicadas</option><option value="hidden">Ocultas</option></select></label>
        </div><div className="filter-actions"><button type="submit" disabled={busy}>Aplicar filtros</button><button type="button" disabled={busy} onClick={() => void load()}>Actualizar colección</button></div>
      </details>
    </form>
    {filtered && <div className="filter-result" role="status"><span>{products.length}{cursor ? '+' : ''} resultados{applied.q ? ` para «${applied.q}»` : ' con los filtros aplicados'}</span><button onClick={clear} disabled={busy}>Limpiar filtros</button></div>}
    {error && <div role="alert" className="notice"><span>{error}</span><button onClick={() => void load()}>Reintentar</button></div>}
    {products.length > 0 && <div className={`selection-toolbar ${selection.length ? 'has-selection' : ''}`}><span>{selection.length ? `${selection.length} fichas seleccionadas` : 'Seleccioná fichas para generar historias por lote'}</span><button disabled={!selection.length || selection.length > 20} onClick={() => onBatch(selection)}>Generar historias por lote ({selection.length}) ↗</button></div>}
    <div className="product-grid" aria-busy={busy}>{products.map(product => {
      const variants = product.variants.filter(variant => variant.active);
      const showVariants = variants.length > 1 || variants.some(variant => (variant.label || variant.size || variant.name).trim().toLocaleLowerCase('es') !== product.title.trim().toLocaleLowerCase('es'));
      return <div className="selectable-product" key={product.id}>
        <label className="product-selector"><input type="checkbox" aria-label={`Seleccionar ${product.title}`} checked={selection.includes(product.id)} disabled={!product.readiness.canGenerateStory} onChange={event => setSelection(current => event.target.checked ? [...current, product.id] : current.filter(id => id !== product.id))}/><span className="sr-only">Seleccionar producto</span></label>
        <button className="product-card" onClick={() => onOpen(product.id)}><div className={`card-photo ${!product.coverImageId ? 'without-photo' : ''}`}><PrivatePhoto product={product} imageId={product.coverImageId}/><span className={`status ${product.status}`}>{statusLabel[product.status]}</span></div>
          <div className="card-body"><small>{product.teamName || 'Producto comercial'} <span aria-hidden="true">↗</span></small><h3>{product.title}</h3>
            {[product.season, product.versionKey === 'player' ? 'Jugador' : product.versionKey === 'fan' ? 'Hincha' : ''].some(Boolean) && <p>{[product.season, product.versionKey === 'player' ? 'Jugador' : product.versionKey === 'fan' ? 'Hincha' : ''].filter(Boolean).join(' · ')}</p>}
            <div className="card-bottom"><strong>{priceLabel(product)}</strong><span>{product.availableQuantity ?? '—'} disponibles</span></div>
            {showVariants && <div className="sizes">{variants.map(variant => <span key={variant.skuId} className={variant.stockAvailable ? '' : 'empty'}>{variant.label || variant.size || variant.name}</span>)}</div>}
          </div>
        </button>
      </div>;
    })}
    {!products.length && !busy && !error && (filtered ? <div className="empty-state"><h2>No encontramos fichas con esta búsqueda.</h2><p>Probá otro nombre o quitá los filtros para ver tu catálogo.</p><button onClick={clear}>Limpiar filtros</button></div> : <div className="empty-state"><h2>Empezá tu catálogo comercial</h2><p>Vinculá productos de Stocky, sumá sus fotos y prepará la primera ficha.</p><button className="primary" onClick={onCreate}>Crear primera ficha</button></div>)}
    </div>
    {busy && <p role="status" className="list-loading">Cargando colección…</p>}
    {cursor && !error && <button className="load-more" disabled={busy} onClick={() => void load(cursor)}>Ver más productos ↓</button>}
  </section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Fields({ fields, setFields }: { fields: CommercialFields; setFields: (value: CommercialFields) => void }) {
  const { session } = useAuth();
  const showSports = session?.businessCategory === 'indumentaria' || Boolean(fields.teamKey || fields.teamName || fields.season || fields.kitKey || fields.versionKey || fields.sleeveKey);
  const change = (key: keyof CommercialFields, value: string) => setFields({ ...fields, [key]: key === 'title' || key === 'description' ? value : value || null });
  const select = (key: keyof CommercialFields, label: string, values: [string, string][]) => <Field label={label}><select aria-label={label} value={fields[key] ?? ''} onChange={event => change(key, event.target.value)}><option value="">Seleccionar</option>{values.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></Field>;
  return <div className="field-grid"><Field label="Título comercial"><input required maxLength={120} value={fields.title} onChange={event => change('title', event.target.value)} placeholder="Nombre del producto"/></Field>{showSports && <details className="specific-fields" open={Boolean(fields.teamKey || fields.teamName || fields.season || fields.kitKey || fields.versionKey || fields.sleeveKey)}><summary>Detalles de indumentaria deportiva · opcionales</summary><div className="field-grid"><Field label="Equipo"><input maxLength={100} value={fields.teamName ?? ''} onChange={event => change('teamName', event.target.value)} placeholder="Barcelona"/></Field><Field label="Identificador del equipo"><input value={fields.teamKey ?? ''} onChange={event => change('teamKey', event.target.value)} placeholder="barcelona" pattern="[a-z0-9]+(-[a-z0-9]+)*"/></Field>{select('teamKind', 'Tipo de equipo', [['club', 'Club'], ['national_team', 'Selección']])}<Field label="Temporada"><input value={fields.season ?? ''} onChange={event => change('season', event.target.value)} placeholder="2025 o 2025/26" pattern="[0-9]{4}(/[0-9]{2}([0-9]{2})?)?"/></Field>{select('kitKey', 'Equipación', [['home', 'Titular'], ['away', 'Suplente'], ['third', 'Tercera'], ['goalkeeper', 'Arquero'], ['special', 'Especial']])}{select('versionKey', 'Versión', [['fan', 'Hincha'], ['player', 'Jugador']])}{select('sleeveKey', 'Manga', [['short', 'Corta'], ['long', 'Larga'], ['sleeveless', 'Sin mangas']])}</div></details>}<Field label="Descripción"><textarea maxLength={4000} value={fields.description} onChange={event => change('description', event.target.value)} rows={4}/><small className="field-help">Contá qué es el producto y qué lo distingue. Usá solo características y condiciones reales.</small>{fields.description.trim().length > 0 && fields.description.trim().length < 12 && <small className="field-hint">Revisá si esta descripción le aporta información a quien consulta.</small>}</Field></div>;
}

function ProductEditor({ id, initialCandidates, onClose, onCreated }: { id: string | null; initialCandidates: Candidate[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { session } = useAuth();
  const draftKey = `fullmatch.draft.${session?.phoneNumber}.${id ?? 'new'}`;
  const [product, setProduct] = useState<Product | null>(null), [fields, setFields] = useState<CommercialFields>({ ...emptyFields, title: initialCandidates[0]?.productModel || initialCandidates[0]?.name || '' });
  const [candidates, setCandidates] = useState<Candidate[]>(initialCandidates), [selected, setSelected] = useState<string[]>(initialCandidates.map(item => item.skuId)), [tab, setTab] = useState<'details' | 'variants' | 'photos'>(id && initialCandidates.length ? 'variants' : 'details');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState(''), [dirty, setDirty] = useState(false);
  const [story, setStory] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [linksDirty, setLinksDirty] = useState(Boolean(id && initialCandidates.length));
  const productRef = useRef(product); productRef.current = product;
  const activity = useRef({ busy: false, story: false }); activity.current = { busy, story };
  const [loading, setLoading] = useState(Boolean(id)), readGeneration = useRef(0);
  const refresh = async () => { if (!id) return true; const generation = ++readGeneration.current; const detail = await query<Product>(`/products/${id}`); if (generation !== readGeneration.current) return false; setLinksDirty(false); setExternalChange(false); setProduct(detail); setFields(productFields(detail)); setSelected(detail.variants.map(variant => variant.skuId)); setDirty(false); return true; };
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true); const loaded = await refresh(); if (!active || !loaded) return;
      if (initialCandidates.length && id) { setSelected(current => [...new Set([...current, ...initialCandidates.map(item => item.skuId)])]); setLinksDirty(true); }
      const saved = localStorage.getItem(draftKey); if (!saved) return;
      try { const draft = JSON.parse(saved); if (fieldKeys.every(key => draft[key] === null || typeof draft[key] === 'string')) { setFields(draft); setDirty(true); setSuccess('Recuperé tu borrador de este navegador. Revisalo antes de guardar.'); } } catch { /* Invalid browser draft is ignored. */ }
    };
    void load().catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; readGeneration.current++; };
  }, [id]);
  useEffect(() => { if (dirty) localStorage.setItem(draftKey, JSON.stringify(fields)); }, [fields, dirty, draftKey]);
  useEffect(() => {
    if (!id) return; let active = true, checking = false;
    const updateAvailability = async () => {
      if (!active || checking || document.hidden || activity.current.busy || activity.current.story) return;
      checking = true; const generation = readGeneration.current;
      try {
        const live = await query<Pick<Product, 'revision' | 'variants' | 'availableQuantity' | 'availability' | 'priceRange' | 'readiness' | 'moneyPolicyRevision' | 'readAt'>>(`/products/${id}/availability`);
        if (!active || generation !== readGeneration.current) return;
        if (productRef.current && productRef.current.revision !== live.revision) setExternalChange(true);
        else setProduct(current => current && current.revision === live.revision ? { ...current, ...live } : current);
      } catch (cause) { if (active && generation === readGeneration.current) setError(message(cause)); }
      finally { checking = false; }
    };
    const focus = () => { void updateAvailability(); };
    addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    const timer = setInterval(focus, 30_000);
    return () => { active = false; clearInterval(timer); removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [id]);
  useEffect(() => {
    if (!dirty && !linksDirty) return; const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    addEventListener('beforeunload', protect); return () => removeEventListener('beforeunload', protect);
  }, [dirty, linksDirty]);
  const action = async (callback: () => Promise<unknown>) => { if (busy || loading) return; readGeneration.current++; setBusy(true); setError(''); setSuccess(''); try { await callback(); } catch (cause) { setError(message(cause)); } finally { readGeneration.current++; setBusy(false); } };
  const save = (event: FormEvent) => { event.preventDefault(); void action(async () => {
    if (!id) { const created = await command<Product>('/products', 'POST', { product: fields, skuLinks: initialCandidates.map(linkOf) }); localStorage.removeItem(draftKey); setDirty(false); onCreated(created.id); }
    else if (product) { const saved = await command<Product>(`/products/${id}`, 'PATCH', { expectedRevision: product.revision, changes: fields }); setProduct(saved); setFields(productFields(saved)); setDirty(false); localStorage.removeItem(draftKey); setSuccess('Ficha guardada.'); }
  }); };
  const openVariants = () => { setTab('variants'); void action(async () => {
    const items: Candidate[] = []; let cursor: string | null = null;
    do { const data: { items: Candidate[]; nextCursor: string | null } = await query(`/inventory-candidates?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`); items.push(...data.items); cursor = data.nextCursor; } while (cursor && items.length < 1000);
    setCandidates(items);
  }); };
  const state = (status: Product['status']) => product && action(async () => { const changed = await command<Product>(`/products/${id}/status`, 'POST', { expectedRevision: product.revision, status, reason: 'Cambio revisado desde Studio' }); setProduct(changed); setSuccess(status === 'ready' ? 'Ficha preparada para generar contenido.' : 'Estado actualizado.'); });
  const upload = (file: File) => product && action(async () => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 12 * 1024 * 1024) throw new Error('Elegí una foto JPG, PNG o WebP de hasta 12 MB.');
    const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
    const sourceSha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    const initialized = await command<{ imageId: string; product: Product }>(`/products/${id}/images`, 'POST', { expectedRevision: product.revision, sourceSha256, sourceSizeBytes: file.size, altText: product.title });
    setProduct(initialized.product);
    try { setProduct(await uploadPhoto(product.id, initialized.imageId, file)); setSuccess('Foto procesada y guardada.'); }
    catch (cause) { setProduct(await query(`/products/${id}`)); throw cause; }
  });
  const retryUpload = (imageId: string, file: File) => product && action(async () => { setProduct(await uploadPhoto(product.id, imageId, file)); setSuccess('Carga recuperada.'); });
  const gallery = (images: string[], cover: string | null) => product && action(async () => { setProduct(await command(`/products/${id}/gallery`, 'PUT', { expectedRevision: product.revision, imageIds: images, coverImageId: cover })); });
  const retire = (imageId: string) => product && action(async () => { const image = product.images.find(item => item.id === imageId)!; setProduct(await command(`/products/${id}/images/${imageId}`, 'PATCH', {
    expectedRevision: product.revision, expectedImageRevision: image.revision, altText: image.altText, focalX: image.focalX, focalY: image.focalY, retire: true })); });
  const variants = [...(product?.variants ?? []), ...candidates.filter(candidate => !product?.variants.some(item => item.skuId === candidate.skuId))];
  const readOnly = product?.status === 'archived' || externalChange;
  if (story && product) return <StoryEditor product={product} onBack={() => { setStory(false); void action(refresh); }}/>;
  return <section className="editor page-section"><button className="back" onClick={() => { if ((!dirty && !linksDirty) || confirm('Tenés cambios sin guardar. ¿Volver a productos?')) onClose(); }}>← Volver a productos</button><div className="section-heading"><div><p className="eyebrow dark">FICHA COMERCIAL</p><h1>{product?.title ?? (id ? 'Cargando ficha…' : 'Una nueva historia')}</h1></div>{product && <span className={`status ${product.status}`}>{statusLabel[product.status]}</span>}</div>
    {error && <Notice action={id ? <button onClick={() => { if ((!dirty && !linksDirty) || confirm('¿Descartar el borrador y cargar los datos actuales?')) { localStorage.removeItem(draftKey); void action(refresh); } }}>Revisar datos actuales</button> : undefined}>{error}</Notice>}{success && <Notice>{success}</Notice>}
    <div className="editor-actions">{id && <button disabled={busy || loading} onClick={() => { if (!dirty || confirm('¿Descartar el borrador y cargar los datos actuales?')) { localStorage.removeItem(draftKey); void action(refresh); } }}>Actualizar ficha</button>}<a href="/?section=productos">Abrir en Stocky ↗</a></div>{externalChange && <Notice>La ficha cambió en otra pantalla. Tu borrador se conserva. Actualizá la ficha antes de guardar.</Notice>}<div className="tabs"><button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>01 Información</button><button disabled={!id} className={tab === 'variants' ? 'active' : ''} onClick={openVariants}>02 SKU vinculados</button><button disabled={!id} className={tab === 'photos' ? 'active' : ''} onClick={() => setTab('photos')}>03 Fotografías</button></div>
    <div className="editor-layout"><div className="editor-main">{tab === 'details' ? <form onSubmit={save}><fieldset disabled={busy || loading || readOnly}><h2>Información del producto</h2><p className="muted">Agregá el nombre y la descripción comercial. Las presentaciones, unidades, atributos, saldos y precios provienen de Stocky.</p><Fields fields={fields} setFields={value => { setFields(value); setDirty(true); }}/><div className="inventory-specs">{product?.variants.map(variant => variant.specifications?.length ? <details key={variant.skuId}><summary>{variant.label || variant.name} · atributos de Stocky</summary><dl>{variant.specifications.map(spec => <div key={spec.label}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>)}</dl><a href="/?section=productos">Editar en Stocky ↗</a></details> : null)}</div><p>{!id && initialCandidates.length ? `${initialCandidates.length} SKU seleccionados se vincularán al crear la ficha. Revisá que correspondan al mismo producto.` : ""}</p><button className="primary" type="submit">{busy ? 'Guardando…' : id ? 'Guardar cambios' : 'Crear ficha'}</button></fieldset></form> : tab === 'variants' ? <div><h2>SKU y presentaciones vinculadas</h2><p>Seleccioná los SKU que corresponden a este producto. Revisá su identidad antes de guardar los vínculos.</p><fieldset disabled={busy || loading || readOnly}><div className="variant-list">{variants.map(item => <label key={item.skuId} className="variant-row"><input type="checkbox" checked={selected.includes(item.skuId)} onChange={event => { setLinksDirty(true); setSelected(current => event.target.checked ? [...current, item.skuId] : current.filter(value => value !== item.skuId)); }}/><span className="size-tag">{item.label || item.size || item.name}</span><div><strong>{item.name}</strong><small>{moneyLabel(item.price)}</small></div><span>{item.stockAvailable ?? '—'} disp. · {item.stockReserved ?? '—'} reserv.</span></label>)}</div><button className="primary" onClick={() => product && void action(async () => {
        setProduct(await command(`/products/${id}/sku-links`, 'PUT', { expectedRevision: product.revision, skuLinks: variants.filter(item => selected.includes(item.skuId)).map(linkOf) })); setLinksDirty(false); setSuccess('Vínculos revisados y guardados.');
      })}>Guardar vínculos</button></fieldset></div> : product && <div><h2>Fotografías del producto</h2><p>Hasta 8 fotos JPG, PNG o WebP. Máximo 12 MB y 24 megapíxeles por foto.</p><label className={`upload-box ${busy ? 'disabled' : ''}`}><span>＋</span><strong>{busy ? 'Procesando fotografía…' : 'Elegir una fotografía'}</strong><small>Tu primera foto será la portada. Mantené un encuadre y una escala similares entre productos.</small><input aria-label="Subir fotografía" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || readOnly} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }}/></label><div className="gallery-grid">{product.images.map((image, index) => <div className="gallery-item" key={image.id}><div className="gallery-photo">{image.status === 'ready' ? <PrivatePhoto product={product} imageId={image.id}/> : <span>{image.status === 'processing' ? 'Procesando…' : image.status === 'failed' ? 'Carga fallida' : 'Esperando archivo'}</span>}{product.coverImageId === image.id && <span className="status ready">Portada</span>}</div><small>{image.altText}</small><div className="gallery-actions"><button disabled={busy || readOnly || image.status !== 'ready'} onClick={() => void gallery(product.images.map(item => item.id), image.id)}>Portada</button><button aria-label="Mover foto a la izquierda" disabled={busy || readOnly || index === 0} onClick={() => { const ids = product.images.map(item => item.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void gallery(ids, product.coverImageId); }}>←</button><button disabled={busy || readOnly} onClick={() => void retire(image.id)}>Retirar</button></div><PhotoDetails product={product} image={image} disabled={busy || readOnly} onSaved={setProduct} onError={cause => setError(message(cause))}/>{['pending', 'failed', 'processing'].includes(image.status) && <label className="retry-file">Reintentar con el mismo archivo<input aria-label="Reintentar fotografía" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || readOnly} onChange={event => { const file = event.target.files?.[0]; if (file) void retryUpload(image.id, file); event.target.value = ''; }}/></label>}</div>)}</div></div>}</div>
      <aside className="editor-summary"><div className="summary-photo">{product ? <PrivatePhoto product={product} imageId={product.coverImageId}/> : <div className="photo-empty">S ／</div>}</div><p className="eyebrow dark">VISTA COMERCIAL</p><h3>{product?.title || fields.title || 'Tu próximo producto'}</h3>{product && <><strong>{priceLabel(product)}</strong><p>{product.availableQuantity ?? '—'} unidades disponibles</p><div className="sizes">{product.variants.filter(item => item.active).map(item => <span key={item.skuId}>{item.label || item.size || item.name}</span>)}</div><hr/><h4>{product.readiness.canPrepare ? 'Lista para preparar' : 'Antes de preparar'}</h4><PreparationBlockers product={product} onTab={next => next === "variants" ? openVariants() : setTab(next)}/>{product.status === 'archived' ? <button disabled={busy} onClick={() => void state('draft')}>Restaurar a borrador</button> : <><button className="primary" disabled={busy || externalChange || dirty || linksDirty || !product.readiness.canPrepare || product.status === 'ready'} onClick={() => void state('ready')}>{product.status === 'ready' ? 'Ficha preparada ✓' : 'Preparar ficha'}</button><button className="text-button" disabled={busy || externalChange || dirty} onClick={() => void state('archived')}>Archivar ficha</button></>}</>}
      {product && <PublicationPanel product={product} disabled={busy || externalChange || dirty}/>}
      {product?.readiness.canGenerateStory && <button className="story-launch" disabled={busy || dirty} onClick={() => setStory(true)}>Generar historia ↗</button>}</aside></div></section>;
}

function PhotoDetails({ product, image, disabled, onSaved, onError }: { product: Product; image: Photo; disabled: boolean; onSaved: (product: Product) => void; onError: (error: unknown) => void }) {
  const [alt, setAlt] = useState(image.altText), [x, setX] = useState(image.focalX), [y, setY] = useState(image.focalY), [saving, setSaving] = useState(false);
  useEffect(() => { setAlt(image.altText); setX(image.focalX); setY(image.focalY); }, [image.revision]);
  const save = async () => { setSaving(true); try { onSaved(await command(`/products/${product.id}/images/${image.id}`, 'PATCH', {
    expectedRevision: product.revision, expectedImageRevision: image.revision, altText: alt, focalX: x, focalY: y, retire: false })); } catch (error) { onError(error); } finally { setSaving(false); } };
  return <details className="photo-details"><summary>Descripción y enfoque</summary><label className="field"><span>Descripción accesible</span><input maxLength={300} disabled={disabled || saving} value={alt} onChange={event => setAlt(event.target.value)}/></label><label className="field"><span>Enfoque horizontal</span><input type="range" min="0" max="1" step="0.01" disabled={disabled || saving} value={x} onChange={event => setX(Number(event.target.value))}/></label><label className="field"><span>Enfoque vertical</span><input type="range" min="0" max="1" step="0.01" disabled={disabled || saving} value={y} onChange={event => setY(Number(event.target.value))}/></label><button disabled={disabled || saving} onClick={() => void save()}>{saving ? 'Guardando…' : 'Guardar descripción y enfoque'}</button></details>;
}

function Settings({ profile, onSaved }: { profile: Profile; onSaved: (profile: Profile) => void }) {
  const [brandName, setBrandName] = useState(profile.brandName), [phone, setPhone] = useState(profile.salesWhatsapp ?? ''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [appearance, setAppearance] = useState({ ...defaultAppearance, ...profile.appearance });
  const upload = async (kind: 'logo' | 'cover', file: File) => {
    setBusy(true); setError(''); setSaved(false);
    try {
      if (file.size > 12 * 1024 * 1024) throw new Error('La imagen debe pesar hasta 12 MB.');
      const result = await (await studioFetch(`/brand-assets/${kind}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })).json();
      setAppearance(current => ({ ...current, [`${kind}Id`]: result.id }));
    } catch (cause) { setError(message(cause)); throw cause; } finally { setBusy(false); }
  };
  return <section className="page-section settings"><p className="eyebrow dark">LA IDENTIDAD DE TU NEGOCIO</p><h1>Configuración</h1><form className="panel" onChange={() => setSaved(false)} onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { onSaved(await command('/profile', 'PUT', { expectedRevision: profile.revision, brandName, salesWhatsapp: phone || null, appearance })); setSaved(true); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }}><fieldset disabled={busy}><h2>Información comercial</h2><Field label="Nombre de marca"><input required maxLength={80} value={brandName} onChange={event => setBrandName(event.target.value)}/></Field><Field label="WhatsApp de ventas · código de país y número"><input inputMode="tel" pattern="[0-9]{8,15}" value={phone} onChange={event => setPhone(event.target.value)} placeholder="598…"/></Field>
    <AppearanceFields value={appearance} onChange={value => { setAppearance(value); setSaved(false); }} brandName={brandName} disabled={busy} onUpload={upload}/>
    </fieldset>{error && <Notice>{error}</Notice>}{saved && <Notice>Configuración guardada.</Notice>}<button className="primary" disabled={busy}>{busy ? 'Procesando…' : 'Guardar configuración'}</button></form>
    <div className="panel"><h2>Moneda y precios</h2><p>{profile.moneyPolicy ? `${profile.moneyPolicy.currency} · Importes de Stocky en unidades enteras` : 'Pendiente de confirmación para este negocio'}</p><small>La moneda fue confirmada al configurar tu negocio. Revisá las variantes históricas debajo; los cambios de precio se realizan en Stocky.</small></div><CatalogSettings/></section>;
}

function Recovery({ onRecovered }: { onRecovered: () => void }) {
  const [items, setItems] = useState(pendingOperations), [error, setError] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState('');
  const run = async (callback: () => Promise<unknown>) => { setBusy(true); setError(''); try { await callback(); setItems(pendingOperations()); setResult('Operación recuperada. Podés volver a revisar la ficha actual.'); onRecovered(); } catch (cause) { setError(message(cause)); setItems(pendingOperations()); } finally { setBusy(false); } };
  return <section className="page-section"><p className="eyebrow dark">CONTINUÁ DONDE QUEDASTE</p><h1>Recuperar intentos</h1><p>Si se cortó la conexión después de guardar, consultá el recibo o reenviá el mismo intento.</p>{error && <Notice>{error}</Notice>}{result && <Notice>{result}</Notice>}{items.map(item => <div className="recovery-row" key={item.operationId}><div><strong>{item.method === 'POST' && item.route === '/products' ? 'Crear ficha comercial' : 'Cambio comercial pendiente'}</strong><small>{new Date(item.at).toLocaleString('es-UY')}</small><code>{item.operationId}</code></div><button disabled={busy} onClick={() => void run(() => recoverOperation(item.operationId))}>Consultar recibo</button><button disabled={busy} onClick={() => void run(() => retryOperation(item))}>Reenviar mismo intento</button></div>)}{!items.length && <div className="panel">No hay intentos comerciales pendientes en este navegador.</div>}</section>;
}
