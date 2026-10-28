import { useEffect, useState } from 'react';
import { fetchUniversalOperationDetail, type UniversalOperationDetail } from '../../services/universalDraftService';
import { toUserFacingError } from '../../services/apiClient';
import { useAuth } from '../../store/AuthStore';
import { StockyLogo } from '../brand/StockyLogo';
import { ThemeToggle } from './ThemeToggle';

export function OperationDetailPage({ id }: { id: string }) {
  const { session, logout } = useAuth();
  const [detail, setDetail] = useState<UniversalOperationDetail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setDetail(null); setError('');
    fetchUniversalOperationDetail(id).then(value => { if (active) setDetail(value); }).catch(cause => {
      if (!active) return;
      const status = (cause as { status?: number })?.status;
      setError(status === 404 || status === 403 ? 'No encontré esta operación para tu cuenta. Ingresá con el mismo número que usaste en WhatsApp.'
        : status === 409 ? 'El detalle estará disponible cuando la operación esté confirmada.' : toUserFacingError(cause));
    });
    return () => { active = false; };
  }, [id, attempt]);

  const panelUrl = new URL(location.href); panelUrl.searchParams.delete('operation'); panelUrl.searchParams.set('section', 'actividad'); panelUrl.hash = '';
  return <main className="mx-auto min-h-screen max-w-4xl px-4 py-6 text-[color:var(--text)] sm:px-6">
    <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <a href={panelUrl.href} aria-label="Abrir Stocky"><StockyLogo size="md"/></a>
      <div className="flex items-center gap-3"><span className="text-sm text-[color:var(--muted)]">{session?.businessName}</span><ThemeToggle/><button className="erp-button-secondary" onClick={logout}>Cerrar sesión</button></div>
    </header>
    <a className="erp-accent-text inline-flex min-h-11 items-center text-sm" href={panelUrl.href}>← Volver a movimientos</a>
    <h1 className="type-title mt-3 text-2xl sm:text-3xl">Detalle de la operación</h1>
    {!detail && !error && <p className="mt-6" role="status">Cargando el detalle completo…</p>}
    {error && <div className="erp-panel mt-6" role="alert"><p>{error}</p><button className="erp-button-secondary mt-4" onClick={() => setAttempt(value => value + 1)}>Reintentar</button></div>}
    {detail && <div className="mt-6 space-y-6">
      <section className="erp-panel">
        <h2 className="type-title text-lg">Cambios guardados</h2>
        <p className="mt-2 text-sm text-[color:var(--muted)]">Este es el resultado de esa carga. Los saldos corresponden al momento en que se confirmó.</p>
        <ul className="mt-4 space-y-3">{detail.changes.map((line, index) => <li key={index} className="break-words border-b border-[color:var(--border)] pb-3 text-sm leading-6 last:border-0 last:pb-0">{line}</li>)}</ul>
      </section>
      <section className="erp-panel"><h2 className="type-title text-lg">Solicitud</h2><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{detail.text}</p></section>
      <section className="erp-panel"><h2 className="type-title text-lg">Revisión completa</h2>
        <div className="mt-4 divide-y divide-[color:var(--border)]">{detail.review.map(item => <article key={item.itemId} className="py-4 first:pt-0 last:pb-0">
          <h3 className="type-subtitle break-words">{item.title}</h3><ul className="mt-2 space-y-1 text-sm leading-6 text-[color:var(--muted)]">{item.details.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">{line}</li>)}</ul>
        </article>)}</div>
      </section>
    </div>}
  </main>;
}
