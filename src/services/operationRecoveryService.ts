import type { ParsedVoicePayload } from '../domain/types';
import { requestJson } from './apiClient';

export type OperationRecovery = { status: 'applied' | 'not_applied'; operationId: string; operationResult?: Record<string, unknown> };

/** This endpoint only reads the frozen legacy operation receipt. */
export async function checkOperationRecovery(proposal: ParsedVoicePayload): Promise<OperationRecovery> {
  const result = await requestJson<unknown>('/api/operations/recovery', {
    method: 'POST',
    body: JSON.stringify({ operationId: proposal.operationId, sourceText: proposal.sourceText, actions: proposal.actions }),
  });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('No pudimos verificar el estado de la operación anterior.');
  const value = result as Record<string, unknown>;
  if ((value.status !== 'applied' && value.status !== 'not_applied') || value.operationId !== proposal.operationId ||
      Object.keys(value).some(key => !['status', 'operationId', 'operationResult'].includes(key)) ||
      (value.operationResult !== undefined && (!value.operationResult || typeof value.operationResult !== 'object' || Array.isArray(value.operationResult))) ||
      (value.status === 'not_applied' && value.operationResult !== undefined)) {
    throw new Error('No pudimos verificar el estado de la operación anterior.');
  }
  if (value.status === 'applied') {
    const receipt = value.operationResult as Record<string, unknown> | undefined;
    const recognizedIds = [`panel:${proposal.operationId}`, `account-compat:panel:${proposal.operationId}`, `batch:panel:${proposal.operationId}`];
    if (!receipt || receipt.status !== 'applied' || typeof receipt.operationId !== 'string' || !recognizedIds.includes(receipt.operationId)) {
      throw new Error('No pudimos verificar el estado de la operación anterior.');
    }
  }
  return value as OperationRecovery;
}
