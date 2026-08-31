import { getWhatsAppVariants } from './phone.js';
import {
  VARIANT_KEYWORD_ALT,
  buildCategoryPromptContext,
  formatAllVariantsScope,
  formatVariantRef,
  getBusinessCategoryPreset,
} from './businessCategories.js';
import { formatCatalogPromptSection, groundActionsAgainstCatalog, hasProductMatchHold } from './voiceCatalogContext.js';

const DEFAULT_MODEL_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_META_GRAPH_API_VERSION = 'v21.0';
const MAX_CONVERSATION_TURNS = 4;
const MAX_CONTEXT_REPLY_CHARS = 450;
const MAX_MODEL_OUTPUT_TOKENS = 2048;

const truncateText = (value, maxChars) => {
  const text = String(value ?? '').trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
};

const formatConversationContext = (conversationTurns = []) => {
  if (!Array.isArray(conversationTurns) || !conversationTurns.length) {
    return '';
  }

  const lines = conversationTurns
    .map((turn) => {
      const role = turn?.role === 'assistant' ? 'Stocky' : 'Usuario';
      const text = String(turn?.text ?? '').trim();
      if (!text) {
        return null;
      }
      return `${role}: ${text}`;
    })
    .filter(Boolean);

  if (!lines.length) {
    return '';
  }

  return `
Contexto reciente de la conversacion (usa esto para interpretar mensajes cortos o de seguimiento):
${lines.join('\n')}
- Si el mensaje actual es un seguimiento ("y las de river?", "de argentina?", "y en talle M?", "a 18 c/u"), completa la accion reusando intent/productType/campos del contexto.
- Ejemplo: contexto consulto stock de "Camiseta Boca" y el usuario dice "y las de river?" -> query_stock de "Camiseta River".
- Ejemplo: contexto consulto stock de "Camiseta" y dice "de argentina?" -> query_stock de "Camiseta Argentina".
- Si el mensaje actual pide cargar lo anterior ("carga todo lo que te mencioné", "eso es lo nuevo que ingresó", "cargalo al sistema"), extraé CADA producto del listado del contexto y devolvé un add_stock por ítem.
- No ignores el mensaje actual: el contexto solo completa lo que falta.
`.trim();
};

const looksLikeLoadPreviousCommand = (text) => {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > 220) {
    return false;
  }

  const normalized = normalizeText(cleaned);
  const asksToLoad =
    /\b(?:carga|cargar|cargalo|cargalos|agrega|agregar|agregalo|mete|meter|metelo)\b/.test(normalized) &&
    /\b(?:anterior|antes|mencione|mencion|dije|dicho|eso|todo|sistema|stock|inventario)\b/.test(normalized);
  const confirmsInbound =
    /(?:lo nuevo que ingreso|(?:eso|todo)(?:\s+lo que te (?:mencione|dije))?(?:\s+anteriormente)?\s+es lo (?:nuevo )?que ingreso)/.test(
      normalized,
    );

  return asksToLoad || confirmsInbound;
};

const looksLikeInventoryCatalog = (text) => {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 120) {
    return false;
  }

  const normalized = normalizeText(cleaned);
  if (
    /\b(?:cuant[oa]s?|cu[aá]nto|quedan|me queda|mostrame|decime|pedidos? pendientes?|me pidio|pedido\s*:)\b/.test(
      normalized,
    )
  ) {
    return false;
  }

  if (
    /\b(?:elimina(?:r)?(?:l[ao]s?)?|borra(?:r)?(?:l[ao]s?)?|no existe|esta de mas)\b/.test(normalized)
  ) {
    return false;
  }

  const productHits = (normalized.match(/\b(?:camiseta|camisetas|buzo|buzos|short|shorts|la de|las de)\b/g) || []).length;
  const teamHits = (
    normalized.match(
      /\b(?:river|boca|independiente|racing|argentina|velez|chelsea|genoa|inter|psg|paris|saint germain|madrid)\b/g,
    ) || []
  ).length;
  const priceMentions = (normalized.match(/\b(?:vale|valen|cuesta|cuestan|sale|salen|precio)\b/g) || []).length;
  const hasPrice = priceMentions > 0 || /\bmil pesos\b/.test(normalized);
  const hasSize = /\b(?:talle|talles)\b/.test(normalized);
  const distinctItems = Math.max(productHits, teamHits, priceMentions);

  return distinctItems >= 3 && (hasPrice || hasSize);
};

const looksLikeDeleteProducts = (text) => {
  const normalized = normalizeText(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return false;
  }

  if (/\bpedido\b/.test(normalized) && /\b(?:elimina|borra|saca|quita)\b/.test(normalized)) {
    return false;
  }

  return (
    /\b(?:elimina(?:r)?(?:l[ao]s?)?|borra(?:r)?(?:l[ao]s?)?|sac[aá](?:l[ao]s?)?|quita(?:r)?(?:l[ao]s?)?)\b/.test(
      normalized,
    ) || /\b(?:no existe|esta de mas)\b/.test(normalized)
  );
};

const findLastCatalogUserText = (conversationTurns = []) => {
  if (!Array.isArray(conversationTurns)) {
    return '';
  }

  for (let index = conversationTurns.length - 1; index >= 0; index -= 1) {
    const turn = conversationTurns[index];
    if (turn?.role === 'assistant') {
      continue;
    }

    const text = String(turn?.text ?? '').trim();
    if (!text || looksLikeLoadPreviousCommand(text)) {
      continue;
    }

    if (text.length >= 40) {
      return text;
    }
  }

  return '';
};

const buildOperationHint = (text, conversationTurns = []) => {
  if (looksLikeLoadPreviousCommand(text)) {
    const previous = findLastCatalogUserText(conversationTurns);
    const listado = previous
      ? `\nListado a cargar (extraé CADA producto, no lo resumas):\n${previous}`
      : '\nSi el contexto tiene un listado de productos, extraé CADA uno.';

    return `El mensaje actual pide CARGAR AL STOCK lo dictado antes. Devolvé un add_stock por cada producto del listado. qty 1 si no hay cantidad. "vale/cuesta/sale" es el price del ingreso, NO update_product. Atributos globales (variante, versión, precio) aplican a todos. Convertí "N mil" a N*1000. Un ítem = una acción. NO devuelvas actions vacío.${listado}`;
  }

  if (looksLikeDeleteProducts(text)) {
    return 'El usuario pide ELIMINAR productos del inventario (delete_product), NO pedidos. "eliminarla", "borrala", "no existe", "está de más", "la de X", "la que se llama X" son delete_product. Resolvé cada uno contra el inventario. Si un modelo tiene varias variantes y no dijo cuál, NO borres: missingFields ["productMatch"] y suggestedPhrases con cada SKU. NO uses unknown ni actions vacío.';
  }

  if (looksLikeInventoryCatalog(text)) {
    return 'Esto es un LISTADO DE INGRESO (add_stock), no una actualización de precios. Un add_stock por cada producto distinto. Nunca concatenes varios ítems en un productName. qty 1 si no hay cantidad. Atributos globales ("todo talle/número X", "todas versión Y", "todo vale N") aplican a TODOS. Si corrige el atributo al final, usá el último. Convertí "N mil" a N*1000. Copiá el estilo de nombres del inventario. NO uses update_product ni actions vacío.';
  }

  return '';
};

const looksLikeCoordinatedStockOps = (text) => {
  const normalized = normalizeText(text);
  const hasSell = /\b(?:vendi|vendio|vendiste|vendieron)\b/.test(normalized);
  const hasAdd = /\b(?:compre|compra|llegaron|llegó|llegó|entraron|recibi|recibieron|ingreso|ingresaron|carg[aeá]|agreg[aeá])\b/.test(
    normalized,
  );
  return hasSell && hasAdd;
};

const MUTATING_ACTION_TYPES = new Set([
  'add_stock',
  'sell',
  'delete_product',
  'update_product',
  'reserve_stock',
  'add_debt',
  'payment_received',
  'client_order',
  'update_pedido',
  'delete_pedido',
]);

const coerceCatalogActions = (actions, { forceAddStock = false } = {}) => {
  if (!forceAddStock || !Array.isArray(actions) || !actions.length) {
    return actions;
  }

  return actions.map((action) => {
    if (action?.type !== 'update_product') {
      return action;
    }

    return {
      type: 'add_stock',
      productName: action.productName,
      productType: action.productType,
      productModel: action.productModel,
      size: action.size,
      qty: 1,
      price: action.price,
    };
  });
};

const buildPrompt = (text, preset, conversationTurns = [], operationHint = '', catalog = null) => `
Sos un analista de operaciones para Stocky, un ERP de stock y pedidos.
Convertí la frase del usuario en JSON con esta estructura:
{
  "schemaVersion": 1,
  "sourceText": string,
  "intent": "add_stock" | "reserve_stock" | "sell" | "add_debt" | "payment_received" | "client_order" | "query_stock" | "query_pedidos" | "update_product" | "update_pedido" | "delete_pedido" | "delete_product" | "mixed" | "unknown",
  "confidence": number,
  "requiresConfirmation": boolean,
  "actions": [
    { "type": "add_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "price"?: number },
    { "type": "reserve_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "clientName"?: string },
    { "type": "sell", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "price"?: number },
    { "type": "add_debt", "clientName": string, "amount": number, "productType"?: string, "productModel"?: string, "size"?: string, "productName"?: string, "qty"?: number },
    { "type": "payment_received", "clientName": string, "amount": number },
    { "type": "client_order", "clientName"?: string, "proveedorName"?: string, "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty"?: number },
    { "type": "query_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string },
    { "type": "query_pedidos", "estado"?: "pendiente" | "conseguido" | "descartado" | "todos", "clientName"?: string, "proveedorName"?: string, "productName"?: string },
    { "type": "update_product", "productName": string, "productType"?: string, "productModel"?: string, "size"?: string, "price"?: number, "stockAvailable"?: number },
    { "type": "update_pedido", "productName": string, "qty"?: number, "size"?: string, "estado"?: "pendiente" | "conseguido" | "descartado", "clientName"?: string },
    { "type": "delete_pedido", "productName": string, "clientName"?: string },
    { "type": "delete_product", "productName": string }
  ],
  "missingFields"?: string[],
  "suggestedPhrases"?: string[]
}

${buildCategoryPromptContext(preset)}

${formatCatalogPromptSection(catalog, text)}

${formatConversationContext(conversationTurns)}
${operationHint ? `\nInstrucción extra de operación:\n${operationHint}\n` : ''}
Reglas:
- Solo JSON, sin markdown.
- sourceText = mensaje actual. confidence 0..1. Nunca qty 0.
- Un producto distinto = una acción. NUNCA concatenes varios ítems en un productName.
- Atributos globales ("todo en talle/número X", "todas versión Y", "todo vale N") aplican a todos los ítems. Si corrige al final, usá el último valor.
- "N mil" = N*1000. Price solo es plata, nunca gramos/ml/kg.
- Ingreso / carga / compré / entraron / recibí = add_stock. En un listado, "vale/cuesta" es price del ingreso, NO update_product. qty 1 si no hay cantidad.
- "eliminá / borrala / no existe / está de más / la de X / la que se llama X" = delete_product. Si hay inventario, usá el nombre exacto. Si el modelo tiene varias variantes y no dijo cuál, NO borres: missingFields ["productMatch"] y suggestedPhrases con cada SKU candidato.
- "borrá el pedido de X" = delete_pedido. "conseguido/descartado" sobre un pedido = update_pedido.
- Consulta de stock = query_stock (sin mutar). Consulta de pedidos = query_pedidos. Preguntas como "¿qué me pidió Juan?", "¿qué pedidos hay pendientes?", "mostrame los pedidos de María" son query_pedidos, NUNCA client_order.
- client_order es SOLO cuando el usuario ANOTA un pedido nuevo: "Juan me pidió una camiseta", "anotame que María quiere un mate".
- Pago recibido = payment_received. Reserva "para X" = reserve_stock + clientName.
- update_product / update_pedido solo modifican existentes.
- Si el mensaje tiene DOS operaciones distintas unidas con "y" / "además" / "pero" (ej: "vendí una de Boca y me llegaron 5 de River"), devolvé UN action por cláusula, types distintos, intent "mixed". No te quedes con la última ni fusiones las cláusulas.
- Si no hay match claro contra el inventario (varios SKUs posibles y el usuario no dijo la variante), missingFields: ["productMatch"] y suggestedPhrases con candidatos. Aplica a delete_product, sell, add_stock y client_order. No ejecutes.

Texto del usuario (mensaje actual):
${text}
`;

