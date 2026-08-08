import { clearAuthSession, getAuthToken } from './authTokenStore';

const API_BASE = import.meta.env.DEV
  ? ''
  : String(import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_META_API_BASE ?? '').trim();

const NETWORK_ERROR_MESSAGE = 'Sin conexión. Revisá tu internet e intentá de nuevo.';

const parseErrorBody = (errorText: string, status: number) => {
  const trimmed = errorText.trim();
  if (!trimmed) {
    return `No se pudo completar la operación (${status}).`;
  }

  try {
    const parsed = JSON.parse(trimmed) as { error?: string; message?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // plain text body
  }

  if (/failed to fetch|networkerror|load failed/i.test(trimmed)) {
    return NETWORK_ERROR_MESSAGE;
  }

  return trimmed;
};

export const toUserFacingError = (error: unknown, fallback = 'No se pudo completar la operación.') => {
  if (!(error instanceof Error) || !error.message.trim()) {
    return fallback;
  }

  if (/failed to fetch|networkerror|load failed|network request failed/i.test(error.message)) {
    return NETWORK_ERROR_MESSAGE;
  }

  return error.message.trim() || fallback;
};

export const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const token = getAuthToken();

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      ...init,
    });
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }

  if (response.status === 401) {
    clearAuthSession();
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(parseErrorBody(errorText, response.status));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};