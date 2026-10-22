import { useEffect, useRef, useState } from 'react';
import { command, imageBlob, query, studioFetch } from './api';
import { renderStory, type StorySettings, type StorySnapshot } from './storyRenderer';
import { textOnColor, type Product, type Profile } from './types';
import { reportExport } from './exportEvents';
import { PromotionFields, defaultPromotion } from './PromotionFields';

export function StoryEditor({ product, onBack }: { product: Product; onBack: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null), selectedImage = product.images.find(image => image.id === product.coverImageId)!;
  const [settings, setSettings] = useState<StorySettings>({ templateId: 'available', templateVersion: 1, imageId: selectedImage.id,
    expectedImageRevision: selectedImage.revision, skuIds: product.variants.filter(item => item.active && item.identityReviewed && (item.stockAvailable ?? 0) > 0).map(item => item.skuId),
    showPrice: true, fit: 'contain', zoom: 1, focalX: selectedImage.focalX, focalY: selectedImage.focalY, caption: '', cta: 'CONSULTANOS POR WHATSAPP' });
  const [format, setFormat] = useState<'png' | 'jpeg'>('png'), [snapshot, setSnapshot] = useState<StorySnapshot | null>(null), [blob, setBlob] = useState<Blob | null>(null);
  const [generatedKey, setGeneratedKey] = useState(''), [previewExpanded, setPreviewExpanded] = useState(false), [thumbnail, setThumbnail] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const settingsKey = JSON.stringify({ settings, format }), pendingPreview = generatedKey !== settingsKey;
  useEffect(() => { let active = true; void query<Profile>('/profile').then(value => { if (active) setProfile(value); }).catch(() => {}); return () => { active = false; }; }, []);
  useEffect(() => { let active = true, url = ''; setThumbnail(''); void imageBlob(product.id, settings.imageId).then(photo => { if (active) { url = URL.createObjectURL(photo); setThumbnail(url); } }).catch(() => {}); return () => { active = false; if (url) URL.revokeObjectURL(url); }; }, [product.id, settings.imageId]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [checkedAt, setCheckedAt] = useState('');
  const check = async (id: string) => {
    const data = await (await studioFetch(`/story-snapshots/${id}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!data.valid) { setGeneratedKey(''); setSnapshot(null); throw new Error('Cambiaron los datos del producto. Volvé a la ficha, revisá el stock y generá una nueva historia.'); }
    setCheckedAt(data.checkedAt); return data;
  };
  const generate = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const current = await query<Product>(`/products/${product.id}`);
      if (current.revision !== product.revision) throw new Error('La ficha cambió. Volvé para cargar los datos actuales.');
      const prepared = await command<StorySnapshot>(`/products/${product.id}/story-snapshots`, 'POST', { expectedProductRevision: product.revision, settings });
      const photo = await imageBlob(product.id, settings.imageId);
      const rendered = await renderStory(canvasRef.current!, prepared, photo, format);
      await check(prepared.snapshotId); setSnapshot(prepared); setBlob(rendered); setGeneratedKey(settingsKey);
    } catch (cause) { setGeneratedKey(''); setSnapshot(null); setError(cause instanceof Error ? cause.message : 'No pude generar la historia.'); } finally { setBusy(false); }
  };
  const filename = `${product.slug}-${settings.templateId}-${new Date().toISOString().slice(0, 10)}-${snapshot?.snapshotId.slice(0, 8) ?? 'preview'}.${format === 'jpeg' ? 'jpg' : 'png'}`;
  const finalAction = async (share = false) => {
    if (!snapshot || !blob || pendingPreview || busy) return; setBusy(true); setError('');
    try {
      await check(snapshot.snapshotId);
      await reportExport(snapshot, blob, filename, share ? 'share_requested' : 'download_requested');
      await check(snapshot.snapshotId);
      const file = new File([blob], filename, { type: blob.type });
      if (share && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: product.title });
      else { const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 20_000); }
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'No pude descargar la historia.'); }
    finally { setBusy(false); }
  };
  const patch = (change: Partial<StorySettings>) => setSettings(current => ({ ...current, ...change }));
  const templates = [
    { id: 'arrival', label: 'Nuevo ingreso', note: 'Presentá una novedad' },
    { id: 'available', label: 'Stock disponible', note: 'Disponibilidad actual' },
    { id: 'last_unit', label: 'Última unidad', note: 'Se valida contra el stock' },
    ...(product.teamKey || settings.templateId === 'matchday' ? [{ id: 'matchday', label: 'Deportiva · Día de fútbol', note: 'Para esta colección' }] : []),
    { id: 'promo', label: 'Promoción', note: 'Con condiciones y vigencia' },
  ];
  const chooseTemplate = (templateId: string) => patch({ templateId, promotion: templateId === 'promo' ? settings.promotion ?? defaultPromotion() : null });
  return <section className="page-section story-editor">
    <button className="back" disabled={busy} onClick={onBack}>← Volver a la ficha</button>
    <div className="section-heading"><div><h1>Generar historia</h1><p className="muted">{product.title}</p></div><span className="muted">1080 × 1920</span></div>
    {error && <div role="alert" className="notice">{error}</div>}
    <div className="story-layout">
      <div className="story-controls panel"><fieldset disabled={busy}>
        <h2>Diseño y contenido</h2>
        <label className="field"><span>Plantilla</span><select aria-label="Plantilla" value={settings.templateId} onChange={event => chooseTemplate(event.target.value)}>{templates.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
        <details className="template-browser"><summary>Comparar diseños</summary><p className="control-help">Muestras de composición. Generá la previsualización para revisar el resultado con tus datos.</p><div className="template-options" role="group" aria-label="Diseños disponibles">{templates.map(template => <button type="button" key={template.id} aria-pressed={settings.templateId === template.id} onClick={() => chooseTemplate(template.id)}>
          <span className={`template-mini template-${template.id}`} aria-hidden="true" style={{ backgroundColor: profile?.appearance?.primaryColor ?? '#001A4D', color: textOnColor(profile?.appearance?.primaryColor ?? '#001A4D') }}>
            {thumbnail && <img src={thumbnail} alt=""/>}<span>{template.id === 'promo' ? '%' : template.id === 'last_unit' ? '1' : template.label}</span>
          </span><strong>{template.label}</strong><small>{template.note}</small>
        </button>)}</div></details>
        <p className="control-help">{product.availableQuantity === 1 ? 'Sugerencia: Última unidad, porque queda una sola disponible.' : 'Sugerencia: Stock disponible, según el inventario actual.'} <button type="button" className="inline-action" onClick={() => chooseTemplate(product.availableQuantity === 1 ? 'last_unit' : 'available')}>Usar sugerencia</button></p>
        {settings.promotion && <PromotionFields promotion={settings.promotion} onChange={promotion => patch({ promotion })}/>}
        <label className="field"><span>Fotografía</span><select aria-label="Fotografía" value={settings.imageId} onChange={event => { const image = product.images.find(item => item.id === event.target.value)!; patch({ imageId: image.id, expectedImageRevision: image.revision, focalX: image.focalX, focalY: image.focalY }); }}>{product.images.filter(image => image.status === 'ready').map((image, index) => <option key={image.id} value={image.id}>Foto {index + 1}{image.id === product.coverImageId ? ' · Portada' : ''}</option>)}</select></label>
        <div className="story-sizes"><span>Presentaciones que querés mostrar</span><div className="sizes">{product.variants.filter(item => item.active && item.identityReviewed && (item.stockAvailable ?? 0) > 0).map(item => <label key={item.skuId}><input type="checkbox" checked={settings.skuIds.includes(item.skuId)} onChange={event => patch({ skuIds: event.target.checked ? [...settings.skuIds, item.skuId] : settings.skuIds.filter(id => id !== item.skuId) })}/>{item.label || item.size || item.name}</label>)}</div></div>
        <label className="checkbox-field"><input type="checkbox" checked={settings.showPrice} onChange={event => patch({ showPrice: event.target.checked })}/> Mostrar precio</label>
        <details className="story-adjustments"><summary>Encuadre y posición</summary>
          <label className="field"><span>Encuadre</span><select aria-label="Encuadre" value={settings.fit} onChange={event => patch({ fit: event.target.value as StorySettings['fit'] })}><option value="contain">Foto completa</option><option value="cover">Llenar el espacio</option></select></label>
          {([['zoom', 'Acercamiento', 1, 2], ['focalX', 'Posición horizontal', 0, 1], ['focalY', 'Posición vertical', 0, 1]] as const).map(([key, label, min, max]) => <label className="field" key={key}><span>{label}</span><input type="range" min={min} max={max} step="0.01" value={settings[key]} onChange={event => patch({ [key]: Number(event.target.value) })}/></label>)}
        </details>
        <label className="field"><span>Mensaje secundario</span><input maxLength={100} value={settings.caption} onChange={event => patch({ caption: event.target.value })} placeholder="Un detalle para destacar de tu producto"/></label>
        <label className="field"><span>Llamada a la acción</span><input maxLength={50} value={settings.cta} onChange={event => patch({ cta: event.target.value })}/></label>
      </fieldset></div>
      <div className={`story-preview ${previewExpanded ? 'is-expanded' : ''}`}>
        <div id="story-preview-canvas" className={`canvas-frame ${blob ? 'ready' : ''}`}><canvas ref={canvasRef} aria-label="Previsualización de historia 1080 por 1920"/>{!blob && <div className="canvas-placeholder"><BrandMini/><p>{busy ? 'Preparando tu historia…' : 'Tu historia, acá.'}</p><small>Elegí un diseño y generá la previsualización.</small></div>}</div>
        <div className="preview-actions">
          <button type="button" className="preview-expand" aria-expanded={previewExpanded} aria-controls="story-preview-canvas" onClick={() => setPreviewExpanded(value => !value)}>{previewExpanded ? 'Vista compacta' : 'Ver historia completa'}</button>
          <p role="status" className="preview-state">{busy ? 'Generando y revisando datos…' : blob && pendingPreview ? 'Cambios sin aplicar. Regenerá para descargar.' : blob ? 'Previsualización lista para descargar.' : 'El diseño usa la marca y los colores de tu negocio.'}</p>
          <button className="primary story-generate" disabled={busy || !settings.skuIds.length} onClick={() => void generate()}>{busy ? 'Generando…' : 'Generar previsualización'}</button>
          <label className="field"><span>Formato de descarga</span><select disabled={busy} aria-label="Formato de descarga" value={format} onChange={event => setFormat(event.target.value as 'png' | 'jpeg')}><option value="png">PNG · máxima calidad</option><option value="jpeg">JPG · archivo más liviano</option></select></label>
          <div className="export-actions"><button disabled={busy || !blob || pendingPreview || !snapshot} onClick={() => void finalAction()}>Descargar {format === 'jpeg' ? 'JPG' : 'PNG'} ↓</button>{typeof navigator.share === 'function' && <button disabled={busy || !blob || pendingPreview || !snapshot} onClick={() => void finalAction(true)}>Compartir ↗</button>}</div>
          {checkedAt && !pendingPreview && <small>Datos revisados a las {new Date(checkedAt).toLocaleTimeString('es-UY')}.</small>}
          <p className="control-help">La historia es una imagen estática. La disponibilidad se revisa antes de descargar y no se reservan unidades.</p>
        </div>
      </div>
    </div>
  </section>;
}

function BrandMini() { return <strong className="mini-brand">S<span>／</span></strong>; }
