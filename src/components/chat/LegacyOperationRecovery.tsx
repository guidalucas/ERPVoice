import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../domain/types';
import { useAppStore } from '../../store/AppStore';
import { requestJson, toUserFacingError } from '../../services/apiClient';
import { archivePendingProposal, restorePendingProposal } from '../../services/pendingProposalStorage';
import { checkOperationRecovery, type OperationRecovery } from '../../services/operationRecoveryService';

const button = 'mt-2 rounded-xl border border-sky-500/30 px-3 py-2 text-sm disabled:opacity-40';

export function LegacyOperationRecovery({ storageKey, copyToComposer, openReview }: {
  storageKey: string; copyToComposer: (text: string) => boolean; openReview: (text: string) => void;
}) {
  const [proposal, setProposal] = useState(() => restorePendingProposal(storageKey));
  const [result, setResult] = useState<OperationRecovery | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const lock = useRef(false);
  const { hydratePersistedState } = useAppStore();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const refreshReads = async () => {
    try {
      const snapshot = await requestJson<Pick<AppState, 'products' | 'clients' | 'proveedores' | 'pedidos' | 'transactions'>>('/api/state');
      if (!active.current) return;
      if (!snapshot || !Array.isArray(snapshot.products) || !Array.isArray(snapshot.clients) || !Array.isArray(snapshot.transactions)) throw new Error('Respuesta incompleta');
      hydratePersistedState(snapshot); setRefreshError('');
    } catch { if (active.current) setRefreshError('La operación ya está aplicada, pero no pudimos actualizar los datos. Reintentá la actualización.'); }
  };
  const check = async () => {
    if (!proposal || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setResult(null);
    try {
      const current = await checkOperationRecovery(proposal);
      if (!active.current) return;
      setResult(current);
      if (current.status === 'applied') await refreshReads();
    } catch (failure) { if (active.current) setError(toUserFacingError(failure)); }
    finally { if (active.current) { lock.current = false; setBusy(false); } }
  };
  const handoff = () => {
    if (!active.current || lock.current || !proposal || !proposal.sourceText.trim() || result?.status !== 'not_applied') return;
    if (!copyToComposer(proposal.sourceText)) { setError('No pudimos guardar el texto en el chat. Conservamos la propuesta anterior.'); return; }
    if (!archivePendingProposal(storageKey, proposal)) { setError('No pudimos archivar la propuesta anterior. Conservamos el original y la copia en el chat.'); return; }
    setProposal(null);
    openReview(proposal.sourceText);
  };
  const archiveApplied = () => {
    if (!active.current || lock.current || !proposal || result?.status !== 'applied') return;
    if (!archivePendingProposal(storageKey, proposal, 'verified-applied')) { setError('No pudimos archivar la propuesta anterior. Conservamos el original.'); return; }
    setProposal(null);
  };

  if (!proposal) return null;
  return <section aria-label="Recuperar operación anterior" className="mx-3 mb-3 shrink-0 rounded-xl border border-amber-500/30 p-3 text-sm text-slate-200">
    <h3 className="font-semibold">Operación anterior pendiente de verificar</h3>
    <p className="mt-1 whitespace-pre-wrap">{proposal.sourceText}</p>
    <p className="mt-2">Consultá si ya fue aplicada antes de preparar una nueva revisión.</p>
    <button type="button" className={button} disabled={busy} onClick={() => void check()}>Consultar estado</button>
    {result?.status === 'applied' && <div><p role="status" className="mt-2">La operación anterior ya fue aplicada. No se creará otra operación.</p><button type="button" className={button} disabled={busy || Boolean(refreshError)} onClick={archiveApplied}>Archivar operación verificada</button></div>}
    {result?.status === 'not_applied' && <div><p role="status" className="mt-2">La operación anterior no fue aplicada. Podés llevar su texto a una nueva revisión.</p>{!proposal.sourceText.trim() && <p role="alert">La propuesta no tiene texto original para revisar. Conservamos su referencia.</p>}<button type="button" className={button} disabled={busy || !proposal.sourceText.trim()} onClick={handoff}>Preparar revisión universal</button></div>}
    {error && <p role="alert" className="mt-2 text-amber-200">{error}</p>}
    {refreshError && <div role="alert"><p>{refreshError}</p><button type="button" className={button} disabled={busy} onClick={() => void refreshReads()}>Actualizar datos</button></div>}
  </section>;
}
