import { useEffect, useState } from 'react';
import { query, studioFetch } from './api';
import { renderAutoStory, type AutoStoryPayload } from './autoStoryRender';

const route = '/automatic-stories';
type Attempt = { id: string; status: string; error_code?: string; product_id?: string; title?: string;
  created_at: string; published_at?: string };
type Settings = { ready: boolean; enabled: boolean; connection: string; instagramId?: string; instagramUsername?: string; nextAttempt?: string;
  lastPublished: Attempt | null; history: Attempt[] };
const connections: Record<string, string> = { not_configured: 'Sin configurar', pending: 'Pendiente de verificación',
  connected: 'Conectada', expired: 'Vencida', revoked: 'Revocada', error: 'Error de conexión' };
const states: Record<string, string> = { rendering: 'Renderizando', ready: 'Imagen lista', creating: 'Preparando en Meta',
  publishing: 'Publicando', published: 'Publicada', skipped: 'Omitida', failed: 'Fallida', unknown: 'Resultado incierto' };
const date = (value: string) => new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short',
  timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(value));
const put = (path: string, payload: unknown) => studioFetch(path, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

export function AutomaticStories({ owner, onOpen }: { owner: boolean; onOpen: (id: string) => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [preview, setPreview] = useState<Blob>();
  const [url, setUrl] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(false);
  const refresh = async () => setSettings(await query<Settings>(route));
  useEffect(() => { void refresh().catch(error => setNotice(error.message)); }, []);
  useEffect(() => {
    if (!preview) { setUrl(''); return; }
    const current = URL.createObjectURL(preview);
    setUrl(current);
    return () => URL.revokeObjectURL(current);
  }, [preview]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : 'No pude completar la operación.'); }
    finally { setBusy(false); }
  }
  async function configure(enabled: boolean, verifyBusiness = false) {
    try { await put(route, { enabled, verifyBusiness }); }
    finally { await refresh(); }
  }
  async function simulate() {
    setPreview(undefined);
    const data: AutoStoryPayload | { status: 'skipped' } = await (await studioFetch(route + '/simulate', { method: 'POST' })).json();
    if (data.status === 'skipped') { setNotice('No hay productos con ficha lista, foto y stock con precio.'); return; }
    setPreview(await renderAutoStory(data));
  }
  return <section className="page-section">
    <h1>Historias automáticas</h1>
    {notice && <p role="status">{notice}</p>}
    {!settings && !notice && <p>Cargando configuración…</p>}
    {settings && !settings.ready && <p>Falta aplicar la migración de historias automáticas.</p>}
    {settings?.ready && <>
      <div className="panel">
        <p>Instagram · {connections[settings.connection]} {settings.instagramUsername && <small>@{settings.instagramUsername}</small>}</p>
        <p>Automatización · {settings.enabled ? 'Activada' : 'Desactivada'}</p>
        {settings.nextAttempt && <p>Próximo intento previsto · {date(settings.nextAttempt)} (Argentina)</p>}
        {owner && settings.connection !== 'not_configured' && settings.connection !== 'connected' && <>
          <label><input type="checkbox" checked={verify} onChange={event => setVerify(event.target.checked)}/> Confirmo que la cuenta configurada es Business y autorizo su conexión.</label>
          <button type="button" disabled={busy || !verify} onClick={() => void run(() => configure(false, true))}>Verificar conexión</button>
        </>}
        {owner && (settings.connection === 'connected' || settings.enabled) &&
          <button type="button" disabled={busy} onClick={() => void run(() => configure(!settings.enabled))}>
            {settings.enabled ? 'Desactivar' : 'Autorizar y activar publicación automática'}
          </button>}
        <button type="button" disabled={busy} onClick={() => void run(simulate)}>Simular historia</button>
        {url && <p><img src={url} alt="Vista previa de la historia simulada" width="216" height="384"/></p>}
      </div>
      <div className="panel">
        <h2>Última publicación confirmada</h2>
        {settings.lastPublished?.published_at
          ? <p>{settings.lastPublished.title} · {date(settings.lastPublished.published_at)}</p> : <p>Todavía no hay publicaciones confirmadas.</p>}
        <h2>Historial de intentos</h2>
        <button type="button" disabled={busy} onClick={() => void run(refresh)}>Actualizar historial</button>
        {settings.history.length ? <ul>{settings.history.map(attempt => <li key={attempt.id}>
          {date(attempt.created_at)} · {states[attempt.status]}
          {attempt.product_id && <> · <button type="button" onClick={() => onOpen(attempt.product_id!)}>{attempt.title}</button></>}
          {attempt.error_code && <> · <code>{attempt.error_code}</code></>}
        </li>)}</ul> : <p>Todavía no hay intentos programados.</p>}
      </div>
    </>}
  </section>;
}

export function AutomaticStoryProductPreference({ id }: { id: string }) {
  const [enabled, setEnabled] = useState<boolean>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const path = `${route}/products/${id}`;
  useEffect(() => {
    const controller = new AbortController();
    void query<{ enabled?: boolean }>(path, controller.signal).then(result => setEnabled(result.enabled)).catch(() => {});
    return () => controller.abort();
  }, [path]);
  if (enabled === undefined) return null;
  return <div>
    <label><input type="checkbox" checked={enabled} disabled={saving} onChange={async event => {
      const next = event.target.checked;
      setSaving(true);
      setError('');
      try { await put(path, { enabled: next }); setEnabled(next); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'No pude guardar la preferencia.'); }
      finally { setSaving(false); }
    }}/> Incluir en historias automáticas</label>
    {error && <p role="status">{error}</p>}
  </div>;
}
