import { InventoryOperationError } from './inventoryOperations.js';
import { accountResultReply } from './accountOperations.js';
import { validateUniversalOperationReview } from './universalOperationReview.js';

const fail = (code, message) => { throw new InventoryOperationError(code, message); };
const invalidDraft = () => fail('INVALID_DRAFT_REQUEST', 'El borrador o recibo de la operación está incompleto o no es válido.');
const PREVIEW_LIMIT = 3500;
const RECEIPT_LIMIT = 1200;
const RECEIPT_ITEMS = 6;
const numberText = value => typeof value === 'number' ? value.toLocaleString('es-AR') : String(value);
const inlineText = value => String(value).replace(/\s+/g, ' ').trim();

/**
 * Explicit WhatsApp control namespace. Once a recognized verb and OPERACION
 * prefix are present, malformed input stays in this namespace and is rejected.
 */
export function parseUniversalMetaCommand(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const prefix = /^(REVISAR|RESPONDER|CONFIRMAR|CANCELAR)\s+OPERACI(?:O|Ó)N(?:\s|$)/i.exec(text);
  if (!prefix) return null;
  const rest = text.slice(prefix[0].length).trim();
  const verb = prefix[1].toUpperCase();
  if (verb === 'REVISAR') {
    if (!rest || rest.length > 12000) return { kind: 'invalid' };
    return { kind: 'prepare', text: rest };
  }
  if (verb === 'RESPONDER') {
    const match = /^([a-f\d]{8})\s+([\s\S]+)$/i.exec(rest);
    if (!match) return { kind: 'invalid' };
    const body = match[2].trim();
    if (!body || body.length > 12000) return { kind: 'invalid' };
    return { kind: 'reply', code: match[1].toLowerCase(), text: body };
  }
  const match = /^([a-f\d]{8})$/i.exec(rest);
  if (!match) return { kind: 'invalid' };
  return { kind: verb === 'CONFIRMAR' ? 'confirm' : 'cancel', code: match[1].toLowerCase() };
}

function validatePreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || typeof preview.digest !== 'string' || !/^[a-f\d]{64}$/i.test(preview.digest)
    || !['awaiting_confirmation', 'awaiting_clarification', 'applied', 'cancelled','answered'].includes(preview.status)) invalidDraft();
  return preview;
}

const renderReview = (review) => review.map((item) => [item.title, ...item.details.map((detail) => `• ${detail}`)].join('\n')).join('\n\n');

/** Render backend-owned preview facts; this function does not interpret or change a plan. */
export function universalMetaPreviewReply(input, options = {}) {
  const preview = validatePreview(input);
  if (preview.status === 'cancelled') return 'La operación fue cancelada. No se aplicó ningún cambio.';
  if (preview.status === 'applied') return universalMetaReceiptReply(preview.result, options);
  if (preview.status === 'answered') {
    if(preview.plan || typeof preview.answer?.text!=='string' || !preview.answer.text.trim() || !Array.isArray(preview.answer.items)) invalidDraft();
    if(preview.answer.text.length>PREVIEW_LIMIT) fail('DRAFT_PREVIEW_TOO_LARGE','La respuesta completa supera el límite de WhatsApp. Pedí un conjunto más pequeño o consultá desde el panel.');
    return preview.answer.text;
  }

  const hasPlan = preview.plan !== undefined && preview.plan !== null;
  const review = hasPlan ? validateUniversalOperationReview(preview.plan, preview.review) : null;
  let output;
  if (preview.status === 'awaiting_clarification') {
    if (typeof preview.question !== 'string' || !preview.question.trim()) invalidDraft();
    output = [
      'Necesito una aclaración antes de preparar la operación.',
      preview.question.trim(),
      ...(review ? ['Revisión conservada del borrador anterior:', renderReview(review)] : []),
      'Respondé directamente en este chat. Para descartar la operación, escribí «cancelar».',
      'La vigencia del borrador es de 15 minutos.',
    ].join('\n\n');
  } else {
    if (!hasPlan || !review) invalidDraft();
    output = [
      'Propuesta revisada; todavía no se aplicó.',
      renderReview(review),
      'Respondé «confirmar» para aplicar, «cancelar» para descartar, o escribí qué querés corregir.',
      'La vigencia del borrador es de 15 minutos.',
    ].join('\n\n');
  }
  if (output.length > PREVIEW_LIMIT) fail('DRAFT_PREVIEW_TOO_LARGE', 'La revisión completa supera el límite de WhatsApp. Separá la operación en grupos más pequeños o usá el panel para revisar todos los detalles.');
  return output;
}

