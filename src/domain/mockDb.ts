import type { AppState } from './types';

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

export const initialAppState: AppState = {
  products: [
    {
      id: 'product-boca-titular-2026',
      name: 'Camiseta Boca Titular 2026',
      stockAvailable: 0,
      stockReserved: 0,
      price: 50000,
    },
    {
      id: 'product-argentina-suplente',
      name: 'Camiseta Argentina Suplente',
      stockAvailable: 0,
      stockReserved: 0,
      price: 55000,
    },
  ],
  clients: [
    {
      id: 'client-gimnasio-el-refugio',
      name: 'Gimnasio El Refugio',
      debt: 0,
    },
  ],
  transactions: [],
  chatMessages: [
    {
      id: createId('message'),
      role: 'bot',
      text: 'Listo. Dictame un movimiento o probá con la frase de ejemplo.',
    },
  ],
  pendingProposal: null,
};