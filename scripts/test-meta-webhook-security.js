import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createMetaWebhookSignatureMiddleware,
  hasMetaWebhookAppSecret,
  verifyMetaWebhookSignature,
} from '../server/metaWebhookSecurity.js';

const appSecret = randomBytes(32).toString('hex');
const rawBody = Buffer.from('{ "message": "caf\u00e9", "amount": 5 }\n', 'utf8');
const sign = (body, secret = appSecret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const signature = sign(rawBody);
const verify = (overrides = {}) => verifyMetaWebhookSignature({ rawBody, signature, appSecret, ...overrides });

test('accepts a real HMAC for exact UTF-8 body bytes, including empty bodies', () => {
  assert.equal(verify(), true);
  assert.equal(verify({ rawBody: Buffer.alloc(0), signature: sign(Buffer.alloc(0)) }), true);
  assert.equal(verify({ signature: `sha256=${signature.slice(7).toUpperCase()}` }), true);
});

test('rejects tampering, different serialization, wrong secret and wrong digest', () => {
  assert.equal(verify({ rawBody: Buffer.from('{ "message": "caf\u00e9", "amount": 6 }\n') }), false);
  assert.equal(verify({ rawBody: Buffer.from(JSON.stringify(JSON.parse(rawBody.toString('utf8')))) }), false);
  assert.equal(verify({ appSecret: `${appSecret}other` }), false);
  assert.equal(verify({ signature: `sha256=${'0'.repeat(64)}` }), false);
});

test('fails closed on absent or invalid app secrets', () => {
  for (const value of [undefined, null, '', ' \t\n', 123, {}, Buffer.from(appSecret)]) {
    assert.equal(hasMetaWebhookAppSecret(value), false);
    assert.equal(verify({ appSecret: value }), false);
  }
  assert.equal(hasMetaWebhookAppSecret(appSecret), true);
  assert.equal(verifyMetaWebhookSignature(), false);
});

test('requires a Buffer instead of trusting parsed JSON or strings', () => {
  for (const value of [undefined, null, rawBody.toString('utf8'), JSON.parse(rawBody), new Uint8Array(rawBody)]) {
    assert.equal(verify({ rawBody: value }), false);
  }
});

test('rejects missing, malformed, duplicate and wrong-length signatures without throwing', () => {
  for (const value of [
    undefined, null, '', 42, {}, [signature], `${signature}, ${signature}`,
    signature.slice(0, -1), `${signature}0`, `${signature}\n`, ` ${signature}`,
    signature.replace('sha256=', 'sha1='), signature.replace('sha256=', 'SHA256='),
    `sha256=${'g'.repeat(64)}`, `sha256=${'a'.repeat(63)}!`, signature.slice(7),
  ]) {
    assert.equal(verify({ signature: value }), false);
  }
});

const runMiddleware = ({ secret = appSecret, method = 'POST', body = rawBody, header = signature } = {}) => {
  let nextCalls = 0;
  let status;
  let response;
  const res = {
    status(value) { status = value; return this; },
    json(value) { response = value; return this; },
  };
  createMetaWebhookSignatureMiddleware({ appSecret: secret })(
    { method, rawBody: body, headers: { 'x-hub-signature-256': header } },
    res,
    () => { nextCalls += 1; },
  );
  return { nextCalls, status, response };
};

test('middleware permits valid POST and bypasses GET challenge verification', () => {
  assert.equal(runMiddleware().nextCalls, 1);
  assert.equal(runMiddleware({ method: 'GET', secret: '', header: null, body: null }).nextCalls, 1);
});

test('middleware blocks invalid POST before the handler and returns generic errors', () => {
  for (const options of [{ header: null }, { header: [signature] }, { body: {} }, { header: sign(Buffer.from('tampered')) }]) {
    const result = runMiddleware(options);
    assert.equal(result.nextCalls, 0);
    assert.equal(result.status, 401);
    assert.deepEqual(result.response, { error: 'Invalid Meta webhook signature' });
  }
});

test('middleware rejects missing production or development configuration', () => {
  const result = runMiddleware({ secret: '' });
  assert.equal(result.nextCalls, 0);
  assert.equal(result.status, 503);
  assert.deepEqual(result.response, { error: 'Meta webhook signing is not configured' });
});
