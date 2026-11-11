import { useConfirm } from '../components/ui/ConfirmationProvider';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../store/AuthStore';
import { createWhatsAppLogin, pollWhatsAppLogin, type WhatsAppLoginChallenge } from '../services/authService';
import { command, imageBlob, pendingOperations, query, recoverOperation, retryOperation, studioFetch, StudioError, uploadPhoto } from './api';
import { defaultAppearance, brandInitials, moneyLabel, priceLabel, type Candidate, type CommercialFields, type Product, type Profile, type Photo, type SkuMetadataChange } from './types';
import { SkuMetadataFields, validSkuMetadataChange } from './SkuMetadataFields';
import { StoryEditor } from './StoryEditor';
import { CatalogSettings, CatalogShortcut, PublicationPanel, finishAndPublish, publishProduct, type Catalog, type Publication } from './Publication';
import { ContentLibrary } from './ContentLibrary';
import { BatchStudio } from './BatchStudio';
import { createBatchJob, readBatchJob } from './batchJob';
import { BusinessOnboarding, type SetupStatus } from './BusinessOnboarding';
import { MoneyReview } from './MoneyReview';
import { PendingInventory } from './PendingInventory';
import { ExistingProductPicker } from './ExistingProductPicker';
import { AppearanceFields, BrandImage } from './Branding';
import { StockyLogo } from '../components/brand/StockyLogo';
import { ThemeToggle } from '../components/dashboard/ThemeToggle';
import { useNearViewport } from './useNearViewport';

const message = (error: unknown) => error instanceof Error ? error.message : 'No pude completar la operación.';
const statusLabel = { draft: 'Borrador', ready: 'Preparada', archived: 'Archivada' };
const blockerLabels: Record<string, string> = { COVER_REQUIRED: 'Elegí una foto de portada', NO_ACTIVE_SKU: 'Vinculá al menos un SKU activo',
  IDENTITY_INCOMPLETE: 'Completá el nombre del producto', MONEY_UNCONFIRMED: 'Confirmá moneda y escala en la preparación de Stocky',
  SKU_IDENTITY_CHANGED: 'Revisá los vínculos: cambió una variante', INVALID_VARIANT: 'Revisá la presentación y la unidad en Stocky',
  DUPLICATE_SIZE: 'Hay variantes con la misma presentación', PRICE_NOT_READY: 'Revisá los precios en Stocky', INVENTORY_INVALID: 'Revisá los saldos en Stocky' };
const emptyFields: CommercialFields = { title: '', description: '' };
const fieldKeys = Object.keys(emptyFields) as (keyof CommercialFields)[];
const identityLabels: Record<string, string> = { teamKey: 'identificador del equipo', teamName: 'equipo', teamKind: 'tipo de equipo', season: 'temporada', kitKey: 'equipación', versionKey: 'versión', sleeveKey: 'manga' };
const productFields = ({ title, description }: CommercialFields): CommercialFields => ({ title, description });
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

