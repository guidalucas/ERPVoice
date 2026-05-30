export interface Product {
  id: string;
  name: string;
  stockAvailable: number;
  stockReserved: number;
  price: number;
}

export interface Client {
  id: string;
  name: string;
  debt: number;
}

export type VoiceIntent = 'add_stock' | 'reserve_stock' | 'sell' | 'add_debt' | 'payment_received' | 'mixed' | 'unknown';

export type ParsedAction =
  | {
      type: 'add_stock';
      productName: string;
      qty: number;
    }
  | {
      type: 'reserve_stock';
      productName: string;
      qty: number;
      clientName?: string;
    }
  | {
      type: 'add_debt';
      clientName: string;
      amount: number;
      productName?: string;
      qty?: number;
    }
  | {
      type: 'payment_received';
      clientName: string;
      amount: number;
    };

// Sell/venta action
export type ParsedActionSell = {
  type: 'sell';
  productName: string;
  qty: number;
};

// Extend the union to include sell
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
  transactions: Transaction[];
  chatMessages: ChatMessage[];
  pendingProposal: ParsedVoicePayload | null;
}