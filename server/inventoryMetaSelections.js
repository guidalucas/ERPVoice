import { InventoryOperationError } from './inventoryOperations.js';
import { inventoryResultReply } from './inventoryResults.js';

const selectionKinds = {
  'sku.deactivate': { label: 'BAJA', title: 'la baja', intent: 'delete_product' },
  'sku.update': { label: 'CAMBIO', title: 'el cambio', intent: 'update_product' },
  'stock.adjust': { label: 'AJUSTE', title: 'el ajuste', intent: 'update_product' },
};

export const parseMetaSelectionCommand = (text) => {
  const match = /^\s*(confirmar|cancelar)\s+(baja|cambio|ajuste)\s+([a-f0-9]{8})\s*$/i.exec(String(text ?? ''));
  if (!match) return null;
  const mutationType = { baja: 'sku.deactivate', cambio: 'sku.update', ajuste: 'stock.adjust' }[match[2].toLowerCase()];
  return { confirm: match[1].toLowerCase() === 'confirmar', code: match[3].toLowerCase(), mutationType, intent: selectionKinds[mutationType].intent };
};

export const parseMetaDeactivationCommand = (text) => {
  const command = parseMetaSelectionCommand(text);
  return command?.mutationType === 'sku.deactivate' ? { confirm: command.confirm, code: command.code } : null;
};

const changeLabels = { name: 'Nombre', productType: 'Tipo de producto', productModel: 'Modelo', size: 'Talle o tamaño', attributes: 'Atributos', price: 'Precio', priceCurrency: 'Moneda' };

export const inventorySelectionPreviewReply = (preview) => {
  const type = preview.mutation?.type;
  if (!Object.hasOwn(selectionKinds, type)) throw new InventoryOperationError('UNSUPPORTED_OPERATION', 'Esta selección no admite ese tipo de operación.');
  const kind = selectionKinds[type];
  const code = preview.digest.slice(0, 8).toUpperCase();
  const changes = type === 'sku.update' ? `\nCambios: ${Object.entries(preview.mutation.changes).map(([key, value]) => `${changeLabels[key] ?? key}: ${JSON.stringify(value)}`).join('; ')}.` : '';
  const members = preview.members.map((member) => {
    const identity = `• ${member.name}${member.size ? ` (${member.size})` : ''}`;
    if (type === 'stock.adjust') return `${identity}: disponible ${member.stockAvailable} ${member.unit} → ${member.finalAvailable} ${member.unit}; reservado ${member.stockReserved} ${member.unit} → ${member.finalReserved} ${member.unit}`;
    return `${identity}: disponible ${member.stockAvailable}; reservado ${member.stockReserved}`;
  }).join('\n');
  const reason = preview.mutation.reason ? `\nMotivo: ${preview.mutation.reason}.` : '';
  const consequence = type === 'sku.deactivate' ? 'Saldrán del inventario activo; se conservarán stock e historial. ' : '';
  const reply = `Revisá ${kind.title} de ${preview.members.length} ${preview.members.length === 1 ? 'producto' : 'productos'}:\n${members}${changes}${reason}\n\n${consequence}Esta selección vence en 15 minutos y no incorporará productos nuevos.\nPara confirmar respondé CONFIRMAR ${kind.label} ${code}. Para cancelar: CANCELAR ${kind.label} ${code}.`;
  if (reply.length > 3500) throw new InventoryOperationError('SELECTION_PREVIEW_TOO_LARGE', 'El conjunto es demasiado grande para revisarlo en un mensaje. Pedí grupos más pequeños; no apliqué ningún cambio.');
  return reply;
};

export const deactivationPreviewReply = (preview) => inventorySelectionPreviewReply({ ...preview, mutation: preview.mutation ?? { type: 'sku.deactivate' } });

export const inventorySelectionReceiptReply = (result) => {
  const reply = inventoryResultReply(result);
  if (reply.length <= 3500) return reply;
  const counts = new Map();
  for (const item of result.items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  const summary = [...counts].map(([type, count]) => {
    if (type === 'sku.deactivate') return `Se desactivaron los ${count} productos de la selección confirmada. Se conservaron stock e historial.`;
    if (type === 'sku.update') return `Se actualizaron los ${count} productos de la selección confirmada.`;
    if (type === 'stock.adjust') return `Se ajustaron los saldos de ${count} productos de la selección confirmada.`;
    return `Se aplicaron ${count} operaciones de ${type}.`;
  }).join(' ');
  return `${summary} El recibo completo quedó guardado en el negocio.`;
};

export const metaDeactivationReceiptReply = inventorySelectionReceiptReply;
