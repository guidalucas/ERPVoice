import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryOperationError } from '../server/inventoryOperations.js';
import { parseUniversalMetaCommand, universalMetaPreviewReply, universalMetaReceiptReply } from '../server/universalMetaOperations.js';
import { processMetaWebhook } from '../server/metaWebhookProcessor.js';

const digest = 'a1b2c3d4'.padEnd(64, '0');
const plan = (ids = ['one', 'two']) => ({ actions: ids.map((itemId) => ({ itemId })) });
const review = (ids = ['one', 'two']) => ids.map((itemId, index) => ({ itemId, title: `Cambio ${index + 1}`, details: [`Dato ${index + 1}a`, `Dato ${index + 1}b`] }));
const ready = (overrides = {}) => ({ draftId: 'draft-secret-id', version: 3, text: 'pedido', expiresAt: '2026-10-18T15:15:00.000Z', status: 'awaiting_confirmation', plan: plan(), digest, review: review(), ...overrides });
const expectCode = (fn, code) => assert.throws(fn, (error) => error instanceof InventoryOperationError && error.code === code);

test('webhook handlers and replays precede legacy catalog/provider loading for text and stored audio', async () => {
  for (const type of ['text','audio']) {
    const sourceText='CONFIRMAR OPERACION a1b2c3d4';
    const message={id:`lazy-${type}`,from:'59899000971',type,...(type==='text'?{text:{body:sourceText}}:{audio:{id:'no-network-audio'}})};
    const body={object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[message]}}]}]};
    const reply={intent:'mixed',replyText:'Recibo persistido',actions:[],requiresConfirmation:false};
    const result=await processMetaWebhook(body,{
      loadTranscript:async()=>sourceText,saveTranscript:async()=>{},
      resolveCatalog:async()=>assert.fail('handled replay must not read the catalog'),
      processStockText:async input=>{assert.equal(input.sourceText,sourceText);return reply;},
    });
    assert.equal(result[0].stockBatchResponse,reply);assert.equal(result[0].replyText,reply.replyText);
    await assert.rejects(processMetaWebhook(body,{
      loadTranscript:async()=>sourceText,saveTranscript:async()=>{},
      resolveCatalog:async()=>assert.fail('failed handler must not fall back to a catalog/parser'),
      processStockText:async()=>{throw new Error('retryable SQL failure');},
    }),/retryable SQL failure/);
  }
});

test('explicit command parser handles accents, casing, bodies and malformed namespace commands', () => {
  assert.deepEqual(parseUniversalMetaCommand(' revisar operación   pedido de lana '), { kind: 'prepare', text: 'pedido de lana' });
  assert.deepEqual(parseUniversalMetaCommand('RESPONDER OPERACION A1B2C3D4 cambiar cantidad'), { kind: 'reply', code: 'a1b2c3d4', text: 'cambiar cantidad' });
  assert.deepEqual(parseUniversalMetaCommand('confirmar operación A1B2C3D4'), { kind: 'confirm', code: 'a1b2c3d4' });
  assert.deepEqual(parseUniversalMetaCommand('CANCELAR OPERACION a1b2c3d4'), { kind: 'cancel', code: 'a1b2c3d4' });
  for (const input of ['REVISAR OPERACION', 'RESPONDER OPERACION abc cambio', 'CONFIRMAR OPERACION a1b2c3d4 ahora', 'CANCELAR OPERACIÓN'])
    assert.deepEqual(parseUniversalMetaCommand(input), { kind: 'invalid' });
  assert.equal(parseUniversalMetaCommand('¿Cuánto stock queda?'), null);
  assert.equal(parseUniversalMetaCommand('REVISAR INVENTARIO pantalón'), null);
  assert.deepEqual(parseUniversalMetaCommand(`REVISAR OPERACION ${'x'.repeat(12001)}`), { kind: 'invalid' });
});

test('ready preview renders every reviewed item in plan order and requires exact unique coverage', () => {
  const output = universalMetaPreviewReply(ready());
  assert.ok(output.indexOf('Cambio 1') < output.indexOf('Cambio 2'));
  assert.match(output, /Dato 1a[\s\S]*Dato 1b[\s\S]*Dato 2a[\s\S]*Dato 2b/);
  assert.match(output, /todavía no se aplicó/);
  assert.match(output, /Respondé «confirmar» para aplicar, «cancelar» para descartar, o escribí qué querés corregir/);
  assert.doesNotMatch(output, /OPERACION|A1B2C3D4|<corrección>/);
  assert.match(output, /15 minutos/);
  expectCode(() => universalMetaPreviewReply(ready({ review: [review()[0]] })), 'INVALID_DRAFT_REQUEST');
  expectCode(() => universalMetaPreviewReply(ready({ review: [review()[1], review()[0]] })), 'INVALID_DRAFT_REQUEST');
  expectCode(() => universalMetaPreviewReply(ready({ review: [review()[0], { ...review()[1], itemId: 'one' }] })), 'INVALID_DRAFT_REQUEST');
  expectCode(() => universalMetaPreviewReply(ready({ plan: plan(['one', 'two', 'hidden-change']) })), 'INVALID_DRAFT_REQUEST');
  expectCode(() => universalMetaPreviewReply(ready({ review: [{ ...review()[0], details: ['visible'] }, { ...review()[1], details: ['visible'] }], plan: plan(['one', 'two', 'hidden-change']) })), 'INVALID_DRAFT_REQUEST');
});

