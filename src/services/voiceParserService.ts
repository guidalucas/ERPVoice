import type { ParsedAction, ParsedActionUnion, ParsedVoicePayload, VoiceIntent } from '../domain/types';
import { VARIANT_KEYWORD_ALT } from '../domain/businessCategories';

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const titleCase = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

const singularizeProductType = (value: string) => {
  const trimmed = value.trim();

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

const composeProductName = (parts: { productType?: string; productModel?: string; size?: string; fallback?: string }) => {
  const values = [parts.productType, parts.productModel, parts.size]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (values.length) {
    return values.join(' ');
  }

  return parts.fallback?.trim() ?? '';
};

const parseProductDescriptor = (value: string) => {
  const normalized = normalizeText(value).replace(/\s+/g, ' ').trim();
  const sizeMatch = normalized.match(new RegExp(`(?:,\\s*|\\s+)(?:${VARIANT_KEYWORD_ALT})\\s+([a-z0-9\\/]+)\\b`, 'i'));
  const size = sizeMatch ? sizeMatch[1]!.toUpperCase() : undefined;
  const withoutSize = normalized
    .replace(new RegExp(`(?:,\\s*|\\s+)(?:${VARIANT_KEYWORD_ALT})\\s+[a-z0-9\\/]+\\b`, 'i'), '')
    .trim();
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

const tryParseQueryStockAction = (fragment: string): ParsedActionUnion | null => {
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

    const productText = match[1]
      .replace(/^(?:de\s+)/i, '')
      .replace(new RegExp(`\\s+y\\s+(?:qu[eé]\\s+)?(?:${VARIANT_KEYWORD_ALT})(?:\\s+(?:tengo|hay|quedan))?$`, 'iu'), '')
      .replace(/\s+(?:me\s+)?(?:quedan|queda|tengo|hay)$/iu, '')
      .replace(new RegExp(`\\ben\\s+(?:${VARIANT_KEYWORD_ALT})\\b`, 'gi'), 'talle')
      .trim();

    if (!productText || productText.length < 2) {
      continue;
    }

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

const tryParseQueryPedidosAction = (fragment: string): ParsedActionUnion | null => {
  const cleaned = String(fragment ?? '')
    .replace(/\s+/g, ' ')
    .trim()
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
    /(?:cu[aá]les?\s+son|qu[eé]\s+(?:pedidos?|me\s+pidieron)|cu[aá]ntos?\s+pedidos?|lista(?:do)?\s+de\s+pedidos?|mostr[aá](?:me)?\s+(?:los\s+)?pedidos?|decime\s+(?:los\s+)?pedidos?|pedidos?\s+(?:que\s+)?(?:tengo|pendientes?)|pedidos?\s+pendientes?|tengo\s+pedidos?|qu[eé]\s+me\s+(?:pidieron|encargaron)|qu[eé]\s+tengo\s+(?:pendiente|que\s+conseguir))/i.test(
      cleaned,
    ) || /^(?:pedidos?(?:\s+pendientes?)?)$/i.test(cleaned);

  if (!looksLikeQuery) {
    return null;
  }

  let estado: 'pendiente' | 'conseguido' | 'descartado' | 'todos' = 'pendiente';
  if (/\bconseguidos?\b/i.test(cleaned)) {
    estado = 'conseguido';
  } else if (/\bdescartados?\b/i.test(cleaned)) {
    estado = 'descartado';
  } else if (/\btodos?\s+(?:los\s+)?pedidos?\b/i.test(cleaned) && !/\bpendiente/i.test(cleaned)) {
    estado = 'todos';
  }

  let clientName: string | undefined;
  const clientMatch =
    cleaned.match(/\b(?:del\s+cliente|tiene)\s+([a-záéíóúñü\s]+?)(?:\s+(?:pendiente|conseguido|descartado)s?)?$/iu) ||
    cleaned.match(/\bpedidos?\s+de\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+)?)/iu);

  if (clientMatch?.[1]) {
    const raw = clientMatch[1].trim().replace(/\s+(?:pendiente|conseguido|descartado)s?$/i, '');
    const tokens = raw.split(/\s+/).filter((token) => !QUERY_PEDIDOS_STOPWORDS.has(normalizeText(token)));
    if (tokens.length && !/^(?:proveedor|producto)/i.test(tokens[0] ?? '')) {
      clientName = tokens.map((token) => titleCase(token)).join(' ');
    }
  }

  let proveedorName: string | undefined;
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

const extractFirstNumber = (value: string) => {
  const match = value.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : null;
};

const parseQuantity = (value: string) => {
  const normalized = normalizeText(value).trim();

  const numberMatch = normalized.match(/\b(\d+)\b/);
  if (numberMatch) {
    return Number(numberMatch[1]);
  }

  const quantityMap: Record<string, number> = {
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

const parseNumericValue = (value: string) => {
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

  const valueNumber = Number(normalizedNumber);
  return Number.isFinite(valueNumber) && valueNumber > 0 ? valueNumber : null;
};

const parsePrice = (value: string) => {
  const normalized = String(value ?? '').toLowerCase();
  const moneyMatch = normalized.match(
    /(?:valen?|vale|cuestan|cuesta|sale|precio|a|por)\s*\$?\s*([0-9]+(?:[.,][0-9]{3})*(?:[.,][0-9]+)?)\s*(?:c\/u|c\.u\.|pesos|\$)?/i,
  );

  if (!moneyMatch || moneyMatch.index === undefined) {
    return null;
  }

  const fullMatch = moneyMatch[0];
  const window = normalized.slice(Math.max(0, moneyMatch.index - 2), moneyMatch.index + fullMatch.length + 12);
  if (/(?:por|de|a)\s*\$?\s*[0-9]+(?:[.,][0-9]+)?\s*(?:g|gr|gramos?|kg|kilos?|ml|lts?|litros?|cm|mm)\b/i.test(window)) {
    return null;
  }

  if (/\bpor\s+[0-9]/i.test(fullMatch) && !/[\$]|c\/u|c\.u\.|pesos|vale|precio|cuestan?/i.test(fullMatch)) {
    const after = normalized.slice(moneyMatch.index + fullMatch.length, moneyMatch.index + fullMatch.length + 16);
    if (/^\s*(?:g|gr|gramos?|kg|kilos?|ml|lts?|litros?|unidades?|u\.?\b)/i.test(after)) {
      return null;
    }
  }

  return parseNumericValue(moneyMatch[1]);
};

const applyPriceFromText = (actions: ParsedActionUnion[], text: string) => {
  const price = parsePrice(text);
  if (price === null || !Number.isFinite(price)) {
    return;
  }

  for (const action of actions) {
    if ((action.type === 'add_stock' || action.type === 'sell') && !Number.isFinite(action.price ?? NaN)) {
      action.price = price;
    }
  }
};

const splitReservationTarget = (value: string, lastProductName?: string) => {
  const paraMatch = value.match(/^(.+?)\s+para\s+(.+)$/i);

  if (paraMatch) {
    return {
      productName: paraMatch[1]!.trim(),
      clientName: paraMatch[2]!.trim(),
    };
  }

  const alMatch = value.match(/^al\s+(.+)$/i);

  if (alMatch) {
    return {
      productName: lastProductName?.trim() ?? value.trim(),
      clientName: alMatch[1]!.trim(),
    };
  }

  return {
    productName: value.trim(),
    clientName: undefined as string | undefined,
  };
};

const splitCompoundText = (value: string) =>
  value
    .split(/\s*(?:,|\by\b|\.\s*|;|\n)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

const extractMultipleActionsFromText = (text: string): ParsedActionUnion[] => {
  const normalized = normalizeText(text);
  const fullLine = normalized.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const queryPedidosAction = tryParseQueryPedidosAction(fullLine);
  if (queryPedidosAction) {
    return [queryPedidosAction];
  }

  const fragments = splitCompoundText(normalized);
  const actions: ParsedActionUnion[] = [];
  let lastProductName: string | undefined;

  for (const fragment of fragments) {
    const paymentMatch = fragment.match(/^(.+?)\s+me\s+pag(?:o|ó)\s+(\d+)\s*(mil)?$/u);
    if (paymentMatch) {
      const clientName = paymentMatch[1]!.trim();
      const amountBase = Number(paymentMatch[2]);
      if (amountBase <= 0) {
        continue;
      }

      const amount = paymentMatch[3] ? amountBase * 1000 : amountBase;
      actions.push({ type: 'payment_received', clientName, amount } as ParsedActionUnion);
      continue;
    }

    const duePaymentMatch = fragment.match(/^(.+?)\s+me\s+tiene\s+que\s+pagar\s+las?\s+(\d+)\s+(.+)$/u);
    if (duePaymentMatch) {
      const clientName = duePaymentMatch[1]!.trim();
      const qty = parseQuantity(duePaymentMatch[2]);
      const productRaw = duePaymentMatch[3]!.trim();

      if (!qty || qty <= 0) {
        continue;
      }

      const productName = productRaw
        .split(/\s+/)
        .map((s) => s[0]?.toUpperCase() + s.slice(1))
        .join(' ');

      actions.push({
        type: 'add_debt',
        clientName,
        productName,
        qty,
        amount: 0,
      } as ParsedActionUnion);
      continue;
    }

    const orderMatch = fragment.match(/^(.+?)\s+(?:me\s+)?(?:pidio|pidió|pide|quiere|encargo|encargó|encargaron)\s+(.+)$/u);
    if (orderMatch) {
      const clientName = orderMatch[1]!.trim();
      const rest = orderMatch[2]!.trim();
      const qty = parseQuantity(rest) ?? 1;
      const productText = rest.replace(/^(?:una?|unos?|unas?|\d+)\s+/i, '').trim();
      const productDescriptor = parseProductDescriptor(productText);

      if (clientName && productDescriptor.productName) {
        actions.push({
          type: 'client_order',
          clientName,
          productName: productDescriptor.productName,
          productType: productDescriptor.productType,
          productModel: productDescriptor.productModel,
          size: productDescriptor.size,
          qty,
        });
      }
      continue;
    }

    const buyMatch = fragment.match(
      /\b(?:compre|compré|compra(?:r|ste|ron)?|adquiri|adquirí|entraron|entran|llegaron|recibi|recibieron|recibí|ingreso|ingrese|ingresaron)\s+(?:(\d+)\s+)?(.+)$/u,
    );
    if (buyMatch) {
      const qty = buyMatch[1] ? Number(buyMatch[1]) : parseQuantity(buyMatch[2]!) ?? 1;
      if (qty <= 0) {
        continue;
      }

      const productText = buyMatch[2]!
        .replace(/^(?:una?|unos?|unas?|\d+)\s+/i, '')
        .replace(new RegExp(`\\ben\\s+(?:${VARIANT_KEYWORD_ALT})\\b`, 'gi'), 'talle')
        .trim();
      const productDescriptor = parseProductDescriptor(productText);
      if (!productDescriptor.productName) {
        continue;
      }

      actions.push({
        type: 'add_stock',
        productName: productDescriptor.productName,
        productType: productDescriptor.productType,
        productModel: productDescriptor.productModel,
        size: productDescriptor.size,
        qty,
      });
      lastProductName = productDescriptor.productName;
      continue;
    }

    const reserveMatch = fragment.match(/\b(?:les deje|les dejé|deje|dejé|reserve|reservé|reservaron)\s+(\d+)\s+(.+)$/u);
    if (reserveMatch) {
      const qty = Number(reserveMatch[1]);
      if (qty <= 0) {
        continue;
      }

      const targetRaw = reserveMatch[2].trim();
      const reservationTarget = splitReservationTarget(targetRaw, lastProductName);
      const productDescriptor = parseProductDescriptor(reservationTarget.productName);
      const resolvedProductName = reservationTarget.productName === targetRaw.trim() && lastProductName ? lastProductName : productDescriptor.productName;
      actions.push({
        type: 'reserve_stock',
        productName: resolvedProductName,
        productType: productDescriptor.productType,
        productModel: productDescriptor.productModel,
        size: productDescriptor.size,
        clientName: reservationTarget.clientName,
        qty,
      });
      continue;
    }

    const sellMatch = fragment.match(/\b(?:vend(?:i|í)o|vendiste|vendieron|vendi)\s+(\d+)\s+(.+)$/u);
    if (sellMatch) {
      const qty = Number(sellMatch[1]);
      if (qty <= 0) {
        continue;
      }

      const productDescriptor = parseProductDescriptor(sellMatch[2].trim());
      actions.push({
        type: 'sell',
        productName: productDescriptor.productName,
        productType: productDescriptor.productType,
        productModel: productDescriptor.productModel,
        size: productDescriptor.size,
        qty,
      } as ParsedActionUnion);
      continue;
    }
  }

  return actions;
};

const inferIntent = (actions: ParsedActionUnion[]): VoiceIntent => {
  if (actions.length === 0) {
    return 'unknown';
  }

  const uniqueTypes = new Set(actions.map((action) => action.type));

  if (uniqueTypes.size > 1) {
    return 'mixed';
  }

  return actions[0]!.type;
};

const buildPayload = (
  sourceText: string,
  actions: ParsedActionUnion[],
  options: Partial<Pick<ParsedVoicePayload, 'confidence' | 'requiresConfirmation' | 'missingFields' | 'suggestedPhrases' | 'intent'>> = {},
): ParsedVoicePayload => {
  const allReadOnly =
    actions.length > 0 && actions.every((action) => action.type === 'query_stock' || action.type === 'query_pedidos');

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parseAction = (value: unknown): ParsedActionUnion | null => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }

  const qty = typeof value.qty === 'number' ? value.qty : Number(value.qty);
  const amount = typeof value.amount === 'number' ? value.amount : Number(value.amount);

  if (value.type === 'add_stock' || value.type === 'reserve_stock' || value.type === 'sell') {
    const productType = typeof value.productType === 'string' ? value.productType : undefined;
    const productModel = typeof value.productModel === 'string' ? value.productModel : undefined;
    const size = typeof value.size === 'string' ? value.size : undefined;
    const productName = typeof value.productName === 'string' ? value.productName : composeProductName({ productType, productModel, size });
    const price = typeof value.price === 'number' ? value.price : Number(value.price);

    if (!productName || Number.isNaN(qty) || qty <= 0) {
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

  if (value.type === 'add_debt') {
    if (typeof value.clientName !== 'string' || Number.isNaN(amount)) {
      return null;
    }

    return {
      type: 'add_debt',
      clientName: value.clientName,
      amount,
      productName: typeof value.productName === 'string' ? value.productName : undefined,
      productType: typeof value.productType === 'string' ? value.productType : undefined,
      productModel: typeof value.productModel === 'string' ? value.productModel : undefined,
      size: typeof value.size === 'string' ? value.size : undefined,
      qty: typeof value.qty === 'number' && !Number.isNaN(value.qty) ? value.qty : undefined,
    };
  }

  if (value.type === 'payment_received') {
    if (typeof value.clientName !== 'string' || Number.isNaN(amount) || amount <= 0) {
      return null;
    }

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
    const orderQty = Number.isNaN(qty) || qty <= 0 ? 1 : qty;
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
    const estado =
      estadoRaw === 'pendiente' || estadoRaw === 'conseguido' || estadoRaw === 'descartado' || estadoRaw === 'todos'
        ? estadoRaw
        : 'pendiente';
    return {
      type: 'query_pedidos',
      estado,
      ...(typeof value.clientName === 'string' && value.clientName.trim() ? { clientName: value.clientName.trim() } : {}),
      ...(typeof value.proveedorName === 'string' && value.proveedorName.trim()
        ? { proveedorName: value.proveedorName.trim() }
        : {}),
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
      ...(hasPrice ? { price: priceValue } : {}),
      ...(hasStock ? { stockAvailable: Math.trunc(stockValue) } : {}),
    };
  }

  if (value.type === 'update_pedido' && typeof value.productName === 'string' && value.productName.trim()) {
    const estado = typeof value.estado === 'string' ? value.estado.trim().toLowerCase() : undefined;
    const validEstado = estado === 'pendiente' || estado === 'conseguido' || estado === 'descartado' ? estado : undefined;
    const orderQty = Number.isNaN(qty) || qty <= 0 ? undefined : qty;
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
    };
  }

  if (value.type === 'delete_pedido' && typeof value.productName === 'string' && value.productName.trim()) {
    return { type: 'delete_pedido', productName: value.productName.trim() };
  }

  if (value.type === 'delete_product' && typeof value.productName === 'string' && value.productName.trim()) {
    return { type: 'delete_product', productName: value.productName.trim() };
  }

  return null;
};

export class VoiceParserService {
  parse(text: string): ParsedVoicePayload {
    const normalized = normalizeText(text);
    const fullLine = normalized.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    const queryPedidosAction = tryParseQueryPedidosAction(fullLine);
    if (queryPedidosAction) {
      return buildPayload(text, [queryPedidosAction], {
        intent: 'query_pedidos',
        requiresConfirmation: false,
      });
    }
    const queryStockAction = tryParseQueryStockAction(fullLine);
    if (queryStockAction) {
      return buildPayload(text, [queryStockAction], {
        intent: 'query_stock',
        requiresConfirmation: false,
      });
    }

    // Generic patterns: operation + cantidad + producto
    const patterns: { regex: RegExp; type: ParsedAction['type'] | 'sell' | 'payment_received' }[] = [
      {
        regex:
          /\b(?:compre|compré|compra(?:r|ste|ron)?|adquiri|adquiri|entraron|entran|llegaron|recibi|recibieron|recibí|ingreso|ingrese|ingresaron)\s+(?:(\d+)\s+)?(.+)$/u,
        type: 'add_stock',
      },
      { regex: /\b(?:vend(?:i|í)o|vendiste|vendieron|vendi)\s+(\d+)\s+(.+)$/u, type: 'sell' },
      { regex: /\b(?:reserve|reservé|reservaron|le deje|deje|dejó)\s+(\d+)\s+(.+)$/u, type: 'reserve_stock' },
    ];

    const actions: import('../domain/types').ParsedActionUnion[] = [];
    const suggested: string[] = [];

    let lastProductName: string | undefined;
    let inPedidoList = /^(?:pedido\s*:|tengo que (?:hacer un )?pedido\b|tengo que (?:pedir|encargar)\b|necesito (?:pedir|encargar)\b|hay que (?:pedir|encargar)\b)/i.test(
      normalized.trim(),
    );

    const parseQtyAndProductText = (value: string) => {
      const raw = value.replace(/\s+/g, ' ').trim();
      if (!raw) {
        return null;
      }

      const cantidadMatch = raw.match(/^(.*?)\s+cantidad\s+(\d+)\s*$/i);
      if (cantidadMatch) {
        const productText = cantidadMatch[1]!.trim();
        const qty = Number(cantidadMatch[2]);
        if (productText && qty > 0) {
          return { productText, qty };
        }
      }

      const leadingQtyMatch = raw.match(/^(\d+)\s+(.+)$/);
      if (leadingQtyMatch) {
        const qty = Number(leadingQtyMatch[1]);
        const productText = leadingQtyMatch[2]!.trim();
        if (productText && qty > 0) {
          return { productText, qty };
        }
      }

      const qty = parseQuantity(raw) ?? 1;
      const productText = raw
        .replace(/^(?:una?|unos?|unas?|\d+)\s+/i, '')
        .replace(/\s+cantidad\s+\d+\s*$/i, '')
        .trim();

      return productText ? { productText, qty } : null;
    };

    const pushPedido = (productText: string, qty: number, clientName?: string, proveedorName?: string) => {
      const productDescriptor = parseProductDescriptor(productText);
      if (!productDescriptor.productName) {
        return;
      }
      const normalizedClient = clientName?.trim();
      const normalizedProveedor = proveedorName?.trim();
      actions.push({
        type: 'client_order',
        ...(normalizedClient ? { clientName: normalizedClient } : {}),
        ...(normalizedProveedor ? { proveedorName: normalizedProveedor } : {}),
        productName: productDescriptor.productName,
        productType: productDescriptor.productType,
        productModel: productDescriptor.productModel,
        size: productDescriptor.size,
        qty,
      });
      suggested.push(
        `${qty} ${productDescriptor.productName}`,
      );
    };

    for (const fragment of splitCompoundText(normalized)) {
      const proveedorPedidoMatch = fragment.match(
        /^(?:pedido|pedidos)\s+(?:del?|al?|para(?:\s+el)?)\s+proveedor\s+(.+?)\s*:\s*(.+)$/i,
      );
      if (proveedorPedidoMatch) {
        const proveedorName = proveedorPedidoMatch[1]!.trim();
        const parsed = parseQtyAndProductText(proveedorPedidoMatch[2]!.trim());
        if (proveedorName && parsed) {
          pushPedido(parsed.productText, parsed.qty, undefined, proveedorName);
        }
        continue;
      }

      const proveedorEncargarMatch = fragment.match(
        /^(?:pedir|encargar|pedido)\s+(?:a|al|del)\s+proveedor\s+(.+?)\s+(.+)$/i,
      );
      if (proveedorEncargarMatch) {
        const proveedorName = proveedorEncargarMatch[1]!.trim();
        const parsed = parseQtyAndProductText(proveedorEncargarMatch[2]!.trim());
        if (proveedorName && parsed) {
          pushPedido(parsed.productText, parsed.qty, undefined, proveedorName);
        }
        continue;
      }

      const orderMatch = fragment.match(/^(.+?)\s+(?:me\s+)?(?:pidio|pidió|pide|quiere|encargo|encargó|encargaron)\s+(.+)$/u);
      if (orderMatch) {
        const clientName = orderMatch[1]!.trim();
        if (!/^(?:pedido|pedidos)$/i.test(clientName)) {
          const parsed = parseQtyAndProductText(orderMatch[2]!.trim());
          if (clientName && parsed) {
            pushPedido(parsed.productText, parsed.qty, clientName);
          }
          continue;
        }
      }

      const pedidoPrefix = fragment.match(
        /^(?:pedido\s*:?\s*|tengo que (?:hacer un )?pedido (?:de\s+)?|tengo que (?:pedir|encargar)\s+|necesito (?:pedir|encargar)\s+|hay que (?:pedir|encargar)\s+)(.+)$/i,
      );
      if (pedidoPrefix) {
        inPedidoList = true;
        const rest = pedidoPrefix[1]!.trim();
        const proveedorInline = rest.match(/^(?:del?|al?|para(?:\s+el)?)\s+proveedor\s+(.+?)\s*:\s*(.+)$/i);
        if (proveedorInline) {
          const parsed = parseQtyAndProductText(proveedorInline[2]!.trim());
          if (parsed) {
            pushPedido(parsed.productText, parsed.qty, undefined, proveedorInline[1]!.trim());
          }
          continue;
        }
        const parsed = parseQtyAndProductText(rest);
        if (parsed) {
          pushPedido(parsed.productText, parsed.qty);
        }
        continue;
      }

      if (inPedidoList) {
        const parsed = parseQtyAndProductText(fragment);
        if (parsed && !/\b(?:compre|compré|vendi|vendí|reserve|reservé|ingreso)\b/i.test(parsed.productText)) {
          pushPedido(parsed.productText, parsed.qty);
          continue;
        }
      }

      for (const p of patterns) {
        const m = fragment.match(p.regex);
        if (!m) {
          continue;
        }

        const qty = m[1] ? Number(m[1]) : parseQuantity(m[2]!.trim()) ?? 1;
        const productRaw = m[2]!
          .replace(/^(?:una?|unos?|unas?|\d+)\s+/i, '')
          .replace(new RegExp(`\\ben\\s+(?:${VARIANT_KEYWORD_ALT})\\b`, 'gi'), 'talle')
          .trim();
        const productName = productRaw
          .split(/\s+/)
          .map((s) => s[0]?.toUpperCase() + s.slice(1))
          .join(' ');

        if (qty <= 0 || !productName) {
          continue;
        }

        if (p.type === 'add_stock') {
          const price = parsePrice(productRaw) ?? parsePrice(fragment);
          actions.push({ type: 'add_stock', productName, qty, price: price ?? undefined });
          lastProductName = productName;
          suggested.push(`compré ${qty} ${productRaw}`);
        } else if (p.type === 'reserve_stock') {
          const reservationTarget = splitReservationTarget(productRaw, lastProductName);
          const resolvedProductName = reservationTarget.productName === productRaw.trim() && lastProductName ? lastProductName : reservationTarget.productName;
          actions.push({
            type: 'reserve_stock',
            productName: resolvedProductName,
            clientName: reservationTarget.clientName,
            qty,
          });
          suggested.push(
            reservationTarget.clientName
              ? `reservé ${qty} ${resolvedProductName} para ${reservationTarget.clientName}`
              : `reservé ${qty} ${resolvedProductName}`,
          );
        } else if (p.type === 'sell') {
          const price = parsePrice(productRaw) ?? parsePrice(fragment);
          // @ts-ignore - cast to any to satisfy return type
          actions.push({ type: 'sell', productName, qty, price: price ?? undefined } as any);
          suggested.push(`vendí ${qty} ${productRaw}`);
        }

        break;
      }
    }

    return buildPayload(text, actions, {
      suggestedPhrases: suggested.length ? suggested : undefined,
    });
  }

  parseModelJson(rawResponse: string): ParsedVoicePayload | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawResponse);
    } catch {
      return null;
    }

    if (!isRecord(parsed)) {
      return null;
    }

    const sourceText = typeof parsed.sourceText === 'string' ? parsed.sourceText : rawResponse;
    const actions = Array.isArray(parsed.actions) ? parsed.actions.map(parseAction).filter((action): action is ParsedActionUnion => action !== null) : [];
    const normalizedActions = actions.length ? actions : extractMultipleActionsFromText(sourceText);
    applyPriceFromText(normalizedActions, sourceText);

    if (!normalizedActions.length) {
      return null;
    }

    const suggestedPhrases = Array.isArray(parsed.suggestedPhrases)
      ? parsed.suggestedPhrases.filter((value): value is string => typeof value === 'string')
      : undefined;

    const missingFields = Array.isArray(parsed.missingFields)
      ? parsed.missingFields.filter((value): value is string => typeof value === 'string')
      : undefined;

    const intent = typeof parsed.intent === 'string' ? (parsed.intent as VoiceIntent) : undefined;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;
    const requiresConfirmation = typeof parsed.requiresConfirmation === 'boolean' ? parsed.requiresConfirmation : undefined;

    return buildPayload(sourceText, normalizedActions, {
      intent,
      confidence,
      requiresConfirmation,
      missingFields,
      suggestedPhrases,
    });
  }
}

export const voiceParserService = new VoiceParserService();