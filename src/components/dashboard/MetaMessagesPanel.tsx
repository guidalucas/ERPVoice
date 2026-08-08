import { useEffect, useState } from 'react';
import { requestJson } from '../../services/apiClient';

type MetaEvent = {
  at: string;
  from: string | null;
  body: string | null;
  numMedia: number;
  kind?: 'audio' | 'text' | 'empty';
  sourceText?: string;
  transcript?: string | null;
  replyText?: string;
  error?: string;
};

const formatDateTime = (value: string) => {
  try {
    return new Date(value).toLocaleString('es-AR');
  } catch {
    return value;
  }
};

export function MetaMessagesPanel() {
  const [events, setEvents] = useState<MetaEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadEvents = async () => {
      try {
        const data = await requestJson<MetaEvent[]>('/api/meta-events');

        if (!cancelled) {
          setEvents(Array.isArray(data) ? data : []);
          setError(null);
          setIsLoading(false);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : 'No se pudieron leer los eventos de Meta.');
          setIsLoading(false);
        }
      }
    };

    loadEvents();
    const intervalId = window.setInterval(loadEvents, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <article className="erp-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100">Mensajes WhatsApp</h3>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Últimos mensajes y audios recibidos desde Meta Cloud API</p>
        </div>
        <span className="erp-chip normal-case tracking-normal text-slate-800 dark:text-slate-200">
          {(import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_META_API_BASE ?? '')
            ? (import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_META_API_BASE ?? '').replace(/^https?:\/\//, '')
            : 'same-origin'}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading && <div className="erp-card-soft text-sm text-slate-600 dark:text-slate-400">Cargando eventos de Meta...</div>}

        {!isLoading && error && <div className="erp-card-soft text-sm text-rose-700 dark:text-rose-200">{error}</div>}

        {!isLoading && !error && events.length === 0 && (
          <div className="erp-card-soft text-sm text-slate-600 dark:text-slate-400">Todavía no llegaron mensajes desde Meta.</div>
        )}

        {events.map((event, index) => (
          <div key={`${event.at}-${index}`} className="erp-card-soft">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-900 dark:text-slate-100">{event.from ?? 'Origen desconocido'}</p>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{formatDateTime(event.at)}</p>
              </div>
              <span className="erp-chip text-emerald-700 dark:text-emerald-300">
                {event.kind ?? 'event'}
              </span>
            </div>

            <div className="mt-3 space-y-2 text-sm text-slate-700 dark:text-slate-300">
              {event.body && (
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">Body:</span> {event.body}
                </p>
              )}
              {typeof event.numMedia === 'number' && <p>Medios: {event.numMedia}</p>}
              {event.sourceText && (
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">Procesado:</span> {event.sourceText}
                </p>
              )}
              {event.replyText && (
                <p className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--overlay-soft)] px-3 py-2 text-slate-700 dark:text-slate-300">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">Respuesta:</span> {event.replyText}
                </p>
              )}
              {event.error && (
                <p className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-rose-700 dark:text-rose-200">
                  <span className="font-semibold text-rose-800 dark:text-rose-100">Error:</span> {event.error}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}