test('oversized full review is rejected without truncating any reviewed facts', () => {
  const oversized = ready({ plan: plan(['one']), review: [{ itemId: 'one', title: 'Propuesta', details: ['x'.repeat(3600)] }] });
  expectCode(() => universalMetaPreviewReply(oversized), 'DRAFT_PREVIEW_TOO_LARGE');
});

test('clarification retains previous full review and never offers confirmation', () => {
  const output = universalMetaPreviewReply(ready({ status: 'awaiting_clarification', question: '¿Qué variante corresponde?' }));
  assert.match(output, /¿Qué variante corresponde\?/);
  assert.match(output, /Revisión conservada/);
  assert.match(output, /Cambio 1[\s\S]*Cambio 2/);
  assert.match(output, /Respondé directamente en este chat/);
  assert.match(output, /«cancelar»/);
  assert.doesNotMatch(output, /confirmar|OPERACION|A1B2C3D4|<corrección>/);
  assert.match(universalMetaPreviewReply(ready({ status: 'awaiting_clarification', question: '¿Qué variante?', plan: null, review: null })), /¿Qué variante\?/);
});

test('composed receipt describes persisted stock, account, order, party and derived stock facts', () => {
  const result = { receipts: [
    { items: [{ type: 'stock.receive', quantity: { value: 4, unit: 'unit' }, skuName: 'Camisa', skuId: 'sku-uuid-secret', stockAvailable: 9, stockReserved: 2 }] },
    { items: [{ type: 'account.charge', clientName: 'Ana', amount: 35, balance: 90 }] },
    { receipts: [{ kind: 'update', pedido: { id: 'order-secret', producto: 'Camisa', qty: 4, estado: 'conseguido' }, inventoryResult: { items: [{ type: 'stock.receive', quantity: { value: 4, unit: 'unit' }, skuName: 'Camisa', skuId: 'sku-uuid-secret', stockAvailable: 9, stockReserved: 2 }] } }] },
    { items: [{ type: 'supplier.merge', party: { id: 'supplier-secret', name: 'Tienda Norte', notas: 'Cuenta histórica' }, removedParty: { id: 'supplier-removed', name: 'Tienda Centro' }, affectedOrders: [{ id: 'o1' }, { id: 'o2' }] }] },
  ] };
  const output = universalMetaReceiptReply(result);
  assert.match(output, /Ingreso aplicado: 4 unit de Camisa\. Disponible: 9; reservado: 2\./);
  assert.match(output, /Cargo registrado: Ana; importe 35; saldo 90\./);
  assert.match(output, /Pedido actualizado: Camisa; cantidad 4; estado conseguido\./);
  assert.match(output, /Disponible: 9; reservado: 2/);
  assert.match(output, /Proveedor unido: Tienda Centro unido a Tienda Norte\./);
  assert.match(output, /Notas guardadas: Cuenta histórica/);
  assert.match(output, /Pedidos afectados: 2/);
  assert.doesNotMatch(output, /sku-uuid-secret|order-secret|supplier-secret|supplier-removed/);
});

test('large receipt uses the exact generic summary and malformed receipts fail closed', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ type: 'client.update', party: { name: `Cliente ${index}`, notas: 'nota'.repeat(40) } }));
  assert.equal(universalMetaReceiptReply({ items }), 'Operación aplicada. El recibo completo de todos los cambios quedó guardado en el negocio.');
  expectCode(() => universalMetaReceiptReply({ items: [{ type: 'client.update', party: {} }] }), 'INVALID_DRAFT_REQUEST');
  assert.doesNotMatch(universalMetaReceiptReply({ items: [{ type: 'sku.create', skuName: 'Camisa', skuId: 'a0b1c2d3-uuid', stockAvailable: 2, stockReserved: 0, currency: 'UYU', price: 10 }] }), /a0b1c2d3-uuid/);
  const update=universalMetaReceiptReply({items:[{type:'sku.update',skuName:'Conversor',skuId:'sku-private-id',stockAvailable:2,stockReserved:0,revision:3,
    changes:{family:{id:'family-private-id',version:2},attributes:{voltage:{state:'known',type:'number',value:0,unit:'v'},certified:{state:'known',type:'boolean',value:false},length:{state:'unknown',type:'number',unit:'mm'}}}}]});
  assert.doesNotMatch(update,/private-id/);assert.match(update,/Familia: versión 2/);assert.match(update,/voltage: 0 v/);assert.match(update,/certified: No/);assert.match(update,/length: Desconocido mm/);
});

test('cancelled preview is clear and applied preview reuses its persisted receipt', () => {
  assert.match(universalMetaPreviewReply(ready({ status: 'cancelled' })), /cancelada/);
  const output = universalMetaPreviewReply(ready({ status: 'applied', result: { items: [{ type: 'account.payment', clientName: 'Ana', amount: 10, balance: 0 }] } }));
  assert.match(output, /Pago registrado: Ana; importe 10; saldo 0/);
});
