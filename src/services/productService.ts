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
export const applyStateActions = async (sourceText: string, actions: ParsedActionUnion[]) =>
  requestJson<PersistedState>('/api/state/apply', {
    method: 'POST',
    body: JSON.stringify({ sourceText, actions }),
  });

export const createProduct = async (product: ProductInput) =>
  requestJson<Product>('/api/products', {
    method: 'POST',
    body: JSON.stringify(product),
  });

export const updateProduct = async (productId: string, product: Partial<ProductInput>) =>
  requestJson<Product>(`/api/products/${productId}`, {
    method: 'PUT',
    body: JSON.stringify(product),
  });

export const deleteProduct = async (productId: string) =>
  requestJson<void>(`/api/products/${productId}`, {
    method: 'DELETE',
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
