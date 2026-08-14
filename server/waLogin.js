import crypto from 'crypto';
import {
  authenticateWaLoginChallenge as authenticateWaLoginChallengeDb,
  claimWaLoginChallenge as claimWaLoginChallengeDb,
  createWaLoginChallenge as createWaLoginChallengeDb,
  hasDatabaseConfig,
} from './postgresDatabase.js';
import { normalizePhone } from './phone.js';

const LOGIN_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOGIN_TOKEN_LENGTH = 6;
const LOGIN_TOKEN_PATTERN = new RegExp(`\\blogin\\s+([${LOGIN_TOKEN_ALPHABET}]{${LOGIN_TOKEN_LENGTH}})\\b`, 'i');
const DEFAULT_TTL_SECONDS = 5 * 60;
const CREATE_RATE_WINDOW_MS = 15 * 60 * 1000;
const CREATE_RATE_MAX = 8;

const memoryChallenges = new Map();
const createHitsByIp = new Map();
let cachedWhatsAppNumber = null;
let cachedWhatsAppNumberAt = 0;

const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret ?? '')).digest('hex');

const isSameHex = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ''), 'hex');
  const rightBuffer = Buffer.from(String(right ?? ''), 'hex');

  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const normalizeLoginToken = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export const parseWaLoginToken = (text) => {
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

  const match = LOGIN_TOKEN_PATTERN.exec(normalized);
  return match ? normalizeLoginToken(match[1]) : null;
};

export const createLoginToken = () => {
  const bytes = crypto.randomBytes(LOGIN_TOKEN_LENGTH);
  let token = '';

  for (let index = 0; index < LOGIN_TOKEN_LENGTH; index += 1) {
    token += LOGIN_TOKEN_ALPHABET[bytes[index] % LOGIN_TOKEN_ALPHABET.length];
  }

  return token;
};

export const createSessionSecret = () => crypto.randomBytes(32).toString('base64url');

export const getWaLoginTtlSeconds = () => {
  const parsed = Number(process.env.AUTH_WA_LOGIN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  return Math.min(10 * 60, Math.max(60, Number.isFinite(parsed) ? parsed : DEFAULT_TTL_SECONDS));
};

export const isWaLoginCreateRateLimited = (ip) => {
  const key = String(ip ?? 'unknown');
  const now = Date.now();
  const recent = (createHitsByIp.get(key) ?? []).filter((timestamp) => now - timestamp < CREATE_RATE_WINDOW_MS);
  recent.push(now);
  createHitsByIp.set(key, recent);
  return recent.length > CREATE_RATE_MAX;
};

const pruneMemoryChallenges = () => {
  const now = Date.now();
  for (const [token, challenge] of memoryChallenges.entries()) {
    if (new Date(challenge.expiresAt).getTime() < now && challenge.status === 'pending') {
      memoryChallenges.delete(token);
    }
  }
};

const createMemoryChallenge = ({ loginToken, secretHash, expiresAt }) => {
  pruneMemoryChallenges();
  memoryChallenges.set(loginToken, {
    loginToken,
    secretHash,
    status: 'pending',
    phoneNumber: null,
    expiresAt,
  });
};

const authenticateMemoryChallenge = (loginToken, phoneNumber) => {
  const challenge = memoryChallenges.get(loginToken);

  if (!challenge) {
    return { ok: false, reason: 'not_found' };
  }

  if (challenge.status === 'consumed') {
    return { ok: false, reason: 'already_used' };
  }

  if (new Date(challenge.expiresAt).getTime() < Date.now()) {
    memoryChallenges.delete(loginToken);
    return { ok: false, reason: 'expired' };
  }

  if (challenge.status === 'authenticated') {
    if (challenge.phoneNumber === phoneNumber) {
      return { ok: true, reason: 'already_authenticated', phoneNumber: challenge.phoneNumber };
    }
    return { ok: false, reason: 'already_used' };
  }

  challenge.status = 'authenticated';
  challenge.phoneNumber = phoneNumber;
  return { ok: true, reason: 'authenticated', phoneNumber };
};

const claimMemoryChallenge = (loginToken, sessionSecret) => {
  const challenge = memoryChallenges.get(loginToken);

  if (!challenge) {
    return { ok: false, reason: 'not_found' };
  }

  if (!isSameHex(challenge.secretHash, hashSecret(sessionSecret))) {
    return { ok: false, reason: 'invalid_secret' };
  }

  if (challenge.status === 'pending') {
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      memoryChallenges.delete(loginToken);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, status: 'pending' };
  }

  if (challenge.status !== 'authenticated' && challenge.status !== 'consumed') {
    return { ok: false, reason: 'not_found' };
  }

  const expiresAt = new Date(challenge.expiresAt).getTime();
  if (Date.now() >= expiresAt) {
    return { ok: false, reason: 'expired' };
  }

  challenge.status = 'consumed';
  return { ok: true, status: 'authenticated', phoneNumber: challenge.phoneNumber };
};