function inventoryReceipt(result) {
  if (!result || !Array.isArray(result.items) || result.items.some((item) => !item || typeof item.type !== 'string'
    || (item.type.startsWith('stock.') || item.type.startsWith('sku.')) && (typeof item.skuName !== 'string' || !item.skuName.trim()))) invalidDraft();
  return result.items.map(item=>{
    const name = `${inlineText(item.skuName)}${item.size ? ` (${inlineText(item.size)})` : ''}`;
    const stock = `Disponible: ${numberText(item.stockAvailable)}${item.stockReserved ? ` · reservado: ${numberText(item.stockReserved)}` : ''}`;
    if (item.type === 'sku.create') return `Producto creado: ${name} · ${stock} · ${item.currency} ${numberText(item.price)}`;
    if (item.type === 'sku.deactivate') return `Producto desactivado: ${name} · stock conservado: ${numberText(item.stockAvailable)}`;
    if (item.type === 'stock.adjust') return `Stock ajustado: ${name} · ${stock}`;
    if (item.type !== 'sku.update') {
      const verb = { 'stock.receive': 'Ingreso aplicado', 'stock.sell': 'Venta registrada', 'stock.reserve': 'Reserva registrada', 'stock.withdraw': 'Retiro aplicado' }[item.type];
      if (!verb || !item.quantity) invalidDraft();
      const unit = item.quantity.unit === 'unit' ? item.quantity.value === 1 ? 'unidad' : 'unidades' : item.quantity.unit;
      const price = item.type === 'stock.sell' ? item.price == null ? ' · precio no informado' : ` · ${item.currency} ${numberText(item.price)} c/u` : '';
      return `${verb}: ${numberText(item.quantity.value)} ${unit} de ${name} · ${stock}${price}`;
    }
    // The full immutable receipt retains the reference; presentation uses its
    // reviewed version and human field values instead of exposing internal IDs.
    const labels={name:'Nombre',productType:'Tipo',productModel:'Modelo',size:'Variante',price:'Precio',priceCurrency:'Moneda'};
    const valueText=value=>value===null ? 'Sin valor' : typeof value==='boolean' ? value ? 'Sí' : 'No' : String(value);
    const changes=Object.entries(item.changes ?? {}).flatMap(([key,value])=>{
      if(key==='family') return [`Familia: versión ${value.version}`];
      if(key==='attributes') return Object.keys(value).length ? Object.entries(value).map(([name,attribute])=>
        `${name}: ${attribute.state==='known' ? valueText(attribute.value) : ({unknown:'Desconocido',not_applicable:'No corresponde',missing:'Falta informar'}[attribute.state])}${attribute.unit ? ` ${attribute.unit}` : ''}`) : ['Sin atributos'];
      return [`${labels[key] ?? key}: ${valueText(value)}`];
    });
    return `Producto actualizado: ${name}${changes.length ? ` · ${changes.join(' · ')}` : ''}`;
  }).join('\n');
}

function accountReceipt(result) {
  if (!result || !Array.isArray(result.items) || result.items.some((item) => !item || typeof item.type !== 'string')) invalidDraft();
  return accountResultReply(result);
}

