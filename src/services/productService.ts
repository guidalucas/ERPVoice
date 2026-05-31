import type { Client, Product, Transaction } from '../domain/types';

const API_BASE = '';

export type ProductInput = {
  name: string;
  productType?: string | null;
  productModel?: string | null;
  size?: string | null;
  stockAvailable?: number;
  stockReserved?: number;
  price?: number;
};

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
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