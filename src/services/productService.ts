import type { Client, Product, Transaction } from '../domain/types';
import { requestJson } from './apiClient';

export type ProductInput = {
  name: string;
  productType?: string | null;
  productModel?: string | null;
  size?: string | null;
  stockAvailable?: number;
  stockReserved?: number;
  price?: number;
};

export const fetchPersistedState = async () => requestJson<{ products: Product[]; clients: Client[]; transactions: Transaction[] }>('/api/state');

export const createProduct = async (product: ProductInput) => requestJson<Product>('/api/products', {
  method: 'POST',
  body: JSON.stringify(product),
});

export const updateProduct = async (productId: string, product: Partial<ProductInput>) => requestJson<Product>(`/api/products/${productId}`, {
  method: 'PUT',
  body: JSON.stringify(product),
});

export const deleteProduct = async (productId: string) => requestJson<void>(`/api/products/${productId}`, {
  method: 'DELETE',
});