import { getWhatsAppVariants } from './phone.js';

const DEFAULT_MODEL_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_META_GRAPH_API_VERSION = 'v21.0';

const buildPrompt = (text) => `
Sos un analista de operaciones para un ERP de stock y cuentas corrientes.
Convertí la frase del usuario en un JSON válido con esta estructura exacta:
{
  "schemaVersion": 1,
  "sourceText": string,
  "intent": "add_stock" | "reserve_stock" | "sell" | "add_debt" | "payment_received" | "mixed" | "unknown",
  "confidence": number,
  "requiresConfirmation": boolean,
  "actions": [
    { "type": "add_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "price"?: number },
    { "type": "reserve_stock", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "clientName"?: string },
    { "type": "sell", "productType"?: string, "productModel"?: string, "size"?: string, "productName": string, "qty": number, "price"?: number },
    { "type": "add_debt", "clientName": string, "amount": number, "productType"?: string, "productModel"?: string, "size"?: string, "productName"?: string, "qty"?: number }
    { "type": "payment_received", "clientName": string, "amount": number }
  ],
  "missingFields"?: string[],
  "suggestedPhrases"?: string[]
}

Reglas:
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
- Si la frase incluye prenda, modelo y talle, separá productType, productModel y size. Ejemplo: "3 camisetas de boca titular, talle M" -> productType: "Camiseta", productModel: "Boca Titular", size: "M", productName: "Camiseta Boca Titular M".
- Si una frase tiene dos movimientos, devolvé dos objetos en actions.
- Ejemplo: "compre 20 camisetas de argentina, les deje 3 al gimnasio" -> [{"type":"add_stock","productName":"camisetas de argentina","qty":20},{"type":"reserve_stock","productName":"camisetas de argentina","qty":3,"clientName":"gimnasio"}].

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
  const sizeMatch = normalized.match(/(?:,\s*|\s+)talle\s+([a-z0-9]+)\b/i);
  const size = sizeMatch ? sizeMatch[1].toUpperCase() : undefined;
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

const parsePrice = (value) => {
  const normalized = String(value ?? '').replace(/[.,]/g, '').trim();
  const match = normalized.match(/(?:valen?|vale|a|por|precio)\s*\$?\s*([0-9]+)/i);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
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

const buildPayload = (sourceText, actions, options = {}) => ({
  schemaVersion: 1,
  sourceText,
  intent: options.intent ?? inferIntent(actions),
  confidence: options.confidence ?? (actions.length > 1 ? 0.92 : 0.83),
  requiresConfirmation: options.requiresConfirmation ?? actions.length > 0,
  actions,
  missingFields: options.missingFields,
  suggestedPhrases: options.suggestedPhrases,
});

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

  return null;
};

const extractMultipleActionsFromText = (text) => {
  const normalized = normalizeText(text);
  const fragments = splitCompoundText(normalized);
  const actions = [];
  let lastProductName;

  for (const fragment of fragments) {
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

    const addStockMatch = fragment.match(/\b(?:compre|compré|compra(?:r|ste|ron)?|adquiri|adquirí|entraron|entran|llegaron|recibi|recibieron|recibí)\s+(\d+)\s+(.+)$/u);
    if (addStockMatch) {
      const qty = Number(addStockMatch[1]);
      if (qty > 0) {
        const rawProductText = addStockMatch[2].trim();
        const price = parsePrice(rawProductText) ?? parsePrice(fragment);
        const cleanedProductText = rawProductText.replace(/\s*(?:valen?|vale|a|por|precio)\s*\$?\s*[0-9]+(?:[.,][0-9]{3})*\s*$/i, '').trim();
        const productDescriptor = parseProductDescriptor(cleanedProductText);
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
      continue;
    }

    const reserveMatch = fragment.match(/\b(?:les deje|les dejé|deje|dejé|reserve|reservé|reservaron)\s+(\d+)\s+(.+)$/u);
    if (reserveMatch) {
      const qty = Number(reserveMatch[1]);
      if (qty > 0) {
        const targetRaw = reserveMatch[2].trim();
        const reservationTarget = splitReservationTarget(targetRaw, lastProductName);
        const productDescriptor = parseProductDescriptor(reservationTarget.productName);
        actions.push({
          type: 'reserve_stock',
          productName: reservationTarget.productName === targetRaw && lastProductName ? lastProductName : productDescriptor.productName,
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
      const qty = Number(sellMatch[1]);
      if (qty > 0) {
        const productDescriptor = parseProductDescriptor(sellMatch[2].trim());
        actions.push({
          type: 'sell',
          productName: productDescriptor.productName,
          productType: productDescriptor.productType,
          productModel: productDescriptor.productModel,
          size: productDescriptor.size,
          qty,
        });
      }
    }
  }

  return actions;
};

const parseLocalText = (text) => {
  const actions = extractMultipleActionsFromText(text);
  if (!actions.length) {
    return null;
  }

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

const parseVoiceTextWithModel = async (text) => {
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
        content: buildPrompt(text),
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
    const normalizedActionsWithFallbackPrice = normalizedActions.map((action) => {
      if ((action.type === 'add_stock' || action.type === 'sell') && action.price === undefined && Number.isFinite(inferredPrice) && inferredPrice > 0) {
        return { ...action, price: inferredPrice };
      }
      return action;
    });

    if (!normalizedActionsWithFallbackPrice.length) {
      return parseLocalText(text);
    }

    return buildPayload(sourceText, normalizedActionsWithFallbackPrice, {
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

const formatAction = (action) => {
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

  return `+$${action.amount.toLocaleString('es-AR')} en cuenta de ${action.clientName}`;
};

const buildReplyText = ({ transcript, parsed }) => {
  if (!parsed?.actions?.length) {
    return transcript
      ? `Recibí tu audio, pero no pude detectar una acción clara. Texto: ${transcript}`
      : 'Recibí tu mensaje, pero no pude detectar una acción clara.';
  }

  const actionSummary = parsed.actions.map(formatAction).join(' | ');

  return transcript
    ? `Recibí tu audio. Detecté: ${actionSummary}. Texto: ${transcript}`
    : `Recibí tu mensaje. Detecté: ${actionSummary}.`;
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

const processMetaMessage = async (metaMessage) => {
  if (metaMessage.messageType === 'audio' && metaMessage.audioId) {
    const transcript = await transcribeMetaAudioId(metaMessage.audioId);
    const parsed = await parseVoiceTextWithModel(transcript);

    return {
      ...metaMessage,
      kind: 'audio',
      sourceText: transcript,
      transcript,
      parsed,
      replyText: buildReplyText({ transcript, parsed }),
    };
  }

  if (metaMessage.textBody) {
    const parsed = await parseVoiceTextWithModel(metaMessage.textBody);

    return {
      ...metaMessage,
      kind: 'text',
      sourceText: metaMessage.textBody,
      transcript: null,
      parsed,
      replyText: buildReplyText({ transcript: null, parsed }),
    };
  }

  return {
    ...metaMessage,
    kind: 'empty',
    sourceText: '',
    transcript: null,
    parsed: null,
    replyText: 'Recibí el mensaje, pero no encontré texto ni audio para procesar.',
  };
};

export const processMetaWebhook = async (body) => {
  if (!body || body.object !== 'whatsapp_business_account') {
    return [];
  }

  const incomingMessages = extractMetaMessages(body);
  const results = [];

  for (const message of incomingMessages) {
    results.push(await processMetaMessage(message));
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