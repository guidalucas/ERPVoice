import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../store/AuthStore';
import { createWhatsAppLogin, pollWhatsAppLogin, type WhatsAppLoginChallenge } from '../services/authService';
import { command, imageBlob, pendingOperations, query, recoverOperation, retryOperation, uploadPhoto } from './api';
import { moneyLabel, priceLabel, type Candidate, type CommercialFields, type Product, type Profile, type Photo } from './types';
import { StoryEditor } from './StoryEditor';

const message = (error: unknown) => error instanceof Error ? error.message : 'No pude completar la operación.';
const statusLabel = { draft: 'Borrador', ready: 'Preparada', archived: 'Archivada' };
const blockerLabels: Record<string, string> = { COVER_REQUIRED: 'Elegí una foto de portada', NO_ACTIVE_SKU: 'Vinculá al menos un talle activo',
  IDENTITY_INCOMPLETE: 'Completá la identidad de la camiseta', MONEY_UNCONFIRMED: 'Confirmá moneda y escala en la preparación de Stocky',
  SKU_IDENTITY_CHANGED: 'Revisá los vínculos: cambió una variante', INVALID_VARIANT: 'Revisá el talle y la unidad en Stocky',
  DUPLICATE_SIZE: 'Hay más de una variante con el mismo talle', PRICE_NOT_READY: 'Revisá los precios en Stocky', INVENTORY_INVALID: 'Revisá los saldos en Stocky' };
const emptyFields: CommercialFields = { title: '', description: '', teamKey: null, teamName: null, teamKind: null, season: null, kitKey: null, versionKey: null, sleeveKey: null };
const fieldKeys = Object.keys(emptyFields) as (keyof CommercialFields)[];
const productFields = (product: Product) => Object.fromEntries(fieldKeys.map(key => [key, product[key]])) as CommercialFields;
const linkOf = (item: Candidate | Product['variants'][number]) => ({ skuId: item.skuId, expectedRevision: item.revision, expectedFingerprint: item.identityFingerprint });
function Brand() { return <div className="brand"><span className="brand-mark">FM<span>／</span></span><div>FULLMATCH<small>STUDIO</small></div></div>; }
function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) { return <div role="status" className="notice">{children}{action}</div>; }

