export interface Product {
  id: string;
  name: string;
  productType?: string | null;
  productModel?: string | null;
  size?: string | null;
  stockAvailable: number;
  stockReserved: number;
  price: number;
}

export interface Client {
  id: string;
  name: string;
  debt: number;
  notas?: string | null;
}

export type PedidoEstado = 'pendiente' | 'conseguido' | 'descartado';

export interface Pedido {
  id: string;
  clienteId: string;
  producto: string;
  productType?: string | null;
  productModel?: string | null;
  talle?: string | null;
  qty: number;
  estado: PedidoEstado;
  fechaPedido: string;
  notas?: string | null;
}

export type VoiceIntent =
  | 'add_stock'
  | 'reserve_stock'
  | 'sell'
  | 'add_debt'
  | 'payment_received'
  | 'client_order'
  | 'mixed'
  | 'unknown';

export type ParsedAction =
  | {
      type: 'add_stock';
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      qty: number;
      price?: number;
    }
  | {
      type: 'reserve_stock';
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      qty: number;
      clientName?: string;
      price?: number;
    }
  | {
      type: 'add_debt';
      clientName: string;
      amount: number;
      productName?: string;
      productType?: string;
      productModel?: string;
      size?: string;
      qty?: number;
    }
  | {
      type: 'payment_received';
      clientName: string;
      amount: number;
    }
  | {
      type: 'client_order';
      clientName: string;
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      qty?: number;
      notas?: string;
    };

export type ParsedActionSell = {
  type: 'sell';
  productName: string;
  productType?: string;
  productModel?: string;
  size?: string;
  qty: number;
  price?: number;
};

export type ParsedActionUnion = ParsedAction | ParsedActionSell;

export type ParsedActionExtended = ParsedAction | { type: 'sell'; productName: string; qty: number };

export interface ParsedVoicePayload {
  schemaVersion: 1;
  sourceText: string;
  intent: VoiceIntent;
  confidence: number;
  requiresConfirmation: boolean;
  actions: ParsedActionUnion[];
  missingFields?: string[];
  suggestedPhrases?: string[];
}

export interface Transaction {
  id: string;
  timestamp: string;
  sourceText: string;
  actions: ParsedActionUnion[];
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'bot';
  text: string;
  parsedPayload?: ParsedVoicePayload;
}

export interface AppState {
  products: Product[];
  clients: Client[];
  pedidos: Pedido[];
  transactions: Transaction[];
  chatMessages: ChatMessage[];
  pendingProposal: ParsedVoicePayload | null;
}
