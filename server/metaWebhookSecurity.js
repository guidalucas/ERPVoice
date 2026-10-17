import { createHmac, timingSafeEqual } from 'node:crypto';

/** The Meta app secret is distinct from the GET verification token. */
export const hasMetaWebhookAppSecret = (appSecret) => (
  typeof appSecret === 'string' && appSecret.trim().length > 0
);

/** Authenticate the original body bytes, never a parsed/re-serialized object. */
export const verifyMetaWebhookSignature = ({ rawBody, signature, appSecret } = {}) => {
  if (!hasMetaWebhookAppSecret(appSecret) || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  // Check length before hex decoding: Buffer.from silently truncates bad hex.
  if (typeof signature !== 'string'
    || signature.length !== 71
    || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
    return false;
  }

  const supplied = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, supplied);
};

/** Mount on the Meta webhook route after capturing req.rawBody as a Buffer.
 * GET challenge verification is intentionally independent of POST signing.
 * Missing configuration rejects delivery in every environment; readiness
 * endpoints can use hasMetaWebhookAppSecret with the same configured value.
 */
export const createMetaWebhookSignatureMiddleware = ({
  appSecret = process.env.META_APP_SECRET,
} = {}) => (req, res, next) => {
  if (req.method !== 'POST') {
    next();
    return;
  }

  if (!hasMetaWebhookAppSecret(appSecret)) {
    res.status(503).json({ error: 'Meta webhook signing is not configured' });
    return;
  }

  if (!verifyMetaWebhookSignature({
    rawBody: req.rawBody,
    signature: req.headers?.['x-hub-signature-256'],
    appSecret,
  })) {
    res.status(401).json({ error: 'Invalid Meta webhook signature' });
    return;
  }

  next();
};
