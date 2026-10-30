import { executeInventoryPlanInTransaction } from '../inventoryPostgres.js';
import { record, denseArray, text, integer } from './validation.js';
import { fail } from './errors.js';

const fields = ['productType', 'productModel', 'size'];
export function normalizeSkuMetadataChanges(input) {
  const updates = denseArray(input, 100, 'atributos de SKU').map(input => {
    const item = record(input, ['skuId', 'expectedRevision', 'expectedFingerprint', 'changes']);
    const changes = record(item.changes, fields, 'atributos del rubro');
    if (!Object.keys(changes).length) fail('INVALID_COMMAND', 'Indicá al menos un atributo para actualizar.', 400);
    return { skuId: text(item.skuId, 180, 'SKU'), expectedRevision: integer(item.expectedRevision),
      expectedFingerprint: text(item.expectedFingerprint, 128, 'identidad del SKU'),
      changes: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value === null ? null : text(value, key === 'size' ? 80 : 180, key, { empty: true }) || null])) };
  });
  if (new Set(updates.map(item => item.skuId)).size !== updates.length) fail('INVALID_COMMAND', 'No repitas un SKU en los atributos.', 400);
  return updates;
}

// The same inventory executor validates identity/revision and records the edits.
// Both the metadata and the commercial links commit in the caller's transaction.
export async function applySkuMetadata(client, context, operationId, updates, allowedIds) {
  if (updates.some(item => !allowedIds.includes(item.skuId))) fail('INVALID_COMMAND', 'Solo podés editar atributos de los SKU vinculados a esta ficha.', 400);
  if (!updates.length) return new Map();
  const plan = { contractVersion: 1, businessId: context.businessId, operationId: `commerce-metadata:${operationId}`,
    source: { channel: 'panel', text: 'Atributos del rubro revisados desde Studio' },
    actions: updates.map((item, index) => ({ itemId: `metadata-${index}`, type: 'sku.update',
      target: { kind: 'existing', skuId: item.skuId, expectedRevision: item.expectedRevision, expectedFingerprint: item.expectedFingerprint },
      changes: item.changes, reason: 'Atributos del rubro revisados desde Studio' })) };
  try {
    const result = await executeInventoryPlanInTransaction(client, plan, { businessId: context.businessId, actorId: context.actorId, permissions: ['inventory:update'] });
    return new Map(result.items.map(item => [item.skuId, { skuId: item.skuId, expectedRevision: item.revision, expectedFingerprint: item.product.identityFingerprint }]));
  } catch (error) {
    if (error.name === 'InventoryOperationError') fail(error.code, 'El SKU cambió o sus atributos no son válidos. Actualizá la ficha y revisá los datos antes de guardar.', 409);
    throw error;
  }
}
