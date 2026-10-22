import { useEffect, useState } from 'react';
import { studioFetch } from './api';
import { type Appearance } from './types';
import { defaultHeroLayout, type HeroBlock, type HeroLayout } from '../shared/catalogAppearance.js';
import { CatalogDesignPreview, catalogDesigns, useBrandAssetUrls } from './CatalogDesignPreview';

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
  const assets = useBrandAssetUrls(value);
  const [mobile, setMobile] = useState(false), [editing, setEditing] = useState(false), [selectedBlock, setSelectedBlock] = useState<HeroBlock>('title');
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
  const layout = value.heroLayout ?? defaultHeroLayout;
  const position = layout[selectedBlock];
  const updateLayout = (heroLayout: HeroLayout) => { if (!disabled) patch({ heroLayout }); };
  const blockLabels: Record<HeroBlock, string> = { tagline: 'Frase de marca', title: 'Título', description: 'Descripción', button: 'Botón' };
  return <div className="appearance-layout"><div className="appearance-controls"><h2>Identidad visual</h2><p>El logo y los colores se usan en tu catálogo y en las nuevas historias. La portada y los textos personalizan tu página pública.</p>
    <fieldset className="catalog-design-picker" disabled={disabled}><legend>Diseño del catálogo · opcional</legend><div className="catalog-design-options">
      {catalogDesigns.map(design => <label className="catalog-design-option" key={design.id}>
        <input type="radio" name="catalog-design" aria-label={design.name} value={design.id} checked={(value.preset ?? 'classic') === design.id} onChange={() => patch({ preset: design.id })}/>
        <CatalogDesignPreview value={{ ...value, preset: design.id }} brandName={brandName} assets={assets} miniature/>
        <span className="catalog-design-caption"><strong>{design.name}</strong><small>{design.description}</small></span>
      </label>)}
    </div></fieldset><p className="catalog-preview-note">Elegí la tienda que más te guste. Las miniaturas usan tu identidad y productos de ejemplo; la vista grande muestra fichas de tu catálogo. Los cambios se aplican al guardar configuración.</p>
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
    <h2>Tu página</h2><p className="catalog-preview-note">Los textos del banner son opcionales. Podés dejar cada campo vacío o mostrar solamente la imagen.</p>
    <div className="banner-text-fields">{([['tagline', 'Frase de marca', 80], ['heroTitle', 'Título de portada', 120], ['heroDescription', 'Descripción de portada', 300], ['collectionTitle', 'Título de la colección', 60]] as const).map(([key, label, limit]) => <label className="field" key={key}><span>{label}</span>{key === 'heroDescription' ? <textarea aria-label={label} maxLength={limit} value={value[key]} onChange={event => patch({ [key]: event.target.value })}/> : <input aria-label={label} required={key === 'collectionTitle'} maxLength={limit} value={value[key]} onChange={event => patch({ [key]: event.target.value })}/>}</label>)}</div>
    <div className="banner-options"><h3>Contenido del banner</h3>
      <label className="checkbox-field"><input type="checkbox" checked={value.heroContentVisible === false} onChange={event => { patch({ heroContentVisible: !event.target.checked }); setEditing(false); }}/> Solo imagen · ocultar textos y botón</label>
      {value.heroContentVisible !== false && <><label className="checkbox-field"><input type="checkbox" checked={value.heroButtonVisible !== false} onChange={event => patch({ heroButtonVisible: event.target.checked })}/> Mostrar botón «Explorar catálogo»</label>
        <label className="checkbox-field"><input type="checkbox" checked={value.heroTextBackground !== false} onChange={event => patch({ heroTextBackground: event.target.checked })}/> Mostrar recuadro detrás del texto</label>
        {value.heroTextBackground === false && <><p>Los textos quedan sin fondo. Si hay una portada, se colocan directamente sobre la imagen.</p><label className="field"><span>Color del texto sobre la imagen</span><select aria-label="Color del texto sobre la imagen" value={value.heroTextTone ?? 'light'} onChange={event => patch({ heroTextTone: event.target.value as 'light' | 'dark' })}><option value="light">Claro · para imágenes oscuras</option><option value="dark">Oscuro · para imágenes claras</option></select></label></>}
        <div className="banner-edit-actions"><button type="button" disabled={disabled} aria-pressed={editing} onClick={() => { setEditing(!editing); setMobile(false); if (!value.heroLayout) patch({ heroLayout: structuredClone(defaultHeroLayout) }); }}>{editing ? 'Terminar de ubicar bloques' : 'Ubicar bloques en el banner'}</button>
          {value.heroLayout && <button type="button" disabled={disabled} onClick={() => { patch({ heroLayout: null }); setEditing(false); }}>Restablecer composición</button>}</div>
        {editing && <><p>Arrastrá cada bloque en la vista previa o ajustá su posición y ancho. Podés usar las flechas del teclado sobre un bloque. En celulares se apilan para mantener la lectura.</p>
          <div className="banner-block-controls"><label className="field"><span>Bloque a ubicar</span><select value={selectedBlock} onChange={event => setSelectedBlock(event.target.value as HeroBlock)}>{Object.entries(blockLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            {([['x', 'Posición horizontal'], ['y', 'Posición vertical'], ['width', 'Ancho del bloque']] as const).map(([key, label]) => <label className="field" key={key}><span>{label} · {position[key]}%</span><input type="range" aria-label={label} min={key === 'width' ? 20 : 0} max="100" step="1" value={position[key]} onChange={event => updateLayout({ ...layout, [selectedBlock]: { ...position, [key]: Number(event.target.value) } })}/></label>)}
          </div></>}
      </>}
      {value.heroContentVisible === false && <p>{value.coverId ? 'Se mostrará la portada completa, sin textos ni botón. Los textos quedan guardados para volver a usarlos.' : 'Elegí una portada para mostrarla sola. Mientras tanto, se verá el color de fondo.'}</p>}
    </div>
    </div><aside className="appearance-preview-panel"><div className="catalog-preview-toolbar"><h3>Vista previa de tu tienda</h3><div className="catalog-preview-devices" role="group" aria-label="Dispositivo de vista previa"><button type="button" aria-pressed={!mobile} onClick={() => setMobile(false)}>Escritorio</button><button type="button" aria-pressed={mobile} onClick={() => setMobile(true)}>Celular</button></div></div>
    <div className={`catalog-preview-shell ${mobile ? 'is-mobile' : ''}`}><CatalogDesignPreview value={value} brandName={brandName} assets={assets} mobile={mobile} editing={editing} disabled={disabled} selectedBlock={selectedBlock} onSelectBlock={setSelectedBlock} onLayoutChange={updateLayout}/></div>
    <p className="catalog-preview-note">Vista previa con fichas de tu catálogo · Guardá la configuración para aplicar el diseño a tu tienda.</p></aside></div>;
}
