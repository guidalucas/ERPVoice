import type { AppState } from './types';

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

export const initialAppState: AppState = {
  products: [],
  clients: [],
  transactions: [],
  chatMessages: [
    {
      id: createId('message'),
      role: 'bot',
      text: 'Hola! Soy ERPVoice. Podés escribir o grabar comandos como "vendí 3 remeras a Juan" o "agregá 10 pantalones".',
    },
  ],
  pendingProposal: null,
};