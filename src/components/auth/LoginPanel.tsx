import { useEffect, useRef, useState } from 'react';
import { fetchDevAuthStatus } from '../../services/authService';
import { useAuth } from '../../store/AuthStore';
import { StockyLogo } from '../brand/StockyLogo';
import { ThemeToggle } from '../dashboard/ThemeToggle';

type Step = 'phone' | 'code';

const OTP_LENGTH = 6;

/** Quita 54 / 549 del valor canónico para mostrar junto al prefijo visual +54. */
function toLocalPhoneInput(value: string): string {
  const digits = value.replace(/\D/g, '');

  if (digits.startsWith('549') && digits.length >= 12) {
    return digits.slice(3);
  }

  if (digits.startsWith('54') && digits.length >= 12) {
    return digits.slice(2);
  }

  return digits;
}

/** Formatea el canónico (549…) para mensajes legibles. */
function formatPhoneForMessage(canonical: string): string {
  const digits = canonical.replace(/\D/g, '');

  if (digits.length === 13 && digits.startsWith('549')) {
    const local = digits.slice(3);

    if (local.startsWith('11')) {
      return `+54 9 11 ${local.slice(2, 6)}-${local.slice(6)}`;
    }

    return `+54 9 ${local.slice(0, 3)} ${local.slice(3, 6)}-${local.slice(6)}`;
  }

  if (digits.length === 12 && digits.startsWith('54')) {
    const local = digits.slice(2);
    return `+54 ${local.slice(0, 3)} ${local.slice(3, 6)}-${local.slice(6)}`;
  }

  return digits ? `+${digits}` : '';
}

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

