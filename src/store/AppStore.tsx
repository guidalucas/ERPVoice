import { createContext, useContext, useReducer, type ReactNode } from 'react';
import type { AppState, ChatMessage, ParsedVoicePayload } from '../domain/types';
import { initialAppState } from '../domain/mockDb';
import { applyConfirmedActions } from '../services/transactionService';

type AppAction =
  | { type: 'ADD_CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'SET_PENDING_PROPOSAL'; payload: ParsedVoicePayload | null }
  | { type: 'CONFIRM_PENDING_PROPOSAL' }
  | { type: 'CLEAR_PENDING_PROPOSAL' };

interface AppStoreValue {
  state: AppState;
  addChatMessage: (message: ChatMessage) => void;
  setPendingProposal: (payload: ParsedVoicePayload | null) => void;
  confirmPendingProposal: () => void;
  clearPendingProposal: () => void;
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
    default:
      return state;
  }
};

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);

  const value: AppStoreValue = {
    state,
    addChatMessage: (message) => dispatch({ type: 'ADD_CHAT_MESSAGE', message }),
    setPendingProposal: (payload) => dispatch({ type: 'SET_PENDING_PROPOSAL', payload }),
    confirmPendingProposal: () => dispatch({ type: 'CONFIRM_PENDING_PROPOSAL' }),
    clearPendingProposal: () => dispatch({ type: 'CLEAR_PENDING_PROPOSAL' }),
  };

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