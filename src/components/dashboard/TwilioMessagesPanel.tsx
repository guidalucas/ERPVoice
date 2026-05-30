import { useEffect, useState } from 'react';

type TwilioEvent = {
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

const TWILIO_API_BASE = import.meta.env.VITE_TWILIO_API_BASE ?? 'http://localhost:3001';

const formatDateTime = (value: string) => {
  try {
    return new Date(value).toLocaleString('es-AR');
  } catch {
    return value;
  }
};

export function TwilioMessagesPanel() {
  const [events, setEvents] = useState<TwilioEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadEvents = async () => {
      try {
        const response = await fetch(`${TWILIO_API_BASE}/api/twilio-events`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as TwilioEvent[];

        if (!cancelled) {
          setEvents(Array.isArray(data) ? data : []);
          setError(null);
          setIsLoading(false);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : 'No se pudieron leer los eventos de Twilio.');
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
    <article className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold text-slate-900">Mensajes Twilio</h3>
          <p className="mt-1 text-xs text-slate-500">Últimos mensajes y audios recibidos desde WhatsApp</p>
        </div>
        <span className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white">
          {TWILIO_API_BASE.replace(/^https?:\/\//, '')}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading && <div className="rounded-2xl bg-white p-4 text-sm text-slate-500 shadow-sm">Cargando eventos de Twilio...</div>}

        {!isLoading && error && <div className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-700 shadow-sm">{error}</div>}

        {!isLoading && !error && events.length === 0 && (
          <div className="rounded-2xl bg-white p-4 text-sm text-slate-500 shadow-sm">Todavía no llegaron mensajes desde Twilio.</div>
        )}

        {events.map((event, index) => (
          <div key={`${event.at}-${index}`} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-900">{event.from ?? 'Origen desconocido'}</p>
                <p className="mt-1 text-xs text-slate-500">{formatDateTime(event.at)}</p>
              </div>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-700">
                {event.kind ?? 'event'}
              </span>
            </div>

            <div className="mt-3 space-y-2 text-sm text-slate-700">
              {event.body && (
                <p>
                  <span className="font-semibold text-slate-900">Body:</span> {event.body}
                </p>
              )}
              {typeof event.numMedia === 'number' && <p>Medios: {event.numMedia}</p>}
              {event.sourceText && (
                <p>
                  <span className="font-semibold text-slate-900">Procesado:</span> {event.sourceText}
                </p>
              )}
              {event.replyText && (
                <p className="rounded-2xl bg-slate-50 px-3 py-2 text-slate-600">
                  <span className="font-semibold text-slate-900">Respuesta:</span> {event.replyText}
                </p>
              )}
              {event.error && (
                <p className="rounded-2xl bg-rose-50 px-3 py-2 text-rose-700">
                  <span className="font-semibold text-rose-900">Error:</span> {event.error}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}