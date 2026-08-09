import type { AppState } from './types';

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

export const initialAppState: AppState = {
  products: [],
  clients: [],
  proveedores: [],
  pedidos: [],
  transactions: [],
  chatMessages: [
    {
      id: createId('message'),
      role: 'bot',
      text: 'Hola! Soy Stocky. Podés escribir o grabar comandos como "Juan me pidió una camiseta de Boca talle M" o "compré 10 camisetas de Argentina".',
    },
  ],
  pendingProposal: null,
};