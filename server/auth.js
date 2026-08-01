import crypto from 'crypto';
import { normalizePhone as normalizeCanonicalPhone } from './phone.js';

const base64UrlEncode = (value) => Buffer.from(value).toString('base64url');

const base64UrlDecode = (value) => Buffer.from(value, 'base64url').toString('utf8');

export const normalizePhone = normalizeCanonicalPhone;

export const normalizeLoginPhone = normalizeCanonicalPhone;

export const getJwtSecret = () => process.env.AUTH_JWT_SECRET || process.env.META_VERIFY_TOKEN || 'erpvoice_dev_auth_secret';

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
  const secret = getJwtSecret();
  const rawToken = String(token ?? '').trim();

  if (!rawToken) {
    return null;
  }

  const parts = rawToken.split('.');

  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');

  const signatureBuffer = Buffer.from(signature, 'base64url');
  const expectedBuffer = Buffer.from(expectedSignature, 'base64url');

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp <= now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
};