import { useEffect, useRef, useState } from 'react';
import {
  createWhatsAppLogin,
  fetchDevAuthStatus,
  pollWhatsAppLogin,
  type WhatsAppLoginChallenge,
} from '../../services/authService';
import { useAuth } from '../../store/AuthStore';
import { StockyLogo } from '../brand/StockyLogo';
import { ThemeToggle } from '../dashboard/ThemeToggle';

const POLL_INTERVAL_MS = 1500;

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[2.4]">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[2.4]">
      <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z" />
      <path d="M17 11a5 5 0 0 1-10 0" />
      <path d="M12 17v4" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[2.4]">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`h-4 w-4 fill-none stroke-current stroke-[2.2] transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
      <path d="M12.04 2C6.58 2 2.15 6.43 2.15 11.89c0 1.76.46 3.48 1.34 5L2 22l5.27-1.38c1.46.8 3.1 1.22 4.77 1.22h.01c5.46 0 9.89-4.43 9.89-9.89C21.94 6.43 17.5 2 12.04 2Zm5.76 14.04c-.24.67-1.18 1.23-1.93 1.4-.51.11-1.18.2-3.44-.74-2.89-1.2-4.76-4.14-4.9-4.33-.14-.2-1.15-1.53-1.15-2.92 0-1.39.73-2.07 1-2.36.24-.26.64-.38 1.02-.38.12 0 .23 0 .33.01.29.01.44.03.63.49.24.56.82 2.01.89 2.16.07.15.12.32.02.51-.1.2-.15.32-.3.5-.14.17-.3.38-.43.51-.14.14-.29.29-.12.56.16.27.73 1.2 1.56 1.95 1.08.96 1.95 1.26 2.26 1.41.3.14.47.12.65-.07.18-.2.75-.87.95-1.17.2-.3.4-.25.67-.15.27.1 1.71.8 2.01.95.3.15.5.22.57.34.07.12.07.7-.17 1.37Z" />
    </svg>
  );
}

const trustBullets = [
  { icon: CheckIcon, text: 'Sin contraseñas: entrás mandando un mensaje a Stocky' },
  { icon: MicIcon, text: 'Cargás stock hablando, como se lo contarías a un empleado' },
  { icon: ShieldIcon, text: 'Tus datos y los de tus clientes, protegidos' },
];

function VoiceFlowMock() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timings = [700, 1500, 1400, 2800];
    const timer = window.setTimeout(() => {
      setPhase((current) => (current + 1) % timings.length);
    }, timings[phase]);

    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <div className="relative mx-auto w-full max-w-[19rem] overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#0b1424] shadow-2xl shadow-emerald-950/30">
      <div className="flex items-center gap-2.5 bg-[#12a65a] px-4 py-3 text-white">
        <div className="overflow-hidden rounded-full ring-2 ring-white/20">
          <StockyLogo size="sm" className="rounded-full" />
        </div>
        <div>
          <p className="type-brand text-sm leading-tight">Stocky</p>
          <p className="text-[11px] font-medium text-white/85">En línea</p>
        </div>
      </div>

      <div className="flex min-h-[210px] flex-col gap-2.5 px-3 py-4">
        <div
          className={`flex justify-end transition-all duration-500 ${
            phase >= 1 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          }`}
        >
          <div className="flex items-center gap-2 rounded-2xl rounded-tr-sm bg-sky-500 px-3 py-2.5 text-white">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15">
              <MicIcon />
            </span>
            <span className="flex items-end gap-[3px] text-sky-100">
              {[6, 11, 8, 14, 7, 10, 5].map((height, index) => (
                <span
                  key={index}
                  className="waveform-bar"
                  style={{ height: `${height}px`, animationDelay: `${index * 90}ms` }}
                />
              ))}
            </span>
            <span className="text-xs font-medium text-sky-100/90">0:07</span>
          </div>
        </div>

        <div
          className={`flex justify-start transition-all duration-500 ${
            phase === 2 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          } ${phase >= 3 ? 'hidden' : ''}`}
        >
          <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-sm bg-[#172337] px-3.5 py-3">
            <span className="typing-dot" />
            <span className="typing-dot" style={{ animationDelay: '150ms' }} />
            <span className="typing-dot" style={{ animationDelay: '300ms' }} />
          </div>
        </div>

        <div
          className={`flex justify-start transition-all duration-500 ${
            phase >= 3 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          }`}
        >
          <div className="max-w-[13.5rem] rounded-2xl rounded-tl-sm bg-[#172337] px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-100">
            Listo ✅ Sumé <b className="text-emerald-400">12 pares</b> de Zapatilla Running talle 42 al stock.
          </div>
        </div>
      </div>
    </div>
  );
}