const readEnv = () => ({
  modelEndpoint: process.env.VITE_VOICE_MODEL_ENDPOINT || DEFAULT_MODEL_ENDPOINT,
  apiKey: process.env.VITE_VOICE_MODEL_API_KEY,
  model: process.env.VITE_VOICE_MODEL_NAME || DEFAULT_MODEL,
  transcriptionEndpoint: process.env.VITE_VOICE_TRANSCRIPTION_ENDPOINT || DEFAULT_TRANSCRIPTION_ENDPOINT,
  transcriptionApiKey: process.env.VITE_VOICE_TRANSCRIPTION_API_KEY || process.env.VITE_VOICE_MODEL_API_KEY,
  transcriptionModel: process.env.VITE_VOICE_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL,
  metaAccessToken: process.env.META_ACCESS_TOKEN,
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID,
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || DEFAULT_META_GRAPH_API_VERSION,
});

const normalizeText = (value) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const titleCase = (value) =>
  String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

const singularizeProductType = (value) => {
  const trimmed = String(value ?? '').trim();

  if (trimmed.length <= 3) {
    return titleCase(trimmed);
  }

  if (trimmed.endsWith('es')) {
    return titleCase(trimmed.slice(0, -2));
  }

  if (trimmed.endsWith('s')) {
    return titleCase(trimmed.slice(0, -1));
  }

  return titleCase(trimmed);
};

const composeProductName = ({ productType, productModel, size, fallback }) => {
  const values = [productType, productModel, size]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  if (values.length) {
    return values.join(' ');
  }

  return String(fallback ?? '').trim();
};

const parseProductDescriptor = (value) => {
  const normalized = normalizeText(value).replace(/\s+/g, ' ').trim();
  const sizeMatch = normalized.match(new RegExp(`(?:,\\s*|\\s+)(?:${VARIANT_KEYWORD_ALT})\\s+([a-z0-9\\/]+)\\b`, 'i'));
  const size = sizeMatch ? String(sizeMatch[1]).toUpperCase() : undefined;
  const withoutSize = normalized.replace(new RegExp(`(?:,\\s*|\\s+)(?:${VARIANT_KEYWORD_ALT})\\s+[a-z0-9\\/]+\\b`, 'i'), '').trim();
  const descriptorParts = withoutSize.split(/\s+del?\s+/i);
  const rawProductType = descriptorParts[0] ?? withoutSize;
  const rawProductModel = descriptorParts.slice(1).join(' de ') || undefined;

  const productType = rawProductType ? singularizeProductType(rawProductType) : undefined;
  const productModel = rawProductModel ? titleCase(rawProductModel) : undefined;

  return {
    productType,
    productModel,
    size,
    productName: composeProductName({ productType, productModel, size, fallback: value }),
  };
};

const extractDeleteProductActions = (text) => {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!looksLikeDeleteProducts(cleaned)) {
    return [];
  }

  const normalized = normalizeText(cleaned);
  const defaultType = /\bcamisetas?\b/.test(normalized)
    ? 'Camiseta'
    : /\bbuzos?\b/.test(normalized)
      ? 'Buzo'
      : /\bshorts?\b/.test(normalized)
        ? 'Short'
        : '';

  const actions = [];
  const seen = new Set();

  const pushName = (raw) => {
    let value = normalizeText(String(raw ?? ''))
      .replace(/\b(?:no existe|esta de mas|elimina(?:r)?(?:l[ao]s?)?|borra(?:r)?(?:l[ao]s?)?|esa|ese|eso|tambien)\b/g, ' ')
      .replace(/[.,;:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    value = value.replace(/^(?:la|el|las|los|de|del)\s+/, '').trim();
    value = value.replace(/\s+(?:la|el|las|los|de|del)$/, '').trim();
    value = value.replace(/\ben version (jugador|fan)\b/g, 'versión $1');
    if (value.length < 3 || /^(?:esa|ese|eso|la|el|las|los|un|una|de|del|tambien|mas)$/.test(value)) {
      return;
    }
    if (/^(?:par de camisetas?|camisetas? de mas|de mas)$/.test(value)) {
      return;
    }

    const titled = titleCase(value);
    const alreadyTyped = /^(?:camiseta|buzo|short)\b/i.test(titled);
    const prefixed = defaultType && !alreadyTyped ? `${defaultType} ${titled}` : titled;
    const productDescriptor = parseProductDescriptor(prefixed);
    const productName = productDescriptor.productName || prefixed;
    const key = normalizeText(productName);
    if (!productName || seen.has(key)) {
      return;
    }
    seen.add(key);
    actions.push({
      type: 'delete_product',
      productName,
      productType: productDescriptor.productType,
      productModel: productDescriptor.productModel,
      size: productDescriptor.size,
    });
  };

  for (const match of normalized.matchAll(
    /\bla de(?:l)?\s+(.+?)(?=\s+(?:no existe|esta de mas|elimin|borra|saca|quita)|,|$)/g,
  )) {
    pushName(match[1]);
  }

  for (const match of normalized.matchAll(
    /\b(?:la|el) que se llama\s+(.+?)(?=\s+(?:tambien\s+)?(?:esta de mas|elimin|borra|no existe)|,|$)/g,
  )) {
    pushName(match[1]);
  }

  for (const match of normalized.matchAll(
    /\b(?:elimina(?:r)?|borra(?:r)?|saca|quita(?:r)?)\s+(?:el\s+)?(?:producto\s+)?(?!pedido\b)(.+?)(?=\s+y\s+|,|$)/g,
  )) {
    const raw = String(match[1] ?? '').trim();
    if (/^(?:la|lo|las|los|esa|ese|eso)$/i.test(raw)) {
      continue;
    }
    pushName(raw);
  }

  return actions;
};

const parseQtyAndProductText = (value) => {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return null;
  }

  const cantidadMatch = raw.match(/^(.*?)\s+cantidad\s+(\d+)\s*$/i);
  if (cantidadMatch) {
    const productText = cantidadMatch[1].trim();
    const qty = Number(cantidadMatch[2]);
    if (productText && qty > 0) {
      return { productText, qty };
    }
  }

  const leadingQtyMatch = raw.match(/^(\d+)\s+(.+)$/);
  if (leadingQtyMatch) {
    const qty = Number(leadingQtyMatch[1]);
    const productText = leadingQtyMatch[2].trim();
    if (productText && qty > 0) {
      return { productText, qty };
    }
  }

  const qty = parseQuantity(raw) ?? 1;
  const productText = raw
    .replace(/^(?:una?|unos?|unas?|\d+)\s+/i, '')
    .replace(/\s+cantidad\s+\d+\s*$/i, '')
    .trim();

  if (!productText) {
    return null;
  }

  return { productText, qty };
};

const buildClientOrderAction = (productText, qty, clientName) => {
  const productDescriptor = parseProductDescriptor(productText);
  if (!productDescriptor.productName) {
    return null;
  }

  const normalizedClient = typeof clientName === 'string' ? clientName.trim() : '';

  return {
    type: 'client_order',
    ...(normalizedClient ? { clientName: normalizedClient } : {}),
    productName: productDescriptor.productName,
    productType: productDescriptor.productType,
    productModel: productDescriptor.productModel,
    size: productDescriptor.size,
    qty: qty > 0 ? qty : 1,
  };
};

const stripPedidoPrefix = (fragment) => {
  const trimmed = String(fragment ?? '').trim();
  const match = trimmed.match(
    /^(?:pedido\s*:?\s*|tengo que (?:hacer un )?pedido (?:de\s+)?|tengo que (?:pedir|encargar)\s+|necesito (?:pedir|encargar)\s+|hay que (?:pedir|encargar)\s+)(.+)$/i,
  );
  return match ? match[1].trim() : null;
};

const splitCompoundText = (value) =>
  value
    .split(/\s*(?:,|\by\b|\.\s*|;|\n)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

const parseQuantity = (value) => {
  const normalized = normalizeText(value).trim();
  const numberMatch = normalized.match(/\b(\d+)\b/);

  if (numberMatch) {
    return Number(numberMatch[1]);
  }

  const quantityMap = {
    uno: 1,
    una: 1,
    un: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
    once: 11,
    doce: 12,
    trece: 13,
    catorce: 14,
    quince: 15,
    dieciseis: 16,
    diecisiete: 17,
    dieciocho: 18,
    diecinueve: 19,
    veinte: 20,
  };

  const quantityToken = normalized.split(/\s+/).find((token) => quantityMap[token] !== undefined);
  return quantityToken ? quantityMap[quantityToken] : null;
};

const parseNumericValue = (value) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return null;
  }

  const cleaned = normalized.replace(/[^0-9,\.]/g, '');
  if (!cleaned) {
    return null;
  }

  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;
  let normalizedNumber = cleaned;

  if (commaCount > 0 && dotCount > 0) {
    normalizedNumber = cleaned.replace(/\./g, '').replace(/,/g, '.');
  } else if (dotCount > 0 && cleaned.split('.').pop()?.length === 3) {
    normalizedNumber = cleaned.replace(/\./g, '');
  } else {
    normalizedNumber = cleaned.replace(/,/g, '.');
  }

  const amount = Number(normalizedNumber);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

