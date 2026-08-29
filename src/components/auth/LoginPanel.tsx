import { useEffect, useRef, useState } from 'react';
import { CaretDown, Check, Microphone, ShieldCheck, WhatsappLogo } from '@phosphor-icons/react';
import {
  createWhatsAppLogin,
  fetchDevAuthStatus,
  pollWhatsAppLogin,
  type WhatsAppLoginChallenge,
} from '../../services/authService';
import { useAuth } from '../../store/AuthStore';
import { StockyLogo } from '../brand/StockyLogo';
import { WaveformMark } from '../brand/WaveformMark';
import { ThemeToggle } from '../dashboard/ThemeToggle';

const POLL_INTERVAL_MS = 1500;

const pillars = [
  { icon: Microphone, title: 'Comandos de voz', text: 'Hablás, Stocky lo carga.' },
  { icon: WhatsappLogo, title: 'WhatsApp', text: 'Desde el celular, sin otra app.' },
  { icon: ShieldCheck, title: 'Vos decidís', text: 'Entiende el audio. El control es tuyo.' },
];

function PillarList({ className }: { className: string }) {
  return (
    <ul className={className}>
      {pillars.map(({ icon: Icon, title, text }) => (
        <li key={title} className="rounded-[0.875rem] border px-3.5 py-3" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <Icon size={20} weight="regular" className="text-[color:var(--accent)]" aria-hidden="true" />
          <p className="mt-2 text-sm type-subtitle text-[color:var(--text)]">{title}</p>
          <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">{text}</p>
        </li>
      ))}
    </ul>
  );
}

