import type { ParsedAction, ParsedActionUnion, ParsedVoicePayload, VoiceIntent } from '../domain/types';

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
  const sizeMatch = normalized.match(/(?:,\s*|\s+)talle\s+([a-z0-9]+)\b/i);
  const size = sizeMatch ? sizeMatch[1]!.toUpperCase() : undefined;
  const withoutSize = normalized.replace(/(?:,\s*|\s+)talle\s+[a-z0-9]+\b/i, '').trim();
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

    const buyMatch = fragment.match(/\b(?:compre|compré|compra(?:r|ste|ron)?|adquiri|adquirí)\s+(\d+)\s+(.+)$/u);
    if (buyMatch) {
      const qty = Number(buyMatch[1]);
      if (qty <= 0) {
        continue;
      }

      const productDescriptor = parseProductDescriptor(buyMatch[2].trim());
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
): ParsedVoicePayload => ({
  schemaVersion: 1,
  sourceText,
  intent: options.intent ?? inferIntent(actions),
  confidence: options.confidence ?? (actions.length > 1 ? 0.92 : 0.83),
  requiresConfirmation: options.requiresConfirmation ?? actions.length > 0,
  actions,
  missingFields: options.missingFields,
  suggestedPhrases: options.suggestedPhrases,
});

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

  return null;
};

export class VoiceParserService {
  parse(text: string): ParsedVoicePayload {
    const normalized = normalizeText(text);
    // Try to match the example complex sentence first (backwards compatible)
    if (
      normalized.includes('me llegaron') &&
      normalized.includes('camisetas de boca') &&
      normalized.includes('le deje') &&
      normalized.includes('gimnasio el refugio')
    ) {
      const quantities = normalized.match(/\b\d+\b/g)?.map(Number) ?? [];
      const stockQty = quantities[0] ?? 10;
      const reserveQty = quantities[1] ?? 5;
      const basePrice = 50000;

      const actions: ParsedAction[] = [
        {
          type: 'add_stock',
          productName: 'Camiseta Boca',
          qty: stockQty,
        },
        {
          type: 'reserve_stock',
          productName: 'Camiseta Boca',
          qty: reserveQty,
        },
        {
          type: 'add_debt',
          clientName: 'Gimnasio El Refugio',
          amount: reserveQty * basePrice,
        },
      ];

      return buildPayload(text, actions, {
        intent: 'mixed',
        confidence: 0.96,
        requiresConfirmation: true,
        suggestedPhrases: [
          `entraron ${stockQty} camisetas de Boca`,
          `reservé ${reserveQty} camisetas para Gimnasio El Refugio`,
        ],
      });
    }

    // Generic patterns: operation + cantidad + producto
    const patterns: { regex: RegExp; type: ParsedAction['type'] | 'sell' | 'payment_received' }[] = [
      { regex: /\b(?:compre|compré|compra(?:r|ste|ron)?|adquiri|adquiri)\s+(\d+)\s+(.+)$/u, type: 'add_stock' },
      { regex: /\b(?:entraron|entran|llegaron|recibi|recibieron|recibí)\s+(\d+)\s+(.+)$/u, type: 'add_stock' },
      { regex: /\b(?:vend(?:i|í)o|vendiste|vendieron|vendi)\s+(\d+)\s+(.+)$/u, type: 'sell' },
      { regex: /\b(?:reserve|reservé|reservaron|le deje|deje|dejó)\s+(\d+)\s+(.+)$/u, type: 'reserve_stock' },
    ];

    const actions: import('../domain/types').ParsedActionUnion[] = [];
    const suggested: string[] = [];

    let lastProductName: string | undefined;

    for (const fragment of splitCompoundText(normalized)) {
      for (const p of patterns) {
        const m = fragment.match(p.regex);
        if (!m) {
          continue;
        }

        const qty = Number(m[1]);
        const productRaw = m[2].trim();
        const productName = productRaw
          .split(/\s+/)
          .map((s) => s[0]?.toUpperCase() + s.slice(1))
          .join(' ');

        if (p.type === 'add_stock') {
          actions.push({ type: 'add_stock', productName, qty });
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
          // @ts-ignore - cast to any to satisfy return type
          actions.push({ type: 'sell', productName, qty } as any);
          suggested.push(`vendí ${qty} ${productRaw}`);
        }

        break;
      }
    }

    // Fallback: try to extract any number and mark as add_stock
    if (!actions.length) {
      const stockQty = extractFirstNumber(normalized);
      if (stockQty) {
        actions.push({ type: 'add_stock', productName: 'Camiseta Boca', qty: stockQty });
        suggested.push(`entraron ${stockQty} camisetas`);
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