const parsePrice = (value) => {
  const normalized = String(value ?? '').toLowerCase();

  // Prefer explicit money cues: c/u, $, vale/precio, "a 18 c/u"
  const moneyMatch = normalized.match(
    /(?:valen?|vale|cuestan|cuesta|salen?|precio|\ba\b|\bpor\b)\s*\$?\s*([0-9]+(?:[.,][0-9]{3})*(?:[.,][0-9]+)?)\s*(mil)?\s*(?:c\/u|c\.u\.|pesos|\$)?/i,
  );

  if (!moneyMatch) {
    return null;
  }

  const fullMatch = moneyMatch[0];
  // Avoid treating weight/volume as price: "por 55 gramos", "de 500ml", "por 1 kg"
  if (/\b(?:g|gr|gramos?|kg|kilos?|ml|lts?|litros?|cm|mm)\b/i.test(fullMatch) ||
      /(?:por|de|a)\s*\$?\s*[0-9]+(?:[.,][0-9]+)?\s*(?:g|gr|gramos?|kg|kilos?|ml|lts?|litros?|cm|mm)\b/i.test(normalized.slice(Math.max(0, moneyMatch.index - 2), (moneyMatch.index ?? 0) + fullMatch.length + 12))) {
    return null;
  }

  // If "por N" without money cue and followed by units that aren't money, skip
  if (/\bpor\s+[0-9]/i.test(fullMatch) && !/[\$]|c\/u|c\.u\.|pesos|vale|precio|cuestan?/i.test(fullMatch)) {
    const after = normalized.slice((moneyMatch.index ?? 0) + fullMatch.length, (moneyMatch.index ?? 0) + fullMatch.length + 16);
    if (/^\s*(?:g|gr|gramos?|kg|kilos?|ml|lts?|litros?|unidades?|u\.?\b)/i.test(after)) {
      return null;
    }
  }

  const amount = parseNumericValue(moneyMatch[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const resolved = moneyMatch[2] ? amount * 1000 : amount;
  if (resolved >= 1900 && resolved <= 2100 && !/vale|precio|cuesta|sale|\$|pesos|c\/u/i.test(fullMatch)) {
    return null;
  }

  return resolved;
};

const applyPriceFromText = (actions, text) => {
  const price = parsePrice(text);
  if (!Number.isFinite(price)) {
    return;
  }

  for (const action of actions) {
    if ((action.type === 'add_stock' || action.type === 'sell') && !Number.isFinite(action.price ?? NaN)) {
      action.price = price;
    }
  }
};

const splitReservationTarget = (value, lastProductName) => {
  const paraMatch = value.match(/^(.+?)\s+para\s+(.+)$/i);

  if (paraMatch) {
    return {
      productName: paraMatch[1].trim(),
      clientName: paraMatch[2].trim(),
    };
  }

  const alMatch = value.match(/^al\s+(.+)$/i);

  if (alMatch) {
    return {
      productName: lastProductName?.trim() ?? value.trim(),
      clientName: alMatch[1].trim(),
    };
  }

  return {
    productName: value.trim(),
    clientName: undefined,
  };
};

const inferIntent = (actions) => {
  if (!actions.length) {
    return 'unknown';
  }

  const uniqueTypes = new Set(actions.map((action) => action.type));
  return uniqueTypes.size > 1 ? 'mixed' : actions[0].type;
};

const isReadOnlyAction = (action) => action?.type === 'query_stock' || action?.type === 'query_pedidos';

const buildPayload = (sourceText, actions, options = {}) => {
  const allReadOnly = actions.length > 0 && actions.every(isReadOnlyAction);

  return {
    schemaVersion: 1,
    sourceText,
    intent: options.intent ?? inferIntent(actions),
    confidence: options.confidence ?? (actions.length > 1 ? 0.92 : 0.83),
    requiresConfirmation: options.requiresConfirmation ?? (actions.length > 0 && !allReadOnly),
    actions,
    missingFields: options.missingFields,
    suggestedPhrases: options.suggestedPhrases,
  };
};

const withCatalogGrounding = (payload, catalog) => {
  if (!payload?.actions?.length) {
    return payload;
  }

  const grounded = groundActionsAgainstCatalog(payload.actions, catalog);
  const missingFields = [...new Set([...(payload.missingFields || []), ...(grounded.missingFields || [])])];
  const suggestedPhrases = grounded.suggestedPhrases?.length ? grounded.suggestedPhrases : payload.suggestedPhrases;

  return {
    ...payload,
    actions: grounded.actions,
    intent: inferIntent(grounded.actions) || payload.intent,
    requiresConfirmation: Boolean(payload.requiresConfirmation || grounded.requiresConfirmation),
    missingFields: missingFields.length ? missingFields : undefined,
    suggestedPhrases,
  };
};

const stripCodeFences = (value) =>
  value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

const extractContent = (responseData) => {
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  const data = responseData;

  if (Array.isArray(data.choices)) {
    const firstChoice = data.choices[0];
    const content = firstChoice?.message?.content;
    if (typeof content === 'string') {
      return content;
    }
  }

  if (typeof data.output_text === 'string') {
    return data.output_text;
  }

  return null;
};

const parseAction = (value) => {
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
    return null;
  }

  const qty = typeof value.qty === 'number' ? value.qty : Number(value.qty);
  const amount = typeof value.amount === 'number' ? value.amount : Number(value.amount);

  if (value.type === 'add_stock' || value.type === 'reserve_stock' || value.type === 'sell') {
    const productType = typeof value.productType === 'string' ? value.productType : undefined;
    const productModel = typeof value.productModel === 'string' ? value.productModel : undefined;
    const size = typeof value.size === 'string' ? value.size : undefined;
    const price = typeof value.price === 'number' ? value.price : Number(value.price);
    const productName = typeof value.productName === 'string' ? value.productName : composeProductName({ productType, productModel, size });
    const resolvedQty = Number.isFinite(qty) && qty > 0 ? qty : value.type === 'add_stock' ? 1 : NaN;

    if (!productName || !Number.isFinite(resolvedQty) || resolvedQty <= 0) {
      return null;
    }

    return {
      type: value.type,
      productName,
      productType,
      productModel,
      size,
      qty: resolvedQty,
      price: Number.isFinite(price) && price > 0 ? price : undefined,
      clientName: typeof value.clientName === 'string' ? value.clientName : undefined,
    };
  }

  if (value.type === 'add_debt' && typeof value.clientName === 'string' && Number.isFinite(amount)) {
    return {
      type: 'add_debt',
      clientName: value.clientName,
      amount,
      productName: typeof value.productName === 'string' ? value.productName : undefined,
      productType: typeof value.productType === 'string' ? value.productType : undefined,
      productModel: typeof value.productModel === 'string' ? value.productModel : undefined,
      size: typeof value.size === 'string' ? value.size : undefined,
      qty: Number.isFinite(Number(value.qty)) ? Number(value.qty) : undefined,
    };
  }

  if (value.type === 'payment_received' && typeof value.clientName === 'string' && Number.isFinite(amount) && amount > 0) {
    return {
      type: 'payment_received',
      clientName: value.clientName,
      amount,
    };
  }

  if (value.type === 'client_order') {
    const productType = typeof value.productType === 'string' ? value.productType : undefined;
    const productModel = typeof value.productModel === 'string' ? value.productModel : undefined;
    const size = typeof value.size === 'string' ? value.size : undefined;
    const productName = typeof value.productName === 'string' ? value.productName : composeProductName({ productType, productModel, size });
    const orderQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const rawClient = typeof value.clientName === 'string' ? value.clientName.trim() : '';
    const rawProveedor = typeof value.proveedorName === 'string' ? value.proveedorName.trim() : '';

    if (!productName) {
      return null;
    }

    return {
      type: 'client_order',
      ...(rawClient ? { clientName: rawClient } : {}),
      ...(rawProveedor ? { proveedorName: rawProveedor } : {}),
      productName,
      productType,
      productModel,
      size,
      qty: orderQty,
      notas: typeof value.notas === 'string' ? value.notas : undefined,
    };
  }

  if (value.type === 'query_stock') {
    const productType = typeof value.productType === 'string' ? value.productType : undefined;
    const productModel = typeof value.productModel === 'string' ? value.productModel : undefined;
    const size = typeof value.size === 'string' ? value.size : undefined;
    const productName = typeof value.productName === 'string' ? value.productName : composeProductName({ productType, productModel, size });

    if (!productName) {
      return null;
    }

    return {
      type: 'query_stock',
      productName,
      productType,
      productModel,
      size,
    };
  }

  if (value.type === 'query_pedidos') {
    const estadoRaw = typeof value.estado === 'string' ? value.estado.trim().toLowerCase() : 'pendiente';
    const estado = ['pendiente', 'conseguido', 'descartado', 'todos'].includes(estadoRaw) ? estadoRaw : 'pendiente';
    return {
      type: 'query_pedidos',
      estado,
      ...(typeof value.clientName === 'string' && value.clientName.trim() ? { clientName: value.clientName.trim() } : {}),
      ...(typeof value.proveedorName === 'string' && value.proveedorName.trim() ? { proveedorName: value.proveedorName.trim() } : {}),
      ...(typeof value.productName === 'string' && value.productName.trim() ? { productName: value.productName.trim() } : {}),
    };
  }

  if (value.type === 'update_product' && typeof value.productName === 'string' && value.productName.trim()) {
    const priceValue = Number.isFinite(Number(value.price)) ? Number(value.price) : amount;
    const stockValue = Number(value.stockAvailable);
    const hasPrice = Number.isFinite(priceValue) && priceValue > 0;
    const hasStock = Number.isFinite(stockValue) && stockValue >= 0;

    if (!hasPrice && !hasStock) {
      return null;
    }

    return {
      type: 'update_product',
      productName: value.productName.trim(),
      productType: typeof value.productType === 'string' ? value.productType : undefined,
      productModel: typeof value.productModel === 'string' ? value.productModel : undefined,
      size: typeof value.size === 'string' ? value.size : undefined,
      ...(hasPrice ? { price: priceValue } : {}),
      ...(hasStock ? { stockAvailable: Math.trunc(stockValue) } : {}),
    };
  }

  if (value.type === 'update_pedido' && typeof value.productName === 'string' && value.productName.trim()) {
    const estado = typeof value.estado === 'string' ? value.estado.trim().toLowerCase() : undefined;
    const validEstado = ['pendiente', 'conseguido', 'descartado'].includes(estado) ? estado : undefined;
    const orderQty = Number.isFinite(qty) && qty > 0 ? qty : undefined;
    const size =
      typeof value.size === 'string' && value.size.trim()
        ? value.size.trim().toUpperCase()
        : undefined;

    if (!orderQty && !validEstado && !size) {
      return null;
    }

    return {
      type: 'update_pedido',
      productName: value.productName.trim(),
      ...(orderQty ? { qty: orderQty } : {}),
      ...(size ? { size } : {}),
      ...(validEstado ? { estado: validEstado } : {}),
      ...(typeof value.clientName === 'string' && value.clientName.trim() ? { clientName: value.clientName.trim() } : {}),
    };
  }

  if (value.type === 'delete_pedido' && typeof value.productName === 'string' && value.productName.trim()) {
    return {
      type: 'delete_pedido',
      productName: value.productName.trim(),
      ...(typeof value.clientName === 'string' && value.clientName.trim() ? { clientName: value.clientName.trim() } : {}),
    };
  }

  if (value.type === 'delete_product' && typeof value.productName === 'string' && value.productName.trim()) {
    return {
      type: 'delete_product',
      productName: value.productName.trim(),
      productType: typeof value.productType === 'string' ? value.productType : undefined,
      productModel: typeof value.productModel === 'string' ? value.productModel : undefined,
      size: typeof value.size === 'string' ? value.size : undefined,
    };
  }

  return null;
};

const tryParseQueryStockAction = (fragment) => {
  const cleaned = String(fragment ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[¿?¡!.,;:]+$/g, '')
    .trim();

  if (!cleaned) {
    return null;
  }

  const patterns = [
    new RegExp(
      `^(?:cuant[oa]s?|cu[aá]nto)\\s+(?:stock\\s+(?:me\\s+)?(?:queda|tengo|hay)\\s+de\\s+)?(.+?)(?:\\s+(?:me\\s+)?(?:quedan|queda|tengo|hay))?(?:\\s+y\\s+(?:qu[eé]\\s+)?(?:${VARIANT_KEYWORD_ALT})(?:\\s+(?:tengo|hay|quedan))?)?$`,
      'iu',
    ),
    new RegExp(`^(?:qu[eé]\\s+(?:${VARIANT_KEYWORD_ALT})(?:\\s+(?:tengo|hay|quedan))?\\s+(?:de\\s+)?)(.+)$`, 'iu'),
    /^(?:tengo\s+stock\s+de\s+)(.+)$/iu,
    /^(?:hay\s+)(.+?)(?:\s+en\s+stock)$/iu,
    /^(?:stock\s+(?:de\s+)?)(.+)$/iu,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    let productText = match[1]
      .replace(/^(?:de\s+)/i, '')
      .replace(new RegExp(`\\s+y\\s+(?:qu[eé]\\s+)?(?:${VARIANT_KEYWORD_ALT})(?:\\s+(?:tengo|hay|quedan))?$`, 'iu'), '')
      .replace(/\s+(?:me\s+)?(?:quedan|queda|tengo|hay)$/iu, '')
      .replace(new RegExp(`\\ben\\s+(?:${VARIANT_KEYWORD_ALT})\\b`, 'gi'), 'talle')
      .trim();

    if (!productText || productText.length < 2) {
      continue;
    }

    // Avoid treating mutation phrases as stock queries
    if (/\b(?:compre|compr[eé]|vend[ií]|reserve|reserv[eé]|pidio|pidi[oó]|pedido|ingreso|ingresaron)\b/i.test(productText)) {
      continue;
    }

    const productDescriptor = parseProductDescriptor(productText);
    if (!productDescriptor.productName) {
      continue;
    }

    return {
      type: 'query_stock',
      productName: composeProductName({
        productType: productDescriptor.productType,
        productModel: productDescriptor.productModel,
        // Omit size so the query can list all available sizes
        fallback: productDescriptor.productName,
      }),
      productType: productDescriptor.productType,
      productModel: productDescriptor.productModel,
    };
  }

  return null;
};

const QUERY_PEDIDOS_STOPWORDS = new Set([
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'de',
  'del',
  'al',
  'que',
  'me',
  'te',
  'se',
  'tengo',
  'tiene',
  'tienen',
  'hay',
  'son',
  'esta',
  'estan',
  'pendiente',
  'pendientes',
  'conseguido',
  'conseguidos',
  'descartado',
  'descartados',
  'pedido',
  'pedidos',
  'cuales',
  'cual',
  'cuantos',
  'cuantas',
  'cuanto',
  'lista',
  'listado',
  'todos',
  'todas',
  'mostrar',
  'mostrame',
  'decime',
  'dime',
  'cliente',
  'clientes',
  'proveedor',
  'proveedores',
  'mis',
  'tus',
  'sus',
  'por',
  'para',
  'con',
  'sin',
  'registrados',
]);

const tryParseQueryPedidosAction = (fragment) => {
  const cleaned = String(fragment ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[¿?¡!]+/, '')
    .replace(/[¿?¡!.,;:]+$/g, '')
    .trim();

  if (!cleaned) {
    return null;
  }

  if (
    /\b(?:actualiza|cambia|modifica|borra|elimina|sac[aá]|quita|marc[aá]|descart[aá]|cancel[aá]|consegu[ií])\b/i.test(
      cleaned,
    )
  ) {
    return null;
  }

  if (
    /^(?:pedido\s*:|tengo que (?:hacer un )?pedido\b|tengo que (?:pedir|encargar)\b|necesito (?:pedir|encargar)\b|hay que (?:pedir|encargar)\b)/i.test(
      cleaned,
    )
  ) {
    return null;
  }

  const looksLikeQuery =
    /(?:cu[aá]les?\s+son|qu[eé]\s+(?:pedidos?|me\s+pidi[oó]|me\s+pidieron|pidio|pidi[oó]|pidieron)|cu[aá]ntos?\s+pedidos?|lista(?:do)?\s+de\s+pedidos?|mostr[aá](?:me)?\s+(?:los\s+)?pedidos?|decime\s+(?:los\s+)?pedidos?|pedidos?\s+(?:que\s+)?(?:tengo|pendientes?)|pedidos?\s+pendientes?|tengo\s+pedidos?|qu[eé]\s+me\s+(?:pidio|pidi[oó]|pidieron|encargo|encarg[oó]|encargaron)|qu[eé]\s+tengo\s+(?:pendiente|que\s+conseguir)|qu[eé]\s+(?:le\s+)?(?:pidio|pidi[oó]|pidieron)\s+)/i.test(
      cleaned,
    ) || /^(?:pedidos?(?:\s+pendientes?)?)$/i.test(cleaned);

  if (!looksLikeQuery) {
    return null;
  }

  let estado = 'pendiente';
  if (/\bconseguidos?\b/i.test(cleaned)) {
    estado = 'conseguido';
  } else if (/\bdescartados?\b/i.test(cleaned)) {
    estado = 'descartado';
  } else if (/\btodos?\s+(?:los\s+)?pedidos?\b/i.test(cleaned) && !/\bpendiente/i.test(cleaned)) {
    estado = 'todos';
  }

  let clientName;
  const clientMatch =
    cleaned.match(/\b(?:qu[eé]|cual(?:es)?)\s+me\s+(?:pidio|pidi[oó]|pidieron|encargo|encarg[oó]|encargaron)\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+)?)/iu) ||
    cleaned.match(/\b(?:qu[eé]|cual(?:es)?)\s+(?:le\s+)?(?:pidio|pidi[oó]|pidieron)\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+)?)/iu) ||
    cleaned.match(/\b(?:del\s+cliente|tiene)\s+([a-záéíóúñü\s]+?)(?:\s+(?:pendiente|conseguido|descartado)s?)?$/iu) ||
    cleaned.match(/\bpedidos?\s+de\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+)?)/iu);

  if (clientMatch?.[1]) {
    const raw = clientMatch[1].trim().replace(/\s+(?:pendiente|conseguido|descartado)s?$/i, '');
    const tokens = raw.split(/\s+/).filter((token) => !QUERY_PEDIDOS_STOPWORDS.has(normalizeText(token)));
    if (tokens.length && !/^(?:proveedor|producto)/i.test(tokens[0])) {
      clientName = tokens.map((token) => titleCase(token)).join(' ');
    }
  }

  let proveedorName;
  const proveedorMatch = cleaned.match(/\b(?:del\s+proveedor|al\s+proveedor|proveedor)\s+([a-záéíóúñü0-9\s]+)/iu);
  if (proveedorMatch?.[1]) {
    const raw = proveedorMatch[1].trim().replace(/\s+(?:pendiente|conseguido|descartado)s?$/i, '');
    if (raw && !QUERY_PEDIDOS_STOPWORDS.has(normalizeText(raw))) {
      proveedorName = titleCase(raw);
    }
  }

  return {
    type: 'query_pedidos',
    estado,
    ...(clientName ? { clientName } : {}),
    ...(proveedorName ? { proveedorName } : {}),
  };
};

