import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetaSelectionCommand, parseMetaDeactivationCommand, inventorySelectionPreviewReply, deactivationPreviewReply, inventorySelectionReceiptReply, metaDeactivationReceiptReply } from '../server/inventoryMetaSelections.js';
import { inventoryResultReply } from '../server/inventoryResults.js';

const member = { skuId: 'sku-1', name: 'Producto genérico', size: 'M', stockAvailable: 8, stockReserved: 3, unit: 'kg', finalAvailable: 12, finalReserved: 1 };
const preview = (type, extra = {}) => ({ digest: 'aBcD1234'.toLowerCase().repeat(8), members: [member], mutation: { type, reason: 'Conteo físico', ...extra } });

test('selection commands accept all supported labels, case and surrounding whitespace', () => {
  for (const [label, mutationType, intent] of [['BAJA', 'sku.deactivate', 'delete_product'], ['CAMBIO', 'sku.update', 'update_product'], ['AJUSTE', 'stock.adjust', 'update_product']]) {
    for (const [verb, confirm] of [['cOnFiRmAr', true], ['CANCELAR', false]]) {
      assert.deepEqual(parseMetaSelectionCommand(` \t${verb}  ${label} AbCd1234 \n`), { confirm, code: 'abcd1234', mutationType, intent });
    }
  }
});

test('invalid commands fail closed and legacy parser only accepts BAJA', () => {
  for (const input of [null, '', 'confirmar baja abc1234', 'confirmar baja abc123456', 'confirmar baja zbc12345', 'confirmar cambio abcd1234 ahora', 'sí baja abcd1234', 'confirmar venta abcd1234', 'confirmar abcd1234']) assert.equal(parseMetaSelectionCommand(input), null);
  assert.deepEqual(parseMetaDeactivationCommand('CONFIRMAR BAJA ABCD1234'), { confirm: true, code: 'abcd1234' });
  assert.deepEqual(parseMetaDeactivationCommand('cancelar baja ABCD1234'), { confirm: false, code: 'abcd1234' });
  assert.equal(parseMetaDeactivationCommand('confirmar cambio abcd1234'), null);
  assert.equal(parseMetaDeactivationCommand('cancelar ajuste abcd1234'), null);
});

test('adjustment preview shows exact before/final quantities, units, reason and commands', () => {
  const reply = inventorySelectionPreviewReply(preview('stock.adjust'));
  assert.match(reply, /disponible 8 kg → 12 kg; reservado 3 kg → 1 kg/);
  assert.match(reply, /Motivo: Conteo físico/);
  assert.match(reply, /15 minutos y no incorporará productos nuevos/);
  assert.match(reply, /CONFIRMAR AJUSTE ABCD1234/);
  assert.match(reply, /CANCELAR AJUSTE ABCD1234/);
  assert.doesNotMatch(reply, /desactiv|baja/i);
});

test('update preview includes every member, current stocks and human-readable changes', () => {
  const input = preview('sku.update', { changes: { name: 'Nuevo nombre', productType: 'Insumo', productModel: null, size: 'L', attributes: { material: 'algodón' }, price: 0, priceCurrency: 'UYU' } });
  input.members = Array.from({ length: 12 }, (_, index) => ({ ...member, name: `Producto ${index}`, stockAvailable: index, stockReserved: index + 1 }));
  const reply = inventorySelectionPreviewReply(input);
  for (let index = 0; index < 12; index++) assert.ok(reply.includes(`• Producto ${index} (M): disponible ${index}; reservado ${index + 1}`));
  for (const detail of ['Nombre: "Nuevo nombre"', 'Tipo de producto: "Insumo"', 'Modelo: null', 'Talle o tamaño: "L"', 'Atributos: {"material":"algodón"}', 'Precio: 0', 'Moneda: "UYU"', 'Motivo: Conteo físico', 'CONFIRMAR CAMBIO ABCD1234', 'CANCELAR CAMBIO ABCD1234']) assert.ok(reply.includes(detail), detail);
});

test('deactivation keeps conservation text and legacy shape without mutation', () => {
  const input = preview('sku.deactivate');
  const reply = inventorySelectionPreviewReply(input);
  assert.match(reply, /disponible 8; reservado 3/);
  assert.match(reply, /se conservarán stock e historial/);
  assert.match(reply, /CONFIRMAR BAJA ABCD1234/);
  assert.match(reply, /CANCELAR BAJA ABCD1234/);
  assert.equal(deactivationPreviewReply(input), reply);
  const { mutation, ...legacy } = input;
  assert.match(deactivationPreviewReply(legacy), /Revisá la baja/);
});

test('unknown mutation is rejected instead of offering a confirmation', () => {
  for (const type of [undefined, 'stock.sell', 'constructor', '__proto__']) assert.throws(() => inventorySelectionPreviewReply(preview(type)), { code: 'UNSUPPORTED_OPERATION' });
});

test('oversized previews reject the whole review rather than truncating members or changes', () => {
  for (const type of ['sku.deactivate', 'sku.update', 'stock.adjust']) {
    const input = preview(type, { ...(type === 'sku.update' ? { changes: { name: 'Nuevo' } } : {}) });
    input.members = Array.from({ length: 100 }, () => ({ ...member }));
    assert.throws(() => inventorySelectionPreviewReply(input), { code: 'SELECTION_PREVIEW_TOO_LARGE' });
  }
  assert.throws(() => inventorySelectionPreviewReply(preview('sku.update', { changes: { name: 'x'.repeat(3501) } })), { code: 'SELECTION_PREVIEW_TOO_LARGE' });
});

test('small receipts remain unchanged and long receipts summarize the correct operation and count', () => {
  for (const [type, expected] of [['sku.deactivate', 'Se desactivaron los 40 productos'], ['sku.update', 'Se actualizaron los 40 productos'], ['stock.adjust', 'Se ajustaron los saldos de 40 productos']]) {
    const item = { type, skuName: 'Producto', stockAvailable: 8, stockReserved: 3, revision: 2 };
    assert.equal(inventorySelectionReceiptReply({ items: [item] }), inventoryResultReply({ items: [item] }));
    const result = { items: Array.from({ length: 40 }, () => ({ ...item, skuName: 'Producto'.repeat(30) })) };
    const reply = inventorySelectionReceiptReply(result);
    assert.ok(reply.includes(expected));
    assert.match(reply, /recibo completo quedó guardado en el negocio/);
    assert.ok(reply.length <= 3500);
    if (type !== 'sku.deactivate') assert.doesNotMatch(reply, /desactiv/);
    assert.equal(metaDeactivationReceiptReply(result), reply);
  }
});
