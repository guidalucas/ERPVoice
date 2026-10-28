import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryOperationError } from '../server/inventoryOperations.js';
import { parseUniversalMetaCommand, universalMetaPreviewReply, universalMetaReceiptReply, universalReceiptDetails, universalOperationDetail } from '../server/universalMetaOperations.js';
import { operationDetailUrl } from '../server/operationDetailLink.js';
import { processMetaWebhook } from '../server/metaWebhookProcessor.js';
import { interpretationRecoveryMessage, interpretationRecoveryContext, operationErrorMessage } from '../server/interpretationRecovery.js';

test('every operation rejection gives a cause and a concrete next action without leaking internal errors', () => {
  const cases = [
    ['INTERPRETATION_UNAVAILABLE', /servicio de interpretación/, /reenviá el mismo mensaje/],
    ['FORBIDDEN', /no está habilitada/, /administra el negocio/],
    ['DRAFT_EXPIRED', /venció el plazo/, /instrucción completa/],
    ['DRAFT_NOT_FOUND', /no encontré una propuesta/, /nueva propuesta/],
    ['DRAFT_NOT_READY', /aclaración pendiente/, /última pregunta/],
    ['DRAFT_NOT_PENDING', /resultado definitivo/, /historial/],
    ['DRAFT_VERSION_MISMATCH', /versión anterior/, /revisión vigente/],
    ['REVISION_MISMATCH', /datos cambiaron/, /valores actuales/],
    ['INSUFFICIENT_STOCK', /no hay suficientes unidades/, /stock actual/],
    ['SKU_NOT_FOUND', /no existe o no pertenece/, /nombre exacto/],
    ['SKU_INACTIVE', /dado de baja/, /producto activo/],
    ['SKU_HAS_RESERVATIONS', /unidades reservadas/, /resolvelas/],
    ['PAYMENT_EXCEEDS_DEBT', /supera la deuda/, /consultá su saldo/],
    ['CLIENT_HAS_BALANCE', /tiene saldo/, /resolvé o transferí/],
    ['CLIENT_HAS_ORDERS', /pedidos vinculados/, /resolvelos/],
    ['PRICE_CONFLICT', /precio o la moneda/, /importe y moneda/],
    ['INVALID_PRODUCT_SCHEMA', /atributos del producto/, /atributos requeridos/],
    ['IDEMPOTENCY_CONFLICT', /asociado a otra instrucción/, /recuperá el resultado/],
    ['PERSISTED_EFFECT_MISMATCH', /no pude verificar/, /antes de repetir/],
    ['LEGACY_WRITER_RETIRED', /flujo anterior/, /REVISAR OPERACION/],
    ['transcription_timeout', /tardó demasiado/, /por escrito/],
    ['transcription_not_configured', /no está configurada/, /por escrito/],
    ['audio_too_large', /tamaño máximo/, /audio más corto/],
    ['STATE_UNAVAILABLE', /leer los datos guardados/, /conservá tu vista/],
  ];
  for (const [code, cause, action] of cases) {
    const error = new InventoryOperationError(code, 'secret SQL token=private raw provider payload');
    const message = operationErrorMessage(error, { channel: 'whatsapp', noChanges: true });
    assert.match(message, /porque/); assert.match(message, /Probá: /);
    assert.match(message, cause, code); assert.match(message, action, code);
    assert.match(message, /No apliqué cambios/);
    assert.doesNotMatch(message, /secret|SQL|token|payload/);
    assert.ok(message.length < 3500);
  }
  const unknown = operationErrorMessage(new Error('raw SQL failure'));
  assert.match(unknown, /causa exacta no pude determinar/);
  assert.match(unknown, /Probá: .*antes de repetir/);
  assert.doesNotMatch(unknown, /raw|SQL|No apliqué cambios/);
  const tooLarge=operationErrorMessage(new InventoryOperationError('INTERPRETATION_UNAVAILABLE','internal',{reason:'CATALOG_TOO_LARGE'}));
  assert.match(tooLarge,/supera el tamaño/);assert.match(tooLarge,/Probá: .*grupos más pequeños/);
  assert.doesNotMatch(tooLarge,/servicio de interpretación/);
});