const tryParseMutationAction = (fragment) => {
  const updatePriceMatch = fragment.match(
    /^(?:(?:la|el|las|los)\s+)?(.+?)\s+(?:vale|cuesta|sale|precio(?:\s+(?:es|actual))?\s*(?:es|de|=|:)?)\s*\$?\s*([0-9]+(?:[.,][0-9]{3})*(?:[.,][0-9]+)?)\s*$/u,
  );
  if (updatePriceMatch) {
    const productText = updatePriceMatch[1].trim().replace(/^(?:producto|precio de)\s+/i, '');
    const price = parsePrice(updatePriceMatch[2]) ?? Number(String(updatePriceMatch[2]).replace(/\./g, '').replace(',', '.'));
    if (productText && Number.isFinite(price) && price > 0) {
      return { type: 'update_product', productName: productText, price };
    }
  }

  const updatePedidoQtyMatch = fragment.match(
    /^(?:actualiza(?:r)?|cambia(?:r)?|modifica(?:r)?|pone(?:le)?|actualizá|cambiá)?\s*(?:el\s+)?pedido\s+(?:de\s+)?(.+?)\s*,?\s*(?:la\s+)?cantidad\s+(?:son|es|a|=|:)?\s*(\d+)\s*$/u,
  );
  if (updatePedidoQtyMatch && /\b(?:actualiza|cambia|modifica|pedido|cantidad)\b/i.test(fragment)) {
    const productText = updatePedidoQtyMatch[1].trim();
    const qty = Number(updatePedidoQtyMatch[2]);
    if (productText && qty > 0 && !/^(?:la|el)$/i.test(productText)) {
      return { type: 'update_pedido', productName: productText, qty };
    }
  }

  const updatePedidoSizeMatch = fragment.match(
    new RegExp(
      `^(?:actualiza(?:r)?|cambia(?:r)?|modifica(?:r)?|pone(?:le)?|actualizá|cambiá)?\\s*(?:el\\s+)?pedido\\s+(?:de\\s+)?(.+?)\\s*[—\\-–,.]?\\s*(?:el\\s+)?(?:${VARIANT_KEYWORD_ALT})\\s+(?:es|a|=|:)?\\s*([a-z0-9\\/]+)\\s*$`,
      'iu',
    ),
  );
  if (updatePedidoSizeMatch && new RegExp(`\\b(?:actualiza|cambia|modifica|pedido|${VARIANT_KEYWORD_ALT})\\b`, 'i').test(fragment)) {
    const productText = updatePedidoSizeMatch[1].trim().replace(/[—\-–,.\s]+$/u, '');
    const size = updatePedidoSizeMatch[2].trim().toUpperCase();
    if (productText && size && !/^(?:la|el)$/i.test(productText)) {
      return { type: 'update_pedido', productName: productText, size };
    }
  }

  const pedidoConseguidoMatch = fragment.match(
    /^(?:(?:marc[aá]|pone(?:le)?|dejal[oa]|deja)\s+(?:el\s+)?pedido\s+(?:de\s+)?(.+?)\s+(?:como\s+)?(?:conseguido|listo|ok)|(?:el\s+)?pedido\s+(?:de\s+)?(.+?)\s+(?:ya\s+)?(?:est[aá]\s+)?(?:conseguido|listo)|consegu[ií]\s+(?:el\s+)?pedido\s+(?:de\s+)?(.+))$/u,
  );
  if (pedidoConseguidoMatch) {
    const productText = (pedidoConseguidoMatch[1] || pedidoConseguidoMatch[2] || pedidoConseguidoMatch[3] || '').trim();
    if (productText) {
      return { type: 'update_pedido', productName: productText, estado: 'conseguido' };
    }
  }

  const pedidoDescartadoMatch = fragment.match(
    /^(?:(?:descart[aá]|cancel[aá])\s+(?:el\s+)?pedido\s+(?:de\s+)?(.+)|(?:el\s+)?pedido\s+(?:de\s+)?(.+?)\s+(?:qued[oó]\s+)?descartado)$/u,
  );
  if (pedidoDescartadoMatch) {
    const productText = (pedidoDescartadoMatch[1] || pedidoDescartadoMatch[2] || '').trim();
    if (productText) {
      return { type: 'update_pedido', productName: productText, estado: 'descartado' };
    }
  }

  const deletePedidoMatch = fragment.match(
    /^(?:borra(?:r)?|elimin[aá](?:r)?|sac[aá]|quita(?:r)?)\s+(?:el\s+)?pedido\s+(?:de\s+)?(.+)$/u,
  );
  if (deletePedidoMatch) {
    const productText = deletePedidoMatch[1].trim();
    if (productText) {
      return { type: 'delete_pedido', productName: productText };
    }
  }

  const deleteProductMatch = fragment.match(
    /^(?:borra(?:r)?(?:l[ao]s?)?|elimin[aá](?:r)?(?:l[ao]s?)?|sac[aá](?:l[ao]s?)?|quita(?:r)?(?:l[ao]s?)?)\s+(?:el\s+)?(?:producto\s+)?(.+)$/u,
  );
  if (deleteProductMatch) {
    const productText = deleteProductMatch[1]
      .trim()
      .replace(/^(?:esa|ese|eso|esta|este)\s+/i, '')
      .trim();
    if (productText && !/^(?:esa|ese|eso|la|lo|las|los|el)$/i.test(productText) && !/\bpedido\b/i.test(productText)) {
      return { type: 'delete_product', productName: productText };
    }
  }

  return null;
};

