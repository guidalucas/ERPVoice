import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.js';
import { normalizePhone } from '../phone.js';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const signature = (key, value) => createHmac('sha256', key).update(value).digest('hex');
export const matches = (given, expected) => typeof given === 'string' && /^[a-f0-9]{64}$/.test(given)
  && timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
export const requestMessage = (method, path, time, nonce, sha) => [method, path, time, nonce, sha].join('\n');

export function readAutoStoryConfig(env) {
  const secret = value => /^[0-9a-f]{64}$/i.test(value ?? '') ? Buffer.from(value, 'hex') : null;
  const owner = /^\d{8,15}$/.test(env.AUTO_STORY_OWNER ?? '') && normalizePhone(env.AUTO_STORY_OWNER) === env.AUTO_STORY_OWNER
    ? env.AUTO_STORY_OWNER : null;
  const workerKey = secret(env.AUTO_STORY_RUNNER_KEY);
  const mediaKey = secret(env.AUTO_STORY_MEDIA_KEY);
  const encryptionKey = secret(env.AUTO_STORY_TOKEN_KEY);
  let origin;
  try {
    const url = new URL(env.AUTO_STORY_PUBLIC_ORIGIN);
    if (url.protocol === 'https:' && url.href === url.origin + '/') origin = url.origin;
  } catch { /* Live publishing requires an HTTPS origin. */ }
  const token = env.AUTO_STORY_META_TOKEN;
  const version = env.AUTO_STORY_META_VERSION || 'v26.0';
  const validVersion = /^v\d+\.0$/.test(version);
  const expiresAt = Date.parse(env.AUTO_STORY_META_EXPIRES_AT);
  return { owner, workerKey, mediaKey, origin, encryptionKey, token, expiresAt,
    version: validVersion ? version : undefined,
    liveReady: Boolean(owner && workerKey && mediaKey && origin && encryptionKey && token && Number.isFinite(expiresAt) && validVersion) };
}

export function sealToken(key, owner, token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(owner));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function unsealToken(key, owner, value) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(owner));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

export function assertSignedRunner(req, key, now = Date.now(), beforeUpload = false) {
  const time = req.get('x-stocky-time'), nonce = req.get('x-stocky-nonce');
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const sha = beforeUpload ? req.get('x-stocky-content-sha256') : digest(body);
  if (!key || !/^[a-f0-9]{64}$/.test(sha ?? '') || !/^\d{13}$/.test(time ?? '') || Math.abs(now - Number(time)) > 120_000
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce ?? '')
      || !matches(req.get('x-stocky-signature'), signature(key, requestMessage(req.method, req.originalUrl, time, nonce, sha)))) {
    fail('AUTO_STORY_UNAUTHENTICATED', 'Firma no válida.', 401);
  }
  return nonce;
}