test('all interpretation failure reasons retain their own explanation and recovery action', () => {
  const cases = [
    ['INVALID_EVIDENCE', /respaldar todos los cambios/],
    ['INVALID_MODEL_RESPONSE', /formato inválido/],
    ['INVALID_OPERATION_PLAN', /no forman una operación válida/],
    ['UNKNOWN_CATALOG_REFERENCE', /referencia del pedido/],
    ['INVALID_INVENTORY_UNIT', /unidad solicitada/],
    ['INVALID_REVISION_PATCH', /corrección no pudo vincularse/],
    ['INVALID_CATALOG', /datos actuales del negocio/],
    ['CATALOG_TOO_LARGE', /supera el tamaño/],
    ['UNSUPPORTED_OPERATION_ORDER', /combinación de cambios/],
    ['UNRECOGNIZED_NEW_REASON', /no pude identificar un motivo más específico/],
  ];
  for (const [reason, cause] of cases) {
    const error = new InventoryOperationError('INTERPRETATION_INVALID', 'internal failure', { reason });
    const message = operationErrorMessage(error);
    assert.match(message, cause); assert.match(message, /Probá: /);
    assert.doesNotMatch(message, /internal failure|UNRECOGNIZED_NEW_REASON/);
  }
  const recovery=interpretationRecoveryContext('Borra 2 unidades\nDe la camiseta del real Madrid talle m',true);
  assert.deepEqual(recovery,{stockRemoval:true,reply:true});
  const error=new InventoryOperationError('INTERPRETATION_INVALID','internal',{reason:'FORBIDDEN',recovery});
  const message=operationErrorMessage(error,{channel:'whatsapp',sourceText:'De la camiseta del real Madrid talle m'});
  assert.match(message,/retiro directo de unidades/);assert.match(message,/cantidad final/);assert.match(message,/«cancelar»/);
});

test('empty messages and unusable audio explain the problem and suggest a usable message', async () => {
  for(const type of ['image','audio']) {
    const body={object:'whatsapp_business_account',entry:[{changes:[{value:{messages:[{id:`recovery-${type}`,from:'59899000971',type,...(type==='audio'?{audio:{id:'cached'}}:{image:{id:'unused'}})}]}}]}]};
    const [result]=await processMetaWebhook(body,{loadTranscript:async()=> 'unusable untranslated transcript words',processStockText:()=>assert.fail('unusable input must not prepare an operation')});
    assert.match(result.replyText,/porque/);assert.match(result.replyText,/Probá: /);
    assert.match(result.replyText,/por escrito|nota de voz/);assert.match(result.replyText,/No apliqué cambios/);
  }
});

test('interpretation rejection gives actionable examples without exposing the internal contract', () => {
  for (const reason of ['INVALID_EVIDENCE', 'INVALID_OPERATION_PLAN', 'UNKNOWN_FAILURE']) {
    const message = interpretationRecoveryMessage({ reason, sourceText: 'Cambiá el precio', channel: 'whatsapp' });
    assert.match(message, /No apliqué cambios/);
    assert.match(message, /porque/); assert.match(message, /Probá: /);
    assert.match(message, /instrucción completa/);
    assert.match(message, /Ejemplo de formato/);
    assert.match(message, /Reemplazá los datos entre corchetes/);
    assert.doesNotMatch(message, /contrato|INVALID_|UNKNOWN_|SKU/);
    assert.doesNotMatch(message, /borrador anterior|cancelar/);
    assert.ok(message.length < 3500);
  }
  for (const [sourceText, expected] of [
    ['Anotá un pedido', /pedido de \[nombre completo del cliente\]/],
    ['Registrá un pago', /Registrá un pago\] de \[importe\]/],
    ['Ingresaron camisetas', /Elegí una sola acción/],
  ]) assert.match(interpretationRecoveryMessage({ sourceText }), expected);
});

test('forbidden stock removal explains the limitation and suggests an explicit final balance', () => {
  const message = interpretationRecoveryMessage({ reason: 'FORBIDDEN', sourceText: 'Borra 2 unidades\nDe la camiseta del real Madrid talle m', channel: 'whatsapp', reply: true });
  assert.match(message, /retiro directo de unidades no está habilitado/);
  assert.match(message, /cantidad final/);
  assert.match(message, /no la cantidad que querés quitar/);
  assert.match(message, /dar de baja el producto completo/);
  assert.match(message, /borrador anterior sigue pendiente/);
  assert.match(message, /«cancelar»/);
  assert.doesNotMatch(message, /FORBIDDEN|contrato|Retirá 2|a 1 unidades/);
  const panel = interpretationRecoveryMessage({ reason: 'FORBIDDEN', reply: true });
  assert.match(panel, /Reformular el mismo pedido no habilita/);
  assert.match(panel, /cancelá el borrador/);
  assert.doesNotMatch(panel, /este chat|«cancelar»/);
});

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
  assert.match(output, /^✅ \*Cambios guardados\*\n\n• /);
  assert.match(output, /Ingreso aplicado: 4 unidades de Camisa · Disponible: 9 · reservado: 2/);
  assert.match(output, /Cargo registrado: Ana; importe 35; saldo 90\./);
  assert.match(output, /Pedido actualizado: Camisa; cantidad 4; estado conseguido\./);
  assert.match(output, /Disponible: 9 · reservado: 2/);
  assert.match(output, /Proveedor unido: Tienda Centro unido a Tienda Norte\./);
  assert.doesNotMatch(output, /Notas guardadas|Cuenta histórica/);
  assert.match(output, /Pedidos afectados: 2/);
  assert.doesNotMatch(output, /sku-uuid-secret|order-secret|supplier-secret|supplier-removed/);
});

