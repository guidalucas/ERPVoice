import test from 'node:test';
import assert from 'node:assert/strict';
import { commercialIdentityKey, commercialSlug, normalizeCommercialProduct } from '../server/commerce/productIdentity.js';
import { inventoryPriceToMoney, validateMoneyPolicy, enforceInventoryMoneyPolicy } from '../server/inventoryMoneyPolicy.js';
import { authorizeCommerce } from '../server/commerce/authorization.js';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { record, denseArray } from '../server/commerce/validation.js';
import { createDatabaseRuntime } from '../server/dbRuntime.js';

const policy = { currency: 'ARS', storageUnit: 'major_integer', fractionDigits: 2, revision: 1 };
const product = { title: 'Barcelona', teamKey: 'barcelona', teamName: 'Barcelona', teamKind: 'club',
  season: '2025/26', kitKey: 'home', versionKey: 'player', sleeveKey: 'short' };

test('commercial identity separates season/version/sleeve but not marketing or physical inventory', () => {
  const a = normalizeCommercialProduct(product), before = JSON.stringify(product);
  assert.equal(commercialIdentityKey(a), commercialIdentityKey({ ...a, title: 'Other title', description: 'Marketing' }));
  for (const patch of [{ season: '2024' }, { versionKey: 'fan' }, { sleeveKey: 'long' }, { kitKey: 'away' }]) {
    assert.notEqual(commercialIdentityKey(a), commercialIdentityKey({ ...a, ...patch }));
  }
  assert.equal(commercialIdentityKey(normalizeCommercialProduct({ title: 'Incomplete' })), null);
  assert.equal(JSON.stringify(product), before);
  assert.match(commercialSlug('Argentina / Campeón', '11111111-1111-4111-8111-111111111111'), /^argentina-campeon-/);
});

test('contracts reject authority, stock/price fields, getters and sparse arrays without executing', () => {
  for (const field of ['owner_phone', 'price', 'stockAvailable', 'role']) assert.throws(() => normalizeCommercialProduct({ ...product, [field]: 1 }), { code: 'INVALID_COMMAND' });
  let invoked = false;
  const input = { ...product }; Object.defineProperty(input, 'title', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.throws(() => normalizeCommercialProduct(input)); assert.equal(invoked, false);
  assert.throws(() => denseArray(new Array(3), 10, 'links'));
  assert.throws(() => record(JSON.parse('{"__proto__":{}}'), ['__proto__']));
  assert.throws(() => normalizeCommercialProduct({ ...product, season: 'retro' }));
});

test('money requires confirmed meaning, preserves exact large integers and never assumes XXX', () => {
  assert.deepEqual(inventoryPriceToMoney(65000, 'ARS', policy), { amountMinor: '6500000', currency: 'ARS', fractionDigits: 2 });
  assert.equal(inventoryPriceToMoney(String(Number.MAX_SAFE_INTEGER), 'ARS', policy).amountMinor, '900719925474099100');
  for (const value of [null, -1, 1.5, '01', '1e3', '9007199254740992']) assert.throws(() => inventoryPriceToMoney(value, 'ARS', policy), { code: 'MONEY_UNCONFIRMED' });
  assert.throws(() => inventoryPriceToMoney(65000, 'XXX', policy));
  assert.throws(() => validateMoneyPolicy({ ...policy, storageUnit: 'minor' }));
  assert.throws(() => enforceInventoryMoneyPolicy([{ price: { amount: 10, currency: 'USD' } }], policy));
  assert.doesNotThrow(() => enforceInventoryMoneyPolicy([{ type: 'stock.sell' }], policy));
});

test('commerce is owner-only, enabled and scoped to canonical authenticated identity', () => {
  const owner = { actorId: '59899000101', businessId: '59899000101', role: 'owner' };
  assert.equal(authorizeCommerce(owner, { enabled: true }).businessId, owner.businessId);
  assert.throws(() => authorizeCommerce(owner, { enabled: false }), { code: 'COMMERCE_FORBIDDEN' });
  assert.throws(() => authorizeCommerce({ ...owner, actorId: '59899000202', role: 'member' }, { enabled: true }), { code: 'COMMERCE_FORBIDDEN' });
  assert.throws(() => authorizeCommerce({ ...owner, businessId: '__default__' }, { enabled: true }));
});

test('maintenance target never falls back to production env and remote is explicit', () => {
  assert.throws(() => databaseTarget({ SUPABASE_DATABASE_URL: 'postgres://production' }), { code: 'EXPLICIT_DATABASE_REQUIRED' });
  assert.throws(() => databaseTarget({ COMMERCE_DATABASE_URL: 'postgres://db.example/test' }), /REMOTE_DATABASE/);
  assert.equal(databaseTarget({ COMMERCE_DATABASE_URL: 'postgres://127.0.0.1/test' }).ssl, false);
});

test('runtime does not migrate; transactions rollback and release on failures', async () => {
  const queries = []; let released = 0, ended = 0;
  const runtime = createDatabaseRuntime({ connectionString: 'fixture', poolFactory: () => ({
    connect: async () => ({ query: async sql => { queries.push(sql); }, release: () => { released++; } }), end: async () => { ended++; },
  }) });
  assert.deepEqual(queries, []);
  await runtime.transaction(async client => client.query('SELECT fixture'), { readOnly: true, repeatableRead: true });
  await assert.rejects(() => runtime.transaction(async () => { throw new Error('failure'); }), /failure/);
  assert.deepEqual(queries, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT fixture', 'COMMIT', 'BEGIN', 'ROLLBACK']);
  assert.equal(released, 2); await runtime.close(); assert.equal(ended, 1);
});
