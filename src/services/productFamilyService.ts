import { requestJson } from './apiClient';

export type ProductFamilyAttributeType = 'text' | 'number' | 'boolean';
export type ProductAttributeState = 'known' | 'unknown' | 'not_applicable' | 'missing';
export type ProductFamilyAttributeSchema = {
  type: ProductFamilyAttributeType;
  required: boolean;
  allowedStates: ProductAttributeState[];
  unit?: string;
  values?: Array<string | number | boolean>;
};
export type ProductFamilySchema = {
  name: string;
  unit: string;
  attributes: Record<string, ProductFamilyAttributeSchema>;
  allowAdditionalAttributes: boolean;
};
export type ProductFamily = { familyId: string; version: number; schema: ProductFamilySchema };
export type ProductFamiliesResponse = { families: ProductFamily[] };
export type PublishProductFamilyRequest = {
  operationId: string;
  familyId: string;
  expectedVersion: number;
  schema: ProductFamilySchema;
};
export type PublishProductFamilyResponse = {
  operationId: string;
  businessId: string;
  status: 'applied';
  family: ProductFamily;
};

export const fetchProductFamilies = () => requestJson<ProductFamiliesResponse>('/api/inventory/families');

export const publishProductFamily = (body: PublishProductFamilyRequest) =>
  requestJson<PublishProductFamilyResponse>('/api/inventory/families', {
    method: 'POST',
    body: JSON.stringify(body),
  });
