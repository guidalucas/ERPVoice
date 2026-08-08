import { requestJson } from './apiClient';
import { normalizePhone } from './phone';

export type RequestLoginCodeResponse = {
  challengeId: string;
  phoneNumber: string;
  expiresAt: string;
  expiresInSeconds: number;
  devOtpCode?: string;
  devMode?: boolean;
};

export type VerifyLoginCodeResponse = {
  token: string;
  tokenType: 'Bearer';
  phoneNumber: string;
};

export type DevLoginResponse = VerifyLoginCodeResponse & {
  devMode?: boolean;
};

export const requestLoginCode = async (phoneNumber: string) =>
  requestJson<RequestLoginCodeResponse>('/api/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: normalizePhone(phoneNumber) }),
  });

export const verifyLoginCode = async (payload: {
  phoneNumber: string;
  otpCode: string;
  challengeId: string;
}) =>
  requestJson<VerifyLoginCodeResponse>('/api/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({
      phoneNumber: normalizePhone(payload.phoneNumber),
      otpCode: payload.otpCode.trim(),
      challengeId: payload.challengeId,
    }),
  });

export const requestDevLogin = async (phoneNumber?: string) =>
  requestJson<DevLoginResponse>('/api/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify(phoneNumber ? { phoneNumber: normalizePhone(phoneNumber) } : {}),
  });

export const fetchDevAuthStatus = async () =>
  requestJson<{ enabled: boolean; defaultPhone: string }>('/api/auth/dev-status');

export const fetchCurrentSession = async () => requestJson<{ phoneNumber: string }>('/api/auth/me');