export const createWaLoginSession = async () => {
  const ttlSeconds = getWaLoginTtlSeconds();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const sessionSecret = createSessionSecret();
  const secretHash = hashSecret(sessionSecret);
  const useDatabase = hasDatabaseConfig();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const loginToken = createLoginToken();

    try {
      if (useDatabase) {
        await createWaLoginChallengeDb({ loginToken, secretHash, expiresAt });
      } else {
        if (memoryChallenges.has(loginToken)) {
          continue;
        }
        createMemoryChallenge({ loginToken, secretHash, expiresAt });
      }

      return {
        loginToken,
        sessionSecret,
        expiresAt,
        expiresInSeconds: ttlSeconds,
      };
    } catch (error) {
      const code = error?.code;
      if (code === '23505') {
        continue;
      }
      throw error;
    }
  }

  throw new Error('No se pudo generar un código de acceso. Probá de nuevo.');
};

export const authenticateWaLoginFromWebhook = async (loginToken, phoneNumber) => {
  const token = normalizeLoginToken(loginToken);
  const normalizedPhone = normalizePhone(phoneNumber);

  if (!token || !normalizedPhone) {
    return { ok: false, reason: 'missing_fields' };
  }

  if (hasDatabaseConfig()) {
    return authenticateWaLoginChallengeDb(token, normalizedPhone);
  }

  return authenticateMemoryChallenge(token, normalizedPhone);
};

export const claimWaLoginSession = async (loginToken, sessionSecret) => {
  const token = normalizeLoginToken(loginToken);
  const secret = String(sessionSecret ?? '').trim();

  if (!token || !secret) {
    return { ok: false, reason: 'missing_fields' };
  }

  if (hasDatabaseConfig()) {
    return claimWaLoginChallengeDb(token, secret);
  }

  return claimMemoryChallenge(token, secret);
};

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');

export const getWhatsAppLoginNumber = async () => {
  const fromEnv = digitsOnly(process.env.META_WHATSAPP_NUMBER);

  if (fromEnv) {
    return fromEnv;
  }

  if (cachedWhatsAppNumber && Date.now() - cachedWhatsAppNumberAt < 6 * 60 * 60 * 1000) {
    return cachedWhatsAppNumber;
  }

  const accessToken = String(process.env.META_ACCESS_TOKEN ?? '').trim();
  const phoneNumberId = String(process.env.META_PHONE_NUMBER_ID ?? '').trim();
  const graphVersion = String(process.env.META_GRAPH_API_VERSION ?? 'v21.0').trim() || 'v21.0';

  if (!accessToken || !phoneNumberId) {
    return null;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/${graphVersion}/${phoneNumberId}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const digits = digitsOnly(payload?.display_phone_number);

    if (digits) {
      cachedWhatsAppNumber = digits;
      cachedWhatsAppNumberAt = Date.now();
    }

    return digits || null;
  } catch {
    return null;
  }
};

export const buildWhatsAppLoginUrl = (whatsappNumber, loginToken) => {
  const digits = digitsOnly(whatsappNumber);
  const token = normalizeLoginToken(loginToken);

  if (!digits || !token) {
    return '';
  }

  return `https://wa.me/${digits}?text=${encodeURIComponent(`LOGIN ${token}`)}`;
};
