import { getWhatsAppVariants } from './phone.js';
import {
  VARIANT_KEYWORD_ALT,
  buildCategoryPromptContext,
  formatAllVariantsScope,
  formatVariantRef,
  getBusinessCategoryPreset,
} from './businessCategories.js';

const DEFAULT_MODEL_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_META_GRAPH_API_VERSION = 'v21.0';

const buildPrompt = (text, preset) => `
Sos un analista de operaciones para Stocky, un sistema de stock y pedidos (de clientes o propios al proveedor) para un negocio.
Convertí la frase del usuario en un JSON válido con esta estructura exacta:
{
  "schemaVersion": 1,
  "sourceText": string,
  "intent": "add_stock" | "reserve_stock" | "sell" | "add_debt" | "payment_received" | "client_order" | "query_stock" | "update_product" | "update_pedido" | "delete_pedido" | "delete_product" | "mixed" | "unknown",
  "confidence": number,
  "requiresConfirmation": boolean,
  "actions": [
    { "type": "add_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "price"?: number },
    { "type": "reserve_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "clientName"?: string },
    { "type": "sell", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "price"?: number },
    { "type": "add_debt", "clientName": string, "amount": number, "productType"?: string, "productModel"?: string, "size"?: string, "productName"?: string, "qty"?: number },
    { "type": "payment_received", "clientName": string, "amount": number },
    { "type": "client_order", "clientName"?: string, "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty"?: number },
    { "type": "query_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string },
    { "type": "update_product", "productName": string, "productType"?: string, "productModel"?: string, "size"?: string, "price"?: number, "stockAvailable"?: number },
    { "type": "update_pedido", "productName": string, "qty"?: number, "size"?: string, "estado"?: "pendiente" | "conseguido" | "descartado", "clientName"?: string },
    { "type": "delete_pedido", "productName": string, "clientName"?: string },
    { "type": "delete_product", "productName": string }
  ],
  "missingFields"?: string[],
  "suggestedPhrases"?: string[]
}

${buildCategoryPromptContext(preset)}

Reglas generales:
- Respondé solo JSON, sin markdown ni texto extra.
- Si faltan datos críticos, llená missingFields.
- Si detectás múltiples acciones, intent debe ser "mixed".
- sourceText debe ser el texto original.
- confidence debe estar entre 0 y 1.
- Nunca devuelvas acciones con qty 0.
- Si el texto indica que un cliente te pagó dinero, usá payment_received y no add_debt.
- Si el texto dice que un cliente te tiene que pagar por productos o que todavía no te los pagó, usá sell y también add_debt con clientName, productName, qty y amount 0 si todavía no podés calcularlo.
- Si ya tenés productName y qty, no pidas precio unitario: devolvé la venta y dejá amount en 0 para que el ERP lo calcule.
- Si la frase menciona precio unitario, completá price en add_stock o sell con ese valor numérico.
- Si la frase dice "para X" en una reserva, separá X como clientName y dejá solo el producto en productName.
- Usá client_order para pedidos: si un cliente te pidió algo ("Juan me pidió…") O si vos tenés que pedir/encargar al proveedor ("pedido: …", "tengo que pedir …", lista bajo "pedido:"). NO uses reserve_stock ni sell. Un pedido NO mueve stock.
- client_order requiere productName. clientName es OPCIONAL: si no hay cliente, omitilo o usá "". qty default 1.
- Si el texto es una lista (una línea por producto) bajo "pedido:", creá un client_order por cada ítem.
- Si dice "cantidad N" al final, usá ese N como qty.
- Diferenciá claramente: "compré / compraron / entraron / llegaron / ingreso / ingresaron / recibí" = add_stock; "me pidió / pidió / quiere / encargó / pedido: / tengo que pedir" = client_order.
- Si el usuario pregunta cuánto stock queda, qué variantes hay, o consulta inventario (sin indicar que compró/vendió/pidió nada), usá query_stock. NO mutes stock. requiresConfirmation debe ser false.
- query_stock requiere productName. Si menciona tipo y modelo, separá productType y productModel.
- Si no hay cantidad explícita en un ingreso/compra, usá qty 1.
- Si una frase tiene dos movimientos, devolvé dos objetos en actions.
- Ejemplo genérico: "compre 20 unidades de X, les deje 3 al gimnasio" -> [{"type":"add_stock","productName":"X","qty":20},{"type":"reserve_stock","productName":"X","qty":3,"clientName":"gimnasio"}].
- Ejemplo genérico: "Pedido: producto A cantidad 3" -> [{"type":"client_order","productName":"Producto A","qty":3}].
- Ejemplo genérico: "pedido: prolongador\\ncanilla bronce" -> [{"type":"client_order","productName":"Prolongador","qty":1},{"type":"client_order","productName":"Canilla bronce","qty":1}].
- Si dice que un producto "vale / cuesta / precio" un monto, usá update_product con price (NO add_stock).
- Si actualiza un pedido existente (cantidad, variante/size o estado), usá update_pedido.
- "el pedido de X ya está conseguido / marcá como conseguido" -> update_pedido con estado "conseguido". "descartá el pedido" -> estado "descartado".
- "borrá / eliminá el pedido de X" -> delete_pedido. "borrá el producto X" -> delete_product.
- update_product y update_pedido NO crean registros nuevos: solo modifican existentes.

Texto del usuario:
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
  const descriptorParts = withoutSize.split(/\s+de\s+/i);
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
    /(?:valen?|vale|cuestan|cuesta|sale|precio|a|por)\s*\$?\s*([0-9]+(?:[.,][0-9]{3})*(?:[.,][0-9]+)?)\s*(?:c\/u|c\.u\.|pesos|\$)?/i,
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

  return parseNumericValue(moneyMatch[1]);
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

const buildPayload = (sourceText, actions, options = {}) => {
  const allQueryStock = actions.length > 0 && actions.every((action) => action.type === 'query_stock');

  return {
    schemaVersion: 1,
    sourceText,
    intent: options.intent ?? inferIntent(actions),
    confidence: options.confidence ?? (actions.length > 1 ? 0.92 : 0.83),
    requiresConfirmation: options.requiresConfirmation ?? (actions.length > 0 && !allQueryStock),
    actions,
    missingFields: options.missingFields,
    suggestedPhrases: options.suggestedPhrases,
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

    if (!productName || !Number.isFinite(qty) || qty <= 0) {
      return null;
    }

    return {
      type: value.type,
      productName,
      productType,
      productModel,
      size,
      qty,
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

    if (!productName) {
      return null;
    }

    return {
      type: 'client_order',
      ...(rawClient ? { clientName: rawClient } : {}),
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
    /^(?:borra(?:r)?|elimin[aá](?:r)?|sac[aá]|quita(?:r)?)\s+(?:el\s+)?producto\s+(.+)$/u,
  );
  if (deleteProductMatch) {
    const productText = deleteProductMatch[1].trim();
    if (productText) {
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
  const queryStockAction = tryParseQueryStockAction(fullLine);
  if (queryStockAction) {
    return [queryStockAction];
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
      if (!/^(?:pedido|pedidos)$/i.test(clientName)) {
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
      /\b(?:compre|compré|compra(?:r|ste|ron)?|adquiri|adquirí|entraron|entran|llegaron|recibi|recibieron|recibí|ingreso|ingrese|ingresaron)\s+(?:(\d+)\s+)?(.+)$/u,
    );
    if (addStockMatch) {
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

    const sellMatch = fragment.match(/\b(?:vend(?:i|í)o|vendiste|vendieron|vendi)\s+(\d+)\s+(.+)$/u);
    if (sellMatch) {
      inPedidoList = false;
      const qty = Number(sellMatch[1]);
      if (qty > 0) {
        const rawProductText = sellMatch[2].trim();
        const price = parsePrice(rawProductText) ?? parsePrice(fragment);
        const cleanedProductText = rawProductText.replace(/\s*(?:valen?|vale|a|por|precio)\s*\$?\s*[0-9]+(?:[.,][0-9]{3})*\s*$/i, '').trim();
        const productDescriptor = parseProductDescriptor(cleanedProductText);
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

  applyPriceFromText(actions, normalized);
  return actions;
};

const parseLocalText = (text) => {
  const actions = extractMultipleActionsFromText(text);
  if (!actions.length) {
    return null;
  }

  applyPriceFromText(actions, text);
  return buildPayload(text, actions);
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

const parseVoiceTextWithModel = async (text, preset = getBusinessCategoryPreset('general')) => {
  const { apiKey, model, modelEndpoint } = readEnv();

  if (!apiKey) {
    return parseLocalText(text);
  }

  const requestBody = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Devolvé únicamente JSON válido para automatizar transacciones de un ERP. No agregues texto explicativo.',
      },
      {
        role: 'user',
        content: buildPrompt(text, preset),
      },
    ],
  };

  const response = await fetch(modelEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    return parseLocalText(text);
  }

  const data = await response.json();
  const content = extractContent(data);

  if (!content) {
    return parseLocalText(text);
  }

  try {
    const parsed = JSON.parse(stripCodeFences(content));
    const sourceText = typeof parsed.sourceText === 'string' ? parsed.sourceText : text;
    const actions = Array.isArray(parsed.actions) ? parsed.actions.map(parseAction).filter(Boolean) : [];
    const inferredPrice = parsePrice(sourceText);
    const normalizedActions = actions.length ? actions : extractMultipleActionsFromText(sourceText);
    applyPriceFromText(normalizedActions, sourceText);
    if (sourceText !== text) {
      applyPriceFromText(normalizedActions, text);
    }

    if (!normalizedActions.length) {
      return parseLocalText(text);
    }

    return buildPayload(sourceText, normalizedActions, {
      intent: typeof parsed.intent === 'string' ? parsed.intent : undefined,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      requiresConfirmation: typeof parsed.requiresConfirmation === 'boolean' ? parsed.requiresConfirmation : undefined,
      missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields.filter((value) => typeof value === 'string') : undefined,
      suggestedPhrases: Array.isArray(parsed.suggestedPhrases) ? parsed.suggestedPhrases.filter((value) => typeof value === 'string') : undefined,
    });
  } catch {
    return parseLocalText(text);
  }
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
    const qty = action.qty && action.qty > 0 ? action.qty : 1;
    const sizeLabel = action.size ? ` ${formatVariantRef(preset, action.size)}` : '';
    if (action.clientName?.trim()) {
      return `Pedido: ${action.clientName} pidió ${qty} ${action.productName}${sizeLabel}`;
    }
    return `Pedido: ${qty} ${action.productName}${sizeLabel}`;
  }

  if (action.type === 'query_stock') {
    return `Consulta stock de ${action.productName}`;
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

  const actionSummary = parsed.actions.map((action) => formatAction(action, resolvedPreset)).join('\n• ');
  const prefix = transcript ? `Listo (audio). Texto: ${transcript}\n` : 'Listo.\n';

  return `${prefix}• ${actionSummary}`;
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

const processMetaMessage = async (metaMessage, preset = getBusinessCategoryPreset('general')) => {
  if (metaMessage.messageType === 'audio' && metaMessage.audioId) {
    const transcript = await transcribeMetaAudioId(metaMessage.audioId);
    const parsed = await parseVoiceTextWithModel(transcript, preset);

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
    const parsed = await parseVoiceTextWithModel(metaMessage.textBody, preset);

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

export const processMetaWebhook = async (body, { resolveBusinessCategory } = {}) => {
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

    const preset = getBusinessCategoryPreset(categoryId);
    results.push(await processMetaMessage(message, preset));
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

export const parseVoiceText = async (text, options = {}) => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const preset = getBusinessCategoryPreset(options.businessCategory);
  return parseVoiceTextWithModel(trimmed, preset);
};