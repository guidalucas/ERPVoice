import { useEffect, useState, type CSSProperties } from 'react';
import { studioFetch, imageBlob, query } from './api';
import { brandInitials, textOnColor, priceLabel, type Product, type Appearance } from './types';

export function BrandImage({ id, alt = '', className = '' }: { id: string; alt?: string; className?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true, objectUrl = ''; setUrl('');
    studioFetch(`/brand-assets/${id}`).then(response => response.blob()).then(blob => {
      if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return url ? <img className={className} src={url} alt={alt}/> : <span className={className} aria-label={alt}>◇</span>;
}

export function AppearanceFields({ value, onChange, brandName, disabled, onUpload }: {
  value: Appearance; onChange: (value: Appearance) => void; brandName: string; disabled: boolean;
  onUpload: (kind: 'logo' | 'cover', file: File) => Promise<void>;
}) {
  const [products, setProducts] = useState<Product[]>([]), [previewWidth, setPreviewWidth] = useState<'desktop' | 'mobile'>('desktop'), [previewError, setPreviewError] = useState(false);
  useEffect(() => { let active = true; void query<{ items: Product[] }>('/products').then(result => { if (active) setProducts(result.items.slice(0, 4)); }).catch(() => { if (active) setPreviewError(true); }); return () => { active = false; }; }, []);
  const [uploads, setUploads] = useState<Partial<Record<'logo' | 'cover', { file: File; status: 'uploading' | 'ready' | 'error' }>>>({});
  const upload = async (kind: 'logo' | 'cover', file: File) => {
    setUploads(current => ({ ...current, [kind]: { file, status: 'uploading' } }));
    try {
      await onUpload(kind, file);
      setUploads(current => ({ ...current, [kind]: { file, status: 'ready' } }));
    } catch {
      setUploads(current => ({ ...current, [kind]: { file, status: 'error' } }));
    }
  };
  const patch = (change: Partial<Appearance>) => onChange({ ...value, ...change });
  return <div className="appearance-layout"><div className="appearance-controls"><h2>Identidad visual</h2><p>El logo y los colores se usan en tu catálogo y en las nuevas historias. La portada y los textos personalizan tu página pública.</p>
    <label className="field"><span>Diseño del catálogo · opcional</span><select value={value.preset ?? 'classic'} onChange={event => patch({ preset: event.target.value as Appearance['preset'] })}>
      <option value="classic">Actual · conservar composición</option><option value="editorial">Editorial · fotografías protagonistas</option><option value="technical">Catálogo técnico · información clara</option><option value="local">Comercio de proximidad · navegación rápida</option>
    </select></label><p className="muted">Elegí un diseño sin volver a configurar tu tienda. Conservamos el logo, los colores, las imágenes y los textos. Podés volver al diseño actual cuando quieras.</p>
    <div className="brand-uploads">{(['logo', 'cover'] as const).map(kind => <div key={kind}>
      <label className={`field brand-file-control ${disabled ? 'disabled' : ''}`}><span>{kind === 'logo' ? 'Logo del negocio' : 'Portada del catálogo'}</span>
        <input aria-label={kind === 'logo' ? 'Logo del negocio' : 'Portada del catálogo'} type="file" disabled={disabled} accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(kind, file); }}/>
        <span className="brand-file-button">Elegir {kind === 'logo' ? 'logo' : 'portada'}</span>
      </label><small className="brand-upload-status" role="status">{uploads[kind] ? `${uploads[kind]!.file.name} · ${uploads[kind]!.status === 'uploading' ? 'Cargando…' : uploads[kind]!.status === 'ready' ? 'Cargado. Guardá la configuración para aplicarlo.' : 'No se pudo cargar.'}` : value[`${kind}Id`] ? 'Imagen cargada.' : 'Todavía no elegiste una imagen.'}</small>
      <small>{kind === 'logo' ? 'Recomendado: cuadrado, PNG con transparencia.' : 'Recomendado: horizontal, 1600 × 900.'} JPG, PNG o WebP, hasta 12 MB. Adaptamos el tamaño automáticamente.</small>
      {uploads[kind]?.status === 'error' && <button type="button" disabled={disabled} onClick={() => void upload(kind, uploads[kind]!.file)}>Reintentar {kind === 'logo' ? 'logo' : 'portada'}</button>}
      {value[`${kind}Id`] && <button type="button" disabled={disabled} onClick={() => { patch({ [`${kind}Id`]: null }); setUploads(current => ({ ...current, [kind]: undefined })); }}>Quitar {kind === 'logo' ? 'logo' : 'portada'}</button>}
    </div>)}</div>
    <div className="brand-colors">{([['primaryColor', 'Color de fondo'], ['accentColor', 'Color de acento']] as const).map(([key, label]) => <label className="field" key={key}><span>{label}</span><input type="color" value={value[key]} onChange={event => patch({ [key]: event.target.value })}/></label>)}</div>
    <h2>Tu página</h2>{([['tagline', 'Frase de marca', 80], ['heroTitle', 'Título de portada', 120], ['heroDescription', 'Descripción de portada', 300], ['collectionTitle', 'Título de la colección', 60]] as const).map(([key, label, limit]) => <label className="field" key={key}><span>{label}</span>{key === 'heroDescription' ? <textarea maxLength={limit} value={value[key]} onChange={event => patch({ [key]: event.target.value })}/> : <input required={key === 'heroTitle' || key === 'collectionTitle'} maxLength={limit} value={value[key]} onChange={event => patch({ [key]: event.target.value })}/>}</label>)}
    </div><aside className="appearance-preview-panel"><div className="preview-heading"><h2>Vista previa de tu tienda</h2><div role="group" aria-label="Ancho de vista previa"><button type="button" aria-pressed={previewWidth === 'desktop'} onClick={() => setPreviewWidth('desktop')}>Escritorio</button><button type="button" aria-pressed={previewWidth === 'mobile'} onClick={() => setPreviewWidth('mobile')}>Celular</button></div></div><div className="brand-preview" data-viewport={previewWidth} data-preset={value.preset ?? 'classic'} aria-label="Vista previa del catálogo" style={{ '--brand-primary': value.primaryColor, '--brand-accent': value.accentColor, '--brand-ink': textOnColor(value.primaryColor), '--brand-accent-ink': textOnColor(value.accentColor) } as CSSProperties}>
      <div className="brand-preview-header">{value.logoId ? <BrandImage id={value.logoId} alt={brandName} className="business-logo"/> : <strong>{brandInitials(brandName)}</strong>}<span>{brandName || 'Tu negocio'}</span></div>
      <div className="brand-preview-hero">{value.coverId && <BrandImage id={value.coverId} className="brand-preview-cover"/>}<div><small>{value.tagline}</small><h3>{value.heroTitle}</h3><p>{value.heroDescription}</p><span className="preview-cta">Explorar colección ↓</span></div></div>
      <div className="brand-preview-collection"><h3>{value.collectionTitle}</h3><div className="preview-search" aria-hidden="true">Buscar productos…</div>{products.length ? <div className="brand-preview-products">{products.map(product => <PreviewProduct key={product.id} product={product}/>)}</div> : <p>{previewError ? 'No pude cargar los productos de la vista previa.' : 'Cuando agregues fichas, podrás revisar tus productos en esta vista.'}</p>}</div><small>Productos de tu catálogo · El stock y los precios se consultan al abrir la tienda. Los cambios de diseño se aplican al guardar.</small>
    </div></aside></div>;
}


function PreviewProduct({ product }: { product: Product }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true, imageUrl = ''; setUrl('');
    if (product.coverImageId) void imageBlob(product.id, product.coverImageId, true).then(blob => { if (active) { imageUrl = URL.createObjectURL(blob); setUrl(imageUrl); } }).catch(() => {});
    return () => { active = false; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [product.id, product.coverImageId, product.revision]);
  return <article className="brand-preview-product"><div>{url ? <img src={url} alt={product.title}/> : <span>{product.coverImageId ? 'Fotografía del producto' : 'Sin fotografía'}</span>}</div><h4>{product.title}</h4><strong>{priceLabel(product)}</strong></article>;
}
