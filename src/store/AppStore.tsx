import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type { AppState, ChatMessage, ParsedVoicePayload, Product, Client, Pedido, Proveedor, Transaction } from '../domain/types';
import { initialAppState } from '../domain/mockDb';

type PersistedSnapshot = {
  products: Product[];
  clients: Client[];
  proveedores?: Proveedor[];
  pedidos: Pedido[];
  transactions: Transaction[];
};

type AppAction =
  | { type: 'ADD_CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'HYDRATE_PERSISTED_STATE'; snapshot: PersistedSnapshot };

interface AppStoreValue {
  state: AppState;
  addChatMessage: (message: ChatMessage) => void;
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

  const addChatMessage = useCallback((message: ChatMessage) => {
    dispatch({ type: 'ADD_CHAT_MESSAGE', message });
  }, []);

  const hydratePersistedState = useCallback((snapshot: PersistedSnapshot) => {
    dispatch({ type: 'HYDRATE_PERSISTED_STATE', snapshot });
  }, []);

  const value: AppStoreValue = useMemo(
    () => ({
      state,
      addChatMessage,
      hydratePersistedState,
    }),
    [state, addChatMessage, hydratePersistedState],
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
