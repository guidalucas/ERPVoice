import { requestJson } from './apiClient';
import { normalizePhone } from './phone';

export type RequestLoginCodeResponse = {
  challengeId: string;
  phoneNumber: string;
  expiresAt: string;
  expiresInSeconds: number;
};

export type VerifyLoginCodeResponse = {
  token: string;
  tokenType: 'Bearer';
  phoneNumber: string;
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

export const fetchCurrentSession = async () => requestJson<{ phoneNumber: string }>('/api/auth/me');