const extractMultipleActionsFromText = (text) => {
  const normalized = normalizeText(text);
  const fragments = splitCompoundText(normalized);
  const actions = [];
  const seen = new Set();
  const pushAction = (action) => {
    if (!action) {
      return;
    }
    const key = JSON.stringify(action);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    actions.push(action);
  };

  // Texto completo (conserva comas) para updates del tipo "actualiza el pedido de X, la cantidad son 5"
  const fullLine = normalized.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const queryPedidosAction = tryParseQueryPedidosAction(fullLine);
  if (queryPedidosAction) {
    return [queryPedidosAction];
  }
  const queryStockAction = tryParseQueryStockAction(fullLine);
  if (queryStockAction) {
    return [queryStockAction];
  }

  const deleteActions = extractDeleteProductActions(text);
  if (deleteActions.length) {
    return deleteActions;
  }

  pushAction(tryParseMutationAction(fullLine));

  let lastProductName;
  let inPedidoList = /^(?:pedido\s*:|tengo que (?:hacer un )?pedido\b|tengo que (?:pedir|encargar)\b|necesito (?:pedir|encargar)\b|hay que (?:pedir|encargar)\b)/i.test(
    normalized.trim(),
  );

  for (const fragment of fragments) {
    const mutation = tryParseMutationAction(fragment);
    if (mutation) {
      pushAction(mutation);
      continue;
    }

    const paymentMatch = fragment.match(/^(.+?)\s+me\s+pag(?:o|ó)\s+(\d+)\s*(mil)?$/u);
    if (paymentMatch) {
      const amountBase = Number(paymentMatch[2]);
      if (amountBase > 0) {
        actions.push({
          type: 'payment_received',
          clientName: paymentMatch[1].trim(),
          amount: paymentMatch[3] ? amountBase * 1000 : amountBase,
        });
      }
      continue;
    }

    const duePaymentMatch = fragment.match(/^(.+?)\s+me\s+tiene\s+que\s+pagar\s+las?\s+(\d+)\s+(.+)$/u);
    if (duePaymentMatch) {
      const qty = parseQuantity(duePaymentMatch[2]);
      if (qty && qty > 0) {
        actions.push({
          type: 'add_debt',
          clientName: duePaymentMatch[1].trim(),
          productName: duePaymentMatch[3].trim(),
          qty,
          amount: 0,
        });
      }
      continue;
    }

    const orderMatch = fragment.match(/^(.+?)\s+(?:me\s+)?(?:pidio|pidió|pide|quiere|encargo|encargó|encargaron)\s+(.+)$/u);
    if (orderMatch) {
      const clientName = orderMatch[1].trim();
      if (!/^(?:pedido|pedidos|qu[eé]|cual(?:es)?|cu[aá]nt[oa]s?)$/i.test(clientName)) {
        const parsed = parseQtyAndProductText(orderMatch[2].trim());
        if (clientName && parsed) {
          const action = buildClientOrderAction(parsed.productText, parsed.qty, clientName);
          pushAction(action);
        }
        continue;
      }
    }

    const pedidoBody = stripPedidoPrefix(fragment);
    if (pedidoBody) {
      inPedidoList = true;
      const parsed = parseQtyAndProductText(pedidoBody);
      if (parsed) {
        pushAction(buildClientOrderAction(parsed.productText, parsed.qty));
      }
      continue;
    }

    if (inPedidoList) {
      const parsed = parseQtyAndProductText(fragment);
      if (parsed && !/\b(?:compre|compré|vendi|vendí|reserve|reservé|ingreso)\b/i.test(parsed.productText)) {
        const action = buildClientOrderAction(parsed.productText, parsed.qty);
        if (action) {
          pushAction(action);
          continue;
        }
      }
    }

    const addStockMatch = fragment.match(
      /\b(?:compre|compré|compra(?:r|ste|ron)?|adquiri|adquirí|entraron|entran|llegaron|recibi|recibieron|recibí|ingreso|ingrese|ingresaron|carga|cargá|cargar|agrega|agregá|agregar)\s+(?:(\d+)\s+)?(.+)$/u,
    );
    if (addStockMatch) {
      if (looksLikeLoadPreviousCommand(fragment) || looksLikeLoadPreviousCommand(fullLine)) {
        continue;
      }
      inPedidoList = false;
      const qty = addStockMatch[1] ? Number(addStockMatch[1]) : parseQuantity(addStockMatch[2]) ?? 1;
      if (qty > 0) {
        const rawProductText = addStockMatch[2]
          .replace(/^(?:una?|unos?|unas?|\d+)\s+/i, '')
          .replace(new RegExp(`\\ben\\s+(?:${VARIANT_KEYWORD_ALT})\\b`, 'gi'), 'talle')
          .trim();
        const price = parsePrice(rawProductText) ?? parsePrice(fragment);
        const cleanedProductText = rawProductText.replace(/\s*(?:valen?|vale|a|por|precio)\s*\$?\s*[0-9]+(?:[.,][0-9]{3})*\s*$/i, '').trim();
        const productDescriptor = parseProductDescriptor(cleanedProductText);
        if (productDescriptor.productName) {
          actions.push({
            type: 'add_stock',
            productName: productDescriptor.productName,
            productType: productDescriptor.productType,
            productModel: productDescriptor.productModel,
            size: productDescriptor.size,
            qty,
            price: price ?? undefined,
          });
          lastProductName = productDescriptor.productName;
        }
      }
      continue;
    }

    const reserveMatch = fragment.match(/\b(?:les deje|les dejé|deje|dejé|reserve|reservé|reservaron)\s+(\d+)\s+(.+)$/u);
    if (reserveMatch) {
      inPedidoList = false;
      const qty = Number(reserveMatch[1]);
      if (qty > 0) {
        const targetRaw = reserveMatch[2].trim();
        const reservationTarget = splitReservationTarget(targetRaw, lastProductName);
        const cleanedProductText = reservationTarget.productName.replace(/\s*(?:valen?|vale|a|por|precio)\s*\$?\s*[0-9]+(?:[.,][0-9]{3})*\s*$/i, '').trim();
        const productDescriptor = parseProductDescriptor(cleanedProductText);
        const resolvedName = reservationTarget.productName === targetRaw && lastProductName ? lastProductName : productDescriptor.productName;

        actions.push({
          type: 'reserve_stock',
          productName: resolvedName,
          productType: productDescriptor.productType,
          productModel: productDescriptor.productModel,
          size: productDescriptor.size,
          clientName: reservationTarget.clientName,
          qty,
        });
      }
      continue;
    }

    const sellMatch = fragment.match(/\b(?:vend(?:i|í)o|vendiste|vendieron|vend[ií])\s+(?:(\d+)\s+)?(.+)$/u);
    if (sellMatch) {
      inPedidoList = false;
      const qty = sellMatch[1] ? Number(sellMatch[1]) : parseQuantity(sellMatch[2]) ?? 1;
      if (qty > 0) {
        const rawProductText = sellMatch[2]
          .replace(/^(?:una?|unos?|unas?|\d+)\s+/i, '')
          .trim();
        const price = parsePrice(rawProductText) ?? parsePrice(fragment);
        const cleanedProductText = rawProductText.replace(/\s*(?:valen?|vale|a|por|precio)\s*\$?\s*[0-9]+(?:[.,][0-9]{3})*\s*$/i, '').trim();
        const productDescriptor = parseProductDescriptor(cleanedProductText);
        if (productDescriptor.productName) {
          actions.push({
            type: 'sell',
            productName: productDescriptor.productName,
            productType: productDescriptor.productType,
            productModel: productDescriptor.productModel,
            size: productDescriptor.size,
            qty,
            price: price ?? undefined,
          });
        }
      }
    }
  }

  applyPriceFromText(actions, normalized);
  return actions;
};

const findLastActionOfType = (conversationTurns, type) => {
  if (!Array.isArray(conversationTurns)) {
    return null;
  }

  for (let index = conversationTurns.length - 1; index >= 0; index -= 1) {
    const actions = Array.isArray(conversationTurns[index]?.actions) ? conversationTurns[index].actions : [];
    for (let actionIndex = actions.length - 1; actionIndex >= 0; actionIndex -= 1) {
      if (actions[actionIndex]?.type === type) {
        return actions[actionIndex];
      }
    }
  }

  return null;
};

