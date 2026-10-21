import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUniversalIntent } from '../server/universalIntentInterpreter.js';

const policy = { currency: 'ARS', storageUnit: 'major_integer', fractionDigits: 2, revision: 1 };
const text = 'Cargá una camiseta nueva y dejale el precio de la existente en 65000';
const catalog = { moneyPolicy: policy, products: [{ id: 'sku', name: 'Existente', unit: 'unit', revision: 3, stockAvailable: 2, stockReserved: 0, price: 62000, priceCurrency: 'ARS' }], clients: [], proveedores: [], pedidos: [] };
const context = { actorId: 'owner', businessId: 'owner', permissions: ['inventory:create', 'inventory:receive', 'inventory:update', 'inventory:sell'] };
const invoke = (actions, patch = {}) => interpretUniversalIntent({ sourceText: text, catalog: structuredClone(catalog), context, channel: 'panel', operationId: 'money-voice-test',
  complete: async input => {
    const supplied = JSON.parse(input.messages[1].content); assert.deepEqual(supplied.catalog.moneyPolicy, policy);
    return { ok: true, json: { contractVersion: 1, kind: 'proposal', actions: structuredClone(actions), evidence: actions.map(action => ({ itemId: action.itemId, quote: text })) } };
  }, ...patch });
test('panel and WhatsApp freeze active business currency in compound voice proposals and retain it independently of later configuration', async () => {
  for (const channel of ['panel', 'whatsapp']) {
    const result = await invoke([
      { itemId: 'create', type: 'sku.create', target: { kind: 'new', sku: { name: 'Camiseta nueva', unit: 'unit' } }, initialStock: { available: 1, reserved: 0 }, reason: 'Alta solicitada' },
      { itemId: 'edit', type: 'sku.update', target: { kind: 'existing', skuId: 'sku' }, changes: { price: 65000 }, reason: 'Precio solicitado' },
    ], { channel });
    assert.equal(result.kind, 'ready', result.reason);
    assert.deepEqual(result.plan.actions[0].price, { amount: 0, currency: 'ARS', policy: 'initialize' });
    assert.equal(result.plan.actions[1].changes.priceCurrency, 'ARS'); assert.equal(result.plan.actions[1].target.expectedRevision, 3);
    assert.ok(Object.isFrozen(result.plan)); const frozen = JSON.stringify(result.plan); policy.currency = 'UYU'; assert.equal(JSON.stringify(result.plan), frozen); policy.currency = 'ARS';
  }
});
test('a requested different currency asks for clarification and cannot silently convert or invent a sale price', async () => {
  const result = await invoke([{ itemId: 'edit', type: 'sku.update', target: { kind: 'existing', skuId: 'sku' }, changes: { price: 65000, priceCurrency: 'USD' }, reason: 'Precio solicitado' }]);
  assert.equal(result.kind, 'clarification'); assert.match(result.question, /ARS/); assert.equal(result.plan, undefined);
  const sell = await invoke([{ itemId: 'sell', type: 'stock.sell', target: { kind: 'existing', skuId: 'sku' }, quantity: { value: 1, unit: 'unit' } }]);
  assert.equal(sell.kind, 'ready', sell.reason); assert.equal(sell.plan.actions[0].salePrice, undefined);
});
