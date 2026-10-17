import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { AuthConfigurationError, getJwtSecret, issueJwt, verifyJwt } from '../server/auth.js';
import { parseWaLoginToken } from '../server/waLogin.js';

const secret = randomBytes(32).toString('hex');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = () => ({ phoneNumber: '59800000000', iss: 'ERPVoice', exp: Math.floor(Date.now() / 1000) + 600 });
const signParts = (header, payload, key = secret) => {
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
};
const sign = (payload = claims(), header = { alg: 'HS256', typ: 'JWT' }, key = secret) => (
  signParts(encode(header), encode(payload), key)
);
const withEnv = (updates, run) => {
  const before = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('production supports valid roundtrip and independently signed JWTs, rejects another secret', () => {
  withEnv({ NODE_ENV: 'production', AUTH_JWT_SECRET: secret }, () => {
    assert.equal(getJwtSecret(), secret);
    const token = issueJwt({ phoneNumber: '59800000000' });
    assert.equal(verifyJwt(token).phoneNumber, '59800000000');
    const independentlySignedClaims = claims();
    assert.deepEqual(verifyJwt(sign(independentlySignedClaims)), independentlySignedClaims);
    assert.equal(verifyJwt(sign(claims(), undefined, `${secret}other`)), null);
  });
});

test('production never falls back and issuing fails with a typed configuration error', () => {
  for (const missingOrWeak of [undefined, '', 'short', 'a'.repeat(31), ' '.repeat(64)]) {
    withEnv({ NODE_ENV: 'production', AUTH_JWT_SECRET: missingOrWeak, META_VERIFY_TOKEN: secret }, () => {
      assert.throws(getJwtSecret, (error) => error instanceof AuthConfigurationError && error.code === 'AUTH_JWT_SECRET_INVALID');
      assert.throws(() => issueJwt({}), AuthConfigurationError);
      assert.equal(verifyJwt(sign()), null);
    });
  }
});

test('production minimum is measured in UTF-8 bytes', () => {
  withEnv({ NODE_ENV: 'production', AUTH_JWT_SECRET: '\u00e9'.repeat(16) }, () => {
    assert.equal(getJwtSecret(), '\u00e9'.repeat(16));
    assert.ok(verifyJwt(issueJwt({ user: 'test' })));
  });
});

test('development and test retain explicit secret, verification token and legacy fallback', () => {
  for (const mode of ['development', 'test']) {
    withEnv({ NODE_ENV: mode, AUTH_JWT_SECRET: undefined, META_VERIFY_TOKEN: undefined }, () => {
      assert.equal(getJwtSecret(), 'erpvoice_dev_auth_secret');
      assert.ok(verifyJwt(issueJwt({})));
      process.env.META_VERIFY_TOKEN = 'local-verification-token';
      assert.equal(getJwtSecret(), 'local-verification-token');
      process.env.AUTH_JWT_SECRET = 'local-auth-secret';
      assert.equal(getJwtSecret(), 'local-auth-secret');
    });
  }
});

test('rejects signed unsupported or malformed JWT headers', () => {
  withEnv({ NODE_ENV: 'production', AUTH_JWT_SECRET: secret }, () => {
    for (const header of [null, [], 'JWT', {}, { alg: 'none', typ: 'JWT' }, { alg: 'HS512', typ: 'JWT' }, { alg: 'HS256' }, { alg: 'HS256', typ: 'other' }]) {
      assert.equal(verifyJwt(sign(claims(), header)), null);
    }
    assert.equal(verifyJwt(signParts(Buffer.from('{broken').toString('base64url'), encode(claims()))), null);
  });
});

test('rejects signed wrong issuer, missing expiry, nonnumeric, nonfinite and expired expiry', () => {
  withEnv({ NODE_ENV: 'production', AUTH_JWT_SECRET: secret }, () => {
    for (const payload of [null, [], 'claims', {}, { ...claims(), iss: 'other' }, { exp: claims().exp }, { iss: 'ERPVoice' },
      ...[null, '9999999999', 0, -1, Math.floor(Date.now() / 1000)].map((exp) => ({ ...claims(), exp }))]) {
      assert.equal(verifyJwt(sign(payload)), null);
    }
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    for (const body of ['{"iss":"ERPVoice","exp":1e400}', '{broken']) {
      assert.equal(verifyJwt(signParts(header, Buffer.from(body).toString('base64url'))), null);
    }
    const invalidUtf8 = Buffer.concat([Buffer.from('{"iss":"ERPVoice","exp":9999999999,"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    assert.equal(verifyJwt(signParts(header, invalidUtf8.toString('base64url'))), null);
  });
});

test('rejects malformed encoding, length mismatches and tampering without throwing', () => {
  withEnv({ NODE_ENV: 'production', AUTH_JWT_SECRET: secret }, () => {
    const token = sign();
    const [header, payload, signature] = token.split('.');
    for (const malformed of [undefined, null, 42, {}, '', 'a.b', `${token}.extra`,
      `${header}.${payload}.`, `${header}.${payload}.${signature.slice(1)}`, `${header}.${payload}.${signature}=`,
      `${header}.${payload}.!${signature}`, signParts(`${header}=`, payload), signParts(header, `${payload}=`),
      signParts('a', payload), `${header}.${encode({ ...claims(), user: 'tampered' })}.${signature}`]) {
      assert.equal(verifyJwt(malformed), null);
    }
  });
});

test('WhatsApp login parser accepts LOGIN tokens in any inbound text slot', () => {
  assert.equal(parseWaLoginToken('LOGIN XY34ZK'), 'XY34ZK');
  assert.equal(parseWaLoginToken('  login   xy34zk  '), 'XY34ZK');
  assert.equal(parseWaLoginToken('Hola\nLOGIN XY34ZK\n'), 'XY34ZK');
  assert.equal(parseWaLoginToken('XY34ZK'), null);
  assert.equal(parseWaLoginToken('LOGIN 123456'), null);
});