const tryResolveQueryStockFollowUp = (text, conversationTurns = []) => {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[¿?¡!.,;:]+$/g, '')
    .trim();

  if (!cleaned || cleaned.length > 60) {
    return null;
  }

  const normalized = normalizeText(cleaned);
  if (
    /\b(?:compre|compra|vendi|vendiste|reserve|reserv|recib|ingreso|ingresaron|pedido|actualiza|borra|elimina|cuanto|cuanta|cuantas|cuantos|stock|tengo|hay|vale|cuesta|precio)\b/i.test(
      normalized,
    )
  ) {
    return null;
  }

  const followUpMatch = cleaned.match(/^(?:y\s+)?(?:(?:las?|los?|el|la)\s+)?(?:de\s+)?(.+)$/iu);
  if (!followUpMatch?.[1]) {
    return null;
  }

  const fragment = followUpMatch[1].trim();
  if (!fragment || fragment.length < 2) {
    return null;
  }

  const lastQuery = findLastActionOfType(conversationTurns, 'query_stock');
  if (!lastQuery?.productName && !lastQuery?.productType) {
    return null;
  }

  const productType = lastQuery.productType || undefined;
  const productModel = titleCase(fragment);
  const productName = composeProductName({
    productType,
    productModel,
    fallback: productType ? `${productType} ${productModel}` : productModel,
  });

  return buildPayload(
    text,
    [
      {
        type: 'query_stock',
        productName,
        ...(productType ? { productType } : {}),
        productModel,
      },
    ],
    {
      intent: 'query_stock',
      confidence: 0.82,
      requiresConfirmation: false,
    },
  );
};

const GARMENT_TYPES_ALT = 'camisetas?|buzos?|shorts?|remeras?|pantalones?|camperas?';

const extractGlobalCatalogAttrs = (text) => {
  const normalized = normalizeText(text);
  const todoSizeMatches = [
    ...normalized.matchAll(
      /\b(?:todo(?:\s+esto)?|todas?|todo lo que(?:\s+\w+){0,12})\s+(?:esta(?:n)?\s+)?(?:en\s+)?talle\s+([a-z0-9\/]+)/gi,
    ),
  ];
  const lastTodoSize = todoSizeMatches.length
    ? String(todoSizeMatches[todoSizeMatches.length - 1][1]).toUpperCase()
    : undefined;
  const firstSize = normalized.match(/\btalle\s+([a-z0-9\/]+)/i);
  const globalSize = lastTodoSize || (firstSize ? String(firstSize[1]).toUpperCase() : undefined);

  let globalVersion;
  if (/\bversion jugador\b/.test(normalized)) {
    globalVersion = 'versión jugador';
  } else if (/\bversion fan\b/.test(normalized)) {
    globalVersion = 'versión fan';
  }

  return { globalSize, globalVersion, globalPrice: parsePrice(text) };
};

const findCatalogChunks = (text) => {
  const source = String(text ?? '');
  const pattern = new RegExp(
    `(?:(?:\\b(?:una|un|unas|unos)\\s+)?(?:${GARMENT_TYPES_ALT})\\s+(?:de(?:l)?|titular|suplente|tercera)\\b|\\bla de(?:l)?\\s+(?!mas\\b))`,
    'gi',
  );
  const matches = [...source.matchAll(pattern)];
  if (!matches.length) {
    return [];
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    return source.slice(start, end).trim();
  });
};

const stripCatalogNoise = (chunk) =>
  String(chunk ?? '')
    .replace(
      /\s*(?:,\s*)?(?:vale|valen|cuesta|cuestan|sale|salen|precio)\s*\$?\s*[0-9]+(?:[.,][0-9]{3})*(?:\s*mil)?\s*(?:pesos|euros?)?\.?/gi,
      '',
    )
    .replace(/\b[0-9]+(?:[.,][0-9]{3})+\s*(?:pesos|euros?)\.?/gi, '')
    .replace(/\b[0-9]+\s*mil(?:\s*pesos)?\.?/gi, '')
    .replace(/\btodas?\s+son\s+en\s+versi[oó]n\s+(?:jugador|fan)\b/gi, '')
    .replace(/\btoda(?:s)?\s+en\s+versi[oó]n\s+(?:jugador|fan)\b/gi, '')
    .replace(/\btodo(?:s|as)?(?:\s+esto)?\s+en\s+talle\s+[a-z0-9\/]+\b.*$/gi, '')
    .replace(/\b(?:y\s+)?todo(?:s|as)?(?:\s+esto)?\s+vale\b.*$/gi, '')
    .replace(/\btodo lo que te (?:dije|mencione|voy a mencionar).*$/i, '')
    .replace(/\b(?:pesos|euros?)\b/gi, '')
    .replace(/\btambi[eé]n\b/gi, ' ')
    .replace(/\by\s*$/i, '')
    .replace(/[.,;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const splitGarmentName = (productText, globalVersion) => {
  const cleaned = String(productText ?? '')
    .replace(/[.,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const garmentMatch = cleaned.match(new RegExp(`^(${GARMENT_TYPES_ALT})\\s+(?:del?\\s+)?(.+)$`, 'i'));
  let productType;
  let productModel;
  if (garmentMatch) {
    productType = singularizeProductType(garmentMatch[1]);
    productModel = titleCase(String(garmentMatch[2]).replace(/^del?\s+/i, ''));
    const kitLead = productModel.match(/^(Titular|Suplente|Tercera)\s+(?:De|Del)\s+(.+)$/i);
    if (kitLead) {
      const rest = kitLead[2].trim();
      const yearMatch = rest.match(/^(.+?)\s+(\d{4}(?:\s+\d{4})?)$/);
      const team = (yearMatch ? yearMatch[1] : rest).trim();
      const years = yearMatch ? yearMatch[2] : '';
      productModel = [titleCase(team), titleCase(kitLead[1]), years].filter(Boolean).join(' ');
    }
  } else {
    const descriptor = parseProductDescriptor(cleaned);
    productType = descriptor.productType || 'Camiseta';
    productModel = descriptor.productModel;
  }

  const versionAlready = /\bversi[oó]n\s+(?:jugador|fan)\b/i.test(`${productType} ${productModel || ''}`);
  if (globalVersion && !versionAlready) {
    productModel = [productModel, globalVersion].filter(Boolean).join(' ');
  }

  return { productType, productModel };
};

const actionLooksMashed = (action) => {
  if (action?.type !== 'add_stock') {
    return false;
  }
  const name = normalizeText(action.productName || '');
  const garmentHits = (name.match(/\b(?:camiseta|buzo|short|remera)\b/g) || []).length;
  return garmentHits >= 2 || name.length > 80;
};

const shouldPreferCatalogActions = (catalogActions, modelActions) => {
  if (!Array.isArray(catalogActions) || !catalogActions.length) {
    return false;
  }
  if (!Array.isArray(modelActions) || !modelActions.length) {
    return true;
  }
  const mashedCount = modelActions.filter(actionLooksMashed).length;
  if (mashedCount > 0 && catalogActions.length > modelActions.length - mashedCount) {
    return true;
  }
  return catalogActions.length >= modelActions.length + 2;
};

const extractCatalogActionsFromText = (text) => {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!looksLikeInventoryCatalog(cleaned)) {
    return [];
  }

  const { globalSize, globalVersion, globalPrice } = extractGlobalCatalogAttrs(cleaned);
  const chunks = findCatalogChunks(cleaned);
  const actions = [];
  const seen = new Set();

  for (const rawChunk of chunks) {
    let productText = stripCatalogNoise(rawChunk);
    productText = productText
      .replace(/^las?\s+de(?:l)?\s+/i, '')
      .replace(/\s+en$/i, '')
      .trim();
    if (!productText || productText.length < 3) {
      continue;
    }

    const localPrice = parsePrice(rawChunk);
    const sizeMatch = normalizeText(productText).match(new RegExp(`(?:${VARIANT_KEYWORD_ALT})\\s+([a-z0-9\\/]+)`, 'i'));
    const size = sizeMatch ? String(sizeMatch[1]).toUpperCase() : globalSize;
    const withoutSize = productText
      .replace(new RegExp(`(?:,\\s*|\\s+)(?:${VARIANT_KEYWORD_ALT})\\s+[a-z0-9\\/]+\\b`, 'i'), '')
      .replace(/[.,;]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const prefixed = /^(?:camiseta|buzo|short|remera)\b/i.test(withoutSize)
      ? withoutSize
      : `Camiseta ${withoutSize}`;
    const { productType, productModel } = splitGarmentName(prefixed, globalVersion);
    const productName = composeProductName({
      productType: productType || 'Camiseta',
      productModel,
      size,
      fallback: prefixed,
    });

    const key = productName.toLowerCase();
    if (!productName || seen.has(key)) {
      continue;
    }
    seen.add(key);

    actions.push({
      type: 'add_stock',
      productName,
      productType: productType || 'Camiseta',
      productModel,
      size,
      qty: 1,
      price: localPrice ?? globalPrice ?? undefined,
    });
  }

  return actions;
};

const parseLocalText = (text, conversationTurns = [], catalog = null) => {
  const finish = (payload) => withCatalogGrounding(payload, catalog);

  const followUp = tryResolveQueryStockFollowUp(text, conversationTurns);
  if (followUp) {
    return finish(followUp);
  }

  const deleteActions = extractDeleteProductActions(text);
  if (deleteActions.length) {
    return finish(buildPayload(text, deleteActions));
  }

  if (looksLikeLoadPreviousCommand(text)) {
    const previous = findLastCatalogUserText(conversationTurns);
    if (previous) {
      const catalogActions = extractCatalogActionsFromText(previous);
      if (catalogActions.length) {
        applyPriceFromText(catalogActions, previous);
        return finish(buildPayload(text, catalogActions, { intent: 'add_stock' }));
      }
    }
  }

  const catalogActions = extractCatalogActionsFromText(text);
  if (catalogActions.length) {
    applyPriceFromText(catalogActions, text);
    return finish(buildPayload(text, catalogActions, { intent: 'add_stock' }));
  }

  const actions = extractMultipleActionsFromText(text);
  if (!actions.length) {
    return null;
  }

  applyPriceFromText(actions, text);
  return finish(buildPayload(text, actions));
};

/**
 * Build short conversation turns from saved Meta events for prompt context.
 * Each event contributes user text + bot reply (1 turn).
 */
export const buildConversationTurnsFromEvents = (events, { excludeMessageId = null, maxTurns = MAX_CONVERSATION_TURNS } = {}) => {
  if (!Array.isArray(events) || !events.length) {
    return [];
  }

  const chronological = [...events]
    .filter((event) => {
      if (!event) {
        return false;
      }
      if (excludeMessageId && event.id === excludeMessageId) {
        return false;
      }
      const userText = String(event.sourceText || event.transcript || '').trim();
      return Boolean(userText);
    })
    .sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime())
    .slice(-Math.max(1, maxTurns));

  const turns = [];

  for (const event of chronological) {
    const userText = String(event.sourceText || event.transcript || '').trim();
    const actions = Array.isArray(event.actions) ? event.actions : [];

    if (userText) {
      turns.push({
        role: 'user',
        text: userText,
        actions,
      });
    }

    const replyText = String(event.replyText || '').trim();
    if (
      replyText &&
      !/^procesando tu mensaje/i.test(replyText) &&
      !/^no pude detectar una acci[oó]n clara/i.test(replyText)
    ) {
      turns.push({
        role: 'assistant',
        text: truncateText(replyText, MAX_CONTEXT_REPLY_CHARS),
        actions,
      });
    }
  }

  return turns;
};

const transcribeMetaAudioId = async (audioId) => {
  const { transcriptionApiKey, transcriptionEndpoint, transcriptionModel, metaAccessToken, metaGraphApiVersion } = readEnv();

  if (!transcriptionApiKey) {
    throw new Error('Missing transcription API key');
  }

  if (!metaAccessToken) {
    throw new Error('Missing META_ACCESS_TOKEN');
  }

  const mediaInfoResponse = await fetch(`https://graph.facebook.com/${metaGraphApiVersion}/${audioId}?fields=url,mime_type`, {
    headers: {
      Authorization: `Bearer ${metaAccessToken}`,
    },
  });

  if (!mediaInfoResponse.ok) {
    throw new Error(`Failed to fetch Meta media metadata: ${mediaInfoResponse.status}`);
  }

  const mediaInfo = await mediaInfoResponse.json();
  const mediaUrl = typeof mediaInfo?.url === 'string' ? mediaInfo.url : null;

  if (!mediaUrl) {
    throw new Error('Meta media metadata did not include a downloadable URL');
  }

  const mediaResponse = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${metaAccessToken}`,
    },
  });

  if (!mediaResponse.ok) {
    throw new Error(`Failed to fetch Meta media: ${mediaResponse.status}`);
  }

  const mediaContentType = mediaResponse.headers.get('content-type') || mediaInfo?.mime_type || 'audio/ogg';
  const audioBuffer = await mediaResponse.arrayBuffer();
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: mediaContentType }), 'meta-media.ogg');
  formData.append('model', transcriptionModel);

  const transcriptionResponse = await fetch(transcriptionEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${transcriptionApiKey}`,
    },
    body: formData,
  });

  if (!transcriptionResponse.ok) {
    const errorText = await transcriptionResponse.text();
    throw new Error(`Transcription failed with status ${transcriptionResponse.status}: ${errorText}`);
  }

  const responseText = await transcriptionResponse.text();

  try {
    const parsed = JSON.parse(responseText);
    if (typeof parsed.text === 'string') {
      return parsed.text.trim();
    }
  } catch {
    // fall through to raw text
  }

  return responseText.trim();
};

