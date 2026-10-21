import { useEffect, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import { batchKey, createBatchJob, readBatchJob, saveBatchJob, type BatchJob, type BatchOptions, type BatchItem } from './batchJob';
import { commandWithId, imageBlob, query, studioFetch } from './api';
import { renderStory, type StorySettings, type StorySnapshot } from './storyRenderer';
import { PromotionFields, defaultPromotion } from './PromotionFields';
import { reportExport } from './exportEvents';
import type { Product } from './types';

const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'No pude completar esta historia.';
type Generated = { snapshot: StorySnapshot; blob: Blob; filename: string };
export function BatchStudio({ onBack }: { onBack: () => void }) {
  const [job, setJob] = useState<BatchJob | null>(readBatchJob), [busy, setBusy] = useState(false), [error, setError] = useState(''), [zip, setZip] = useState<Blob | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null), cancelled = useRef(false), mounted = useRef(true), files = useRef<Generated[]>([]), storageKey = useRef(batchKey());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; files.current = []; }; }, []);
  const persist = (next: BatchJob) => { saveBatchJob(next, storageKey.current); if (mounted.current) setJob({ ...next, items: [...next.items] }); };
  const updateOptions = (options: BatchOptions) => {
    if (!job) return;
    if (job.items.some(item => item.request) && !confirm('Cambiar el diseño crea nuevos intentos con datos actuales. ¿Actualizar el lote?')) return;
    const next = createBatchJob(job.items.map(item => item.productId), options); setJob(next); setZip(null); files.current = [];
  };
  const validate = async (snapshotId: string) => {
    const result = await (await studioFetch(`/story-snapshots/${snapshotId}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!result.valid) throw new Error('Cambiaron los datos o venció la historia. Actualizá el lote antes de exportar.');
  };
  const generate = async () => {
    if (!job || busy) return; cancelled.current = false; setBusy(true); setError(''); setZip(null); files.current = [];
    const working: BatchJob = structuredClone(job); let size = 0;
    try {
      for (let index = 0; index < working.items.length; index++) {
        if (cancelled.current) break; const item = working.items[index];
        try {
          item.error = undefined;
          if (!item.request) {
            const product = await query<Product>(`/products/${item.productId}`); if (cancelled.current) break;
            if (!product.readiness.canGenerateStory) throw new Error('La ficha necesita revisión o no tiene stock disponible.');
            const image = product.images.find(photo => photo.id === product.coverImageId && photo.status === 'ready')!;
            let variants = product.variants.filter(variant => variant.active && variant.identityReviewed && (variant.stockAvailable ?? 0) > 0);
            if (working.options.templateId === 'last_unit' && product.availableQuantity !== 1) variants = variants.filter(variant => variant.stockAvailable === 1).slice(0, 1);
            if (!variants.length) throw new Error('Esta ficha no tiene una última unidad disponible.');
            const settings: StorySettings = { templateId: working.options.templateId, templateVersion: 1, imageId: image.id, expectedImageRevision: image.revision,
              skuIds: variants.map(variant => variant.skuId), showPrice: working.options.showPrice, fit: 'contain', zoom: 1, focalX: image.focalX, focalY: image.focalY,
              caption: '', cta: 'PEDILA POR WHATSAPP', promotion: working.options.promotion ?? null };
            item.title = product.title; item.request = { expectedProductRevision: product.revision, settings };
            persist(working); // Durable operation/request before any command can reach the backend.
          }
          const snapshot = item.snapshotId ? await query<StorySnapshot>(`/story-snapshots/${item.snapshotId}`)
            : await commandWithId<StorySnapshot>(`/products/${item.productId}/story-snapshots`, 'POST', item.operationId, item.request);
          if (cancelled.current) break;
          item.snapshotId = snapshot.snapshotId; item.status = 'prepared'; persist(working);
          await validate(snapshot.snapshotId); if (cancelled.current) break;
          const photo = await imageBlob(item.productId, snapshot.content.imageId); if (cancelled.current) break;
          const blob = await renderStory(canvas.current!, snapshot, photo, working.options.format); if (cancelled.current) break;
          await validate(snapshot.snapshotId);
          if (size + blob.size > MAX_BATCH_BYTES) throw new Error('El lote supera 32 MB. Exportá menos fichas o elegí JPG.');
          size += blob.size;
          const name = snapshot.content.title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 70).replace(/^-|-$/g, '') || 'producto';
          const filename = `${String(index + 1).padStart(2, '0')}-${name}-${snapshot.content.settings.templateId}-${snapshot.snapshotId.slice(0, 8)}.${working.options.format === 'jpeg' ? 'jpg' : 'png'}`;
          files.current.push({ snapshot, blob, filename }); item.status = 'generated'; persist(working);
        } catch (cause) { if (cancelled.current) break; item.status = 'failed'; item.error = errorText(cause); persist(working); }
      }
      if (cancelled.current || !mounted.current) return;
      if (working.items.some(item => item.status !== 'generated') || files.current.length !== working.items.length) return;
      const entries: Record<string, Uint8Array> = Object.create(null);
      for (const file of files.current) { await validate(file.snapshot.snapshotId); entries[file.filename] = new Uint8Array(await file.blob.arrayBuffer()); }
      const bytes = zipSync(entries, { level: 0 });
      if (!cancelled.current && mounted.current) setZip(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (canvas.current) { canvas.current.width = 1; canvas.current.height = 1; } if (mounted.current) setBusy(false); }
  };
  const download = async () => {
    if (!job || !zip || busy) return; setBusy(true); setError('');
    try {
      for (const file of files.current) await validate(file.snapshot.snapshotId);
      for (const file of files.current) await reportExport(file.snapshot, file.blob, file.filename, 'download_requested');
      for (const file of files.current) await validate(file.snapshot.snapshotId);
      const url = URL.createObjectURL(zip), anchor = document.createElement('a'); anchor.href = url; anchor.download = `stocky-historias-${new Date().toISOString().slice(0, 10)}-${job.batchId.slice(0, 8)}.zip`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 20_000);
      persist({ ...job, lastDownloadRequestedAt: new Date().toISOString() });
    } catch (cause) { setError(errorText(cause)); setZip(null); }
    finally { if (mounted.current) setBusy(false); }
  };
  if (!job) return <section className="page-section"><h1>No hay un lote activo</h1><p>Seleccioná productos desde Productos para comenzar.</p><button onClick={onBack}>Volver a productos</button></section>;
  const completed = job.items.filter(item => item.status === 'generated').length;
  const reset = () => { const next = createBatchJob(job.items.map(item => item.productId), job.options); setJob(next); setZip(null); files.current = []; setError(''); };
  return <section className="page-section batch-studio"><button className="back" onClick={onBack}>← Volver a productos</button><div className="section-heading"><div><p className="eyebrow dark">MÁS CONTENIDO, MENOS TRABAJO</p><h1>Historias por lote</h1></div><span className="batch-count">{completed} / {job.items.length}</span></div><p>Una historia por producto. Los datos se revisan antes de generar y de descargar el ZIP.</p>{error && <div className="notice" role="alert">{error}</div>}
    <div className="batch-layout"><div className="panel batch-options"><fieldset disabled={busy}><h2>Un diseño para tu selección</h2><label className="field"><span>Plantilla del lote</span><select aria-label="Plantilla del lote" value={job.options.templateId} onChange={event => updateOptions({ ...job.options, templateId: event.target.value, promotion: event.target.value === 'promo' ? job.options.promotion ?? defaultPromotion() : null })}><option value="available">Stock disponible</option><option value="arrival">Nuevo ingreso</option><option value="last_unit">Última unidad</option><option value="matchday">Día de fútbol</option><option value="promo">Promoción</option></select></label><label className="field"><span>Formato del lote</span><select aria-label="Formato del lote" value={job.options.format} onChange={event => updateOptions({ ...job.options, format: event.target.value as 'png' | 'jpeg' })}><option value="jpeg">JPG · más liviano</option><option value="png">PNG · máxima calidad</option></select></label><label className="checkbox-field"><input type="checkbox" checked={job.options.showPrice} onChange={event => updateOptions({ ...job.options, showPrice: event.target.checked })}/> Mostrar precios</label>{job.options.promotion && <PromotionFields promotion={job.options.promotion} onChange={promotion => updateOptions({ ...job.options, promotion })}/>}<button className="primary" onClick={() => void generate()}>{busy ? 'Generando lote…' : completed ? 'Reconstruir y validar lote' : 'Generar lote'}</button><button className="text-button" onClick={reset}>Actualizar datos y reiniciar intentos</button></fieldset><small>Hasta 20 fichas y 32 MB por ZIP. El proceso usa un solo Canvas y conserva su progreso en este navegador.</small></div><div className="batch-progress"><div className="batch-progress-heading"><h2>Tu selección</h2>{busy && <button onClick={() => { cancelled.current = true; }}>Detener después de la historia actual</button>}</div><progress value={completed} max={job.items.length} aria-label="Progreso del lote"/>{job.items.map((item, index) => <div className={`batch-item ${item.status}`} key={item.operationId}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{item.title ?? 'Ficha seleccionada'}</strong><small>{item.error ?? ({ pending: 'Pendiente', prepared: 'Datos preparados', generated: 'Imagen generada', failed: 'Revisar esta ficha' }[item.status])}</small></div><b>{item.status === 'generated' ? '✓' : item.status === 'failed' ? '!' : '·'}</b></div>)}{job.items.some(item => item.status === 'failed') && <button disabled={busy} onClick={() => { const items: BatchItem[] = job.items.filter(item => item.status !== 'failed'); if (!items.length) { setError('No quedan fichas válidas. Volvé a elegir productos o cambiá la plantilla.'); return; } persist({ ...job, items }); setZip(null); }}>Quitar fallidas y continuar</button>}<div className="batch-download"><button className="primary" disabled={busy || !zip} onClick={() => void download()}>Descargar lote ZIP ↓</button>{zip && <small>{job.items.length} historias · {(zip.size / 1024 / 1024).toFixed(1)} MB</small>}{job.lastDownloadRequestedAt && <small>Descarga solicitada a las {new Date(job.lastDownloadRequestedAt).toLocaleTimeString('es-UY')}.</small>}</div></div></div><canvas ref={canvas} className="batch-render-canvas" aria-hidden="true"/></section>;
}