function VoiceFlowMock() {
  const [phase, setPhase] = useState(1);

  useEffect(() => {
    const timings = [700, 1500, 1400, 2800];
    const timer = window.setTimeout(() => {
      setPhase((current) => (current + 1) % timings.length);
    }, timings[phase]);

    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <div className="relative mx-auto w-full max-w-[20rem] overflow-hidden rounded-[1.5rem] border border-[color:var(--border)] bg-[color:var(--surface)]">
      <div className="flex items-center gap-2.5 bg-[#12a65a] px-4 py-3 text-white">
        <div className="overflow-hidden rounded-[0.75rem] ring-2 ring-white/20">
          <StockyLogo size="sm" className="rounded-[0.75rem]" />
        </div>
        <div>
          <p className="type-brand text-sm leading-tight">Stocky</p>
          <p className="text-[11px] font-medium text-white/85">En línea</p>
        </div>
      </div>

      <div className="flex min-h-[214px] flex-col gap-2.5 px-3 py-4" style={{ background: 'var(--surface-elevated)' }}>
        <div
          className={`flex justify-end transition-all duration-500 ${
            phase >= 1 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          }`}
        >
          <div className="erp-brand-gradient flex items-center gap-2 rounded-2xl rounded-tr-sm px-3 py-2.5 text-white">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15">
              <Microphone size={14} weight="bold" />
            </span>
            <WaveformMark className="text-white" bars={7} />
            <span className="text-xs font-medium text-white/90">0:07</span>
          </div>
        </div>

        <div
          className={`flex justify-start transition-all duration-500 ${
            phase === 2 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          } ${phase >= 3 ? 'hidden' : ''}`}
        >
          <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-sm border px-3.5 py-3" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
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
          <div className="max-w-[14rem] rounded-2xl rounded-tl-sm border px-3.5 py-2.5 text-[13px] leading-relaxed text-[color:var(--text)]" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            Listo. Sumé <b className="erp-brand-gradient-text">12 pares</b> de zapatilla running, número 42.
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
    <main className="relative min-h-[100dvh] overflow-hidden px-4 py-5 text-[color:var(--text)] sm:px-6 sm:py-6">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="login-orb -left-24 top-0 h-72 w-72 bg-[color:var(--accent)]/25" />
        <div className="login-orb right-[-5rem] top-1/4 h-80 w-80 bg-[color:var(--accent-2)]/20" style={{ animationDelay: '4s' }} />
        <div className="login-orb bottom-[-4rem] left-1/3 h-64 w-64 bg-[color:var(--accent)]/10" style={{ animationDelay: '8s' }} />
      </div>

      <header className="relative z-20 mx-auto flex max-w-6xl items-center justify-between">
        <StockyLogo size="md" withWordmark subtitle="Inteligente. Rápido. Simple." />
        <ThemeToggle />
      </header>

      <div className="relative mx-auto grid min-h-[calc(100dvh-5.5rem)] max-w-6xl items-center gap-10 py-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
        <section className="flex flex-col justify-center">
          <p className="mb-3 inline-flex items-center gap-2 text-sm type-subtitle text-[color:var(--muted)]">
            <WaveformMark bars={4} />
            Stocky entiende, vos decidís
          </p>
          <h1 className="type-title max-w-xl text-[2.15rem] leading-[1.05] text-[color:var(--text)] sm:text-5xl">
            Tu inventario, tan fácil como <span className="erp-brand-gradient-text">hablar</span>.
          </h1>
          <p className="mt-4 max-w-md text-base leading-7 text-[color:var(--muted)]">
            Mandás un audio o un mensaje por WhatsApp. Stocky entiende, carga el stock y te deja el panel al día.
          </p>

          <PillarList className="mt-8 hidden gap-3 sm:grid sm:grid-cols-3" />

          <div className="mt-8 hidden lg:block">
            <VoiceFlowMock />
          </div>
        </section>

        <section className="w-full">
          <div className="erp-panel animate-fade-in-up p-5 sm:p-7">
            <h2 className="type-title text-2xl text-[color:var(--text)]">
              {isWaiting ? 'Mandá el mensaje y volvé' : 'Entrá con WhatsApp'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-[color:var(--muted)]">
              {isWaiting
                ? 'WhatsApp se abre con el mensaje listo. Tocá Enviar. El panel te deja pasar solo.'
                : 'Sin contraseña ni número para tipear. Tocá, mandá el mensaje y abrimos tu panel.'}
            </p>

            <div className="mt-6 space-y-4">
              {isWaiting && challenge && (
                <div className="rounded-[0.875rem] border px-4 py-4" style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)' }}>
                  <p className="text-xs type-subtitle text-[color:var(--muted)]">Mensaje a enviar</p>
                  <p className="mt-2 font-mono text-lg tracking-[0.16em] text-[color:var(--text)]">
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
                <p className="rounded-[0.875rem] border px-4 py-3 text-sm text-[color:var(--text)]" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
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
                    <WhatsappLogo size={20} weight="fill" aria-hidden="true" />
                    Abrir WhatsApp y enviar
                  </a>
                  <p className="inline-flex items-center justify-center gap-2 text-sm text-[color:var(--muted)]">
                    <WaveformMark bars={4} />
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
                  <WhatsappLogo size={20} weight="fill" aria-hidden="true" />
                  {isSubmitting ? 'Preparando…' : expiresSoon ? 'Generar un código nuevo' : 'Iniciar sesión con WhatsApp'}
                </button>
              )}

              {devLoginEnabled && (
                <div className="rounded-[0.875rem] border border-dashed border-[color:var(--accent-border)] bg-[color:var(--accent-soft)]">
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-3 text-left"
                    onClick={() => setDevPanelOpen((open) => !open)}
                    aria-expanded={devPanelOpen}
                  >
                    <span className="erp-accent-text text-sm font-semibold">Modo prueba (solo en tu PC)</span>
                    <CaretDown size={16} className={`erp-accent-text transition-transform ${devPanelOpen ? 'rotate-180' : ''}`} />
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
                        className="erp-input"
                        inputMode="tel"
                      />
                      <button type="button" className="erp-button-secondary text-sm" onClick={() => void handleDevLogin()} disabled={isSubmitting}>
                        {isSubmitting ? 'Entrando…' : 'Entrar sin WhatsApp'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <p className="flex items-start gap-2 text-xs leading-5 text-[color:var(--muted)]">
                <Check size={14} className="mt-0.5 shrink-0 text-[color:var(--accent)]" aria-hidden="true" />
                El mensaje tiene que salir del WhatsApp con el que manejás el negocio. El código vence en unos minutos.
              </p>
            </div>
          </div>

          <PillarList className="mt-6 grid gap-3 sm:hidden" />

          <div className="mt-6 lg:hidden">
            <VoiceFlowMock />
          </div>
        </section>
      </div>
    </main>
  );
}
