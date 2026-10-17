import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../store/AuthStore';
import { useInventory } from '../../hooks/useInventory';
import { toUserFacingError } from '../../services/apiClient';
import { cancelUniversalDraft, confirmUniversalDraft, fetchUniversalDraft, prepareUniversalDraft, replyUniversalDraft, type UniversalDraftPreview } from '../../services/universalDraftService';

type Attempt = { kind: 'prepare' | 'reply' | 'confirm' | 'cancel'; requestId: string; text: string; draftId?: string; version?: number; digest?: string };
type Saved = { text: string; draftId?: string; attempt?: Attempt; correcting?: boolean };
const button = 'rounded-xl border border-sky-500/30 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';

export function UniversalDraftReview({ onClose }: { onClose: () => void }) {
  const { session } = useAuth();
  const { refreshState } = useInventory();
  const storageKey = session ? `universal-draft:${JSON.stringify([session.tenantPhone, session.phoneNumber])}` : null;
  const [saved, setSaved] = useState<Saved>({ text: '' });
  const [preview, setPreview] = useState<UniversalDraftPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lock = useRef(false);
  const scope = useRef(storageKey);
  scope.current = storageKey;
  const refresh = useRef(refreshState);
  refresh.current = refreshState;
  const dialog = useRef<HTMLDivElement>(null);
  const expired = Boolean(preview && (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= now));
  const completeReview = Boolean(preview?.review?.length && preview.plan?.actions?.length === preview.review.length && new Set(preview.review.map(item => item.itemId)).size === preview.review.length && preview.plan.actions.every(action => preview.review!.some(item => item.itemId === action.itemId)));
  const pending = preview?.status === 'awaiting_confirmation' || preview?.status === 'awaiting_clarification';
  const unresolvedWrite = !preview && (saved.attempt?.kind === 'confirm' || saved.attempt?.kind === 'cancel');

  const persist = (next: Saved) => {
    if (!storageKey) throw new Error('Iniciá sesión para revisar una operación.');
    localStorage.setItem(storageKey, JSON.stringify(next));
    setSaved(next);
  };
  const updateInventory = async () => {
    try { await refresh.current(); setRefreshError(''); }
    catch { setRefreshError('La operación está aplicada, pero no pudimos actualizar los datos en pantalla. Podés reintentar la actualización.'); }
  };

  useEffect(() => {
    let active = true;
    lock.current = true; setBusy(true); setHydrated(false); setSaved({ text: '' }); setConsent(false); setCorrecting(false); setPreview(null); setError(''); setRefreshError(''); setConflict(false);
    const restore = async () => {
      try {
        const raw = storageKey ? localStorage.getItem(storageKey) : null;
        const parsed = raw ? JSON.parse(raw) as Saved : { text: '' };
        if (typeof parsed.text !== 'string' || (parsed.draftId !== undefined && typeof parsed.draftId !== 'string')) throw new Error('No pudimos recuperar la referencia guardada.');
        if (!active) return;
        setSaved(parsed);
        if (parsed.draftId) {
          const current = await fetchUniversalDraft(parsed.draftId);
          if (!active) return;
          setPreview(current);
          const retryReply = parsed.attempt?.kind === 'reply' && parsed.attempt.version === current.version && current.status.startsWith('awaiting_');
          setCorrecting(current.status === 'awaiting_confirmation' && (retryReply || Boolean(parsed.correcting && !parsed.attempt)));
          if (parsed.attempt && !retryReply) persist({ text:current.status === 'awaiting_clarification' ? '' : parsed.text,draftId:current.draftId });
          if (current.status === 'applied') await updateInventory();
        }
      } catch (failure) { if (active) setError(toUserFacingError(failure)); }
      finally { if (active) { lock.current = false; setBusy(false); setHydrated(true); } }
    };
    void restore();
    return () => { active = false; };
  }, [storageKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { window.clearInterval(timer); previous?.focus(); };
  }, []);

  const recover = async (finishCorrection=false) => {
    if (lock.current || !saved.draftId) return;
    lock.current = true; setBusy(true); setConsent(false); setError('');
    try {
      const current = await fetchUniversalDraft(saved.draftId);
      if (scope.current !== storageKey) return;
      const retryReply = !finishCorrection && saved.attempt?.kind === 'reply' && saved.attempt.version === current.version && current.status.startsWith('awaiting_');
      setPreview(current); setConflict(false); setCorrecting(current.status === 'awaiting_confirmation' && retryReply);
      // Preserve an unresolved reply until its command/version is observed.
      if (!retryReply) persist({text:current.status === 'awaiting_clarification' ? '' : saved.text,draftId:current.draftId});
      if (current.status === 'applied') await updateInventory();
    } catch (failure) { setError(toUserFacingError(failure)); }
    finally { lock.current = false; setBusy(false); }
  };

  const submit = async (kind: Attempt['kind']) => {
    if (lock.current || !hydrated || !storageKey) return;
    if (kind === 'confirm' && (correcting || !consent || conflict || expired || !completeReview || preview?.status !== 'awaiting_confirmation' || Date.parse(preview.expiresAt) <= Date.now())) return;
    if ((kind === 'reply' || kind === 'prepare') && !saved.text.trim()) return;
    lock.current = true; setBusy(true); setError('');
    const prior = saved.attempt;
    const attempt: Attempt = prior?.kind === kind && prior.text === saved.text ? prior : { kind, text: saved.text, requestId: crypto.randomUUID(), ...(preview ? { draftId: preview.draftId, version: preview.version, digest: preview.digest } : {}) };
    try {
      // Save before the request: an uncertain response is retried with this same ID.
      persist({ ...saved, attempt });
      const current = kind === 'prepare' ? await prepareUniversalDraft(attempt.requestId, attempt.text)
        : kind === 'reply' ? await replyUniversalDraft(attempt.draftId!, attempt.requestId, attempt.text, attempt.version!)
          : kind === 'confirm' ? await confirmUniversalDraft(attempt.draftId!, attempt.version!, attempt.digest!)
            : await cancelUniversalDraft(attempt.draftId!, attempt.version!, attempt.digest!);
      if (scope.current !== storageKey) return;
      setPreview(current); setConsent(false); setConflict(false); setCorrecting(false);
      persist({ text: current.status === 'awaiting_clarification' ? '' : attempt.text, draftId: current.draftId });
      if (current.status === 'applied') await updateInventory();
    } catch (failure) {
      setConsent(false);
      if (typeof failure === 'object' && failure && 'status' in failure) {
        const status=Number(failure.status);
        if (status===409) setConflict(true);
        if (kind==='reply' && status>=400 && status<500) persist({...saved,attempt:undefined});
      }
      setError(toUserFacingError(failure));
    } finally { lock.current = false; setBusy(false); }
  };

  const changeText = (text: string) => {
    if (busy || (preview?.status === 'awaiting_confirmation' && !correcting)) return;
    try { persist({ ...saved, text, attempt: undefined }); setError(''); }
    catch (failure) { setError(toUserFacingError(failure)); }
  };
  const startNew = () => {
    if (busy || unresolvedWrite || (pending && !conflict)) return;
    try { persist({ text: '' }); setPreview(null); setConsent(false); setCorrecting(false); setConflict(false); setError(''); setRefreshError(''); }
    catch (failure) { setError(toUserFacingError(failure)); }
  };
  const beginCorrection = () => {
    if (busy || expired || conflict || saved.attempt || preview?.status !== 'awaiting_confirmation') return;
    try { persist({text:'',draftId:preview.draftId,correcting:true}); setCorrecting(true); setConsent(false); setError(''); }
    catch (failure) { setError(toUserFacingError(failure)); }
  };

  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-3">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="universal-review-title" aria-busy={busy} className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-sky-500/30 bg-[#101a2e] p-5 text-slate-100 shadow-2xl" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }
    }}>
      <header className="flex items-center justify-between gap-3"><h2 id="universal-review-title" className="text-xl font-semibold">Revisar operación</h2><button type="button" onClick={onClose} className={button} aria-label="Cerrar revisión">Cerrar</button></header>
      <p className="mt-3 text-sm text-slate-300">Describí los cambios. Revisalos completos antes de confirmar.</p>
      {preview?.status === 'applied' ? <p role="status" className="mt-4 rounded-xl bg-emerald-500/15 p-3 text-emerald-200">Operación aplicada correctamente.</p> : preview?.status === 'cancelled' ? <p role="status" className="mt-4">Operación cancelada.</p> : <>
        {preview?.question && <p className="mt-4 rounded-xl bg-sky-500/15 p-3">{preview.question}</p>}
        <label htmlFor="universal-operation-text" className="mt-4 block text-sm font-medium">{correcting ? 'Corrección' : preview?.status === 'awaiting_clarification' ? 'Tu respuesta' : 'Solicitud'}</label>
        <textarea id="universal-operation-text" value={saved.text} maxLength={12000} rows={4} disabled={busy || !hydrated || !session || Boolean(saved.draftId && !preview) || (preview?.status === 'awaiting_confirmation' && !correcting)} onChange={event => changeText(event.target.value)} className="mt-2 w-full rounded-xl border border-sky-500/25 bg-slate-950/60 p-3 disabled:opacity-60" />
        {correcting && <p className="mt-2 text-sm text-slate-300">Indicá qué dato querés corregir. Revisarás todos los cambios antes de confirmar la nueva versión.</p>}
      </>}
      {preview?.review && <ol className="mt-4 space-y-3">{preview.review.map(item => <li key={item.itemId} className="rounded-xl border border-sky-500/20 p-3"><h3 className="font-semibold">{item.title}</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-200">{item.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul></li>)}</ol>}
      {expired && pending && <p role="status" className="mt-4 text-amber-200">Esta revisión venció. Recuperá su estado o cancelala para comenzar otra.</p>}
      {conflict && <p className="mt-4 text-amber-200">La revisión cambió. Recuperá el estado antes de confirmar nuevamente.</p>}
      {preview?.status === 'awaiting_confirmation' && !correcting && <label className="mt-4 flex items-start gap-3"><input type="checkbox" checked={consent} disabled={busy || expired || conflict || !completeReview} onChange={event => setConsent(event.target.checked)} /><span className="text-sm">Revisé todos los cambios y autorizo aplicar esta operación.</span></label>}
      {preview?.status === 'awaiting_confirmation' && !completeReview && <p role="alert" className="mt-3 text-amber-200">No está disponible la revisión completa. Recuperá el estado para continuar.</p>}
      {error && <p role="alert" className="mt-4 text-rose-200">{error}</p>}
      {unresolvedWrite && <p className="mt-3 text-sm text-amber-200">Hay una confirmación o cancelación pendiente de recuperar. Conservamos su referencia para consultar el resultado antes de iniciar otra operación.</p>}
      {refreshError && <div role="alert" className="mt-4 text-amber-200"><p>{refreshError}</p><button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => void updateInventory()}>Actualizar datos</button></div>}
      <div className="mt-5 flex flex-wrap gap-2">
        {!preview && !saved.draftId && <button type="button" className={`${button} bg-sky-600`} disabled={busy || !hydrated || !saved.text.trim()} onClick={() => void submit('prepare')}>{saved.attempt ? 'Reintentar revisión' : 'Preparar revisión'}</button>}
        {preview?.status === 'awaiting_clarification' && <button type="button" className={`${button} bg-sky-600`} disabled={busy || !saved.text.trim() || conflict} onClick={() => void submit('reply')}>Enviar respuesta</button>}
        {preview?.status === 'awaiting_confirmation' && !correcting && <button type="button" className={`${button} bg-emerald-600`} disabled={busy || !consent || conflict || expired || !completeReview} onClick={() => void submit('confirm')}>Confirmar operación</button>}
        {preview?.status === 'awaiting_confirmation' && !correcting && <button type="button" className={button} disabled={busy || expired || conflict || Boolean(saved.attempt)} onClick={beginCorrection}>Corregir revisión</button>}
        {correcting && <button type="button" className={`${button} bg-sky-600`} disabled={busy || !saved.text.trim() || conflict} onClick={() => void submit('reply')}>Revisar corrección</button>}
        {correcting && <button type="button" className={button} disabled={busy} onClick={() => void recover(true)}>Volver a revisión</button>}
        {pending && <button type="button" className={button} disabled={busy} onClick={() => void submit('cancel')}>Cancelar operación</button>}
        {saved.draftId && <button type="button" className={button} disabled={busy} onClick={() => void recover()}>Recuperar estado</button>}
        {(!pending || conflict) && !unresolvedWrite && (preview || saved.draftId || saved.attempt) && <button type="button" className={button} disabled={busy} onClick={startNew}>Nueva operación</button>}
      </div>
      {busy && <p role="status" className="mt-3 text-sm text-slate-300">Procesando…</p>}
    </div>
  </div>;
}