export function PrivatePhoto({ product, imageId, thumbnail = true }: { product: Product; imageId?: string | null; thumbnail?: boolean }) {
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(''); setFailed(false); if (!imageId) return;
    let active = true, objectUrl = '';
    imageBlob(product.id, imageId, thumbnail).then(blob => { if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [product.id, imageId, thumbnail, product.revision]);
  return url ? <img src={url} alt={product.images.find(image => image.id === imageId)?.altText || product.title}/> : <div className="photo-empty"><span className="shirt">◇</span><small>{failed ? 'Foto no disponible' : imageId ? 'Cargando foto…' : 'Tu próxima camiseta, acá'}</small></div>;
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
  return <div className="login"><section className="login-brand"><Brand/><p className="eyebrow">DE LA CANCHA A TUS REDES</p><h1>Tu colección.<br/>Lista para<br/><em>salir a jugar.</em></h1><p>Fichas, fotos y contenido para FullMatch Casacas.</p><span className="pitch-line"/></section>
    <section className="login-form"><div><span className="eyebrow">ESPACIO PRIVADO</span><h2>Entrá a Studio</h2><p>Usá el mismo acceso de Stocky para gestionar tu catálogo comercial.</p>
      {error && <Notice>{error}</Notice>}{challenge ? <><a className="button primary" href={challenge.whatsappUrl} target="_blank" rel="noreferrer">Continuar en WhatsApp ↗</a><p>Enviá el mensaje de acceso. Esta pantalla continuará cuando quede validado.</p><button onClick={() => setChallenge(null)}>Generar otro enlace</button></> : <button className="primary" disabled={busy} onClick={start}>{busy ? 'Preparando acceso…' : 'Ingresar con WhatsApp ↗'}</button>}
      <small>Acceso para el propietario del negocio habilitado.</small></div></section></div>;
}

type View = 'products' | 'pending' | 'settings' | 'recovery';
export function Studio() {
  const { session, isBootstrapping, logout } = useAuth();
  const [view, setView] = useState<View>('products'), [profile, setProfile] = useState<Profile | null>(null), [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null), [creating, setCreating] = useState(false), [version, setVersion] = useState(0);
  useEffect(() => { if (session) query<Profile>('/profile').then(setProfile).catch(cause => setError(message(cause))); }, [session?.phoneNumber, version]);
  useEffect(() => {
    const sync = () => { const match = location.hash.match(/^#\/products\/([a-f0-9-]{36})$/); setSelectedId(match?.[1] ?? null); };
    sync(); addEventListener('hashchange', sync); return () => removeEventListener('hashchange', sync);
  }, []);
  if (isBootstrapping) return <div className="loading"><Brand/><p>Preparando tu espacio…</p></div>;
  if (!session) return <Login/>;
  const open = (id: string) => { setCreating(false); setView('products'); location.hash = `/products/${id}`; setSelectedId(id); };
  const close = () => { location.hash = '/products'; setSelectedId(null); setCreating(false); setVersion(value => value + 1); };
  const navigate = (next: View) => { close(); setView(next); };
  return <div className="studio-shell"><aside className="sidebar"><Brand/><p className="nav-caption">TU ESPACIO COMERCIAL</p><nav aria-label="Navegación de Studio">
    {([['products', '01', 'Productos'], ['pending', '02', 'Pendientes'], ['settings', '03', 'Configuración']] as const).map(([id, number, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><span>{number}</span>{label}<b>↗</b></button>)}
    </nav><div className="sidebar-bottom"><span className="connection-dot"/> Conectado con Stocky<p>El stock y los precios se mantienen en tu inventario.</p><button onClick={() => navigate('recovery')}>Recuperar intentos</button><button onClick={logout}>Cerrar sesión</button></div></aside>
    <main className="workspace"><header className="topbar"><span>FULLMATCH CASACAS <span className="muted">／ Studio</span></span><span className="account"><span className="avatar">FM</span>{profile?.brandName ?? 'Tu negocio'}</span></header><div className="mobile-session"><button onClick={() => navigate('recovery')}>Recuperar intentos</button><button onClick={logout}>Cerrar sesión</button></div>
      {error && <Notice action={<button onClick={() => { setError(''); setVersion(value => value + 1); }}>Reintentar</button>}>{error}</Notice>}
      {selectedId || creating ? <ProductEditor key={selectedId ?? 'new'} id={selectedId} onClose={close} onCreated={open}/> : view === 'products' ? <ProductList key={version} onOpen={open} onCreate={() => setCreating(true)}/> : view === 'pending' ? <PendingList onCreate={() => { setView('products'); setCreating(true); }}/> : view === 'settings' ? profile && <Settings profile={profile} onSaved={setProfile}/> : <Recovery onRecovered={() => setVersion(value => value + 1)}/>}
      <footer>FULLMATCH STUDIO <span>Una ficha. Todas tus posibilidades.</span></footer>
    </main></div>;
}

function ProductList({ onOpen, onCreate }: { onOpen: (id: string) => void; onCreate: () => void }) {
  const [products, setProducts] = useState<Product[]>([]), [q, setQ] = useState(''), [status, setStatus] = useState(''), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const load = async (next?: string) => { setBusy(true); setError(''); try {
    const params = new URLSearchParams({ q, ...(status ? { status } : {}), ...(next ? { cursor: next } : {}) });
    const result = await query<{ items: Product[]; nextCursor: string | null }>(`/products?${params}`);
    setProducts(current => next ? [...current, ...result.items] : result.items); setCursor(result.nextCursor);
  } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, []);
  return <><section className="collection-hero"><div><p className="eyebrow">TU COLECCIÓN, CON IDENTIDAD</p><h1>Del inventario<br/>a la <em>vidriera.</em></h1><p>Prepará tus camisetas una vez.<br/>Dales su mejor presentación.</p><button className="primary" onClick={onCreate}>＋ Nueva ficha comercial</button></div><div className="hero-art" aria-hidden="true"><div className="pitch-circle"/><span>FM</span><small>CASACAS CON HISTORIA</small><b>EST. FULLMATCH</b></div></section>
    <section className="section-heading"><div><p className="eyebrow dark">GESTIONÁ TU COLECCIÓN</p><h2>Productos comerciales <span className="count">{products.length}{cursor ? '+' : ''}</span></h2></div><span className="muted">Datos de stock en vivo</span></section>
    <form className="filters" onSubmit={event => { event.preventDefault(); void load(); }}><label className="search"><span>⌕</span><input aria-label="Buscar camisetas" placeholder="Buscá por camiseta o equipo…" value={q} onChange={event => setQ(event.target.value)}/></label><select aria-label="Filtrar estado" value={status} onChange={event => setStatus(event.target.value)}><option value="">Todos los estados</option><option value="draft">Borradores</option><option value="ready">Preparadas</option><option value="archived">Archivadas</option></select><button type="submit" disabled={busy}>Buscar</button></form>
    {error && <Notice action={<button onClick={() => void load()}>Reintentar</button>}>{error}</Notice>}
    <div className="product-grid">{products.map(product => <button className="product-card" key={product.id} onClick={() => onOpen(product.id)}><div className="card-photo"><PrivatePhoto product={product} imageId={product.coverImageId}/><span className={`status ${product.status}`}>{statusLabel[product.status]}</span></div><div className="card-body"><small>{product.teamName ?? 'IDENTIDAD POR COMPLETAR'} <span>↗</span></small><h3>{product.title}</h3><p>{[product.season, product.versionKey === 'player' ? 'Jugador' : product.versionKey === 'fan' ? 'Hincha' : ''].filter(Boolean).join(' · ') || 'Completá los detalles de la camiseta'}</p><div className="card-bottom"><strong>{priceLabel(product)}</strong><span>{product.availableQuantity ?? '—'} disponibles</span></div><div className="sizes">{product.variants.filter(variant => variant.active).map(variant => <span key={variant.skuId} className={variant.stockAvailable ? '' : 'empty'}>{variant.size || '?'}</span>)}</div></div></button>)}
    {!products.length && !busy && <div className="empty-state"><span>01 ／ EMPEZÁ TU COLECCIÓN</span><h3>La próxima historia empieza con una ficha.</h3><p>Elegí las variantes existentes en Stocky y sumales su presentación comercial.</p><button className="primary" onClick={onCreate}>Crear primera ficha</button></div>}</div>
    {busy && <p role="status">Cargando colección…</p>}{cursor && <button className="load-more" disabled={busy} onClick={() => void load(cursor)}>Ver más camisetas ↓</button>}</>;
}

function PendingList({ onCreate }: { onCreate: () => void }) {
  const [items, setItems] = useState<Candidate[]>([]), [cursor, setCursor] = useState<string | null>(null), [q, setQ] = useState(''), [error, setError] = useState('');
  const load = async (next?: string) => { try { const params = new URLSearchParams({ q, ...(next ? { cursor: next } : {}) }); const result = await query<{ items: Candidate[]; nextCursor: string | null }>(`/inventory-candidates?${params}`); setItems(current => next ? [...current, ...result.items] : result.items); setCursor(result.nextCursor); setError(''); } catch (cause) { setError(message(cause)); } };
  useEffect(() => { void load(); }, []);
  return <section className="page-section"><p className="eyebrow dark">DEL STOCK A TU CATÁLOGO</p><h1>Pendientes de catalogar</h1><p>Variantes activas de Stocky que todavía no tienen una ficha comercial.</p>{error && <Notice>{error}</Notice>}<form className="filters" onSubmit={event => { event.preventDefault(); void load(); }}><input aria-label="Buscar variantes pendientes" value={q} onChange={event => setQ(event.target.value)} placeholder="Buscá una camiseta…"/><button>Buscar</button><button type="button" className="primary" onClick={onCreate}>Crear ficha y vincular</button></form><div className="variant-list">{items.map(item => <div className="variant-row" key={item.skuId}><span className="size-tag">{item.size || '?'}</span><div><strong>{item.name}</strong><small>{moneyLabel(item.price)}</small></div><span>{item.stockAvailable} disponibles</span></div>)}</div>{!items.length && <p>No hay variantes pendientes para esta búsqueda.</p>}{cursor && <button onClick={() => void load(cursor)}>Cargar más</button>}</section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Fields({ fields, setFields }: { fields: CommercialFields; setFields: (value: CommercialFields) => void }) {
  const change = (key: keyof CommercialFields, value: string) => setFields({ ...fields, [key]: key === 'title' || key === 'description' ? value : value || null });
  const select = (key: keyof CommercialFields, label: string, values: [string, string][]) => <Field label={label}><select aria-label={label} value={fields[key] ?? ''} onChange={event => change(key, event.target.value)}><option value="">Seleccionar</option>{values.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></Field>;
  return <div className="field-grid"><Field label="Título comercial"><input required maxLength={120} value={fields.title} onChange={event => change('title', event.target.value)} placeholder="Ej. Barcelona titular 2025"/></Field><Field label="Equipo"><input maxLength={100} value={fields.teamName ?? ''} onChange={event => change('teamName', event.target.value)} placeholder="Barcelona"/></Field><Field label="Identificador del equipo"><input value={fields.teamKey ?? ''} onChange={event => change('teamKey', event.target.value)} placeholder="barcelona" pattern="[a-z0-9]+(-[a-z0-9]+)*"/></Field>{select('teamKind', 'Tipo de equipo', [['club', 'Club'], ['national_team', 'Selección']])}<Field label="Temporada"><input value={fields.season ?? ''} onChange={event => change('season', event.target.value)} placeholder="2025 o 2025/26" pattern="[0-9]{4}(/[0-9]{2}([0-9]{2})?)?"/></Field>{select('kitKey', 'Equipación', [['home', 'Titular'], ['away', 'Suplente'], ['third', 'Tercera'], ['goalkeeper', 'Arquero'], ['special', 'Especial']])}{select('versionKey', 'Versión', [['fan', 'Hincha'], ['player', 'Jugador']])}{select('sleeveKey', 'Manga', [['short', 'Corta'], ['long', 'Larga'], ['sleeveless', 'Sin mangas']])}<Field label="Descripción"><textarea maxLength={4000} value={fields.description} onChange={event => change('description', event.target.value)} rows={3}/></Field></div>;
}

function ProductEditor({ id, onClose, onCreated }: { id: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { session } = useAuth();
  const draftKey = `fullmatch.draft.${session?.phoneNumber}.${id ?? 'new'}`;
  const [product, setProduct] = useState<Product | null>(null), [fields, setFields] = useState<CommercialFields>(emptyFields);
  const [candidates, setCandidates] = useState<Candidate[]>([]), [selected, setSelected] = useState<string[]>([]), [tab, setTab] = useState<'details' | 'variants' | 'photos'>('details');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState(''), [dirty, setDirty] = useState(false);
  const [story, setStory] = useState(false);
  const refresh = async () => { if (!id) return; const detail = await query<Product>(`/products/${id}`); setProduct(detail); setFields(productFields(detail)); setSelected(detail.variants.map(variant => variant.skuId)); setDirty(false); };
  useEffect(() => {
    let active = true;
    const load = async () => {
      await refresh(); if (!active) return;
      const saved = localStorage.getItem(draftKey); if (!saved) return;
      try { const draft = JSON.parse(saved); if (fieldKeys.every(key => draft[key] === null || typeof draft[key] === 'string')) { setFields(draft); setDirty(true); setSuccess('Recuperé tu borrador de este navegador. Revisalo antes de guardar.'); } } catch { /* Invalid browser draft is ignored. */ }
    };
    void load().catch(cause => { if (active) setError(message(cause)); }); return () => { active = false; };
  }, [id]);
  useEffect(() => { if (dirty) localStorage.setItem(draftKey, JSON.stringify(fields)); }, [fields, dirty, draftKey]);
  useEffect(() => {
    if (!dirty) return; const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    addEventListener('beforeunload', protect); return () => removeEventListener('beforeunload', protect);
  }, [dirty]);
  const action = async (callback: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setSuccess(''); try { await callback(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const save = (event: FormEvent) => { event.preventDefault(); void action(async () => {
    if (!id) { const created = await command<Product>('/products', 'POST', { product: fields, skuLinks: [] }); localStorage.removeItem(draftKey); setDirty(false); onCreated(created.id); }
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
  const readOnly = product?.status === 'archived';
  if (story && product) return <StoryEditor product={product} onBack={() => { setStory(false); void action(refresh); }}/>;
  return <section className="editor page-section"><button className="back" onClick={() => { if (!dirty || confirm('Tenés cambios sin guardar. ¿Volver a productos?')) onClose(); }}>← Volver a productos</button><div className="section-heading"><div><p className="eyebrow dark">FICHA COMERCIAL</p><h1>{product?.title ?? (id ? 'Cargando ficha…' : 'Una nueva historia')}</h1></div>{product && <span className={`status ${product.status}`}>{statusLabel[product.status]}</span>}</div>
    {error && <Notice action={id ? <button onClick={() => { if (!dirty || confirm('¿Descartar el borrador y cargar los datos actuales?')) { localStorage.removeItem(draftKey); void action(refresh); } }}>Revisar datos actuales</button> : undefined}>{error}</Notice>}{success && <Notice>{success}</Notice>}
    <div className="tabs"><button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>01 Información</button><button disabled={!id} className={tab === 'variants' ? 'active' : ''} onClick={openVariants}>02 Talles vinculados</button><button disabled={!id} className={tab === 'photos' ? 'active' : ''} onClick={() => setTab('photos')}>03 Fotografías</button></div>
    <div className="editor-layout"><div className="editor-main">{tab === 'details' ? <form onSubmit={save}><fieldset disabled={busy || readOnly}><h2>La identidad de tu camiseta</h2><p className="muted">Los talles, saldos y precios provienen de Stocky.</p><Fields fields={fields} setFields={value => { setFields(value); setDirty(true); }}/><button className="primary" type="submit">{busy ? 'Guardando…' : id ? 'Guardar cambios' : 'Crear ficha'}</button></fieldset></form> : tab === 'variants' ? <div><h2>Elegí los talles de esta camiseta</h2><p>Vinculá únicamente variantes con el mismo equipo, temporada, equipación, versión y manga.</p><fieldset disabled={busy || readOnly}><div className="variant-list">{variants.map(item => <label key={item.skuId} className="variant-row"><input type="checkbox" checked={selected.includes(item.skuId)} onChange={event => setSelected(current => event.target.checked ? [...current, item.skuId] : current.filter(value => value !== item.skuId))}/><span className="size-tag">{item.size || '?'}</span><div><strong>{item.name}</strong><small>{moneyLabel(item.price)}</small></div><span>{item.stockAvailable ?? '—'} disp.</span></label>)}</div><button className="primary" onClick={() => product && void action(async () => {
        setProduct(await command(`/products/${id}/sku-links`, 'PUT', { expectedRevision: product.revision, skuLinks: variants.filter(item => selected.includes(item.skuId)).map(linkOf) })); setSuccess('Vínculos revisados y guardados.');
      })}>Guardar vínculos</button></fieldset></div> : product && <div><h2>Mostrala desde todos los ángulos</h2><p>Hasta 8 fotos JPG, PNG o WebP. Máximo 12 MB y 24 megapíxeles por foto.</p><label className={`upload-box ${busy ? 'disabled' : ''}`}><span>＋</span><strong>{busy ? 'Procesando fotografía…' : 'Elegir una fotografía'}</strong><small>Tu primera foto será la portada</small><input aria-label="Subir fotografía" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || readOnly} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }}/></label><div className="gallery-grid">{product.images.map((image, index) => <div className="gallery-item" key={image.id}><div className="gallery-photo">{image.status === 'ready' ? <PrivatePhoto product={product} imageId={image.id}/> : <span>{image.status === 'processing' ? 'Procesando…' : image.status === 'failed' ? 'Carga fallida' : 'Esperando archivo'}</span>}{product.coverImageId === image.id && <span className="status ready">Portada</span>}</div><small>{image.altText}</small><div className="gallery-actions"><button disabled={busy || readOnly || image.status !== 'ready'} onClick={() => void gallery(product.images.map(item => item.id), image.id)}>Portada</button><button aria-label="Mover foto a la izquierda" disabled={busy || readOnly || index === 0} onClick={() => { const ids = product.images.map(item => item.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void gallery(ids, product.coverImageId); }}>←</button><button disabled={busy || readOnly} onClick={() => void retire(image.id)}>Retirar</button></div><PhotoDetails product={product} image={image} disabled={busy || readOnly} onSaved={setProduct} onError={cause => setError(message(cause))}/>{['pending', 'failed', 'processing'].includes(image.status) && <label className="retry-file">Reintentar con el mismo archivo<input aria-label="Reintentar fotografía" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || readOnly} onChange={event => { const file = event.target.files?.[0]; if (file) void retryUpload(image.id, file); event.target.value = ''; }}/></label>}</div>)}</div></div>}</div>
      <aside className="editor-summary"><div className="summary-photo">{product ? <PrivatePhoto product={product} imageId={product.coverImageId}/> : <div className="photo-empty">FM ／</div>}</div><p className="eyebrow dark">VISTA COMERCIAL</p><h3>{product?.title || fields.title || 'Tu próxima camiseta'}</h3>{product && <><strong>{priceLabel(product)}</strong><p>{product.availableQuantity ?? '—'} unidades disponibles</p><div className="sizes">{product.variants.filter(item => item.active).map(item => <span key={item.skuId}>{item.size || '?'}</span>)}</div><hr/><h4>{product.readiness.canPrepare ? 'Lista para preparar' : 'Antes de preparar'}</h4><ul className="checklist">{product.readiness.blockers.map(code => <li key={code}>{blockerLabels[code] ?? code}</li>)}</ul>{product.status === 'archived' ? <button disabled={busy} onClick={() => void state('draft')}>Restaurar a borrador</button> : <><button className="primary" disabled={busy || dirty || !product.readiness.canPrepare || product.status === 'ready'} onClick={() => void state('ready')}>{product.status === 'ready' ? 'Ficha preparada ✓' : 'Preparar ficha'}</button><button className="text-button" disabled={busy || dirty} onClick={() => void state('archived')}>Archivar ficha</button></>}</>}
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
  return <section className="page-section settings"><p className="eyebrow dark">LA IDENTIDAD DE TU NEGOCIO</p><h1>Configuración</h1><form className="panel" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); setSaved(false); try { onSaved(await command('/profile', 'PUT', { expectedRevision: profile.revision, brandName, salesWhatsapp: phone || null })); setSaved(true); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }}><h2>Información comercial</h2><Field label="Nombre de marca"><input required maxLength={80} value={brandName} onChange={event => setBrandName(event.target.value)}/></Field><Field label="WhatsApp de ventas · código de país y número"><input inputMode="tel" pattern="[0-9]{8,15}" value={phone} onChange={event => setPhone(event.target.value)} placeholder="598…"/></Field>{error && <Notice>{error}</Notice>}{saved && <Notice>Configuración guardada.</Notice>}<button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar configuración'}</button></form><div className="panel"><h2>Moneda y precios</h2><p>{profile.moneyPolicy ? `${profile.moneyPolicy.currency} · Importes de Stocky en unidades enteras` : 'Pendiente de confirmación para este negocio'}</p><small>La moneda se confirma durante la preparación del negocio. Los cambios de precio se realizan en Stocky.</small></div></section>;
}

function Recovery({ onRecovered }: { onRecovered: () => void }) {
  const [items, setItems] = useState(pendingOperations), [error, setError] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState('');
  const run = async (callback: () => Promise<unknown>) => { setBusy(true); setError(''); try { await callback(); setItems(pendingOperations()); setResult('Operación recuperada. Podés volver a revisar la ficha actual.'); onRecovered(); } catch (cause) { setError(message(cause)); setItems(pendingOperations()); } finally { setBusy(false); } };
  return <section className="page-section"><p className="eyebrow dark">CONTINUÁ DONDE QUEDASTE</p><h1>Recuperar intentos</h1><p>Si se cortó la conexión después de guardar, consultá el recibo o reenviá el mismo intento.</p>{error && <Notice>{error}</Notice>}{result && <Notice>{result}</Notice>}{items.map(item => <div className="recovery-row" key={item.operationId}><div><strong>{item.method === 'POST' && item.route === '/products' ? 'Crear ficha comercial' : 'Cambio comercial pendiente'}</strong><small>{new Date(item.at).toLocaleString('es-UY')}</small><code>{item.operationId}</code></div><button disabled={busy} onClick={() => void run(() => recoverOperation(item.operationId))}>Consultar recibo</button><button disabled={busy} onClick={() => void run(() => retryOperation(item))}>Reenviar mismo intento</button></div>)}{!items.length && <div className="panel">No hay intentos comerciales pendientes en este navegador.</div>}</section>;
}