function orderReceipt(result) {
  const kind = result.kind;
  const pedido = result.pedido;
  if (!['create', 'update', 'delete', 'reconcile'].includes(kind) || !pedido || typeof pedido !== 'object'
    || typeof pedido.producto !== 'string' || !Number.isSafeInteger(pedido.qty) || typeof pedido.estado !== 'string') invalidDraft();
  const lead = kind === 'create' ? 'Pedido creado' : kind === 'delete' ? 'Pedido eliminado' : kind === 'reconcile' ? 'Pedido histórico conciliado' : 'Pedido actualizado';
  const order = `${lead}: ${pedido.producto}; cantidad ${pedido.qty}; estado ${pedido.estado}.`;
  return [order, result.inventoryResult ? inventoryReceipt(result.inventoryResult) : ''].filter(Boolean).join('\n');
}

function partyReceipt(result) {
  if (!result || !Array.isArray(result.items) || !result.items.length) invalidDraft();
  const lines = result.items.map((item) => {
    if (!item || typeof item.type !== 'string' || !item.party || typeof item.party.name !== 'string') invalidDraft();
    const [kind, action] = item.type.split('.');
    if (!['client', 'supplier'].includes(kind) || !['create', 'update', 'delete', 'merge'].includes(action)) invalidDraft();
    const noun = kind === 'client' ? 'Cliente' : 'Proveedor';
    const verb = action === 'create' ? 'creado' : action === 'update' ? 'actualizado' : action === 'delete' ? 'eliminado' : 'unido';
    let line = `${noun} ${verb}: ${action === 'merge' && item.removedParty?.name ? `${item.removedParty.name} unido a ` : ''}${item.party.name}.`;
    if (action === 'merge' || action === 'delete') {
      if (!Array.isArray(item.affectedOrders)) invalidDraft();
      line += ` Pedidos afectados: ${item.affectedOrders.length}.`;
    }
    return line;
  });
  return lines.join('\n');
}

function receiptParts(input, output = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidDraft();
  if (input.domainResult) return receiptParts(input.domainResult, output);
  if (Array.isArray(input.receipts)) {
    for (const receipt of input.receipts) receiptParts(receipt, output);
    return output;
  }
  if (input.pedido) output.push(orderReceipt(input));
  else if (input.items?.length && input.items[0]?.type?.startsWith('account.')) output.push(accountReceipt(input));
  else if (input.items?.length && /^(client|supplier)\./.test(input.items[0]?.type ?? '')) output.push(partyReceipt(input));
  else if (Array.isArray(input.items)) output.push(inventoryReceipt(input));
  else invalidDraft();
  return output;
}

/** Full persisted facts, without the item and character limits of WhatsApp. */
export function universalReceiptDetails(result) {
  const lines = receiptParts(result).flatMap(part => part.split('\n')).filter(Boolean).map(inlineText);
  if (!lines.length) invalidDraft();
  return lines;
}

export function universalOperationDetail(preview) {
  if (preview?.status !== 'applied') fail('DRAFT_NOT_PENDING', 'Esta operación todavía no tiene cambios aplicados para consultar.');
  return { draftId: preview.draftId, status: preview.status, text: preview.text,
    review: validateUniversalOperationReview(preview.plan, preview.review),
    changes: universalReceiptDetails(preview.result) };
}

/** Compose only persisted receipt facts from the existing domain result adapters. */
export function universalMetaReceiptReply(result, { detailUrl = null } = {}) {
  const lines = universalReceiptDetails(result);
  const link = detailUrl ? `\n\nVer detalle completo:\n${detailUrl}` : '';
  const visible = [];
  let shortened = false;
  for (const line of lines.slice(0, RECEIPT_ITEMS)) {
    const concise = line.length > 240 ? `${line.slice(0, 239)}…` : line;
    shortened ||= concise !== line;
    if (visible.join('\n').length + concise.length > RECEIPT_LIMIT - 180 - link.length) break;
    visible.push(`• ${concise}`);
  }
  const remaining = lines.length - visible.length;
  return ['✅ *Cambios guardados*', '', ...visible,
    ...(remaining ? [`Y ${remaining} cambio${remaining === 1 ? '' : 's'} más.`] : []),
    ...(!link && (remaining || shortened) ? ['', 'El detalle completo quedó guardado en el negocio.'] : [])].join('\n') + link;
}
