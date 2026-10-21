import { useEffect, useRef, useState } from 'react';
import { command, imageBlob, query, studioFetch } from './api';
import { renderStory, type StorySettings, type StorySnapshot } from './storyRenderer';
import type { Product } from './types';
import { reportExport } from './exportEvents';
import { PromotionFields, defaultPromotion } from './PromotionFields';

export function StoryEditor({ product, onBack }: { product: Product; onBack: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null), selectedImage = product.images.find(image => image.id === product.coverImageId)!;
  const [settings, setSettings] = useState<StorySettings>({ templateId: 'available', templateVersion: 1, imageId: selectedImage.id,
    expectedImageRevision: selectedImage.revision, skuIds: product.variants.filter(item => item.active && item.identityReviewed && (item.stockAvailable ?? 0) > 0).map(item => item.skuId),
    showPrice: true, fit: 'contain', zoom: 1, focalX: selectedImage.focalX, focalY: selectedImage.focalY, caption: '', cta: 'CONSULTANOS POR WHATSAPP' });
  const [format, setFormat] = useState<'png' | 'jpeg'>('png'), [snapshot, setSnapshot] = useState<StorySnapshot | null>(null), [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [checkedAt, setCheckedAt] = useState('');
  useEffect(() => { setBlob(null); setSnapshot(null); setCheckedAt(''); }, [settings, format]);
  const check = async (id: string) => {
    const data = await (await studioFetch(`/story-snapshots/${id}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!data.valid) { setBlob(null); throw new Error('Cambiaron los datos del producto. Volvé a la ficha, revisá el stock y generá una nueva historia.'); }
    setCheckedAt(data.checkedAt); return data;
  };
  const generate = async () => {
    setBusy(true); setError(''); setBlob(null);
    try {
      const current = await query<Product>(`/products/${product.id}`);
      if (current.revision !== product.revision) throw new Error('La ficha cambió. Volvé para cargar los datos actuales.');
      const prepared = await command<StorySnapshot>(`/products/${product.id}/story-snapshots`, 'POST', { expectedProductRevision: product.revision, settings });
      const photo = await imageBlob(product.id, settings.imageId);
      const rendered = await renderStory(canvasRef.current!, prepared, photo, format);
      await check(prepared.snapshotId); setSnapshot(prepared); setBlob(rendered);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No pude generar la historia.'); } finally { setBusy(false); }
  };
  const filename = `${product.slug}-${settings.templateId}-${new Date().toISOString().slice(0, 10)}-${snapshot?.snapshotId.slice(0, 8) ?? 'preview'}.${format === 'jpeg' ? 'jpg' : 'png'}`;
  const finalAction = async (share = false) => {
    if (!snapshot || !blob) return; setBusy(true); setError('');
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
  return <section className="page-section story-editor"><button className="back" onClick={onBack}>← Volver a la ficha</button><div className="section-heading"><div><p className="eyebrow dark">TU PRODUCTO, LISTO PARA COMPARTIR</p><h1>Generar historia</h1></div><span className="muted">1080 × 1920</span></div>
    {error && <div role="alert" className="notice">{error}</div>}<div className="story-layout"><div className="story-controls panel"><fieldset disabled={busy}><h2>Elegí tu presentación</h2><p className="control-help">{product.availableQuantity === 1 ? "Sugerencia: Última unidad, porque queda una sola disponible." : "Sugerencia: Stock disponible, según el inventario actual."} <button type="button" onClick={() => patch({ templateId: product.availableQuantity === 1 ? "last_unit" : "available", promotion: null })}>Usar sugerencia</button></p><label className="field"><span>Plantilla</span><select aria-label="Plantilla" value={settings.templateId} onChange={event => patch({ templateId: event.target.value, promotion: event.target.value === 'promo' ? settings.promotion ?? defaultPromotion() : null })}><option value="arrival">Nuevo ingreso</option><option value="available">Stock disponible</option><option value="last_unit">Última unidad</option>{(product.teamKey || settings.templateId === 'matchday') && <option value="matchday">Deportiva · Día de fútbol</option>}<option value="promo">Promoción</option></select></label>{settings.promotion && <PromotionFields promotion={settings.promotion} onChange={promotion => patch({ promotion })}/>}<p className="control-help">Diseños de Stocky Studio con el logo y los colores de tu configuración. «Nuevo ingreso» es una selección editorial. «Última unidad» se valida contra el stock actual.</p><label className="field"><span>Fotografía</span><select aria-label="Fotografía" value={settings.imageId} onChange={event => { const image = product.images.find(item => item.id === event.target.value)!; patch({ imageId: image.id, expectedImageRevision: image.revision, focalX: image.focalX, focalY: image.focalY }); }}>{product.images.filter(image => image.status === 'ready').map((image, index) => <option key={image.id} value={image.id}>Foto {index + 1}{image.id === product.coverImageId ? ' · Portada' : ''}</option>)}</select></label>
      <div className="story-sizes"><span>Presentaciones que querés mostrar</span><div className="sizes">{product.variants.filter(item => item.active && item.identityReviewed && (item.stockAvailable ?? 0) > 0).map(item => <label key={item.skuId}><input type="checkbox" checked={settings.skuIds.includes(item.skuId)} onChange={event => patch({ skuIds: event.target.checked ? [...settings.skuIds, item.skuId] : settings.skuIds.filter(id => id !== item.skuId) })}/>{item.label || item.size || item.name}</label>)}</div></div>
      <label className="checkbox-field"><input type="checkbox" checked={settings.showPrice} onChange={event => patch({ showPrice: event.target.checked })}/> Mostrar precio</label><label className="field"><span>Encuadre</span><select aria-label="Encuadre" value={settings.fit} onChange={event => patch({ fit: event.target.value as StorySettings['fit'] })}><option value="contain">Foto completa</option><option value="cover">Llenar el espacio</option></select></label>
      {([['zoom', 'Acercamiento', 1, 2], ['focalX', 'Posición horizontal', 0, 1], ['focalY', 'Posición vertical', 0, 1]] as const).map(([key, label, min, max]) => <label className="field" key={key}><span>{label}</span><input type="range" min={min} max={max} step="0.01" value={settings[key]} onChange={event => patch({ [key]: Number(event.target.value) })}/></label>)}
      <label className="field"><span>Mensaje secundario</span><input maxLength={100} value={settings.caption} onChange={event => patch({ caption: event.target.value })} placeholder="La pasión se lleva puesta"/></label><label className="field"><span>Llamada a la acción</span><input maxLength={50} value={settings.cta} onChange={event => patch({ cta: event.target.value })}/></label><label className="field"><span>Formato de descarga</span><select aria-label="Formato de descarga" value={format} onChange={event => setFormat(event.target.value as 'png' | 'jpeg')}><option value="png">PNG · máxima calidad</option><option value="jpeg">JPG · archivo más liviano</option></select></label>
      <button className="primary" disabled={!settings.skuIds.length} onClick={() => void generate()}>{busy ? 'Generando…' : 'Generar previsualización'}</button></fieldset></div><div className="story-preview"><div className={`canvas-frame ${blob ? 'ready' : ''}`}><canvas ref={canvasRef} aria-label="Previsualización de historia 1080 por 1920"/>{!blob && <div className="canvas-placeholder"><BrandMini/><p>{busy ? 'Preparando tu historia…' : 'Tu próxima historia, acá.'}</p><small>Elegí el diseño y generá la previsualización.</small></div>}</div><div className="export-actions"><button className="primary" disabled={busy || !blob} onClick={() => void finalAction()}>Descargar {format === 'jpeg' ? 'JPG' : 'PNG'} ↓</button>{typeof navigator.share === 'function' && <button disabled={busy || !blob} onClick={() => void finalAction(true)}>Compartir ↗</button>}</div>{checkedAt && <small>Datos revisados a las {new Date(checkedAt).toLocaleTimeString('es-UY')}.</small>}<p className="control-help">La imagen descargada es estática. Una venta posterior puede cambiar la disponibilidad. La historia no reserva unidades.</p></div></div></section>;
}
function BrandMini() { return <strong className="mini-brand">S<span>／</span></strong>; }
