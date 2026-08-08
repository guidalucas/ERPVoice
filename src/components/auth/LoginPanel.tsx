import { useEffect, useState } from 'react';
import { fetchDevAuthStatus } from '../../services/authService';
import { useAuth } from '../../store/AuthStore';
import { ThemeToggle } from '../dashboard/ThemeToggle';

type Step = 'phone' | 'code';

export function LoginPanel() {
  const { requestLoginCode, verifyLoginCode, loginWithDevBypass } = useAuth();
  const [step, setStep] = useState<Step>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [devLoginEnabled, setDevLoginEnabled] = useState(false);
  const [devDefaultPhone, setDevDefaultPhone] = useState('5491100000000');

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

  const handleRequestCode = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      const normalizedPhone = phoneNumber.replace(/\D/g, '');

      if (!normalizedPhone) {
        setStatusText('Ingresá un número válido.');
        return;
      }

      const response = await requestLoginCode(normalizedPhone);
      setChallengeId(response.challengeId);
      setPhoneNumber(response.phoneNumber);
      setStep('code');

      if (response.devOtpCode) {
        setOtpCode(response.devOtpCode);
        setStatusText(`Modo local: usá el código ${response.devOtpCode} (también está en la consola del backend).`);
      } else {
        setStatusText('Te enviamos un código por WhatsApp.');
      }
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos enviar el código.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyCode = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      await verifyLoginCode({
        phoneNumber,
        otpCode,
        challengeId,
      });
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos validar el código.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDevLogin = async () => {
    setIsSubmitting(true);
    setStatusText(null);

    try {
      await loginWithDevBypass(phoneNumber.trim() || undefined);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos entrar en modo local.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-mesh-soft-light px-4 py-8 text-slate-900 dark:bg-mesh-soft dark:text-slate-100">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center justify-center">
        <div className="erp-shell grid w-full gap-6 p-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="flex flex-col justify-between rounded-[1.5rem] border p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface-elevated)' }}>
            <div>
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.35em] text-emerald-600 dark:text-emerald-300">Stocky Access</p>
                <ThemeToggle />
              </div>
              <h1 className="mt-3 font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">Ingreso sin contraseña por WhatsApp</h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                Ingresá tu número, recibí un código temporal por WhatsApp y accedé al panel con una sesión JWT propia de tu negocio.
              </p>
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              <div className="erp-card-soft">
                <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Paso 1</p>
                <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Número</p>
              </div>
              <div className="erp-card-soft">
                <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Paso 2</p>
                <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">OTP por WhatsApp</p>
              </div>
              <div className="erp-card-soft">
                <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">Paso 3</p>
                <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Token JWT</p>
              </div>
            </div>
          </div>

          <div className="rounded-[1.5rem] border p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-cyan-700 dark:text-cyan-300">Acceso privado</p>
                <h2 className="mt-2 font-display text-2xl font-bold text-slate-900 dark:text-white">Entrar al dashboard</h2>
              </div>
              <span className="erp-chip text-emerald-700 dark:text-emerald-300">WhatsApp OTP</span>
            </div>

            <div className="mt-6 space-y-4">
              <label className="block space-y-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
                Número de celular
                <input
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  placeholder="54911..."
                  className="erp-input h-12 text-[15px]"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </label>

              {step === 'code' && (
                <label className="block space-y-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
                  Código de 6 dígitos
                  <input
                    value={otpCode}
                    onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    className="erp-input h-12 text-[15px] tracking-[0.3em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                  />
                </label>
              )}

              {statusText && (
                <p className="rounded-2xl border px-4 py-3 text-sm text-slate-800 dark:text-slate-200" style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}>
                  {statusText}
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                {step === 'phone' ? (
                  <button type="button" className="erp-button-primary" onClick={() => void handleRequestCode()} disabled={isSubmitting}>
                    {isSubmitting ? 'Enviando...' : 'Enviar código'}
                  </button>
                ) : (
                  <>
                    <button type="button" className="erp-button-primary" onClick={() => void handleVerifyCode()} disabled={isSubmitting}>
                      {isSubmitting ? 'Verificando...' : 'Entrar'}
                    </button>
                    <button
                      type="button"
                      className="erp-button-secondary"
                      onClick={() => {
                        setStep('phone');
                        setOtpCode('');
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
                <div className="rounded-2xl border border-dashed border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                  <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">Modo local</p>
                  <p className="mt-1 text-xs leading-5 text-emerald-800/80 dark:text-emerald-100/80">
                    Sin WhatsApp. Entrá directo con el teléfono demo {devDefaultPhone}, o el que escribiste arriba.
                  </p>
                  <button type="button" className="erp-button-secondary mt-3 text-sm" onClick={() => void handleDevLogin()} disabled={isSubmitting}>
                    {isSubmitting ? 'Entrando...' : 'Entrar en modo local'}
                  </button>
                </div>
              )}

              <p className="text-xs leading-5 text-slate-600 dark:text-slate-400">
                El código llega al mismo número que usás en WhatsApp. No hace falta contraseña ni email.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