const trustBullets = [
  { icon: CheckIcon, text: 'Sin contraseñas: entrás con un código por WhatsApp' },
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

export function LoginPanel() {
  const { requestLoginCode, verifyLoginCode, loginWithDevBypass } = useAuth();
  const [step, setStep] = useState<Step>('phone');
  /** Lo que ve el usuario junto a +54 (sin código de país). */
  const [phoneInput, setPhoneInput] = useState('');
  /** Valor canónico para la API (ej. 5493454954407). */
  const [canonicalPhone, setCanonicalPhone] = useState('');
  const [otpDigits, setOtpDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [challengeId, setChallengeId] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [devLoginEnabled, setDevLoginEnabled] = useState(false);
  const [devDefaultPhone, setDevDefaultPhone] = useState('5491100000000');
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);

  const otpCode = otpDigits.join('');

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
    if (step === 'code') {
      otpRefs.current[0]?.focus();
    }
  }, [step]);

  const resetOtp = () => setOtpDigits(Array(OTP_LENGTH).fill(''));

  const handlePhoneInputChange = (raw: string) => {
    setPhoneInput(toLocalPhoneInput(raw));
    setCanonicalPhone('');
  };

  const handleRequestCode = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      const digits = phoneInput.replace(/\D/g, '');

      if (!digits) {
        setStatusText('Ingresá un número de celular válido.');
        return;
      }

      const response = await requestLoginCode(digits);
      setChallengeId(response.challengeId);
      setCanonicalPhone(response.phoneNumber);
      setPhoneInput(toLocalPhoneInput(response.phoneNumber));
      setStep('code');
      resetOtp();

      if (response.devOtpCode) {
        setOtpDigits(response.devOtpCode.padEnd(OTP_LENGTH, '').slice(0, OTP_LENGTH).split(''));
        setStatusText(`Para probar en tu PC, usá este código: ${response.devOtpCode}`);
      } else {
        setStatusText('Listo. Te mandamos un código por WhatsApp.');
      }
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos enviar el código. Probá de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyCode = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      await verifyLoginCode({
        phoneNumber: canonicalPhone || phoneInput,
        otpCode,
        challengeId,
      });
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'El código no es válido. Revisalo e intentá otra vez.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDevLogin = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      await loginWithDevBypass(phoneInput.trim() || undefined);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos entrar. Probá de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOtpChange = (index: number, rawValue: string) => {
    const digits = rawValue.replace(/\D/g, '');

    if (!digits) {
      setOtpDigits((prev) => {
        const next = [...prev];
        next[index] = '';
        return next;
      });
      return;
    }

    if (digits.length > 1) {
      setOtpDigits((prev) => {
        const next = [...prev];
        for (let offset = 0; offset < digits.length && index + offset < OTP_LENGTH; offset += 1) {
          next[index + offset] = digits[offset]!;
        }
        return next;
      });
      const lastFilled = Math.min(index + digits.length, OTP_LENGTH) - 1;
      otpRefs.current[Math.min(lastFilled + 1, OTP_LENGTH - 1)]?.focus();
      return;
    }

    setOtpDigits((prev) => {
      const next = [...prev];
      next[index] = digits;
      return next;
    });

    if (index < OTP_LENGTH - 1) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const isOtpComplete = otpDigits.every((digit) => digit !== '');

  const phoneMessageLabel = formatPhoneForMessage(canonicalPhone) || phoneInput || 'tu número';

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
            <div className="mb-6 flex items-center gap-2">
              <div className="login-step-track">
                <div className="login-step-fill" style={{ width: step === 'phone' ? '50%' : '100%' }} />
              </div>
              <span className="shrink-0 text-xs type-subtitle text-[color:var(--muted)]">
                Paso {step === 'phone' ? '1' : '2'} de 2
              </span>
            </div>

            <h2 className="type-title text-2xl text-[color:var(--text)]">
              {step === 'phone' ? '¿Cuál es tu WhatsApp?' : 'Ingresá el código'}
            </h2>
            <p className="mt-2 text-sm text-[color:var(--muted)]">
              {step === 'phone'
                ? 'Usá el mismo número con el que manejás el negocio.'
                : `Te mandamos ${OTP_LENGTH} dígitos por WhatsApp al ${phoneMessageLabel}.`}
            </p>

            <div className="mt-6 space-y-4">
              <label className="block space-y-2 text-sm type-subtitle text-[color:var(--text)]">
                Número de celular
                <div
                  className="flex items-center gap-2 rounded-2xl border px-3 transition focus-within:border-[color:var(--accent)]"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-elevated)' }}
                >
                  <span className="shrink-0 text-sm type-subtitle text-[color:var(--muted)]">+54</span>
                  <span className="h-6 w-px shrink-0" style={{ background: 'var(--border)' }} />
                  <input
                    value={phoneInput}
                    onChange={(event) => handlePhoneInputChange(event.target.value)}
                    placeholder="11 2345-6789"
                    className="h-12 w-full min-w-0 bg-transparent text-[15px] type-body-strong text-[color:var(--text)] outline-none placeholder:font-normal placeholder:text-slate-400 dark:placeholder:text-slate-500"
                    inputMode="tel"
                    autoComplete="tel"
                    disabled={step === 'code'}
                  />
                </div>
              </label>

              {step === 'code' && (
                <div className="space-y-2">
                  <p className="text-sm type-subtitle text-[color:var(--text)]">Código de WhatsApp</p>
                  <div className="flex justify-between gap-2">
                    {otpDigits.map((digit, index) => (
                      <input
                        key={index}
                        ref={(element) => {
                          otpRefs.current[index] = element;
                        }}
                        value={digit}
                        onChange={(event) => handleOtpChange(index, event.target.value)}
                        onKeyDown={(event) => handleOtpKeyDown(index, event)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={OTP_LENGTH}
                        className="otp-box"
                      />
                    ))}
                  </div>
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

              <div className="flex flex-wrap gap-3">
                {step === 'phone' ? (
                  <button
                    type="button"
                    className="erp-button-primary min-h-12 w-full"
                    onClick={() => void handleRequestCode()}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? 'Enviando…' : 'Enviar código por WhatsApp'}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="erp-button-primary min-h-12 flex-1 sm:flex-none"
                      onClick={() => void handleVerifyCode()}
                      disabled={isSubmitting || !isOtpComplete}
                    >
                      {isSubmitting ? 'Entrando…' : 'Entrar al panel'}
                    </button>
                    <button
                      type="button"
                      className="erp-button-secondary min-h-12"
                      onClick={() => {
                        setStep('phone');
                        resetOtp();
                        setChallengeId('');
                        setStatusText(null);
                      }}
                    >
                      Cambiar número
                    </button>
                  </>
                )}
              </div>

              {devLoginEnabled && (
                <div className="rounded-2xl border border-dashed border-[color:var(--accent-border)] bg-[color:var(--accent-soft)]">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                    onClick={() => setDevPanelOpen((open) => !open)}
                    aria-expanded={devPanelOpen}
                  >
                    <span className="erp-accent-text text-sm font-semibold">
                      Modo prueba (solo en tu PC)
                    </span>
                    <span className="erp-accent-text">
                      <ChevronIcon open={devPanelOpen} />
                    </span>
                  </button>
                  {devPanelOpen && (
                    <div className="px-4 pb-4">
                      <p className="text-xs leading-5 text-[color:var(--muted)]">
                        Podés entrar sin WhatsApp usando el número de prueba {devDefaultPhone}, o el que escribiste
                        arriba.
                      </p>
                      <button
                        type="button"
                        className="erp-button-secondary mt-3 text-sm"
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
                El código vence en unos minutos. Si no te llega, revisá que el número esté bien o pedí uno nuevo.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
