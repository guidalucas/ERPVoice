import { clearAuthSession, getAuthToken } from './authTokenStore';

const API_BASE = import.meta.env.DEV
  ? ''
  : String(import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_META_API_BASE ?? '').trim();

export const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (response.status === 401) {
    clearAuthSession();
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};