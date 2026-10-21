import { clearAuthSession, getAuthSession, getAuthToken } from '../services/authTokenStore';
import type { Receipt } from './types';
const base = import.meta.env.DEV ? '' : String(import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_META_API_BASE ?? '').trim();
const prefix = '/api/commerce/v1';
export class StudioError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
export async function studioFetch(route: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers), token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`${base}${prefix}${route}`, { ...options, headers, cache: 'no-store', signal: options.signal ?? AbortSignal.timeout(30_000) }); }
  catch { throw new StudioError('NETWORK_ERROR', 'No pude confirmar la operación. Conservé el intento para recuperarlo.', 0); }
  if (response.status === 401) clearAuthSession();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new StudioError(data.error?.code ?? 'COMMERCE_UNAVAILABLE', typeof data.error?.message === 'string' ? data.error.message : 'No pude completar la operación. Reintentá.', response.status);
  }
  return response;
}
export async function query<T>(route: string): Promise<T> { return (await studioFetch(route)).json(); }
type Pending = { operationId: string; route: string; method: string; body: Record<string, unknown>; at: string };
const pendingKey = () => `fullmatch.pending.${getAuthSession()?.phoneNumber ?? 'none'}`;
export function pendingOperations(): Pending[] {
  try { const value = JSON.parse(localStorage.getItem(pendingKey()) ?? '[]'); return Array.isArray(value) ? value.slice(-30) : []; } catch { return []; }
}
function savePending(items: Pending[]) { localStorage.setItem(pendingKey(), JSON.stringify(items.slice(-30))); }
export function forgetOperation(id: string) { savePending(pendingOperations().filter(item => item.operationId !== id)); }
function settleOperation(pending: Pending) {
  if (pending.route === '/products' && pending.method === 'POST') {
    const key = `fullmatch.draft.${getAuthSession()?.phoneNumber}.new`;
    try { if (JSON.stringify(JSON.parse(localStorage.getItem(key) ?? 'null')) === JSON.stringify(pending.body.product)) localStorage.removeItem(key); } catch { /* Ignore invalid draft. */ }
  }
  forgetOperation(pending.operationId);
}
export async function command<T>(route: string, method: string, input: Record<string, unknown>): Promise<T> {
  return commandWithId(route, method, crypto.randomUUID(), input);
}
export async function commandWithId<T>(route: string, method: string, operationId: string, input: Record<string, unknown>): Promise<T> {
  const body = { ...input, operationId };
  const pending = { operationId, route, method, body, at: new Date().toISOString() };
  const items = pendingOperations();
  const existing = items.find(item => item.operationId === operationId);
  if (existing) {
    if (existing.route !== route || existing.method !== method || JSON.stringify(existing.body) !== JSON.stringify(body)) throw new StudioError('IDEMPOTENCY_CONFLICT', 'El intento pertenece a otro contenido. Actualizá el lote antes de continuar.', 409);
    return retryOperation<T>(existing);
  }
  if (items.length >= 30) throw new StudioError('PENDING_LIMIT', 'Recuperá los intentos pendientes antes de crear otros.', 409);
  savePending([...items, pending]);
  return retryOperation<T>(pending);
}
export async function retryOperation<T>(pending: Pending): Promise<T> {
  try {
    const response: Receipt<T> = await (await studioFetch(pending.route, { method: pending.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.body) })).json();
    settleOperation(pending); return response.result;
  } catch (error) {
    if (error instanceof StudioError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) forgetOperation(pending.operationId);
    throw error;
  }
}
export async function recoverOperation<T>(id: string): Promise<T> {
  const pending = pendingOperations().find(item => item.operationId === id);
  const receipt = await query<Receipt<T>>(`/operations/${id}`); if (pending) settleOperation(pending); else forgetOperation(id); return receipt.result;
}
export const imageRoute = (productId: string, imageId: string, thumbnail = false) => `/products/${productId}/images/${imageId}/content${thumbnail ? '?variant=thumbnail' : ''}`;
export async function imageBlob(productId: string, imageId: string, thumbnail = false) { return (await studioFetch(imageRoute(productId, imageId, thumbnail))).blob(); }
export async function uploadPhoto(productId: string, imageId: string, file: File) {
  return (await studioFetch(imageRoute(productId, imageId), { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })).json();
}
