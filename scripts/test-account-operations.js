import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAccountPlan, planAccountOperation, accountPlanDigest } from '../server/accountOperations.js';
const clients = [{ id: 'a', name: 'A', debt: 100, accountRevision: 2 }, { id: 'b', name: 'B', debt: 20, accountRevision: 3 }];
const action = (type = 'account.payment', value = 30, extra = {}) => ({ itemId: 'one', type, target: { kind: 'existing', clientId: 'a' }, amount: { value, unit: 'legacy-money' }, reason: 'Confirmado', ...extra });
const plan = (actions = [action()]) => ({ contractVersion: 1, businessId: 'business', operationId: 'account-test', actions });
const context = { businessId: 'business', actorId: 'actor', permissions: ['accounts:charge', 'accounts:payment', 'accounts:adjust', 'accounts:transfer'] };
test('account plans reject coercion, hidden fields, unsupported currency and unauthorized scope', () => {
    for (const value of [0, -1, 1.2, '3', null, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => validateAccountPlan(plan([action('account.payment', value)]), context), { code: 'INVALID_ACCOUNT_OPERATION' });
    assert.throws(() => validateAccountPlan(plan([action('account.payment', 1, { amount: { value: 1, unit: 'USD' } })]), context), { code: 'INVALID_ACCOUNT_OPERATION' });
    assert.throws(() => validateAccountPlan(plan([action('account.payment', 1, { target: { kind: 'existing', clientName: 'A' } })]), context), { code: 'INVALID_ACCOUNT_OPERATION' });
    assert.throws(() => validateAccountPlan(plan(), { ...context, businessId: 'other' }), { code: 'BUSINESS_SCOPE_MISMATCH' });
    assert.throws(() => validateAccountPlan(plan(), { ...context, permissions: ['accounts:charge'] }), { code: 'FORBIDDEN' });
    const malicious = Object.defineProperty({}, 'actions', { enumerable: true, get() { throw Error('getter executed'); } });
    assert.throws(() => validateAccountPlan(malicious, context), { code: 'INVALID_ACCOUNT_OPERATION' });
});
test('payments reject excess, absolute adjustments need revisions and input stays unchanged', () => {
    const before = JSON.stringify(clients), p = plan([action(), action('account.charge', 5, { itemId: 'two' })]);
    const validated = validateAccountPlan(p, context), effect = planAccountOperation(validated, clients);
    assert.equal(effect.changedClients[0].debt, 75);
    assert.deepEqual(effect.movements.map((m) => m.delta), [-30, 5]);
    assert.equal(JSON.stringify(clients), before);
    assert.equal(Object.isFrozen(validated.actions[0].amount), true);
    assert.throws(() => planAccountOperation(plan([action('account.payment', 101)]), clients), { code: 'PAYMENT_EXCEEDS_DEBT' });
    assert.throws(() => validateAccountPlan(plan([action('account.adjust', 0)]), context), { code: 'INVALID_ACCOUNT_OPERATION' });
    assert.equal(planAccountOperation(plan([action('account.adjust', 0, { target: { kind: 'existing', clientId: 'a', expectedRevision: 2 } })]), clients).changedClients[0].debt, 0);
});
test('transfers conserve balances atomically and overflow/stale/foreign clients reject the plan', () => {
    const transfer = action('account.transfer', 80, { target: { kind: 'existing', clientId: 'a', expectedRevision: 2 }, destination: { clientId: 'b', expectedRevision: 3 } });
    const result = planAccountOperation(plan([transfer]), clients);
    assert.deepEqual(result.changedClients.map((c) => [c.id, c.debt]).sort(), [['a', 20], ['b', 100]]);
    assert.equal(result.movements.reduce((n, m) => n + m.delta, 0), 0);
    assert.throws(() => planAccountOperation(plan([{ ...transfer, destination: { clientId: 'b', expectedRevision: 4 } }]), clients), { code: 'ACCOUNT_REVISION_MISMATCH' });
    assert.throws(() => planAccountOperation(plan([action('account.charge', Number.MAX_SAFE_INTEGER)]), clients), { code: 'MONEY_OVERFLOW' });
    assert.throws(() => planAccountOperation(plan([action('account.payment', 1, { target: { kind: 'existing', clientId: 'foreign' } })]), clients), { code: 'CLIENT_NOT_FOUND' });
    assert.notEqual(accountPlanDigest(plan()), accountPlanDigest(plan([action('account.payment', 31)])));
});
