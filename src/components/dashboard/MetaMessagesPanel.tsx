import { useEffect, useState } from 'react';
import { requestJson, toUserFacingError } from '../../services/apiClient';

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

const kindLabel = (kind?: MetaEvent['kind']) => {
  if (kind === 'audio') return 'Audio';
  if (kind === 'text') return 'Texto';
  if (kind === 'empty') return 'Vacío';
  return 'Mensaje';
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
          setError(toUserFacingError(fetchError, 'No se pudieron leer los mensajes de WhatsApp.'));
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
      <div>
        <h3 className="type-title text-lg text-[color:var(--text)]">Mensajes WhatsApp</h3>
        <p className="mt-1 text-xs text-[color:var(--muted)]">Últimos mensajes y audios que llegaron al negocio</p>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading && <div className="erp-card-soft text-sm text-[color:var(--muted)]">Cargando mensajes…</div>}

        {!isLoading && error && <div className="erp-card-soft text-sm text-rose-700 dark:text-rose-200">{error}</div>}

        {!isLoading && !error && events.length === 0 && (
          <div className="erp-card-soft text-sm text-[color:var(--muted)]">
            Todavía no llegaron mensajes por WhatsApp. Cuando un cliente escriba o mande audio, aparecen acá.
          </div>
        )}

        {events.map((event, index) => (
          <div key={`${event.at}-${index}`} className="erp-card-soft">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="type-subtitle text-[color:var(--text)]">{event.from ?? 'Número desconocido'}</p>
                <p className="mt-1 text-xs text-[color:var(--muted)]">{formatDateTime(event.at)}</p>
              </div>
              <span className="erp-chip">{kindLabel(event.kind)}</span>
            </div>

            <div className="mt-3 space-y-2 text-sm text-[color:var(--muted)]">
              {event.body && (
                <p>
                  <span className="type-subtitle text-[color:var(--text)]">Mensaje:</span> {event.body}
                </p>
              )}
              {typeof event.numMedia === 'number' && event.numMedia > 0 && <p>Archivos: {event.numMedia}</p>}
              {event.sourceText && (
                <p>
                  <span className="type-subtitle text-[color:var(--text)]">Texto usado:</span> {event.sourceText}
                </p>
              )}
              {event.transcript && (
                <p>
                  <span className="type-subtitle text-[color:var(--text)]">Transcripción:</span> {event.transcript}
                </p>
              )}
              {event.replyText && (
                <p className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--overlay-soft)] px-3 py-2 text-[color:var(--muted)]">
                  <span className="type-subtitle text-[color:var(--text)]">Respuesta:</span> {event.replyText}
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
