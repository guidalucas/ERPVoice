import type { Client, InventoryAttributes, ParsedActionUnion, Pedido, PedidoEstado, Product, Proveedor, Transaction } from '../domain/types';
import { requestJson } from './apiClient';

export type PersistedState = {
  products: Product[];
  clients: Client[];
  proveedores: Proveedor[];
  pedidos: Pedido[];
  transactions: Transaction[];
};

export type ProductInput = {
  name: string;
  productType?: string | null;
  productModel?: string | null;
  size?: string | null;
  attributes?: InventoryAttributes;
  unit?: string;
  priceCurrency?: string;
  stockAvailable?: number;
  stockReserved?: number;
  price?: number;
};

export type ProductAdjustment = {
  operationId: string;
  expectedRevision: number;
  expectedFingerprint?: string;
  reason: string;
};

export type ClientInput = {
  name: string;
  notas?: string | null;
  debt?: number;
};

export type ProveedorInput = {
  name: string;
  notas?: string | null;
};

export type PedidoInput = {
  operationId: string;
  productId?: string | null;
  clienteId: string;
  proveedorId?: string | null;
  producto: string;
  productType?: string | null;
  productModel?: string | null;
  talle?: string | null;
  qty?: number;
  estado?: PedidoEstado;
  notas?: string | null;
};

export const fetchPersistedState = async () => requestJson<PersistedState>('/api/state');

/** Aplica acciones con el mismo shape que el parser de voz (add_stock, sell, etc.). */
export const applyStateActions = async (sourceText: string, actions: ParsedActionUnion[], operationId: string = crypto.randomUUID()) =>
  requestJson<PersistedState>('/api/state/apply', {
    method: 'POST',
    body: JSON.stringify({ sourceText, actions, operationId }),
  });

export type ProductCreation = { operationId: string };
export type ProductModelInput = { productType: string; productModel: string; attributes?: InventoryAttributes; unit?: string; priceCurrency?: string; variants: Array<{ size: string; stockAvailable: number; stockReserved?: number; price: number }> };

export const createProduct = async (product: ProductInput, metadata: ProductCreation) =>
  requestJson<Product>('/api/products', {
    method: 'POST',
    body: JSON.stringify({ ...product, operationId: metadata.operationId }),
  });

export const createProductModel = async (input: ProductModelInput, metadata: ProductCreation) =>
  requestJson<Product[]>('/api/products/model', {
    method: 'POST',
    body: JSON.stringify({ ...input, operationId: metadata.operationId }),
  });

