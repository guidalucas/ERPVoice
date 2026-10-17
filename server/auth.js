import crypto from 'crypto';
import { normalizePhone as normalizeCanonicalPhone } from './phone.js';

const base64UrlEncode = (value) => Buffer.from(value).toString('base64url');

const decodeJwtPart = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid JWT encoding');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new Error('Invalid JWT encoding');
  }
  return bytes;
};

export const normalizePhone = normalizeCanonicalPhone;

export const normalizeLoginPhone = normalizeCanonicalPhone;

export class AuthConfigurationError extends Error {
  constructor() {
    super('Production authentication requires AUTH_JWT_SECRET with at least 32 UTF-8 bytes');
    this.name = 'AuthConfigurationError';
    this.code = 'AUTH_JWT_SECRET_INVALID';
  }
}

export const getJwtSecret = () => {
  const secret = process.env.AUTH_JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new AuthConfigurationError();
    }
    return secret;
  }
  return secret || process.env.META_VERIFY_TOKEN || 'erpvoice_dev_auth_secret';
};

export const extractBearerToken = (authorizationHeader) => {
  const headerValue = String(authorizationHeader ?? '').trim();

  if (!headerValue) {
    return null;
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

export const issueJwt = (payload, expiresInSeconds = Number(process.env.AUTH_JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7)) => {
  const secret = getJwtSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + Math.max(300, Number(expiresInSeconds) || 0),
    iss: 'ERPVoice',
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
};

export const verifyJwt = (token) => {
  try {
    const secret = getJwtSecret();
    if (typeof token !== 'string' || !token.trim()) {
      return null;
    }
    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [encodedHeader, encodedPayload, signature] = parts;
    const headerBytes = decodeJwtPart(encodedHeader);
    const payloadBytes = decodeJwtPart(encodedPayload);
    const signatureBuffer = decodeJwtPart(signature);
    const expectedBuffer = crypto.createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`).digest();
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return null;
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const header = JSON.parse(decoder.decode(headerBytes));
    if (!header || Array.isArray(header) || header.alg !== 'HS256' || header.typ !== 'JWT') {
      return null;
    }
    const payload = JSON.parse(decoder.decode(payloadBytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.iss !== 'ERPVoice') {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
};
