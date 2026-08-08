import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type { AppState, ChatMessage, ParsedVoicePayload, Product, Client, Pedido, Transaction } from '../domain/types';
import { initialAppState } from '../domain/mockDb';
import { applyConfirmedActions } from '../services/transactionService';
import { requestJson } from '../services/apiClient';

type PersistedSnapshot = {
  products: Product[];
  clients: Client[];
  pedidos: Pedido[];
  transactions: Transaction[];
};

type AppAction =
  | { type: 'ADD_CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'SET_PENDING_PROPOSAL'; payload: ParsedVoicePayload | null }
  | { type: 'CONFIRM_PENDING_PROPOSAL' }
  | { type: 'CLEAR_PENDING_PROPOSAL' }
  | { type: 'APPLY_EXTERNAL_PROPOSAL'; payload: ParsedVoicePayload }
  | { type: 'HYDRATE_PERSISTED_STATE'; snapshot: PersistedSnapshot };

interface AppStoreValue {
  state: AppState;
  addChatMessage: (message: ChatMessage) => void;
  setPendingProposal: (payload: ParsedVoicePayload | null) => void;
  confirmPendingProposal: () => void;
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
    case 'CONFIRM_PENDING_PROPOSAL':
      return state.pendingProposal ? applyConfirmedActions(state, state.pendingProposal.actions, state.pendingProposal.sourceText) : state;
    case 'CLEAR_PENDING_PROPOSAL':
      return {
        ...state,
        pendingProposal: null,
      };
    case 'APPLY_EXTERNAL_PROPOSAL':
      return applyConfirmedActions(state, action.payload.actions, action.payload.sourceText);
    case 'HYDRATE_PERSISTED_STATE':
      return {
        ...state,
        products: action.snapshot.products,
        clients: action.snapshot.clients,
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

  const confirmPendingProposal = useCallback(() => {
    const proposal = state.pendingProposal;

    if (!proposal) {
      return;
    }

    dispatch({ type: 'CONFIRM_PENDING_PROPOSAL' });

    void requestJson<PersistedSnapshot>('/api/state/apply', {
      method: 'POST',
      body: JSON.stringify({
        sourceText: proposal.sourceText,
        actions: proposal.actions,
      }),
    })
      .then((snapshot) => {
        if (snapshot?.products && snapshot?.clients && snapshot?.transactions) {
          dispatch({
            type: 'HYDRATE_PERSISTED_STATE',
            snapshot: {
              products: snapshot.products,
              clients: snapshot.clients,
              pedidos: snapshot.pedidos ?? [],
              transactions: snapshot.transactions,
            },
          });
        }
      })
      .catch(() => {
        // best-effort persistence
      });
  }, [state.pendingProposal]);

  const addChatMessage = useCallback((message: ChatMessage) => {
    dispatch({ type: 'ADD_CHAT_MESSAGE', message });
  }, []);

  const setPendingProposal = useCallback((payload: ParsedVoicePayload | null) => {
    dispatch({ type: 'SET_PENDING_PROPOSAL', payload });
  }, []);

  const clearPendingProposal = useCallback(() => {
    dispatch({ type: 'CLEAR_PENDING_PROPOSAL' });
  }, []);

  const applyExternalProposal = useCallback((payload: ParsedVoicePayload) => {
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
