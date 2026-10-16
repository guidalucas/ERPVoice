import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { AppState, ChatMessage, ParsedVoicePayload, Product, Client, Pedido, Proveedor, Transaction } from '../domain/types';
import { initialAppState } from '../domain/mockDb';
import { applyConfirmedActions } from '../services/transactionService';
import { requestJson } from '../services/apiClient';

type PersistedSnapshot = {
  products: Product[];
  clients: Client[];
  proveedores?: Proveedor[];
  pedidos: Pedido[];
  transactions: Transaction[];
};

type AppAction =
  | { type: 'ADD_CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'SET_PENDING_PROPOSAL'; payload: ParsedVoicePayload | null }
  | { type: 'CLEAR_PENDING_PROPOSAL'; proposal?: ParsedVoicePayload }
  | { type: 'APPLY_EXTERNAL_PROPOSAL'; payload: ParsedVoicePayload }
  | { type: 'HYDRATE_PERSISTED_STATE'; snapshot: PersistedSnapshot };

interface AppStoreValue {
  state: AppState;
  addChatMessage: (message: ChatMessage) => void;
  setPendingProposal: (payload: ParsedVoicePayload | null) => void;
  confirmPendingProposal: () => Promise<void>;
  clearPendingProposal: () => void;
  applyExternalProposal: (payload: ParsedVoicePayload) => void;
  hydratePersistedState: (snapshot: PersistedSnapshot) => void;
}

const AppStoreContext = createContext<AppStoreValue | null>(null);

const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'ADD_CHAT_MESSAGE':
      return {
        ...state,
        chatMessages: [...state.chatMessages, action.message],
      };
    case 'SET_PENDING_PROPOSAL':
      return {
        ...state,
        pendingProposal: action.payload,
      };
    case 'CLEAR_PENDING_PROPOSAL':
      return {
        ...state,
        pendingProposal: action.proposal && state.pendingProposal !== action.proposal ? state.pendingProposal : null,
      };
    case 'APPLY_EXTERNAL_PROPOSAL':
      return applyConfirmedActions(state, action.payload.actions, action.payload.sourceText);
    case 'HYDRATE_PERSISTED_STATE':
      return {
        ...state,
        products: action.snapshot.products,
        clients: action.snapshot.clients,
        proveedores: action.snapshot.proveedores ?? [],
        pedidos: action.snapshot.pedidos ?? [],
        transactions: action.snapshot.transactions,
      };
    default:
      return state;
  }
};

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const pendingProposalRef = useRef(state.pendingProposal);
  const confirmationRef = useRef<Promise<void> | null>(null);

  const confirmPendingProposal = useCallback(() => {
    if (confirmationRef.current) {
      return confirmationRef.current;
    }

    const proposal = pendingProposalRef.current;

    if (!proposal) {
      return Promise.resolve();
    }

    const confirmation = (async () => {
      try {
        const snapshot = await requestJson<PersistedSnapshot>('/api/state/apply', {
          method: 'POST',
          body: JSON.stringify({
            sourceText: proposal.sourceText,
            actions: proposal.actions,
            operationId: proposal.operationId,
          }),
        });

        if (!Array.isArray(snapshot?.products) || !Array.isArray(snapshot?.clients) || !Array.isArray(snapshot?.transactions)) {
          throw new Error('No se pudo verificar la confirmación. Intentá de nuevo.');
        }

        dispatch({ type: 'HYDRATE_PERSISTED_STATE', snapshot });
        dispatch({ type: 'CLEAR_PENDING_PROPOSAL', proposal });
        if (pendingProposalRef.current === proposal) {
          pendingProposalRef.current = null;
        }
      } finally {
        confirmationRef.current = null;
      }
    })();
    confirmationRef.current = confirmation;
    return confirmation;
  }, []);

  const addChatMessage = useCallback((message: ChatMessage) => {
    dispatch({ type: 'ADD_CHAT_MESSAGE', message });
  }, []);

  const setPendingProposal = useCallback((payload: ParsedVoicePayload | null) => {
    const proposal = payload ? { ...payload, operationId: payload.operationId ?? crypto.randomUUID() } : null;
    pendingProposalRef.current = proposal;
    dispatch({ type: 'SET_PENDING_PROPOSAL', payload: proposal });
  }, []);

  const clearPendingProposal = useCallback(() => {
    pendingProposalRef.current = null;
    dispatch({ type: 'CLEAR_PENDING_PROPOSAL' });
  }, []);

  const applyExternalProposal = useCallback((payload: ParsedVoicePayload) => {
    pendingProposalRef.current = null;
    dispatch({ type: 'APPLY_EXTERNAL_PROPOSAL', payload });
  }, []);

  const hydratePersistedState = useCallback((snapshot: PersistedSnapshot) => {
    dispatch({ type: 'HYDRATE_PERSISTED_STATE', snapshot });
  }, []);

  const value: AppStoreValue = useMemo(
    () => ({
      state,
      addChatMessage,
      setPendingProposal,
      confirmPendingProposal,
      clearPendingProposal,
      applyExternalProposal,
      hydratePersistedState,
    }),
    [state, addChatMessage, setPendingProposal, confirmPendingProposal, clearPendingProposal, applyExternalProposal, hydratePersistedState],
  );

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export const useAppStore = () => {
  const context = useContext(AppStoreContext);

  if (!context) {
    throw new Error('useAppStore must be used within AppStoreProvider');
  }

  return context;
};

export const createChatMessage = (role: ChatMessage['role'], text: string, parsedPayload?: ParsedVoicePayload): ChatMessage => ({
  id: createId('message'),
  role,
  text,
  parsedPayload,
});
