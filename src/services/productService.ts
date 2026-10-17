import type { Client, ParsedActionUnion, Pedido, PedidoEstado, Product, Proveedor, Transaction } from '../domain/types';
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

export const createProduct = async (product: ProductInput) =>
  requestJson<Product>('/api/products', {
    method: 'POST',
    body: JSON.stringify(product),
  });

export const createProductModel = async (input: { productType: string; productModel: string; variants: Array<{ size: string; stockAvailable: number; price: number }> }) =>
  requestJson<Product[]>('/api/products/model', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const updateProduct = async (productId: string, product: Partial<ProductInput>, adjustment: ProductAdjustment) =>
  requestJson<Product>(`/api/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...product, ...adjustment }),
  });

export type InventorySelectionMutation =
  | { type: 'sku.update'; changes: { name: string; productType: string; productModel: string }; reason: string }
  | { type: 'sku.deactivate'; reason: string };

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
  members: Array<{ skuId: string; name: string; size: string | null; revision: number; stockAvailable: number; stockReserved: number; price: number; priceCurrency: string }>;
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
      || typeof member.priceCurrency !== 'string' || !member.priceCurrency.trim())
    || !mutationMatches(preview.mutation)) {
    throw new Error('La vista previa no coincide con la selección solicitada. No se aplicaron cambios.');
  }
  return preview;
};

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

export const createClient = async (client: ClientInput) =>
  requestJson<Client>('/api/clients', {
    method: 'POST',
    body: JSON.stringify(client),
  });

export const updateClient = async (clientId: string, client: Partial<ClientInput>) =>
  requestJson<Client>(`/api/clients/${clientId}`, {
    method: 'PUT',
    body: JSON.stringify(client),
  });

export const deleteClient = async (clientId: string) =>
  requestJson<void>(`/api/clients/${clientId}`, {
    method: 'DELETE',
  });

export const mergeClients = async (keepId: string, mergeId: string) =>
  requestJson<PersistedState>('/api/clients/merge', {
    method: 'POST',
    body: JSON.stringify({ keepId, mergeId }),
  });

export const createProveedor = async (proveedor: ProveedorInput) =>
  requestJson<Proveedor>('/api/proveedores', {
    method: 'POST',
    body: JSON.stringify(proveedor),
  });

export const updateProveedor = async (proveedorId: string, proveedor: Partial<ProveedorInput>) =>
  requestJson<Proveedor>(`/api/proveedores/${proveedorId}`, {
    method: 'PUT',
    body: JSON.stringify(proveedor),
  });

export const deleteProveedor = async (proveedorId: string) =>
  requestJson<void>(`/api/proveedores/${proveedorId}`, {
    method: 'DELETE',
  });

export const mergeProveedores = async (keepId: string, mergeId: string) =>
  requestJson<PersistedState>('/api/proveedores/merge', {
    method: 'POST',
    body: JSON.stringify({ keepId, mergeId }),
  });

export const createPedido = async (pedido: PedidoInput) =>
  requestJson<Pedido>('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify(pedido),
  });

export const updatePedido = async (pedidoId: string, pedido: Partial<PedidoInput>) =>
  requestJson<Pedido>(`/api/pedidos/${pedidoId}`, {
    method: 'PUT',
    body: JSON.stringify(pedido),
  });

export const deletePedido = async (pedidoId: string) =>
  requestJson<void>(`/api/pedidos/${pedidoId}`, {
    method: 'DELETE',
  });
