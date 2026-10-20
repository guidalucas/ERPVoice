/** Explicit target only; deliberately no dotenv or Stocky bootstrap imports. */
export function databaseTarget(env, { allowRemote = false } = {}) {
  const value = env.COMMERCE_DATABASE_URL;
  if (!value) throw Object.assign(new Error('Set COMMERCE_DATABASE_URL explicitly; no .env.local fallback is used.'), { code: 'EXPLICIT_DATABASE_REQUIRED' });
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('INVALID_DATABASE_PROTOCOL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !allowRemote) throw new Error('REMOTE_DATABASE_REQUIRES_EXPLICIT_PERMISSION');
  return { connectionString: value, ssl: local ? false : { rejectUnauthorized: true } };
}