const parseVoiceTextWithModel = async (
  text,
  preset = getBusinessCategoryPreset('general'),
  conversationTurns = [],
  catalog = null,
) => {
  const { apiKey, model, modelEndpoint } = readEnv();
  const operationHint = buildOperationHint(text, conversationTurns);
  const forceAddStock = looksLikeLoadPreviousCommand(text) || looksLikeInventoryCatalog(text);
  const previousCatalog = looksLikeLoadPreviousCommand(text) ? findLastCatalogUserText(conversationTurns) : '';
  const finish = (payload) => withCatalogGrounding(payload, catalog);

  if (!apiKey) {
    console.warn('[MetaWebhook] parseVoiceText falling back to local parser: missing VITE_VOICE_MODEL_API_KEY');
    return parseLocalText(text, conversationTurns, catalog);
  }

  const requestBody = {
    model,
    temperature: 0,
    max_tokens: MAX_MODEL_OUTPUT_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Devolvé únicamente JSON válido para automatizar transacciones de un ERP. No agregues texto explicativo.',
      },
      {
        role: 'user',
        content: buildPrompt(text, preset, conversationTurns, operationHint, catalog),
      },
    ],
  };

  let response = await fetch(modelEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok && response.status !== 429 && response.status !== 413) {
    delete requestBody.response_format;
    response = await fetch(modelEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  }

  const retryableStatus = (status) => status === 429 || status === 413;
  for (let attempt = 1; attempt <= 3 && response && !response.ok && retryableStatus(response.status); attempt += 1) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const hinted = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt;
    const waitMs = Math.min(8000, hinted);
    console.warn('[MetaWebhook] model HTTP', response.status, `— retry ${attempt}/3 in ${waitMs}ms (no se cae al parser local todavía)`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(modelEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  }

  if (!response.ok) {
    console.warn('[MetaWebhook] parseVoiceText falling back to local parser: model HTTP', response.status);
    return parseLocalText(text, conversationTurns, catalog);
  }

  const data = await response.json();
  const content = extractContent(data);

  if (!content) {
    console.warn('[MetaWebhook] parseVoiceText falling back to local parser: empty model content');
    return parseLocalText(text, conversationTurns, catalog);
  }

  try {
    const parsed = JSON.parse(stripCodeFences(content));
    const sourceText = typeof parsed.sourceText === 'string' ? parsed.sourceText : text;
    const actions = coerceCatalogActions(
      Array.isArray(parsed.actions) ? parsed.actions.map(parseAction).filter(Boolean) : [],
      { forceAddStock },
    );
    const normalizedActions = actions.length
      ? actions
      : coerceCatalogActions(extractMultipleActionsFromText(sourceText), { forceAddStock });
    applyPriceFromText(normalizedActions, sourceText);
    if (sourceText !== text) {
      applyPriceFromText(normalizedActions, text);
    }
    if (previousCatalog) {
      applyPriceFromText(normalizedActions, previousCatalog);
    }

    const localDeletes = extractDeleteProductActions(text);
    if (localDeletes.length && !normalizedActions.some((action) => action.type === 'delete_product')) {
      return finish(buildPayload(text, localDeletes));
    }

    const queryPedidosOverride = tryParseQueryPedidosAction(text);
    if (queryPedidosOverride) {
      const hasMutation = normalizedActions.some((action) => MUTATING_ACTION_TYPES.has(action.type));
      const hasQueryPedidos = normalizedActions.some((action) => action.type === 'query_pedidos');
      if (hasMutation || !hasQueryPedidos) {
        return finish(buildPayload(text, [queryPedidosOverride], { intent: 'query_pedidos', requiresConfirmation: false }));
      }
    }

    if (looksLikeCoordinatedStockOps(text)) {
      const localActions = extractMultipleActionsFromText(text);
      const types = new Set(normalizedActions.map((action) => action.type));
      for (const action of localActions) {
        if ((action.type === 'sell' || action.type === 'add_stock') && !types.has(action.type)) {
          normalizedActions.push(action);
          types.add(action.type);
        }
      }
    }

    const catalogSource = previousCatalog || text;
    const catalogActions = extractCatalogActionsFromText(catalogSource);
    if (forceAddStock && shouldPreferCatalogActions(catalogActions, normalizedActions)) {
      applyPriceFromText(catalogActions, catalogSource);
      return finish(buildPayload(text, catalogActions, { intent: 'add_stock' }));
    }

    if (!normalizedActions.length) {
      const holdFields = Array.isArray(parsed.missingFields)
        ? parsed.missingFields.filter((value) => typeof value === 'string')
        : [];
      const holdPhrases = Array.isArray(parsed.suggestedPhrases)
        ? parsed.suggestedPhrases.filter((value) => typeof value === 'string')
        : [];
      if (holdFields.includes('productMatch') || (parsed.requiresConfirmation && holdPhrases.length)) {
        return {
          schemaVersion: 1,
          sourceText: text,
          intent: typeof parsed.intent === 'string' ? parsed.intent : 'unknown',
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
          requiresConfirmation: true,
          actions: [],
          missingFields: holdFields.includes('productMatch') ? holdFields : [...holdFields, 'productMatch'],
          suggestedPhrases: holdPhrases.length ? holdPhrases : undefined,
        };
      }
      console.warn('[MetaWebhook] model returned no valid actions', {
        preview: String(text).slice(0, 160),
        contentPreview: String(content).slice(0, 400),
      });
      const emptyCatalogSource = previousCatalog || text;
      const emptyCatalogActions = coerceCatalogActions(extractCatalogActionsFromText(emptyCatalogSource), {
        forceAddStock: true,
      });
      if (emptyCatalogActions.length) {
        applyPriceFromText(emptyCatalogActions, emptyCatalogSource);
        return finish(buildPayload(text, emptyCatalogActions, { intent: 'add_stock' }));
      }
      console.warn('[MetaWebhook] parseVoiceText falling back to local parser: model returned no valid actions');
      return parseLocalText(text, conversationTurns, catalog);
    }

    return finish(
      buildPayload(sourceText, normalizedActions, {
        intent: forceAddStock ? 'add_stock' : typeof parsed.intent === 'string' ? parsed.intent : undefined,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
        requiresConfirmation:
          typeof parsed.requiresConfirmation === 'boolean' ? parsed.requiresConfirmation : undefined,
        missingFields: Array.isArray(parsed.missingFields)
          ? parsed.missingFields.filter((value) => typeof value === 'string')
          : undefined,
        suggestedPhrases: Array.isArray(parsed.suggestedPhrases)
          ? parsed.suggestedPhrases.filter((value) => typeof value === 'string')
          : undefined,
      }),
    );
  } catch (error) {
    console.warn('[MetaWebhook] parseVoiceText falling back to local parser: failed to parse model JSON', {
      preview: String(text).slice(0, 160),
      contentPreview: String(content).slice(0, 400),
      error: error instanceof Error ? error.message : error,
    });
    return parseLocalText(text, conversationTurns, catalog);
  }
};

const uniqueActionNames = (items, field) => {
  const names = [];
  for (const item of items) {
    const name = typeof item[field] === 'string' ? item[field].trim() : '';
    if (name && !names.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
      names.push(name);
    }
  }
  return names;
};

const formatOrderHeader = (items) => {
  const clients = uniqueActionNames(items, 'clientName');
  const proveedores = uniqueActionNames(items, 'proveedorName');
  if (clients.length === 1 && proveedores.length === 1) {
    return `Pedido de ${clients[0]} · proveedor ${proveedores[0]}`;
  }
  if (clients.length === 1) {
    return `Pedido de ${clients[0]}`;
  }
  if (proveedores.length === 1) {
    return `Pedido al proveedor ${proveedores[0]}`;
  }
  if (clients.length > 1) {
    return `Pedidos (${clients.join(', ')})`;
  }
  if (proveedores.length > 1) {
    return `Pedidos a proveedores (${proveedores.join(', ')})`;
  }
  return 'Pedido';
};

const formatOrderItem = (action, preset = getBusinessCategoryPreset('general'), { includeProveedor = false } = {}) => {
  const qty = action.qty && action.qty > 0 ? action.qty : 1;
  const sizeLabel = action.size ? ` ${formatVariantRef(preset, action.size)}` : '';
  const proveedorLabel =
    includeProveedor && action.proveedorName?.trim() ? ` · proveedor ${action.proveedorName.trim()}` : '';
  return `${qty} ${action.productName}${sizeLabel}${proveedorLabel}`;
};

const formatOrderGroup = (items, preset) => {
  const includeProveedor = uniqueActionNames(items, 'proveedorName').length > 1;
  const lines = items.map((item) => `• ${formatOrderItem(item, preset, { includeProveedor })}`);
  return `${formatOrderHeader(items)}:\n${lines.join('\n')}`;
};

const formatActionsSummary = (actions, preset) => {
  const parts = [];
  let orderBuffer = [];

  const flushOrders = () => {
    if (!orderBuffer.length) {
      return;
    }

    const groups = new Map();
    for (const action of orderBuffer) {
      const clientName = typeof action.clientName === 'string' ? action.clientName.trim() : '';
      const proveedorName = typeof action.proveedorName === 'string' ? action.proveedorName.trim() : '';
      const key = clientName
        ? `client:${clientName.toLowerCase()}`
        : proveedorName
          ? `proveedor:${proveedorName.toLowerCase()}`
          : 'pedido';
      const current = groups.get(key) ?? { items: [] };
      current.items.push(action);
      groups.set(key, current);
    }

    for (const group of groups.values()) {
      parts.push(formatOrderGroup(group.items, preset));
    }
    orderBuffer = [];
  };

  for (const action of actions) {
    if (action.type === 'client_order') {
      orderBuffer.push(action);
      continue;
    }
    flushOrders();
    parts.push(formatAction(action, preset));
  }
  flushOrders();

  return parts.join('\n\n');
};

const formatAction = (action, preset = getBusinessCategoryPreset('general')) => {
  if (action.type === 'add_stock') {
    return `+${action.qty} stock de ${action.productName}`;
  }

  if (action.type === 'reserve_stock') {
    return `-${action.qty} reserva de ${action.productName}${action.clientName ? ` para ${action.clientName}` : ''}`;
  }

  if (action.type === 'sell') {
    return `-${action.qty} venta de ${action.productName}`;
  }

  if (action.type === 'payment_received') {
    return `-$${action.amount.toLocaleString('es-AR')} cobrado a ${action.clientName}`;
  }

  if (action.type === 'client_order') {
    return formatOrderItem(action, preset);
  }

  if (action.type === 'query_stock') {
    return `Consulta stock de ${action.productName}`;
  }

  if (action.type === 'query_pedidos') {
    const estado = action.estado && action.estado !== 'todos' ? action.estado : 'pendientes';
    const scope = action.clientName
      ? ` de ${action.clientName}`
      : action.proveedorName
        ? ` del proveedor ${action.proveedorName}`
        : '';
    return `Consulta pedidos ${estado}${scope}`;
  }

  if (action.type === 'update_product') {
    const parts = [];
    if (Number.isFinite(action.price) && action.price > 0) {
      parts.push(`precio $${Number(action.price).toLocaleString('es-AR')}`);
    }
    if (Number.isFinite(action.stockAvailable) && action.stockAvailable >= 0) {
      parts.push(`stock ${action.stockAvailable}`);
    }
    const scope = action.size ? formatVariantRef(preset, action.size) : formatAllVariantsScope(preset);
    return `Actualicé ${action.productName} (${scope})${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  if (action.type === 'update_pedido') {
    const parts = [];
    if (Number.isFinite(action.qty) && action.qty > 0) {
      parts.push(`cantidad ${action.qty}`);
    }
    if (action.size) {
      parts.push(formatVariantRef(preset, action.size));
    }
    if (action.estado) {
      parts.push(`estado ${action.estado}`);
    }
    return `Actualicé pedido ${action.productName}${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  if (action.type === 'delete_pedido') {
    return `Eliminé pedido ${action.productName}`;
  }

  if (action.type === 'delete_product') {
    return `Eliminé producto ${action.productName}`;
  }

  return `+$${action.amount.toLocaleString('es-AR')} en cuenta de ${action.clientName}`;
};

const buildReplyText = ({ transcript, parsed, preset }) => {
  const resolvedPreset = preset ?? getBusinessCategoryPreset('general');

  if (!parsed?.actions?.length) {
    return transcript
      ? `No pude detectar una acción clara. Texto: ${transcript}`
      : 'No pude detectar una acción clara. Probá de nuevo con más detalle.';
  }

  if (hasProductMatchHold(parsed)) {
    const options = (parsed.suggestedPhrases || []).join('\n');
    const prefix = transcript ? `Texto: ${transcript}\n\n` : '';
    return `${prefix}No apliqué cambios: hay más de un producto posible.\n${options || 'Decime el nombre exacto.'}`;
  }

  const actionSummary = formatActionsSummary(parsed.actions, resolvedPreset);
  const prefix = transcript ? `Listo (audio). Texto: ${transcript}\n\n` : 'Listo.\n\n';

  return `${prefix}${actionSummary}`;
};

const extractMetaMessages = (body) => {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  const messages = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change?.value;
      const incomingMessages = Array.isArray(value?.messages) ? value.messages : [];

      for (const message of incomingMessages) {
        messages.push({
          entryId: entry?.id ?? null,
          fromNumber: typeof message?.from === 'string' ? message.from : null,
          messageId: typeof message?.id === 'string' ? message.id : null,
          messageType: typeof message?.type === 'string' ? message.type : 'unknown',
          textBody: typeof message?.text?.body === 'string' ? message.text.body.trim() : '',
          audioId: typeof message?.audio?.id === 'string' ? message.audio.id : null,
          timestamp: typeof message?.timestamp === 'string' ? message.timestamp : null,
          rawMessage: message,
        });
      }
    }
  }

  return messages;
};

const processMetaMessage = async (
  metaMessage,
  preset = getBusinessCategoryPreset('general'),
  conversationTurns = [],
  catalog = null,
) => {
  if (metaMessage.messageType === 'audio' && metaMessage.audioId) {
    const transcript = await transcribeMetaAudioId(metaMessage.audioId);
    const parsed = await parseVoiceTextWithModel(transcript, preset, conversationTurns, catalog);

    return {
      ...metaMessage,
      kind: 'audio',
      sourceText: transcript,
      transcript,
      parsed,
      businessCategory: preset.id,
      replyText: buildReplyText({ transcript, parsed, preset }),
    };
  }

  if (metaMessage.textBody) {
    const parsed = await parseVoiceTextWithModel(metaMessage.textBody, preset, conversationTurns, catalog);

    return {
      ...metaMessage,
      kind: 'text',
      sourceText: metaMessage.textBody,
      transcript: null,
      parsed,
      businessCategory: preset.id,
      replyText: buildReplyText({ transcript: null, parsed, preset }),
    };
  }

  return {
    ...metaMessage,
    kind: 'empty',
    sourceText: '',
    transcript: null,
    parsed: null,
    businessCategory: preset.id,
    replyText: 'Recibí el mensaje, pero no encontré texto ni audio para procesar.',
  };
};

export const processMetaWebhook = async (
  body,
  { resolveBusinessCategory, resolveConversationHistory, resolveCatalog } = {},
) => {
  if (!body || body.object !== 'whatsapp_business_account') {
    return [];
  }

  const incomingMessages = extractMetaMessages(body);
  const results = [];

  for (const message of incomingMessages) {
    let categoryId = null;
    if (typeof resolveBusinessCategory === 'function' && message.fromNumber) {
      try {
        categoryId = await resolveBusinessCategory(message.fromNumber);
      } catch (error) {
        console.warn('[MetaWebhook] failed to resolve business category:', error instanceof Error ? error.message : error);
      }
    }

    let conversationTurns = [];
    if (typeof resolveConversationHistory === 'function' && message.fromNumber) {
      try {
        conversationTurns = (await resolveConversationHistory(message.fromNumber, message.messageId)) ?? [];
      } catch (error) {
        console.warn('[MetaWebhook] failed to resolve conversation history:', error instanceof Error ? error.message : error);
      }
    }

    let catalog = null;
    if (typeof resolveCatalog === 'function' && message.fromNumber) {
      try {
        catalog = (await resolveCatalog(message.fromNumber)) ?? null;
      } catch (error) {
        console.warn('[MetaWebhook] failed to resolve catalog:', error instanceof Error ? error.message : error);
      }
    }

    const preset = getBusinessCategoryPreset(categoryId);
    results.push(await processMetaMessage(message, preset, conversationTurns, catalog));
  }

  return results;
};

export const sendMetaReply = async ({ to, text }) => {
  const { metaAccessToken, metaPhoneNumberId, metaGraphApiVersion } = readEnv();

  if (!metaAccessToken || !metaPhoneNumberId || !to || !text) {
    return { sent: false, reason: 'missing_credentials_or_recipient' };
  }

  const recipients = getWhatsAppVariants(to);
  let lastRecipientError = null;

  for (const recipient of recipients) {
    const response = await fetch(`https://graph.facebook.com/${metaGraphApiVersion}/${metaPhoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${metaAccessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: {
          preview_url: false,
          body: text,
        },
      }),
    });

    if (response.ok) {
      return { sent: true, recipientUsed: recipient };
    }

    const errorText = await response.text();
    let parsedErr = null;

    try {
      parsedErr = JSON.parse(errorText);
    } catch {
      // ignore parse failure and throw below for non-JSON errors
    }

    const code = parsedErr?.error?.code;
    if (code === 190) {
      console.error('[MetaWebhook] Meta API error 190: invalid or expired access token. Generate a new token and update META_ACCESS_TOKEN in .env.local.');
      console.error('[MetaWebhook] Meta error details:', JSON.stringify(parsedErr?.error ?? { message: errorText }));
      return { sent: false, reason: 'auth_error', metaError: parsedErr?.error, recipientsTried: recipients };
    }

    if (code === 131030) {
      lastRecipientError = parsedErr.error;
      console.warn(`[MetaWebhook] recipient '${recipient}' rejected with 131030. Trying next format if available...`);
      continue;
    }

    throw new Error(`Meta reply failed with status ${response.status}: ${errorText}`);
  }

  if (lastRecipientError) {
    console.error('[MetaWebhook] Meta API error 131030 for all recipient formats. Add the recipient number as a test recipient in your WhatsApp/Meta app (or use a verified phone number).');
    console.error('[MetaWebhook] Meta error details:', JSON.stringify(lastRecipientError));
    return { sent: false, reason: 'recipient_not_allowed', metaError: lastRecipientError, recipientsTried: recipients };
  }

  return { sent: false, reason: 'recipient_unreachable', recipientsTried: recipients };
};

export const buildMetaVerificationResponse = (challenge) => String(challenge ?? '');

export { parseLocalText };

export const parseVoiceText = async (text, options = {}) => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const preset = getBusinessCategoryPreset(options.businessCategory);
  const conversationTurns = Array.isArray(options.conversationTurns) ? options.conversationTurns : [];
  const catalog = options.catalog ?? null;
  return parseVoiceTextWithModel(trimmed, preset, conversationTurns, catalog);
};