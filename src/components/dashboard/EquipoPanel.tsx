import { useEffect, useState } from 'react';
import { toUserFacingError } from '../../services/apiClient';
import { formatPhoneDisplay } from '../../services/phone';
import {
  cancelTeamInvite,
  createTeamInvite,
  fetchTeam,
  leaveTeam,
  removeTeamMember,
  type TeamSnapshot,
} from '../../services/teamService';
import { useAuth } from '../../store/AuthStore';

type EquipoPanelProps = {
  onClose: () => void;
};

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

export function EquipoPanel({ onClose }: EquipoPanelProps) {
  const { session, applyProfile } = useAuth();
  const [team, setTeam] = useState<TeamSnapshot | null>(null);
  const [phoneInput, setPhoneInput] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isOwner = (team?.role ?? session?.role) === 'owner';

  const loadTeam = async () => {
    const snapshot = await fetchTeam();
    setTeam(snapshot);
    return snapshot;
  };

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const snapshot = await fetchTeam();
        if (!cancelled) {
          setTeam(snapshot);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(toUserFacingError(error, 'No se pudo cargar el equipo.'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleInvite = async () => {
    const digits = phoneInput.replace(/\D/g, '');
    if (!digits) {
      setErrorText('Ingresá un número de celular.');
      return;
    }

    setIsSubmitting(true);
    setErrorText(null);
    setStatusText(null);

    try {
      const result = await createTeamInvite(digits);
      await loadTeam();
      setPhoneInput('');
      setStatusText(
        result.resent
          ? `Reenviamos la invitación a ${formatPhoneDisplay(result.phoneNumber)}.`
          : `Invitamos a ${formatPhoneDisplay(result.phoneNumber)}.`,
      );
    } catch (error) {
      setErrorText(toUserFacingError(error, 'No se pudo enviar la invitación.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    setIsSubmitting(true);
    setErrorText(null);
    setStatusText(null);

    try {
      await cancelTeamInvite(inviteId);
      await loadTeam();
      setStatusText('Invitación cancelada.');
    } catch (error) {
      setErrorText(toUserFacingError(error, 'No se pudo cancelar la invitación.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveMember = async (phoneNumber: string) => {
    setIsSubmitting(true);
    setErrorText(null);
    setStatusText(null);

    try {
      await removeTeamMember(phoneNumber);
      await loadTeam();
      setStatusText(`Sacamos a ${formatPhoneDisplay(phoneNumber)} del equipo.`);
    } catch (error) {
      setErrorText(toUserFacingError(error, 'No se pudo sacar a esa persona.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLeave = async () => {
    setIsSubmitting(true);
    setErrorText(null);
    setStatusText(null);

    try {
      const profile = await leaveTeam();
      applyProfile(profile);
      onClose();
    } catch (error) {
      setErrorText(toUserFacingError(error, 'No se pudo salir del equipo.'));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
      <div
        className="flex max-h-[min(36rem,calc(100vh-3rem))] w-full max-w-lg flex-col overflow-hidden rounded-[1.5rem] border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        role="dialog"
        aria-labelledby="equipo-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="erp-brand-gradient-text text-[10px] uppercase tracking-[0.35em]">Equipo</p>
            <h3 id="equipo-title" className="mt-1 type-title text-xl text-[color:var(--text)]">
              {team?.businessName || session?.businessName || 'Tu negocio'}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              Un WhatsApp opera un solo negocio. Quien entre al equipo ve el mismo stock.
            </p>
          </div>
          <button type="button" className="erp-button-secondary min-h-11 shrink-0 px-3 text-sm" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {isLoading ? (
            <p className="text-sm text-[color:var(--muted)]">Cargando equipo…</p>
          ) : (
            <>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">Miembros</p>
                <ul className="mt-2 space-y-2">
                  {(team?.members ?? []).map((member) => (
                    <li
                      key={member.phoneNumber}
                      className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2.5"
                      style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm type-subtitle text-[color:var(--text)]">
                          {formatPhoneDisplay(member.phoneNumber)}
                        </p>
                        <p className="text-xs text-[color:var(--muted)]">{member.role === 'owner' ? 'Dueño' : 'Miembro'}</p>
                      </div>
                      {isOwner && member.role !== 'owner' && (
                        <button
                          type="button"
                          className="erp-button-secondary min-h-10 shrink-0 px-3 text-xs"
                          disabled={isSubmitting}
                          onClick={() => void handleRemoveMember(member.phoneNumber)}
                        >
                          Sacar
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {isOwner && (team?.invites.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">Pendientes</p>
                  <ul className="mt-2 space-y-2">
                    {team?.invites.map((invite) => (
                      <li
                        key={invite.id}
                        className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2.5"
                        style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm type-subtitle text-[color:var(--text)]">
                            {formatPhoneDisplay(invite.phoneNumber)}
                          </p>
                          <p className="text-xs text-[color:var(--muted)]">Invitación pendiente</p>
                        </div>
                        <button
                          type="button"
                          className="erp-button-secondary min-h-10 shrink-0 px-3 text-xs"
                          disabled={isSubmitting}
                          onClick={() => void handleCancelInvite(invite.id)}
                        >
                          Cancelar
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {isOwner && (
                <label className="block space-y-2 text-sm type-subtitle text-[color:var(--text)]">
                  Invitar por WhatsApp
                  <div className="flex gap-2">
                    <div className="erp-input flex h-12 flex-1 items-center gap-2 px-3">
                      <span className="text-sm text-[color:var(--muted)]">+54</span>
                      <input
                        value={phoneInput}
                        onChange={(event) => setPhoneInput(toLocalPhoneInput(event.target.value))}
                        placeholder="11 0000 0000"
                        className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none"
                        inputMode="numeric"
                        autoComplete="tel"
                      />
                    </div>
                    <button
                      type="button"
                      className="erp-button-primary min-h-12 shrink-0 px-4 text-sm"
                      disabled={isSubmitting}
                      onClick={() => void handleInvite()}
                    >
                      {isSubmitting ? '...' : 'Invitar'}
                    </button>
                  </div>
                </label>
              )}

              {!isOwner && (
                <button
                  type="button"
                  className="erp-button-secondary w-full text-sm"
                  disabled={isSubmitting}
                  onClick={() => void handleLeave()}
                >
                  Salir de este negocio
                </button>
              )}
            </>
          )}

          {statusText && (
            <p className="rounded-2xl border px-3 py-2 text-sm text-[color:var(--text)]" style={{ borderColor: 'var(--border)' }}>
              {statusText}
            </p>
          )}
          {errorText && (
            <p className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
              {errorText}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
