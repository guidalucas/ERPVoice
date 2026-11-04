import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ModalPortal } from './ModalPortal';
import './confirmation.css';

type Confirmation = { title: string; description?: string; action?: string; destructive?: boolean };
type Confirm = (options: Confirmation) => Promise<boolean>;
const Context = createContext<Confirm | null>(null);

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const pending = useRef<((answer: boolean) => void) | null>(null);
  const confirm = useCallback<Confirm>(options => {
    if (pending.current) return Promise.resolve(false);
    return new Promise(resolve => { pending.current = resolve; setRequest(options); });
  }, []);
  const finish = (answer: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(answer);
  };
  useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);
  return <Context.Provider value={confirm}>{children}{request && <ModalPortal>
    <div className="confirmation-overlay" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby={request.description ? 'confirmation-description' : undefined} className="confirmation-dialog">
        <h2 id="confirmation-title">{request.title}</h2>
        {request.description && <p id="confirmation-description">{request.description}</p>}
        <div className="confirmation-actions">
          <button type="button" autoFocus onClick={() => finish(false)}>No, cancelar</button>
          <button type="button" className={request.destructive ? 'confirmation-danger' : 'confirmation-yes'} onClick={() => finish(true)}>Sí, {request.action ?? 'confirmar'}</button>
        </div>
      </div>
    </div>
  </ModalPortal>}</Context.Provider>;
}

export function useConfirm(): Confirm {
  const confirm = useContext(Context);
  if (!confirm) throw new Error('Falta ConfirmationProvider.');
  return confirm;
}