export const updateProduct = async (productId: string, product: Partial<ProductInput>, adjustment: ProductAdjustment) =>
  requestJson<Product>(`/api/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...product, ...adjustment }),
  });

export type InventorySelectionMutation =
  | { type: 'sku.update'; changes: { name: string; productType: string; productModel: string }; reason: string }
  | { type: 'sku.deactivate'; reason: string }
  | { type: 'stock.adjust'; balances: { available?: number; reserved?: number }; reason: string };

export type InventorySelectionReference = { selectionId: string; digest: string };

export type InventorySelectionRequest = {
  requestId: string;
  selector: { kind: 'ids'; skuIds: string[] };
  mutation: InventorySelectionMutation;
};

export type InventorySelectionPreview = {
  selectionId: string;
  digest: string;
  expiresAt: string;
  status: 'pending';
  members: Array<{ skuId: string; name: string; size: string | null; revision: number; stockAvailable: number; stockReserved: number; price: number; priceCurrency: string; unit?: string; finalAvailable?: number; finalReserved?: number }>;
  mutation: InventorySelectionRequest['mutation'];
};

export const previewInventorySelection = async (input: InventorySelectionRequest): Promise<InventorySelectionPreview> => {
  const preview = await requestJson<InventorySelectionPreview>('/api/inventory/selections', {
    method: 'POST', body: JSON.stringify(input),
  });
  const ids = new Set(input.selector.skuIds);
  const mutationMatches = (mutation: InventorySelectionMutation | undefined) => {
    if (!mutation || mutation.type !== input.mutation.type || mutation.reason !== input.mutation.reason) return false;
    if (mutation.type === 'sku.deactivate') return Object.keys(mutation).sort().join(',') === 'reason,type';
    if (mutation.type === 'stock.adjust') {
      if (input.mutation.type !== 'stock.adjust' || Object.keys(mutation).sort().join(',') !== 'balances,reason,type'
        || !mutation.balances || typeof mutation.balances !== 'object' || Array.isArray(mutation.balances)) return false;
      const keys = Object.keys(mutation.balances);
      const expected = input.mutation.balances;
      return keys.length > 0 && keys.length <= 2 && keys.sort().join(',') === Object.keys(expected).sort().join(',')
        && keys.every((key) => (key === 'available' || key === 'reserved')
          && Number.isSafeInteger(mutation.balances[key]) && mutation.balances[key]! >= 0
          && mutation.balances[key] === expected[key]);
    }
    if (input.mutation.type !== 'sku.update' || Object.keys(mutation).sort().join(',') !== 'changes,reason,type'
      || !mutation.changes || Object.keys(mutation.changes).sort().join(',') !== 'name,productModel,productType') return false;
    return (['name', 'productType', 'productModel'] as const).every((key) => mutation.changes[key] === (input.mutation as Extract<InventorySelectionMutation, { type: 'sku.update' }>).changes[key]);
  };
  if (!preview || typeof preview.selectionId !== 'string' || !preview.selectionId.trim()
    || typeof preview.digest !== 'string' || !preview.digest.trim() || preview.status !== 'pending'
    || typeof preview.expiresAt !== 'string' || !Number.isFinite(Date.parse(preview.expiresAt))
    || !Array.isArray(preview.members) || preview.members.length !== ids.size
    || new Set(preview.members.map((member) => member?.skuId)).size !== ids.size
    || preview.members.some((member) => !member || !ids.has(member.skuId) || typeof member.name !== 'string'
      || !(member.size === null || typeof member.size === 'string')
      || !Number.isSafeInteger(member.revision) || member.revision < 0
      || ![member.stockAvailable, member.stockReserved, member.price].every((value) => Number.isSafeInteger(value) && value >= 0)
      || (input.mutation.type === 'stock.adjust' && (typeof member.unit !== 'string' || !member.unit.trim()
        || !Number.isSafeInteger(member.finalAvailable) || !Number.isSafeInteger(member.finalReserved)
        || member.finalAvailable !== (input.mutation.balances.available ?? member.stockAvailable)
        || member.finalReserved !== (input.mutation.balances.reserved ?? member.stockReserved)))
      || typeof member.priceCurrency !== 'string' || !member.priceCurrency.trim())
    || !mutationMatches(preview.mutation)) {
    throw new Error('La vista previa no coincide con la selección solicitada. No se aplicaron cambios.');
  }
  return preview;
};

export const confirmInventorySelection = async ({ selectionId, digest }: InventorySelectionReference) =>
  requestJson<unknown>(`/api/inventory/selections/${selectionId}/confirm`, {
    method: 'POST', body: JSON.stringify({ digest }),
  });

export const updateProductModel = async (input: { selectionId: string; digest: string }) =>
  requestJson<Product[]>('/api/products/model', {
    method: 'PUT',
    body: JSON.stringify(input),
  });

export const deleteProduct = async (productId: string, selection: InventorySelectionReference) =>
  requestJson<{ deleted: number; operationResult: unknown }>(`/api/products/${productId}`, {
    method: 'DELETE',
    body: JSON.stringify(selection),
  });

export const deleteProducts = async (selection: InventorySelectionReference) =>
  requestJson<{ deleted: number; operationResult: unknown }>('/api/products/batch', {
    method: 'DELETE',
    body: JSON.stringify(selection),
  });

export type ClientCreateInput = ClientInput & { operationId: string };
export type ProveedorCreateInput = ProveedorInput & { operationId: string };

export const createClient = async (client: ClientCreateInput) =>
  requestJson<Client>('/api/clients', {
    method: 'POST',
    body: JSON.stringify(client),
  });

export type PartyUpdateInput = { operationId: string; expectedRevision: number; name?: string; notas?: string | null };

export const updateClient = async (clientId: string, client: PartyUpdateInput) =>
  requestJson<Client>(`/api/clients/${clientId}`, {
    method: 'PUT',
    body: JSON.stringify(client),
  });

export type PartyDeleteRequest = { operationId: string; expectedRevision: number; reason: string };
export type ClientDeleteRequest = PartyDeleteRequest & { expectedAccountRevision: number };

export const deleteClient = async (clientId: string, metadata: ClientDeleteRequest) =>
  requestJson<unknown>(`/api/clients/${clientId}`, {
    method: 'DELETE',
    body: JSON.stringify(metadata),
  });

export type ClientMergeRequest = { operationId: string; expectedKeepRevision: number; expectedMergeRevision: number; expectedKeepMetadataRevision: number; expectedMergeMetadataRevision: number };
export const mergeClients = async (keepId: string, mergeId: string, metadata: ClientMergeRequest) =>
  requestJson<PersistedState>('/api/clients/merge', {
    method: 'POST',
    body: JSON.stringify({ keepId, mergeId, ...metadata }),
  });

export const createProveedor = async (proveedor: ProveedorCreateInput) =>
  requestJson<Proveedor>('/api/proveedores', {
    method: 'POST',
    body: JSON.stringify(proveedor),
  });

export const updateProveedor = async (proveedorId: string, proveedor: PartyUpdateInput) =>
  requestJson<Proveedor>(`/api/proveedores/${proveedorId}`, {
    method: 'PUT',
    body: JSON.stringify(proveedor),
  });

export const deleteProveedor = async (proveedorId: string, metadata: PartyDeleteRequest) =>
  requestJson<unknown>(`/api/proveedores/${proveedorId}`, {
    method: 'DELETE',
    body: JSON.stringify(metadata),
  });

export type ProveedorMergeRequest = { operationId: string; expectedKeepRevision: number; expectedMergeRevision: number; reason: string };
export const mergeProveedores = async (keepId: string, mergeId: string, metadata: ProveedorMergeRequest) =>
  requestJson<PersistedState>('/api/proveedores/merge', {
    method: 'POST',
    body: JSON.stringify({ keepId, mergeId, ...metadata }),
  });

export const createPedido = async (pedido: PedidoInput) =>
  requestJson<Pedido>('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify(pedido),
  });

export type PedidoUpdateInput = Partial<PedidoInput> & { operationId: string; expectedRevision: number };

export const updatePedido = async (pedidoId: string, pedido: PedidoUpdateInput) =>
  requestJson<Pedido>(`/api/pedidos/${pedidoId}`, {
    method: 'PUT',
    body: JSON.stringify(pedido),
  });

export type OrderReconciliationRequest = { operationId: string; expectedRevision: number; reconciliation: {
  productId: string; expectedProductRevision: number; expectedFingerprint: string; available: number; reserved: number;
  quantity: number; unit: string; reason: string; confirmed: true;
} };
export const reconcilePedido = async (pedidoId: string, input: OrderReconciliationRequest) =>
  requestJson<{pedido: Pedido; inventoryResult: unknown}>(`/api/pedidos/${pedidoId}/reconcile`, {method:'POST',body:JSON.stringify(input)});

export const deletePedido = async (pedidoId: string, input: { operationId: string; expectedRevision: number }) =>
  requestJson<void>(`/api/pedidos/${pedidoId}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  });
