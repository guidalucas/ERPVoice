export type InventoryAttribute = { unit?: string } & (
  | { state: 'known'; type: 'text'; value: string }
  | { state: 'known'; type: 'number'; value: number }
  | { state: 'known'; type: 'boolean'; value: boolean }
  | { state: 'unknown' | 'not_applicable' | 'missing'; type: 'text' | 'number' | 'boolean'; value?: never }
);

export type InventoryAttributes = Record<string, InventoryAttribute>;

export interface Product {
  revision?: number;
  identityFingerprint?: string;
  id: string;
  name: string;
  productType?: string | null;
  productModel?: string | null;
  size?: string | null;
  stockAvailable: number;
  stockReserved: number;
  price: number;
  attributes?: InventoryAttributes;
  unit?: string;
  priceCurrency?: string;
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
  revision?: number;
  productId?: string | null;
  stockPosting?: { skuId: string; quantity: number; unit: string } | null;
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
      productId?: string;
      expectedFingerprint?: string;
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      qty: number;
      price?: number;
      unit?: string;
      priceCurrency?: string;
    }
  | {
      type: 'reserve_stock';
      productId?: string;
      expectedFingerprint?: string;
      unit?: string;
      priceCurrency?: string;
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
      productId?: string;
      expectedRevision?: number;
      expectedFingerprint?: string;
      reason?: string;
      priceCurrency?: string;
      productName: string;
      productType?: string;
      productModel?: string;
      size?: string;
      price?: number;
      stockAvailable?: number;
      stockReserved?: number;
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
  productId?: string;
  expectedFingerprint?: string;
  unit?: string;
  priceCurrency?: string;
  salePriceKnown?: boolean;
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
  operationId?: string;
  sourceText: string;
  intent: VoiceIntent;
  confidence: number;
  requiresConfirmation: boolean;
  actions: ParsedActionUnion[];
  missingFields?: string[];
  suggestedPhrases?: string[];
}

/** System creation receipt; never accepted as a parsed voice command. */
export type ProductCreatedAction = {
  type: 'create_product';
  productId: string;
  productName: string;
  productType?: string;
  productModel?: string;
  size?: string;
  stockAvailable: number;
  stockReserved: number;
  unit: string;
  price: number;
  priceCurrency: string;
  revision: number;
  reason: string;
};

export type StockWithdrawnAction = { type: 'withdraw_stock'; productId: string; qty: number; unit?: string; reason: string };

export interface Transaction {
  id: string;
  timestamp: string;
  sourceText: string;
  actions: Array<ParsedActionUnion | ProductCreatedAction | StockWithdrawnAction>;
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