export function PrivatePhoto({ product, imageId, thumbnail = true, lazy = false }: {
  product: Product; imageId?: string | null; thumbnail?: boolean; lazy?: boolean;
}) {
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  const { placeholder, shouldLoad } = useNearViewport<HTMLDivElement>(lazy && Boolean(imageId));
  useEffect(() => {
    setUrl(''); setFailed(false); if (!imageId || !shouldLoad) return;
    let active = true, objectUrl = '';
    imageBlob(product.id, imageId, thumbnail).then(blob => { if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [product.id, imageId, thumbnail, product.revision, shouldLoad]);
  return url ? <img src={url} alt={product.images.find(image => image.id === imageId)?.altText || product.title} decoding="async"/> : <div ref={placeholder} className="photo-empty"><span className="shirt">◇</span><small>{failed ? 'Foto no disponible' : imageId ? 'Cargando foto…' : 'Fotografía pendiente'}</small></div>;
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
type ProductStep = 'details' | 'variants' | 'photos';
export function Studio() {
  const confirm = useConfirm();
  const { session, isBootstrapping, logout } = useAuth();
  const [view, setView] = useState<View>('products'), [profile, setProfile] = useState<Profile | null>(null), [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null), [creating, setCreating] = useState(false), [version, setVersion] = useState(0);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [listVersion, setListVersion] = useState(0);
  const [initialStep, setInitialStep] = useState<ProductStep>('details');
  const [completion, setCompletion] = useState('');
  const [showMissingPhotos, setShowMissingPhotos] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [initialCandidates, setInitialCandidates] = useState<Candidate[]>([]);
  const [setupVersion, setSetupVersion] = useState(0);
  const [setup, setSetup] = useState<SetupStatus | null>(null), [setupLoading, setSetupLoading] = useState(true);
  const listVisible = Boolean(session && setup?.enabled && !setupLoading && !setup.needsSetup
    && !session.needsOnboarding && !session.pendingInvite && !isBootstrapping
    && view === 'products' && !selectedId && !creating && !batchOpen);
  const visitedProducts = useRef(false), listScroll = useRef(0);
  const wasListVisible = useRef(false);
  useLayoutEffect(() => {
    if (listVisible) {
      visitedProducts.current = true;
      window.scrollTo({ top: listScroll.current, behavior: 'instant' });
      const saveScroll = () => { listScroll.current = window.scrollY; };
      addEventListener('scroll', saveScroll, { passive: true });
      wasListVisible.current = true;
      return () => removeEventListener('scroll', saveScroll);
    }
    if (wasListVisible.current) window.scrollTo({ top: 0, behavior: 'instant' });
    wasListVisible.current = false;
  }, [listVisible]);
  useEffect(() => {
    let active = true; setSetupLoading(true); setError(''); setSetup(null); setProfile(null);
    if (!session || !['owner', 'admin'].includes(session.role)) { setSetupLoading(false); return; }
    query<SetupStatus>('/setup').then(result => { if (active) { setSetup(result); setProfile(result.profile); } })
      .catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setSetupLoading(false); });
    return () => { active = false; };
  }, [session?.phoneNumber, session?.tenantPhone, session?.role, setupVersion]);
  useEffect(() => {
    const sync = () => { const match = location.hash.match(/^#\/products\/([a-f0-9-]{36})$/); setSelectedId(match?.[1] ?? null); setBatchOpen(location.hash === '#/batch'); if (location.hash === '#/settings') { setCreating(false); setView('settings'); } };
    sync(); addEventListener('hashchange', sync); return () => removeEventListener('hashchange', sync);
  }, []);
  if (isBootstrapping) return <AccessFrame><div className="loading"><p>Preparando tu espacio…</p></div></AccessFrame>;
  if (!session) return <Login/>;
  if (!['owner', 'admin'].includes(session.role) || session.pendingInvite) return <AccessFrame><main className="onboarding panel"><h1>Acceso a Studio</h1><p>Studio está disponible para el dueño y los administradores. Pedile al dueño que revise tu rol desde Equipo.</p><a href="/">Abrir Stocky</a><button onClick={logout}>Cerrar sesión</button></main></AccessFrame>;
  if (setupLoading) return <AccessFrame><div className="loading"><p>Consultando la configuración del negocio…</p></div></AccessFrame>;
  if (!setup || !setup.enabled && setup.profile) return <AccessFrame><main className="onboarding panel"><h1>No pude abrir Studio</h1><Notice action={<button onClick={() => setSetupVersion(value => value + 1)}>Reintentar</button>}>{error || 'El acceso comercial está deshabilitado. Contactá al administrador.'}</Notice><a href="/">Volver a Stocky</a><button onClick={logout}>Cerrar sesión</button></main></AccessFrame>;
  if (setup.needsSetup || session.needsOnboarding) return session.role === 'admin' ? <AccessFrame><main className="onboarding panel"><h1>Falta preparar el negocio</h1><p>El dueño debe completar la configuración inicial y confirmar la moneda antes de usar Studio.</p><a href="/">Volver a Stocky</a></main></AccessFrame> : <AccessFrame><BusinessOnboarding key={session.phoneNumber + setupVersion} status={setup} onDone={() => setSetupVersion(value => value + 1)} onRefresh={() => setSetupVersion(value => value + 1)}/></AccessFrame>;
  const open = (id: string, step: ProductStep = 'details') => { setCompletion(''); setInitialStep(step); setCreating(false); setView('products'); location.hash = `/products/${id}`; setSelectedId(id); };
  const close = () => { setCompletion(''); setInitialStep('details'); location.hash = '/products'; setSelectedId(null); setCreating(false); setInitialCandidates([]); setBatchOpen(false); };
  const navigate = (next: View) => {
    close();
    if (view === 'settings' && next !== 'settings') setCatalogVersion(value => value + 1);
    setView(next);
  };
  const openMissingPhotos = () => {
    listScroll.current = 0;
    setShowMissingPhotos(true);
    setListVersion(value => value + 1);
    navigate('products');
  };
  const resumeBatch = () => { setSelectedId(null); setCreating(false); setBatchOpen(true); location.hash = '/batch'; };
  const startBatch = async (ids: string[]) => {
    if (readBatchJob()?.items.some(item => item.request) && !await confirm({ title: '¿Crear un lote nuevo con esta selección?', description: 'Se reemplazará el lote guardado.', action: 'crear lote', destructive: true })) return;
    try { createBatchJob(ids); resumeBatch(); } catch (cause) { setError(message(cause)); }
  };
  return <div className="studio-shell"><aside className="sidebar"><Brand/><p className="nav-caption">TU ESPACIO COMERCIAL</p><nav aria-label="Navegación de Studio">
    {([['products', '01', 'Productos'], ['pending', '02', 'Pendientes'], ['library', '03', 'Biblioteca'], ['settings', '04', 'Configuración']] as const).map(([id, number, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><span>{number}</span>{label}<b>↗</b></button>)}
    </nav><div className="sidebar-bottom"><span className="connection-dot"/> Conectado con Stocky<p>El stock y los precios se mantienen en tu inventario.</p><button onClick={() => navigate('recovery')}>Recuperar intentos</button><a href="/?section=productos">Abrir Stocky ↗</a><CatalogShortcut refreshKey={catalogVersion} onConfigure={() => navigate('settings')}/><button onClick={logout}>Cerrar sesión</button></div></aside>
    <main className="workspace"><header className="topbar"><span className="workspace-label"><a href="/">Stocky</a><span aria-hidden="true"> / </span>Studio</span><span className="account"><span className="avatar">{profile?.appearance?.logoId ? <BrandImage id={profile.appearance.logoId} alt={profile.brandName}/> : brandInitials(profile?.brandName ?? 'Stocky')}</span><span className="account-name">{profile?.brandName ?? 'Tu negocio'}</span></span><div className="studio-tools"><ThemeToggle/><details className="mobile-session"><summary>Cuenta</summary><div><button onClick={() => navigate('recovery')}>Recuperar intentos</button><button onClick={logout}>Cerrar sesión</button></div></details></div></header>
      {error && <Notice action={<button onClick={() => { setError(''); setVersion(value => value + 1); }}>Reintentar</button>}>{error}</Notice>}
      {completion && !selectedId && !creating && <Notice>{completion}</Notice>}
      {(listVisible || visitedProducts.current) && <div hidden={!listVisible}>
        <ProductList key={`${session.phoneNumber}:${session.tenantPhone}:${listVersion}`} active={listVisible} refreshVersion={version}
          profile={profile} showMissingPhotos={showMissingPhotos} onOpen={open} onCreate={() => { setInitialCandidates([]); setCreating(true); }} onBatch={startBatch}/>
      </div>}
      {batchOpen ? <BatchStudio onBack={close}/> : selectedId || creating ? <ProductEditor key={selectedId ?? 'new'} id={selectedId} initialStep={creating ? 'details' : initialStep} initialCandidates={initialCandidates} onClose={close} onAttach={id => open(id, 'variants')} onPublished={() => { close(); setCompletion('Ficha finalizada y publicada en el catálogo.'); }} onCreated={(id, step) => { setInitialCandidates([]); open(id, step); }}/>
        : view === 'products' ? null
        : view === 'pending' ? <PendingInventory onCreate={items => { setInitialCandidates(items); setView('products'); setCreating(true); }} onLink={(id, items) => { setInitialCandidates(items); open(id); }} onPhotos={openMissingPhotos}/>
        : view === 'library' ? <ContentLibrary onOpen={open} onResumeBatch={resumeBatch}/> : view === 'settings' ? profile && <><Settings profile={profile} onSaved={setProfile}/><MoneyReview/></> : <Recovery onRecovered={() => setVersion(value => value + 1)}/>}
      <footer>STOCKY STUDIO <span>Una ficha. Todas tus posibilidades.</span></footer>
    </main></div>;
}

const emptyProductFilters = { q: '', status: '', team: '', season: '', version: '', sleeve: '', photos: '', publication: '' };
type ListedProduct = Product & { publication: Pick<Publication, 'status' | 'revision'> };
type ProductPage = { items: ListedProduct[]; nextCursor: string | null };
const isPublished = (product: ListedProduct) => product.status === 'ready' && product.publication.status === 'published';
const canPublish = (product: ListedProduct) => product.readiness.canPrepare && !isPublished(product);

function readProductPage(filters: typeof emptyProductFilters, cursor?: string, limit?: number) {
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  return query<ProductPage>(`/products?${params}`);
}

function ProductList({ active, refreshVersion, profile, showMissingPhotos, onOpen, onCreate, onBatch }: {
  active: boolean; refreshVersion: number;
  profile: Profile | null; showMissingPhotos: boolean; onOpen: (id: string, step?: ProductStep) => void; onCreate: () => void; onBatch: (ids: string[]) => void;
}) {
  const [filters, setFilters] = useState({ ...emptyProductFilters, photos: showMissingPhotos ? 'missing' : '' }), [applied, setApplied] = useState(filters);
  const [products, setProducts] = useState<ListedProduct[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [hasSports, setHasSports] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [publicationProgress, setPublicationProgress] = useState('');
  const [publicationResult, setPublicationResult] = useState<{ text: string; failures?: string[] } | null>(null);
  const [summary, setSummary] = useState<{ products: { status: string; count: number }[]; unlinkedSkus: number; withoutPhotos: number } | null>(null);
  const confirm = useConfirm();
  const mounted = useRef(false), publicationRunning = useRef(false);
  const visibility = useRef({ active, generation: 0 });
  useLayoutEffect(() => {
    visibility.current = { active, generation: visibility.current.generation + 1 };
    if (!active) setPublicationResult(null);
  }, [active]);
  const readGeneration = useRef(0);
  const reading = useRef(false), loaded = useRef(false);
  const refreshSummary = () => void query<typeof summary>('/summary').then(value => { if (mounted.current) setSummary(value); }).catch(() => {});
  const load = async (next?: string, values = applied, background = false) => {
    const generation = ++readGeneration.current;
    reading.current = true;
    if (!background) { setBusy(true); setError(''); }
    try {
      let result = await readProductPage(values, next);
      if (background) {
        // Keep the loaded range and rebuild its cursors against the current order.
        while (result.nextCursor && result.items.length < products.length && generation === readGeneration.current) {
          const page = await readProductPage(values, result.nextCursor);
          result = { items: [...result.items, ...page.items], nextCursor: page.nextCursor };
        }
      }
      if (generation !== readGeneration.current) return;
      loaded.current = true;
      setError('');
      setProducts(current => next ? [...current, ...result.items] : result.items);
      if (!next) {
        const selectableIds = new Set(result.items.filter(product => canPublish(product) || product.readiness.canGenerateStory).map(product => product.id));
        setSelection(current => current.filter(id => selectableIds.has(id)));
      }
      setCursor(result.nextCursor); setApplied(values);
      if (result.items.some(product => product.teamKey)) setHasSports(true);
    } catch (cause) { if (!background && generation === readGeneration.current) setError(message(cause)); }
    finally { if (generation === readGeneration.current) { reading.current = false; setBusy(false); } }
  };
  const listLoad = useRef(load); listLoad.current = load;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readGeneration.current++; reading.current = false; };
  }, []);
  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      if (document.hidden || publicationRunning.current || reading.current) return;
      void listLoad.current(undefined, undefined, loaded.current);
      refreshSummary();
    };
    refresh();
    addEventListener('focus', refresh);
    return () => removeEventListener('focus', refresh);
  }, [active, refreshVersion]);
  const change = (key: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  const applyFilters = (values: typeof filters) => { setSelection([]); void load(undefined, values); };
  const clear = () => { setFilters(emptyProductFilters); applyFilters(emptyProductFilters); };
  const filtered = Object.values(applied).some(Boolean), extraCount = Object.entries(filters).filter(([key, value]) => !['q', 'status'].includes(key) && value).length;
  const working = busy || Boolean(publicationProgress);
  const publishable = products.filter(canPublish);
  const selectedToPublish = publishable.filter(product => selection.includes(product.id));
  const storyEligible = new Set(products.filter(product => product.readiness.canGenerateStory).map(product => product.id));
  const storyIds = selection.filter(id => storyEligible.has(id));

  const publish = async (all: boolean) => {
    if (busy || publicationRunning.current) return;
    const generation = visibility.current.generation;
    const isCurrent = () => mounted.current && visibility.current.generation === generation;
    publicationRunning.current = true;
    setPublicationProgress('Consultando fichas para publicar…');
    setPublicationResult(null);
    try {
      const catalog = await query<Catalog | null>('/catalog');
      if (!isCurrent()) return;
      if (!catalog) throw new Error('Configurá el catálogo en Configuración antes de publicar fichas.');

      let candidates = selectedToPublish;
      if (all) {
        const matches = new Map<string, ListedProduct>();
        let next: string | undefined;
        do {
          const page = await readProductPage(applied, next, 50);
          if (!isCurrent()) return;
          for (const product of page.items.filter(canPublish)) matches.set(product.id, product);
          next = page.nextCursor ?? undefined;
        } while (next);
        candidates = [...matches.values()];
      }
      if (!candidates.length) {
        setPublicationResult({ text: 'No hay fichas aptas pendientes de publicar.' });
        return;
      }
      const count = candidates.length === 1 ? '1 ficha' : `${candidates.length} fichas`;
      const scope = all ? filtered ? 'Se incluyen todas las fichas aptas de los resultados filtrados.' : 'Se incluyen todas las fichas aptas de la colección.' : '';
      const visibilityMessage = catalog.publicEnabled ? 'Tus clientes podrán verlas en el catálogo público.' : 'Tus clientes podrán verlas cuando habilites el catálogo público.';
      if (!await confirm({ title: `¿Publicar ${count} en el catálogo?`, description: [scope, visibilityMessage].filter(Boolean).join(' '), action: 'publicar' }) || !isCurrent()) return;

      const published = new Set<string>(), failures: string[] = [];
      let remaining = 0;
      for (const [index, product] of candidates.entries()) {
        setPublicationProgress(`Publicando ficha ${index + 1} de ${candidates.length}… Mantené esta pantalla abierta.`);
        try {
          await publishProduct(product, product.publication.revision, 'Publicación por lote desde Productos comerciales');
          published.add(product.id);
        } catch (cause) {
          failures.push(`${product.title} · ${message(cause)}`);
          if (cause instanceof StudioError && ([0, 401, 403, 429].includes(cause.status) || ['PENDING_LIMIT', 'CATALOG_NOT_CONFIGURED', 'CATALOG_SCHEMA_NOT_READY'].includes(cause.code))) {
            remaining = candidates.length - index - 1;
            break;
          }
        }
        if (!isCurrent()) return;
      }
      if (!isCurrent()) return;
      setSelection(current => current.filter(id => !published.has(id)));
      const completed = published.size === 1 ? '1 ficha publicada.' : `${published.size} fichas publicadas.`;
      const incomplete = failures.length === 1 ? ' No se pudo confirmar 1 publicación.' : failures.length ? ` No se pudieron confirmar ${failures.length} publicaciones.` : '';
      const pending = remaining ? ` Quedaron ${remaining} sin intentar.` : '';
      setPublicationResult({ text: completed + incomplete + pending, failures });
      refreshSummary();
      await load();
    } catch (cause) {
      if (isCurrent()) setPublicationResult({ text: message(cause) });
    } finally {
      publicationRunning.current = false;
      if (mounted.current) {
        setPublicationProgress('');
        if (!isCurrent() && visibility.current.active && !reading.current) {
          void listLoad.current(undefined, undefined, loaded.current);
          refreshSummary();
        }
      }
    }
  };
  return <section className="product-list">
    <header className="products-heading">
      <div><h1>Productos comerciales <span className="count">{summary?.products.reduce((sum, item) => sum + item.count, 0) ?? products.length}{cursor && !summary ? '+' : ''}</span></h1>
        <p>Prepará y compartí el catálogo de {profile?.brandName ?? 'tu negocio'}.</p></div>
      <button className="primary" onClick={onCreate} disabled={Boolean(publicationProgress)}>＋ Nueva ficha comercial</button>
    </header>
    {summary && <p className="collection-stats"><span>{summary.products.find(item => item.status === 'ready')?.count ?? 0} preparadas</span><span>{summary.withoutPhotos ?? 0} sin fotos</span><span>{summary.unlinkedSkus} variantes pendientes</span></p>}
    <form className="filters product-filters" onSubmit={event => { event.preventDefault(); if (!working) applyFilters(filters); }}>
      <div className="filter-primary">
        <label className="search"><span aria-hidden="true">⌕</span><input aria-label="Buscar productos" placeholder="Buscá por producto…" value={filters.q} onChange={event => change('q', event.target.value)}/></label>
        <label className="filter-field"><span>Estado</span><select aria-label="Filtrar estado" value={filters.status} onChange={event => change('status', event.target.value)}><option value="">Todos los estados</option><option value="draft">Borradores</option><option value="ready">Preparadas</option><option value="archived">Archivadas</option></select></label>
        <button className="primary" type="submit" disabled={working}>Buscar</button>
      </div>
      <details className="product-filter-options"><summary>Más filtros{extraCount ? ` · ${extraCount} seleccionados` : ''}</summary>
        <div className="filter-fields">
          {hasSports && <>
            <label className="filter-field"><span>Equipo</span><input aria-label="Filtrar equipo" placeholder="Identificador de equipo" value={filters.team} onChange={event => change('team', event.target.value)}/></label>
            <label className="filter-field"><span>Temporada</span><input aria-label="Filtrar temporada" placeholder="Temporada" value={filters.season} onChange={event => change('season', event.target.value)}/></label>
            <label className="filter-field"><span>Versión</span><select aria-label="Filtrar versión" value={filters.version} onChange={event => change('version', event.target.value)}><option value="">Todas las versiones</option><option value="player">Jugador</option><option value="fan">Hincha</option></select></label>
            <label className="filter-field"><span>Manga</span><select aria-label="Filtrar manga" value={filters.sleeve} onChange={event => change('sleeve', event.target.value)}><option value="">Todas las mangas</option><option value="short">Corta</option><option value="long">Larga</option><option value="sleeveless">Sin mangas</option></select></label>
          </>}
          <label className="filter-field"><span>Fotografías</span><select aria-label="Filtrar fotografías" value={filters.photos} onChange={event => change('photos', event.target.value)}><option value="">Con o sin fotos</option><option value="missing">Sin fotos listas</option><option value="ready">Con fotos listas</option></select></label>
          <label className="filter-field"><span>Publicación</span><select aria-label="Filtrar publicación" value={filters.publication} onChange={event => change('publication', event.target.value)}><option value="">Toda publicación</option><option value="published">Publicadas</option><option value="hidden">Ocultas</option></select></label>
        </div><div className="filter-actions"><button type="submit" disabled={working}>Aplicar filtros</button><button type="button" disabled={working} onClick={() => applyFilters(filters)}>Actualizar colección</button></div>
      </details>
    </form>
    {filtered && <div className="filter-result" role="status"><span>{products.length}{cursor ? '+' : ''} resultados{applied.q ? ` para «${applied.q}»` : ' con los filtros aplicados'}</span><button onClick={clear} disabled={working}>Limpiar filtros</button></div>}
    {error && <div role="alert" className="notice"><span>{error}</span><button disabled={working} onClick={() => applyFilters(filters)}>Reintentar</button></div>}
    {products.length > 0 && <div className={`selection-toolbar ${selection.length ? 'has-selection' : ''}`}>
      <span>{selection.length ? `${selection.length} fichas seleccionadas` : 'Seleccioná fichas para publicar o generar historias por lote'}</span>
      <div className="selection-actions">
        {selection.length > 0 && <>
          <button className="primary" disabled={working || !selectedToPublish.length} onClick={() => void publish(false)}>Publicar seleccionadas ({selectedToPublish.length})</button>
          <button disabled={working || !storyIds.length || storyIds.length > 20} onClick={() => onBatch(storyIds)}>Generar historias por lote ({storyIds.length}) ↗</button>
        </>}
        <button disabled={working || (!publishable.length && !cursor)} onClick={() => void publish(true)}>Publicar todas las fichas aptas</button>
      </div>
    </div>}
    {publicationProgress && <p className="list-loading" role="status">{publicationProgress}</p>}
    {publicationResult && <Notice><div className="publication-result"><p>{publicationResult.text}</p>
      {publicationResult.failures?.length ? <ul>{publicationResult.failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul> : null}
    </div></Notice>}
    <div className="product-grid" aria-busy={busy}>{products.map((product, index) => {
      const variants = product.variants.filter(variant => variant.active);
      const showVariants = variants.length > 1 || variants.some(variant => (variant.label || variant.size || variant.name).trim().toLocaleLowerCase('es') !== product.title.trim().toLocaleLowerCase('es'));
      return <div className="selectable-product" key={product.id}>
        <label className="product-selector"><input type="checkbox" aria-label={`Seleccionar ${product.title}`} checked={selection.includes(product.id)} disabled={working || (!canPublish(product) && !product.readiness.canGenerateStory)} onChange={event => setSelection(current => event.target.checked ? [...current, product.id] : current.filter(id => id !== product.id))}/><span className="sr-only">Seleccionar producto</span></label>
        <button className="product-card" disabled={Boolean(publicationProgress)} onClick={() => onOpen(product.id, showMissingPhotos && applied.photos === 'missing' ? 'photos' : 'details')}><div className={`card-photo ${!product.coverImageId ? 'without-photo' : ''}`}><PrivatePhoto product={product} imageId={product.coverImageId} lazy={index >= 3}/><span className={`status ${product.status}`}>{isPublished(product) ? 'Publicada' : statusLabel[product.status]}</span></div>
          <div className="card-body"><small>{product.teamName || 'Producto comercial'} <span aria-hidden="true">↗</span></small><h3>{product.title}</h3>
            {[product.season, product.versionKey === 'player' ? 'Jugador' : product.versionKey === 'fan' ? 'Hincha' : ''].some(Boolean) && <p>{[product.season, product.versionKey === 'player' ? 'Jugador' : product.versionKey === 'fan' ? 'Hincha' : ''].filter(Boolean).join(' · ')}</p>}
            <div className="card-bottom"><strong>{priceLabel(product)}</strong><span>{product.availableQuantity ?? '—'} disponibles</span></div>
            {showVariants && <div className="sizes">{variants.map(variant => <span key={variant.skuId} className={variant.stockAvailable ? '' : 'empty'}>{variant.label || variant.size || variant.name}</span>)}</div>}
          </div>
        </button>
      </div>;
    })}
    {!products.length && !busy && !error && (filtered ? <div className="empty-state"><h2>No encontramos fichas con esta búsqueda.</h2><p>Probá otro nombre o quitá los filtros para ver tu catálogo.</p><button onClick={clear} disabled={working}>Limpiar filtros</button></div> : <div className="empty-state"><h2>Empezá tu catálogo comercial</h2><p>Vinculá productos de Stocky, sumá sus fotos y prepará la primera ficha.</p><button className="primary" onClick={onCreate} disabled={working}>Crear primera ficha</button></div>)}
    </div>
    {busy && <p role="status" className="list-loading">Cargando colección…</p>}
    {cursor && !error && <button className="load-more" disabled={working} onClick={() => void load(cursor)}>Ver más productos ↓</button>}
  </section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Fields({ fields, setFields }: { fields: CommercialFields; setFields: (value: CommercialFields) => void }) {
  const change = (key: keyof CommercialFields, value: string) => setFields({ ...fields, [key]: value });
  return <div className="field-grid">
    <Field label="Título comercial"><input required maxLength={120} value={fields.title} onChange={event => change('title', event.target.value)} placeholder="Nombre del producto"/></Field>
    <Field label="Descripción · opcional"><textarea aria-label="Descripción · opcional" maxLength={4000} value={fields.description} onChange={event => change('description', event.target.value)} rows={4}/><small className="field-help">Contá qué es el producto y qué lo distingue. Usá solo características y condiciones reales.</small>{fields.description.trim().length > 0 && fields.description.trim().length < 12 && <small className="field-hint">Revisá si esta descripción le aporta información a quien compra.</small>}</Field>
  </div>;
}

function ProductEditor({ id, initialStep, initialCandidates, onClose, onCreated, onAttach, onPublished }: { id: string | null; initialStep: ProductStep; initialCandidates: Candidate[]; onClose: () => void; onCreated: (id: string, step: ProductStep) => void; onAttach: (id: string) => void; onPublished: () => void }) {
  const confirm = useConfirm();
  const { session } = useAuth();
  const draftKey = `fullmatch.draft.${session?.phoneNumber}.${id ?? 'new'}`;
  const [product, setProduct] = useState<Product | null>(null), [fields, setFields] = useState<CommercialFields>({ ...emptyFields, title: initialCandidates[0]?.productModel || initialCandidates[0]?.name || '' });
  const [skuMetadataChanges, setSkuMetadataChanges] = useState<Record<string, SkuMetadataChange>>({});
  const [candidates, setCandidates] = useState<Candidate[]>(initialCandidates), [selected, setSelected] = useState<string[]>(initialCandidates.map(item => item.skuId)), [tab, setTab] = useState<ProductStep>(id && initialCandidates.length ? 'variants' : initialStep);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const focusStep = useRef(initialStep !== 'details' || Boolean(id && initialCandidates.length));
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [choosingExisting, setChoosingExisting] = useState(false);
  useEffect(() => {
    if (focusStep.current) stepHeading.current?.focus();
    focusStep.current = true;
  }, [tab]);
  useEffect(() => {
    if (tab !== 'variants' || !id) return;
    let active = true; setCandidatesLoading(true);
    const loadCandidates = async () => {
      const items: Candidate[] = []; let cursor: string | null = null;
      do { const data: { items: Candidate[]; nextCursor: string | null } = await query(`/inventory-candidates?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`); items.push(...data.items); cursor = data.nextCursor; } while (active && cursor && items.length < 1000);
      if (active) setCandidates([...items, ...initialCandidates.filter(candidate => !items.some(item => item.skuId === candidate.skuId))]);
    };
    void loadCandidates().catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setCandidatesLoading(false); });
    return () => { active = false; };
  }, [tab, id]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState(''), [dirty, setDirty] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [uploadingImageId, setUploadingImageId] = useState<string | null>(null);
  const [story, setStory] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [linksDirty, setLinksDirty] = useState(Boolean(id && initialCandidates.length));
  const productRef = useRef(product); productRef.current = product;
  const activity = useRef({ busy: false, story: false }); activity.current = { busy, story };
  const [loading, setLoading] = useState(Boolean(id)), readGeneration = useRef(0);
  const refresh = async () => { if (!id) return true; const generation = ++readGeneration.current; const detail = await query<Product>(`/products/${id}`); if (generation !== readGeneration.current) return false; setLinksDirty(false); setExternalChange(false); setProduct(detail); setFields(productFields(detail)); setSkuMetadataChanges({}); setSelected(detail.variants.map(variant => variant.skuId)); setDirty(false); return true; };
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true); const loaded = await refresh(); if (!active || !loaded) return;
      if (initialCandidates.length && id) { setSelected(current => [...new Set([...current, ...initialCandidates.map(item => item.skuId)])]); setLinksDirty(true); }
      const saved = localStorage.getItem(draftKey); if (!saved) return;
      try { const draft = JSON.parse(saved); if (fieldKeys.every(key => typeof draft?.[key] === 'string')) {
        setFields(productFields(draft));
        if (Array.isArray(draft.skuMetadataChanges) && draft.skuMetadataChanges.every(validSkuMetadataChange)) setSkuMetadataChanges(Object.fromEntries(draft.skuMetadataChanges.map((item: SkuMetadataChange) => [item.skuId, item])));
        setDirty(true); setSuccess('Recuperé tu borrador de este navegador. Revisalo antes de guardar.');
      } } catch { /* Invalid browser draft is ignored. */ }
    };
    void load().catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; readGeneration.current++; };
  }, [id]);
  useEffect(() => { if (dirty) localStorage.setItem(draftKey, JSON.stringify({ ...fields, ...(Object.keys(skuMetadataChanges).length ? { skuMetadataChanges: Object.values(skuMetadataChanges) } : {}) })); }, [fields, skuMetadataChanges, dirty, draftKey]);
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
  const save = (event: FormEvent) => { event.preventDefault(); const advance = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'save'; void action(async () => {
    const metadata = Object.keys(skuMetadataChanges).length ? { skuMetadataChanges: Object.values(skuMetadataChanges) } : {};
    if (!id) { const created = await command<Product>('/products', 'POST', { product: fields, skuLinks: initialCandidates.map(linkOf), ...metadata }); localStorage.removeItem(draftKey); setDirty(false); onCreated(created.id, advance ? 'variants' : 'details'); }
    else if (product) { const saved = await command<Product>(`/products/${id}`, 'PATCH', { expectedRevision: product.revision, changes: fields, ...metadata }); setProduct(saved); setFields(productFields(saved)); setSkuMetadataChanges({}); setDirty(false); localStorage.removeItem(draftKey); setSuccess('Ficha guardada.'); if (advance) setTab('variants'); }
  }); };
  const openVariants = () => setTab('variants');
  const saveLinks = (advance = false) => product && action(async () => {
    const saved = await command<Product>(`/products/${id}/sku-links`, 'PUT', { expectedRevision: product.revision, skuLinks: variants.filter(item => selected.includes(item.skuId)).map(linkOf) });
    setProduct(saved);
    setLinksDirty(false); setSuccess(saved.status === 'ready' ? 'Vínculos guardados. El producto sigue preparado y conserva su publicación.' : 'Vínculos revisados y guardados.'); if (advance) setTab('photos');
  });
  const publish = async () => { if (product && await confirm({ title: `¿Publicar ${product.title}?`, description: 'La ficha será visible para tus clientes en el catálogo.', action: 'publicar' })) await action(async () => { await finishAndPublish(product); onPublished(); }); };
  const state = async (status: Product['status']) => { if (!product || !await confirm({ title: status === 'archived' ? `¿Archivar ${product.title}?` : `¿Cambiar el estado de ${product.title}?`, action: status === 'archived' ? 'archivar' : 'confirmar cambio', destructive: status === 'archived' })) return; return action(async () => { const changed = await command<Product>(`/products/${id}/status`, 'POST', { expectedRevision: product.revision, status, reason: 'Cambio revisado desde Studio' }); setProduct(changed); setSuccess(status === 'ready' ? 'Ficha preparada para generar contenido.' : 'Estado actualizado.'); }); };
  const sendPhoto = async (productId: string, imageId: string, file: File): Promise<Product> => {
    setUploadingImageId(imageId);
    try {
      const saved = await uploadPhoto(productId, imageId, file);
      setProduct(saved);
      return saved;
    } finally { setUploadingImageId(null); }
  };
  const upload = (files: File[]) => product && files.length > 0 && action(async () => {
    const remaining = 8 - product.images.length;
    if (files.length > remaining) throw new Error(`Elegiste ${files.length} fotos y quedan ${remaining} lugares disponibles. Podés guardar hasta 8 fotos por ficha; seleccioná hasta ${remaining}.`);
    for (const file of files) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 12 * 1024 * 1024) throw new Error(`«${file.name}» no es una foto JPG, PNG o WebP válida de hasta 12 MB. Revisá la selección antes de subirla.`);
    }
    let current = product, saved = 0;
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress({ current: index + 1, total: files.length });
        try {
          const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
          const sourceSha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
          const initialized = await command<{ imageId: string; product: Product }>(`/products/${id}/images`, 'POST', { expectedRevision: current.revision, sourceSha256, sourceSizeBytes: file.size, altText: current.title });
          current = initialized.product; setProduct(current);
          current = await sendPhoto(current.id, initialized.imageId, file); saved++;
        } catch (cause) {
          try { setProduct(await query<Product>(`/products/${id}`)); } catch { /* Keep the latest confirmed gallery when refresh is unavailable. */ }
          throw new Error(`Se guardaron ${saved} de ${files.length} fotos. No se pudo completar «${file.name}»: ${message(cause)}${index + 1 < files.length ? ' Las fotos siguientes no se subieron; podés volver a seleccionarlas.' : ''}`);
        }
      }
      setSuccess(files.length === 1 ? 'Foto procesada y guardada.' : `${saved} fotos procesadas y guardadas.`);
    } finally { setUploadProgress(null); }
  });
  const retryUpload = (imageId: string, file: File) => product && action(async () => { await sendPhoto(product.id, imageId, file); setSuccess('Carga recuperada.'); });
  const gallery = (images: string[], cover: string | null) => product && action(async () => { setProduct(await command(`/products/${id}/gallery`, 'PUT', { expectedRevision: product.revision, imageIds: images, coverImageId: cover })); });
  const retire = async (imageId: string) => { if (!product || !await confirm({ title: '¿Retirar esta fotografía?', action: 'retirar', destructive: true })) return; return action(async () => { const image = product.images.find(item => item.id === imageId)!; setProduct(await command(`/products/${id}/images/${imageId}`, 'PATCH', {
    expectedRevision: product.revision, expectedImageRevision: image.revision, altText: image.altText, focalX: image.focalX, focalY: image.focalY, retire: true })); }); };
  const variants = [...(product?.variants ?? []), ...candidates.filter(candidate => !product?.variants.some(item => item.skuId === candidate.skuId))];
  const readOnly = product?.status === 'archived' || externalChange;
  if (story && product) return <StoryEditor product={product} onBack={() => { setStory(false); void action(refresh); }}/>;
  if (!id && choosingExisting) return <section className="editor page-section"><ExistingProductPicker onChoose={onAttach} onCancel={() => setChoosingExisting(false)}/></section>;
  return <section className="editor page-section"><button className="back" onClick={async () => { if ((!dirty && !linksDirty) || await confirm({ title: '¿Volver a productos sin guardar?', description: 'Podés recuperar este borrador al volver.', action: 'volver', destructive: true })) onClose(); }}>← Volver a productos</button><div className="section-heading"><div><p className="eyebrow dark">FICHA COMERCIAL</p><h1>{product?.title ?? (id ? 'Cargando ficha…' : 'Una nueva historia')}</h1></div>{product && <span className={`status ${product.status}`}>{statusLabel[product.status]}</span>}</div>
    {error && <Notice action={id ? <button onClick={async () => { if ((!dirty && !linksDirty) || await confirm({ title: '¿Descartar el borrador y actualizar?', action: 'actualizar', destructive: true })) { localStorage.removeItem(draftKey); void action(refresh); } }}>Revisar datos actuales</button> : undefined}>{error}</Notice>}{success && <Notice>{success}</Notice>}
    {!id && initialCandidates.length > 0 && <div className="panel"><h2>¿Este modelo ya tiene una publicación?</h2><p>Podés sumar los talles seleccionados a ese producto aunque tengan otro nombre en Stocky.</p><button type="button" disabled={busy || loading} onClick={() => setChoosingExisting(true)}>Adjuntar a un producto publicado</button></div>}
    <div className="editor-actions">{id && <button disabled={busy || loading} onClick={async () => { if ((!dirty && !linksDirty) || await confirm({ title: '¿Descartar el borrador y actualizar?', action: 'actualizar', destructive: true })) { localStorage.removeItem(draftKey); void action(refresh); } }}>Actualizar ficha</button>}<a href="/?section=productos">Abrir en Stocky ↗</a></div>{externalChange && <Notice>La ficha cambió en otra pantalla. Tu borrador se conserva. Actualizá la ficha antes de guardar.</Notice>}<p className="editor-progress" aria-live="polite">Paso {tab === 'details' ? 1 : tab === 'variants' ? 2 : 3} de 3 · {tab === 'details' ? 'Completá la información' : tab === 'variants' ? 'Revisá las presentaciones de Stocky' : 'Agregá fotos o finalizá sin ellas'}</p><nav className="tabs" aria-label="Pasos de la ficha"><button aria-current={tab === 'details' ? 'step' : undefined} disabled={busy || loading} className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>01 Información</button><button aria-current={tab === 'variants' ? 'step' : undefined} disabled={!id || busy || loading} className={tab === 'variants' ? 'active' : ''} onClick={openVariants}>02 SKU vinculados</button><button aria-current={tab === 'photos' ? 'step' : undefined} disabled={!id || busy || loading} className={tab === 'photos' ? 'active' : ''} onClick={() => setTab('photos')}>03 Fotografías</button></nav>
    <div className="editor-layout"><div className="editor-main">{tab === 'details' ? <form onSubmit={save}><fieldset disabled={busy || loading || readOnly}><h2 ref={stepHeading} tabIndex={-1} className="editor-step-heading">Información del producto</h2><p className="muted">Solo el nombre es obligatorio. La descripción, los atributos del rubro y las fotos son opcionales. Los saldos y precios provienen de Stocky.</p><Fields fields={fields} setFields={value => { setFields(value); setDirty(true); }}/><SkuMetadataFields category={session?.businessCategory} items={product ? product.variants.filter(item => item.active) : initialCandidates} changes={skuMetadataChanges} onChange={value => { setSkuMetadataChanges(value); setDirty(true); }}/><div className="inventory-specs">{product?.variants.map(variant => variant.specifications?.length ? <details key={variant.skuId}><summary>{variant.label || variant.name} · atributos de Stocky</summary><dl>{variant.specifications.map(spec => <div key={spec.label}><dt>{spec.label}</dt><dd>{spec.value}</dd></div>)}</dl><a href="/?section=productos">Editar en Stocky ↗</a></details> : null)}</div><p>{!id && initialCandidates.length ? `${initialCandidates.length} SKU seleccionados se vincularán al crear la ficha. Revisá que correspondan al mismo producto.` : ""}</p><div className="editor-step-actions"><button className="primary" type="submit" value="next">{busy ? 'Guardando…' : 'Siguiente: SKU vinculados →'}</button><button type="submit" value="save">{id ? 'Guardar cambios' : 'Crear ficha'}</button></div><p className="editor-step-hint">Al continuar, guardamos la información de esta ficha.</p></fieldset></form> : tab === 'variants' ? <div><h2 ref={stepHeading} tabIndex={-1} className="editor-step-heading">SKU y presentaciones vinculadas</h2><p>Seleccioná los SKU que corresponden a este producto. Revisá su identidad antes de guardar los vínculos.</p><fieldset disabled={busy || loading || candidatesLoading || readOnly}>{candidatesLoading && <p role="status">Cargando SKU disponibles…</p>}<div className="variant-list">{variants.map(item => <label key={item.skuId} className="variant-row"><input type="checkbox" checked={selected.includes(item.skuId)} onChange={event => { setLinksDirty(true); setSelected(current => event.target.checked ? [...current, item.skuId] : current.filter(value => value !== item.skuId)); }}/><span className="size-tag">{item.label || item.size || item.name}</span><div><strong>{item.name}</strong><small>{moneyLabel(item.price)}</small></div><span>{item.stockAvailable ?? '—'} disp. · {item.stockReserved ?? '—'} reserv.</span></label>)}</div><div className="editor-step-actions"><button className="primary" onClick={() => void saveLinks(true)}>{busy ? 'Guardando…' : 'Siguiente: Fotografías →'}</button><button onClick={() => void saveLinks()}>Guardar vínculos</button></div></fieldset><div className="editor-step-back"><button disabled={busy || loading} onClick={() => setTab('details')}>← Anterior: Información</button><p className="editor-step-hint">Al continuar, guardamos los vínculos seleccionados.</p></div></div> : product && <div><h2 ref={stepHeading} tabIndex={-1} className="editor-step-heading">Fotografías del producto</h2><p>Hasta 8 fotos JPG, PNG o WebP. Máximo 12 MB y 32 megapíxeles por foto.</p><label className={`upload-box ${busy || product.images.length >= 8 ? 'disabled' : ''}`}><span>＋</span><strong aria-live="polite">{uploadProgress ? `Procesando foto ${uploadProgress.current} de ${uploadProgress.total}…` : product.images.length >= 8 ? 'Límite de 8 fotos alcanzado' : 'Elegir fotografías'}</strong><small>Podés seleccionar varias a la vez. Quedan {8 - product.images.length} lugares. Tu primera foto será la portada.</small><input aria-label="Subir fotografías" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy || loading || readOnly || product.images.length >= 8} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void upload(files); }}/></label><div className="gallery-grid">{product.images.map((image, index) => <div className="gallery-item" key={image.id}><div className="gallery-photo">{image.status === 'ready' ? <PrivatePhoto product={product} imageId={image.id}/> : <span role="status">{uploadingImageId === image.id || image.status === 'processing' ? 'Procesando…' : image.status === 'failed' ? 'Carga fallida' : 'Esperando archivo'}</span>}{product.coverImageId === image.id && <span className="status ready">Portada</span>}</div><small>{image.altText}</small><div className="gallery-actions"><button disabled={busy || readOnly || image.status !== 'ready'} onClick={() => void gallery(product.images.map(item => item.id), image.id)}>Portada</button><button aria-label="Mover foto a la izquierda" disabled={busy || readOnly || index === 0} onClick={() => { const ids = product.images.map(item => item.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void gallery(ids, product.coverImageId); }}>←</button><button disabled={busy || readOnly} onClick={() => void retire(image.id)}>Retirar</button></div><PhotoDetails product={product} image={image} disabled={busy || readOnly} onSaved={setProduct} onError={cause => setError(message(cause))}/>{uploadingImageId !== image.id && ['pending', 'failed', 'processing'].includes(image.status) && <label className="retry-file">Reintentar con el mismo archivo<input aria-label="Reintentar fotografía" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || readOnly} onChange={event => { const file = event.target.files?.[0]; if (file) void retryUpload(image.id, file); event.target.value = ''; }}/></label>}</div>)}</div><div className="editor-step-actions"><button className="primary" disabled={busy || loading || readOnly || dirty || linksDirty || !product.readiness.canPrepare} onClick={() => void publish()}>{busy ? 'Publicando…' : 'Finalizar y publicar'}</button><button disabled={busy || loading || dirty || linksDirty} onClick={onClose}>Finalizar ficha</button><button disabled={busy || loading} onClick={openVariants}>← Anterior: SKU vinculados</button></div><p className="editor-step-hint">{dirty || linksDirty ? 'Guardá los cambios pendientes en Información o SKU vinculados antes de finalizar.' : 'Las fotos son opcionales y se guardan al subirlas. Finalizá y publicá en un solo paso, o elegí Finalizar ficha para guardarla sin publicar.'}</p></div>}</div>
      <aside className="editor-summary"><div className="summary-photo">{product ? <PrivatePhoto product={product} imageId={product.coverImageId}/> : <div className="photo-empty">S ／</div>}</div><p className="eyebrow dark">VISTA COMERCIAL</p><h3>{product?.title || fields.title || 'Tu próximo producto'}</h3>{product && <><strong>{priceLabel(product)}</strong><p>{product.availableQuantity ?? '—'} unidades disponibles</p><div className="sizes">{product.variants.filter(item => item.active).map(item => <span key={item.skuId}>{item.label || item.size || item.name}</span>)}</div><hr/><h4>{product.readiness.canPrepare ? 'Lista para preparar' : 'Antes de preparar'}</h4><PreparationBlockers product={product} onTab={next => next === "variants" ? openVariants() : setTab(next)}/>{product.status === 'archived' ? <button disabled={busy} onClick={() => void state('draft')}>Restaurar a borrador</button> : <><button className="primary" disabled={busy || externalChange || dirty || linksDirty || !product.readiness.canPrepare || product.status === 'ready'} onClick={() => void state('ready')}>{product.status === 'ready' ? 'Ficha preparada ✓' : 'Preparar ficha'}</button><button className="text-button" disabled={busy || externalChange || dirty} onClick={() => void state('archived')}>Archivar ficha</button></>}</>}
      {product && <PublicationPanel product={product} disabled={busy || loading || externalChange || dirty || linksDirty} onChanged={refresh}/>}
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
