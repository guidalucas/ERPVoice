import { getAuthSession } from '../services/authTokenStore';
import type { StorySettings } from './storyRenderer';
export type BatchOptions = { templateId: string; format: 'png' | 'jpeg'; showPrice: boolean; promotion: StorySettings['promotion'] };
export type BatchItem = { productId: string; operationId: string; title?: string; snapshotId?: string; request?: { expectedProductRevision: number; settings: StorySettings };
  status: 'pending' | 'prepared' | 'generated' | 'failed'; error?: string };
export type BatchJob = { version: 1; batchId: string; createdAt: string; options: BatchOptions; items: BatchItem[]; lastDownloadRequestedAt?: string };
export const batchKey = () => `fullmatch.batch.${getAuthSession()?.phoneNumber ?? 'none'}`;
export function readBatchJob(): BatchJob | null {
  try { const raw = localStorage.getItem(batchKey()); if (!raw || raw.length > 512_000) return null; const value = JSON.parse(raw);
    const uuid = (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
    if (value.version !== 1 || !uuid(value.batchId) || !Array.isArray(value.items) || !value.items.length || value.items.length > 20
      || !value.items.every((item: BatchItem) => uuid(item.productId) && uuid(item.operationId)) || !['png', 'jpeg'].includes(value.options?.format)) return null;
    return value;
  } catch { return null; }
}
export function saveBatchJob(job: BatchJob, key = batchKey()) { localStorage.setItem(key, JSON.stringify(job)); }
export function createBatchJob(productIds: string[], options: BatchOptions = { templateId: 'available', format: 'jpeg', showPrice: true, promotion: null }): BatchJob {
  const ids = [...new Set(productIds)]; if (!ids.length || ids.length > 20) throw new Error('Elegí entre 1 y 20 fichas por lote.');
  const job: BatchJob = { version: 1, batchId: crypto.randomUUID(), createdAt: new Date().toISOString(), options,
    items: ids.map(productId => ({ productId, operationId: crypto.randomUUID(), status: 'pending' })) };
  saveBatchJob(job); return job;
}
