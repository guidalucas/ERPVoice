import { requestJson } from './apiClient';
export type BusinessMoneyPolicy = { currency: string; storageUnit: string; fractionDigits: number; revision: number };
export async function fetchBusinessMoneyPolicy(): Promise<BusinessMoneyPolicy | null> {
  const result = await requestJson<{ moneyPolicy: BusinessMoneyPolicy | null }>('/api/commerce/v1/money-policy', { cache: 'no-store' });
  return result.moneyPolicy ?? null;
}
