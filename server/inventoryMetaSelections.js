import { InventoryOperationError } from './inventoryOperations.js';
import { inventoryResultReply } from './inventoryResults.js';

export const parseMetaDeactivationCommand = (text) => {
  const match = /^\s*(confirmar|cancelar)\s+baja\s+([a-f0-9]{8})\s*$/i.exec(String(text ?? ''));
  return match ? { confirm: match[1].toLowerCase() === 'confirmar', code: match[2].toLowerCase() } : null;
};

export const deactivationPreviewReply = (preview) => {
  const code = preview.digest.slice(0, 8).toUpperCase();
  const members = preview.members.map((member) => `• ${member.name}${member.size ? ` (${member.size})` : ''}: disponible ${member.stockAvailable}; reservado ${member.stockReserved}`).join('\n');
  const reply = `Revisá la baja de ${preview.members.length} SKU:\n${members}\n\nSaldrán del inventario activo; se conservarán stock e historial. Esta selección vence en 15 minutos y no incorporará productos nuevos.\nPara confirmar respondé CONFIRMAR BAJA ${code}. Para cancelar: CANCELAR BAJA ${code}.`;
  if (reply.length > 3500) throw new InventoryOperationError('SELECTION_PREVIEW_TOO_LARGE', 'El conjunto es demasiado grande para revisarlo en un mensaje. Pedí grupos más pequeños; no desactivé ningún SKU.');
  return reply;
};
export const metaDeactivationReceiptReply = (result) => {
  const reply = inventoryResultReply(result);
  return reply.length <= 3500 ? reply : `Se desactivaron los ${result.items.length} SKU de la selección confirmada. Se conservaron stock e historial. El recibo completo quedó guardado en el negocio.`;
};
