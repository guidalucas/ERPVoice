const DEFAULT_MODEL_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

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
    { "type": "add_stock", "productName": string, "qty": number },
    { "type": "reserve_stock", "productName": string, "qty": number, "clientName"?: string },
    { "type": "sell", "productName": string, "qty": number },
    { "type": "add_debt", "clientName": string, "amount": number, "productName"?: string, "qty"?: number }
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
- Si la frase dice "para X" en una reserva, separá X como clientName y dejá solo el producto en productName.
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
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
});

const normalizeText = (value) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

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

  if ((value.type === 'add_stock' || value.type === 'reserve_stock' || value.type === 'sell') && typeof value.productName === 'string' && Number.isFinite(qty) && qty > 0) {
    return {
      type: value.type,
      productName: value.productName,
      qty,
      clientName: typeof value.clientName === 'string' ? value.clientName : undefined,
    };
  }

  if (value.type === 'add_debt' && typeof value.clientName === 'string' && Number.isFinite(amount)) {
    return {
      type: 'add_debt',
      clientName: value.clientName,
      amount,
      productName: typeof value.productName === 'string' ? value.productName : undefined,
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
        actions.push({
          type: 'add_stock',
          productName: addStockMatch[2].trim(),
          qty,
        });
        lastProductName = addStockMatch[2].trim();
      }
      continue;
    }

    const reserveMatch = fragment.match(/\b(?:les deje|les dejé|deje|dejé|reserve|reservé|reservaron)\s+(\d+)\s+(.+)$/u);
    if (reserveMatch) {
      const qty = Number(reserveMatch[1]);
      if (qty > 0) {
        const targetRaw = reserveMatch[2].trim();
        const reservationTarget = splitReservationTarget(targetRaw, lastProductName);
        actions.push({
          type: 'reserve_stock',
          productName: reservationTarget.productName === targetRaw && lastProductName ? lastProductName : reservationTarget.productName,
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
        actions.push({
          type: 'sell',
          productName: sellMatch[2].trim(),
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

const transcribeAudioUrl = async (audioUrl) => {
  const { transcriptionApiKey, transcriptionEndpoint, transcriptionModel, twilioAccountSid, twilioAuthToken } = readEnv();

  if (!transcriptionApiKey) {
    throw new Error('Missing transcription API key');
  }

  const mediaHeaders = {};
  if (twilioAccountSid && twilioAuthToken) {
    mediaHeaders.Authorization = `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64')}`;
  }

  const mediaResponse = await fetch(audioUrl, Object.keys(mediaHeaders).length ? { headers: mediaHeaders } : undefined);
  if (!mediaResponse.ok) {
    throw new Error(`Failed to fetch Twilio media: ${mediaResponse.status}`);
  }

  const mediaContentType = mediaResponse.headers.get('content-type') || 'audio/ogg';
  const audioBuffer = await mediaResponse.arrayBuffer();
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: mediaContentType }), 'twilio-media.ogg');
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
    const normalizedActions = actions.length ? actions : extractMultipleActionsFromText(sourceText);

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

export const processTwilioWebhook = async (body) => {
  const numMedia = Number(body.NumMedia ?? 0);
  const audioUrl = body.MediaUrl0;
  const bodyText = typeof body.Body === 'string' ? body.Body.trim() : '';

  if (numMedia > 0 && audioUrl) {
    const transcript = await transcribeAudioUrl(audioUrl);
    const parsed = await parseVoiceTextWithModel(transcript);
    return {
      sourceText: transcript,
      transcript,
      parsed,
      replyText: buildReplyText({ transcript, parsed }),
      kind: 'audio',
    };
  }

  if (bodyText) {
    const parsed = await parseVoiceTextWithModel(bodyText);
    return {
      sourceText: bodyText,
      transcript: null,
      parsed,
      replyText: buildReplyText({ transcript: null, parsed }),
      kind: 'text',
    };
  }

  return {
    sourceText: '',
    transcript: null,
    parsed: null,
    replyText: 'Recibí el mensaje, pero no encontré texto ni audio para procesar.',
    kind: 'empty',
  };
};

export const escapeXml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const buildTwilioXmlResponse = (message) => {
  const trimmedMessage = message.length > 1200 ? `${message.slice(0, 1190)}...` : message;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(trimmedMessage)}</Message></Response>`;
};