test('large receipts show a bounded list and remaining count; malformed receipts fail closed', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ type: 'client.update', party: { name: `Cliente ${index}`, notas: 'nota'.repeat(40) } }));
  const before = structuredClone(items), summary = universalMetaReceiptReply({ items });
  assert.equal(summary.split('\n').filter(line => line.startsWith('• ')).length, 6);
  assert.match(summary, /Y 24 cambios más/);
  assert.match(summary, /detalle completo quedó guardado/);
  assert.ok(summary.length <= 1200);
  assert.deepEqual(items, before);
  expectCode(() => universalMetaReceiptReply({ items: [{ type: 'client.update', party: {} }] }), 'INVALID_DRAFT_REQUEST');
  assert.doesNotMatch(universalMetaReceiptReply({ items: [{ type: 'sku.create', skuName: 'Camisa', skuId: 'a0b1c2d3-uuid', stockAvailable: 2, stockReserved: 0, currency: 'UYU', price: 10 }] }), /a0b1c2d3-uuid/);
  const update=universalMetaReceiptReply({items:[{type:'sku.update',skuName:'Conversor',skuId:'sku-private-id',stockAvailable:2,stockReserved:0,revision:3,
    changes:{family:{id:'family-private-id',version:2},attributes:{voltage:{state:'known',type:'number',value:0,unit:'v'},certified:{state:'known',type:'boolean',value:false},length:{state:'unknown',type:'number',unit:'mm'}}}}]});
  assert.doesNotMatch(update,/private-id/);assert.match(update,/Familia: versión 2/);assert.match(update,/voltage: 0 v/);assert.match(update,/certified: No/);assert.match(update,/length: Desconocido mm/);
});

test('short receipts omit zero reservations and internal revisions and format amounts', () => {
  const output = universalMetaReceiptReply({ items: [{ type: 'sku.create', skuName: 'Taladro', size: '650 W', stockAvailable: 3, stockReserved: 0, price: 65000, currency: 'ARS', revision: 99 }] });
  assert.match(output, /Producto creado: Taladro \(650 W\) · Disponible: 3 · ARS 65\.000/);
  assert.doesNotMatch(output, /reservado|revisión|99|Entendí/);
});

test('cancelled preview is clear and applied preview reuses its persisted receipt', () => {
  assert.match(universalMetaPreviewReply(ready({ status: 'cancelled' })), /cancelada/);
  const output = universalMetaPreviewReply(ready({ status: 'applied', result: { items: [{ type: 'account.payment', clientName: 'Ana', amount: 10, balance: 0 }] } }));
  assert.match(output, /Pago registrado: Ana; importe 10; saldo 0/);
});

test('confirmed replies link to their operation and keep the WhatsApp character limit', () => {
  const draftId = 'f375eb6a-3184-45c7-8643-b2ebddae8cf3';
  const url = operationDetailUrl(draftId, 'https://stocky.example/app/?old=value#previous');
  assert.equal(url, `https://stocky.example/app/?operation=${draftId}`);
  assert.equal(new URL(operationDetailUrl('draft with & symbols', 'http://localhost:5173')).searchParams.get('operation'), 'draft with & symbols');
  for (const base of ['javascript:alert(1)', 'ftp://example.com', 'https://user:secret@example.com', 'not a URL']) assert.equal(operationDetailUrl(draftId, base), null);
  const items = Array.from({ length: 30 }, (_, index) => ({ type: 'sku.create', skuName: `Remera ${index} ${'algodón '.repeat(40)}`, stockAvailable: 3, stockReserved: 0, price: 100, currency: 'ARS' }));
  const summary = universalMetaReceiptReply({ items }, { detailUrl: url });
  assert.ok(summary.endsWith(`Ver detalle completo:\n${url}`)); assert.ok(summary.length <= 1200);
  const details = universalReceiptDetails({ items });
  assert.equal(details.length, 30); assert.ok(details[29].length > 240); assert.ok(!details[29].endsWith('…'));
  const preview = ready({ draftId, status: 'applied', result: { items } });
  const detail = universalOperationDetail(preview);
  assert.deepEqual(detail.changes, details); assert.deepEqual(detail.review, preview.review); assert.equal(detail.text, preview.text);
  assert.match(universalMetaPreviewReply(preview, { detailUrl: url }), /Ver detalle completo:/);
  assert.doesNotMatch(universalMetaPreviewReply(ready(), { detailUrl: url }), /Ver detalle completo:/);
  assert.doesNotMatch(universalMetaPreviewReply(ready({ status: 'cancelled' }), { detailUrl: url }), /Ver detalle completo:/);
  expectCode(() => universalOperationDetail(ready()), 'DRAFT_NOT_PENDING');
});
