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

export interface Proveedor {
  id: string;
  name: string;
  notas?: string | null;
}

export type PedidoEstado = 'pendiente' | 'conseguido' | 'descartado';

export interface Pedido {
  id: string;
  clienteId: string;
  proveedorId?: string | null;
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
  | 'query_stock'
  | 'query_pedidos'
  | 'update_product'
  | 'update_pedido'
  | 'delete_pedido'
  | 'delete_product'
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
      clientName?: string;
      proveedorName?: string;
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      qty?: number;
      notas?: string;
    }
  | {
      type: 'query_stock';
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      groupBy?: 'size';
    }
  | {
      type: 'query_pedidos';
      estado?: PedidoEstado | 'todos';
      clientName?: string;
      proveedorName?: string;
      productName?: string;
    }
  | {
      type: 'update_product';
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      price?: number;
      stockAvailable?: number;
    }
  | {
      type: 'update_pedido';
      productName: string;
      qty?: number;
      size?: string;
      estado?: PedidoEstado;
      clientName?: string;
    }
  | {
      type: 'delete_pedido';
      productName: string;
      clientName?: string;
    }
  | {
      type: 'delete_product';
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
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
  proveedores: Proveedor[];
  pedidos: Pedido[];
  transactions: Transaction[];
  chatMessages: ChatMessage[];
  pendingProposal: ParsedVoicePayload | null;
}
