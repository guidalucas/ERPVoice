import { useState } from 'react';
import { useAuth } from '../../store/AuthStore';
import { formatPhoneDisplay } from '../../services/phone';
import { StockyLogo } from '../brand/StockyLogo';
import { ThemeToggle } from '../dashboard/ThemeToggle';

export function AcceptInvitePanel() {
  const { session, acceptInvite, declineInvite, logout } = useAuth();
  const pendingInvite = session?.pendingInvite ?? null;
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const businessName = pendingInvite?.businessName?.trim() || 'un negocio';
  const hasOwnBusiness = Boolean(pendingInvite?.hasOwnBusiness ?? session?.hasOwnBusiness);
  const invitedBy = pendingInvite?.invitedByPhone ? formatPhoneDisplay(pendingInvite.invitedByPhone) : null;

  const handleAccept = async () => {
    if (!pendingInvite) {
      return;
    }

    setIsSubmitting(true);
    setStatusText(null);

    try {
      await acceptInvite(pendingInvite.id);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos aceptar la invitación.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDecline = async () => {
    if (!pendingInvite) {
      return;
    }

    setIsSubmitting(true);
    setStatusText(null);

    try {
      await declineInvite(pendingInvite.id);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'No pudimos rechazar la invitación.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-[100dvh] px-4 py-8 text-[color:var(--text)]">
      <section className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-3xl items-center justify-center">
        <div className="erp-panel w-full p-6 sm:p-8">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <StockyLogo size="lg" />
                <div>
                  <h1 className="type-title text-2xl text-[color:var(--text)]">Te invitaron a {businessName}</h1>
                </div>
              </div>
              <ThemeToggle />
            </div>

            <p className="mt-4 text-sm leading-6 text-[color:var(--muted)]">
              {invitedBy
                ? `${invitedBy} te invitó a operar el stock de ${businessName} con este WhatsApp.`
                : `Te invitaron a operar el stock de ${businessName} con este WhatsApp.`}
            </p>

            {hasOwnBusiness ? (
              <div
                className="mt-5 rounded-2xl border px-4 py-3 text-sm leading-6 text-[color:var(--text)]"
                style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
              >
                Ya tenés un negocio en Stocky. Si aceptás, este WhatsApp deja de operar <span className="type-subtitle">tu</span> stock
                y pasa a {businessName}. Tus datos no se borran: vuelven a verse si salís del equipo.
              </div>
            ) : (
              <p className="mt-5 text-sm leading-6 text-[color:var(--muted)]">
                Si aceptás, vas a ver el mismo inventario, pedidos y clientes que el dueño. No hace falta configurar un negocio nuevo.
              </p>
            )}

            {statusText && (
              <p
                className="mt-5 rounded-2xl border px-4 py-3 text-sm text-[color:var(--text)]"
                style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
              >
                {statusText}
              </p>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" className="erp-button-primary" onClick={() => void handleAccept()} disabled={isSubmitting}>
                {isSubmitting ? 'Guardando...' : hasOwnBusiness ? `Unirme a ${businessName}` : 'Unirme'}
              </button>
              <button type="button" className="erp-button-secondary" onClick={() => void handleDecline()} disabled={isSubmitting}>
                Rechazar
              </button>
              <button type="button" className="erp-button-secondary" onClick={logout} disabled={isSubmitting}>
                Salir
              </button>
            </div>
        </div>
      </section>
    </main>
  );
}
