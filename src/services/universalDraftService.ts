import { requestJson } from './apiClient';

export type UniversalDraftPreview = {
  draftId: string;
  version: number;
  text: string;
  expiresAt: string;
  status: 'awaiting_confirmation' | 'awaiting_clarification' | 'applied' | 'cancelled' | 'answered';
  digest: string;
  question?: string;
  answer?: { text: string; items: unknown[]; observedAt?: string };
  plan?: { actions: { itemId: string }[] };
  evidence?: { itemId: string; quote: string }[];
  review?: { itemId: string; title: string; details: string[] }[];
  result?: unknown;
};
const base = '/api/operation-drafts';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
const post = (url: string, body: unknown) => requestJson<UniversalDraftPreview>(url, { method: 'POST', body: JSON.stringify(body) });
export const prepareUniversalDraft = (requestId: string, text: string) => post(base, { requestId, text });
export const fetchUniversalDraft = (id: string) => requestJson<UniversalDraftPreview>(path(id));
export const replyUniversalDraft = (id: string, requestId: string, text: string, version: number) => post(`${path(id)}/replies`, { requestId, text, version });
export const confirmUniversalDraft = (id: string, version: number, digest: string) => post(`${path(id)}/confirm`, { version, digest });
export const cancelUniversalDraft = (id: string, version: number, digest: string) => post(`${path(id)}/cancel`, { version, digest });