function remainingLabel(expiresAt: string) {
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function LoginPanel() {
  const { completeWhatsAppLogin, loginWithDevBypass } = useAuth();
  const [challenge, setChallenge] = useState<WhatsAppLoginChallenge | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [devLoginEnabled, setDevLoginEnabled] = useState(false);
  const [devDefaultPhone, setDevDefaultPhone] = useState('5491100000000');
  const [devPhoneInput, setDevPhoneInput] = useState('');
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  const completingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadDevStatus = async () => {
      try {
        const status = await fetchDevAuthStatus();
        if (!cancelled) {
          setDevLoginEnabled(Boolean(status.enabled));
          if (status.defaultPhone) {
            setDevDefaultPhone(status.defaultPhone);
          }
        }
      } catch {
        if (!cancelled) {
          setDevLoginEnabled(false);
        }
      }
    };

    void loadDevStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!challenge) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  useEffect(() => {
    if (!challenge || completingRef.current) {
      return;
    }

    let cancelled = false;

    const tick = async () => {
      if (completingRef.current || cancelled) {
        return;
      }

      try {
        const result = await pollWhatsAppLogin({
          loginToken: challenge.loginToken,
          sessionSecret: challenge.sessionSecret,
        });

        if (cancelled || completingRef.current) {
          return;
        }

        if (result.status === 'authenticated') {
          completingRef.current = true;
          setIsCompleting(true);
          await completeWhatsAppLogin({
            token: result.token,
            phoneNumber: result.phoneNumber,
          });
          return;
        }

        if (result.status === 'expired' || result.status === 'not_found' || result.status === 'used') {
          setChallenge(null);
          setStatusText('El código venció o ya se usó. Generá uno nuevo para entrar.');
        }
      } catch (error) {
        if (!cancelled) {
          setStatusText(error instanceof Error ? error.message : 'No pudimos comprobar el acceso. Reintentando…');
        }
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [challenge, completeWhatsAppLogin]);

  const handleStartWhatsAppLogin = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      const nextChallenge = await createWhatsAppLogin();
      completingRef.current = false;
      setIsCompleting(false);
      setChallenge(nextChallenge);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos armar el acceso. Probá de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDevLogin = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      await loginWithDevBypass(devPhoneInput.trim() || undefined);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos entrar. Probá de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isWaiting = Boolean(challenge);
  const expiresSoon = challenge ? new Date(challenge.expiresAt).getTime() - now <= 0 : false;

  return (
    <main className="relative min-h-screen overflow-hidden bg-mesh-soft-light px-4 py-8 text-[color:var(--text)] dark:bg-mesh-soft">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="login-orb -left-24 top-0 h-72 w-72 bg-[#1677FF]/20" />
        <div
          className="login-orb right-[-5rem] top-1/4 h-80 w-80 bg-[#5B8CFF]/15"
          style={{ animationDelay: '4s' }}
        />
        <div
          className="login-orb bottom-[-4rem] left-1/3 h-72 w-72 bg-[#8BB4FF]/10"
          style={{ animationDelay: '8s' }}
        />
      </div>

      <div className="absolute right-4 top-4 z-20 sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl flex-col items-center justify-center gap-10 py-4 lg:flex-row lg:items-center lg:gap-14">
        <section className="flex w-full max-w-xl flex-col justify-center gap-6 lg:w-[54%]">
          <StockyLogo size="md" withWordmark subtitle="Tu stock, por voz" />

          <div>
            <h1 className="type-title text-3xl leading-[1.1] tracking-tight text-[color:var(--text)] sm:text-4xl">
              Actualizá tu stock hablando por WhatsApp
            </h1>
            <p className="mt-4 max-w-md text-sm leading-6 text-[color:var(--muted)]">
              Sin apps para instalar ni planillas. Le mandás un audio o un mensaje a Stocky y él entiende, carga y avisa
              solo.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {trustBullets.map(({ icon: Icon, text }) => (
              <span
                key={text}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs type-body-strong text-[color:var(--muted)]"
                style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
              >
                <span className="erp-accent-text">
                  <Icon />
                </span>
                {text}
              </span>
            ))}
          </div>

          <div className="hidden lg:block">
            <p className="mb-3 text-xs type-subtitle uppercase tracking-[0.24em] text-[color:var(--muted)]">
              Así se ve en WhatsApp
            </p>
            <VoiceFlowMock />
          </div>
        </section>

        <section className="w-full max-w-md lg:w-[46%]">
          <div className="erp-shell relative animate-fade-in-up p-6 sm:p-8">
            <h2 className="type-title text-2xl text-[color:var(--text)]">
              {isWaiting ? 'Mandá el mensaje y volvé acá' : 'Entrá con WhatsApp'}
            </h2>
            <p className="mt-2 text-sm text-[color:var(--muted)]">
              {isWaiting
                ? 'WhatsApp se abre con el mensaje listo. Solo tenés que tocar Enviar. El panel te deja entrar solo.'
                : 'No hace falta escribir tu número. Tocá el botón, mandá el mensaje y te abrimos el panel.'}
            </p>

            <div className="mt-6 space-y-4">
              {isWaiting && challenge && (
                <div
                  className="rounded-2xl border px-4 py-4"
                  style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
                >
                  <p className="text-xs type-subtitle uppercase tracking-[0.18em] text-[color:var(--muted)]">
                    Mensaje a enviar
                  </p>
                  <p className="mt-2 font-mono text-lg tracking-[0.18em] text-[color:var(--text)]">
                    LOGIN {challenge.loginToken}
                  </p>
                  <p className="mt-2 text-xs text-[color:var(--muted)]">
                    {expiresSoon
                      ? 'Este código ya venció.'
                      : `Vence en ${remainingLabel(challenge.expiresAt)}. Si WhatsApp no se abrió, usá el botón de abajo.`}
                  </p>
                </div>
              )}

              {statusText && (
                <p
                  className="rounded-2xl border px-4 py-3 text-sm text-[color:var(--text)]"
                  style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
                >
                  {statusText}
                </p>
              )}

              {isWaiting && challenge && !expiresSoon ? (
                <div className="flex flex-col gap-3">
                  <a
                    href={challenge.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="erp-button-primary inline-flex min-h-12 w-full items-center justify-center gap-2"
                  >
                    <WhatsAppIcon />
                    Abrir WhatsApp y enviar
                  </a>
                  <p className="text-center text-sm text-[color:var(--muted)]">
                    {isCompleting ? 'Entrando al panel…' : 'Esperando que mandes el mensaje…'}
                  </p>
                  <button
                    type="button"
                    className="erp-button-secondary min-h-12"
                    onClick={() => {
                      setChallenge(null);
                      completingRef.current = false;
                      setIsCompleting(false);
                      setStatusText(null);
                    }}
                  >
                    Generar otro código
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="erp-button-primary inline-flex min-h-12 w-full items-center justify-center gap-2"
                  onClick={() => void handleStartWhatsAppLogin()}
                  disabled={isSubmitting}
                >
                  <WhatsAppIcon />
                  {isSubmitting ? 'Preparando…' : expiresSoon ? 'Generar un código nuevo' : 'Iniciar sesión con WhatsApp'}
                </button>
              )}

              {devLoginEnabled && (
                <div className="rounded-2xl border border-dashed border-[color:var(--accent-border)] bg-[color:var(--accent-soft)]">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                    onClick={() => setDevPanelOpen((open) => !open)}
                    aria-expanded={devPanelOpen}
                  >
                    <span className="erp-accent-text text-sm font-semibold">Modo prueba (solo en tu PC)</span>
                    <span className="erp-accent-text">
                      <ChevronIcon open={devPanelOpen} />
                    </span>
                  </button>
                  {devPanelOpen && (
                    <div className="space-y-3 px-4 pb-4">
                      <p className="text-xs leading-5 text-[color:var(--muted)]">
                        Podés entrar sin WhatsApp usando el número de prueba {devDefaultPhone}, o uno propio.
                      </p>
                      <input
                        value={devPhoneInput}
                        onChange={(event) => setDevPhoneInput(event.target.value)}
                        placeholder={devDefaultPhone}
                        className="h-11 w-full rounded-2xl border px-3 text-sm type-body-strong text-[color:var(--text)] outline-none"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface-elevated)' }}
                        inputMode="tel"
                      />
                      <button
                        type="button"
                        className="erp-button-secondary text-sm"
                        onClick={() => void handleDevLogin()}
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? 'Entrando…' : 'Entrar sin WhatsApp'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <p className="text-xs leading-5 text-[color:var(--muted)]">
                El mensaje tiene que salir del WhatsApp con el que manejás el negocio. El código vence en unos minutos.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
