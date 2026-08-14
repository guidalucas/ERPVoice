import type { BusinessCategoryId } from '../domain/businessCategories';
import { requestJson } from './apiClient';
import { normalizePhone } from './phone';

export type WhatsAppLoginChallenge = {
  loginToken: string;
  sessionSecret: string;
  expiresAt: string;
  expiresInSeconds: number;
  whatsappNumber: string;
  whatsappUrl: string;
};

export type WhatsAppLoginPollResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'not_found' }
  | {
      status: 'authenticated';
      token: string;
      tokenType: 'Bearer';
      phoneNumber: string;
    };

export type DevLoginResponse = {
  token: string;
  tokenType: 'Bearer';
  phoneNumber: string;
  devMode?: boolean;
};

export type PendingInvite = {
  id: string;
  tenantPhone: string;
  businessName: string | null;
  invitedByPhone: string;
  expiresAt: string;
  hasOwnBusiness: boolean;
};

export type AuthUserProfile = {
  phoneNumber: string;
  tenantPhone: string;
  role: 'owner' | 'member';
  businessName: string | null;
  businessCategory: BusinessCategoryId | null;
  needsOnboarding: boolean;
  pendingInvite: PendingInvite | null;
  hasOwnBusiness: boolean;
};

export type SaveBusinessProfilePayload = {
  businessName: string;
  businessCategory: BusinessCategoryId;
};

export const createWhatsAppLogin = async () =>
  requestJson<WhatsAppLoginChallenge>('/api/auth/wa-login', {
    method: 'POST',
    body: JSON.stringify({}),
  });

export const pollWhatsAppLogin = async (payload: { loginToken: string; sessionSecret: string }) =>
  requestJson<WhatsAppLoginPollResponse>('/api/auth/wa-login/poll', {
    method: 'POST',
    body: JSON.stringify({
      loginToken: payload.loginToken,
      sessionSecret: payload.sessionSecret,
    }),
  });

export const requestDevLogin = async (phoneNumber?: string) =>
  requestJson<DevLoginResponse>('/api/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify(phoneNumber ? { phoneNumber: normalizePhone(phoneNumber) } : {}),
  });

export const fetchDevAuthStatus = async () =>
  requestJson<{ enabled: boolean; defaultPhone: string }>('/api/auth/dev-status');

export const fetchCurrentSession = async () => requestJson<AuthUserProfile>('/api/auth/me');

export const saveBusinessProfile = async (payload: SaveBusinessProfilePayload) =>
  requestJson<AuthUserProfile>('/api/business-profile', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
