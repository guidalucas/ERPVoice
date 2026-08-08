import type { ParsedVoicePayload } from '../domain/types';
import { voiceParserService } from './voiceParserService';

const DEFAULT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

const buildPrompt = (text: string) => `
Sos un analista de operaciones para Stocky, un sistema de stock y pedidos de clientes.
Convertí la frase del usuario en un JSON válido con esta estructura exacta:
{
  "schemaVersion": 1,
  "sourceText": string,
  "intent": "add_stock" | "reserve_stock" | "sell" | "add_debt" | "payment_received" | "client_order" | "mixed" | "unknown",
  "confidence": number,
  "requiresConfirmation": boolean,
  "actions": [
    { "type": "add_stock", "productName": string, "qty": number, "productType"?: string, "productModel"?: string, "size"?: string, "price"?: number },
    { "type": "reserve_stock", "productName": string, "qty": number, "clientName"?: string, "productType"?: string, "productModel"?: string, "size"?: string },
    { "type": "sell", "productName": string, "qty": number, "productType"?: string, "productModel"?: string, "size"?: string, "price"?: number },
    { "type": "add_debt", "clientName": string, "amount": number, "productName"?: string, "qty"?: number },
    { "type": "payment_received", "clientName": string, "amount": number },
    { "type": "client_order", "clientName": string, "productName": string, "qty"?: number, "productType"?: string, "productModel"?: string, "size"?: string }
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
- Si alguien te pide / pidió / quiere / encargó un producto, usá client_order. NO uses reserve_stock ni sell. Un pedido de cliente NO mueve stock.
- Diferenciá: "compré / entraron / llegaron" = add_stock; "me pidió / pidió / quiere / encargó" = client_order.
- Si una frase tiene dos movimientos, devolvé dos objetos en actions.
- Ejemplo: "compre 20 camisetas de argentina, les deje 3 al gimnasio" -> [{"type":"add_stock","productName":"camisetas de argentina","qty":20},{"type":"reserve_stock","productName":"camisetas de argentina","qty":3,"clientName":"gimnasio"}].
- Ejemplo: "Juan me pidió una camiseta de Boca titular talle M" -> [{"type":"client_order","clientName":"Juan","productName":"Camiseta Boca Titular M","productType":"Camiseta","productModel":"Boca Titular","size":"M","qty":1}].

Texto del usuario:
${text}
`;

const readEnv = () => ({
  endpoint: import.meta.env.VITE_VOICE_MODEL_ENDPOINT as string | undefined,
  apiKey: import.meta.env.VITE_VOICE_MODEL_API_KEY as string | undefined,
  model: import.meta.env.VITE_VOICE_MODEL_NAME as string | undefined,
  transcriptionEndpoint: import.meta.env.VITE_VOICE_TRANSCRIPTION_ENDPOINT as string | undefined,
  transcriptionApiKey: (import.meta.env.VITE_VOICE_TRANSCRIPTION_API_KEY || import.meta.env.VITE_VOICE_MODEL_API_KEY) as
    | string
    | undefined,
  transcriptionModel: import.meta.env.VITE_VOICE_TRANSCRIPTION_MODEL as string | undefined,
});

const maskKey = (k?: string) => (k ? `${k.slice(0, 8)}...` : 'none');

const extractContent = (responseData: unknown): string | null => {
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  const data = responseData as Record<string, unknown>;

  const choices = data.choices;
  if (Array.isArray(choices)) {
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (typeof content === 'string') {
      return content;
    }
  }

  const outputText = data.output_text;
  if (typeof outputText === 'string') {
    return outputText;
  }

  return null;
};

const stripCodeFences = (value: string) =>
  value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

export class VoiceModelService {
  async transcribeAudio(audioBlob: Blob): Promise<string | null> {
    const { transcriptionApiKey, transcriptionEndpoint, transcriptionModel } = readEnv();

    if (!transcriptionApiKey) {
      console.log('[VoiceModel] No credentials found, cannot transcribe audio');
      return null;
    }

    const endpoint = transcriptionEndpoint ?? DEFAULT_TRANSCRIPTION_ENDPOINT;
    const formData = new FormData();
    formData.append('file', audioBlob, 'voice.webm');
    formData.append('model', transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL);

    console.log('[VoiceModel] Transcribing audio:', {
      endpoint,
      model: transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL,
      size: audioBlob.size,
      keyPreview: maskKey(transcriptionApiKey),
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${transcriptionApiKey}`,
      },
      body: formData,
    });

    console.log('[VoiceModel] Transcription status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[VoiceModel] Transcription failed with status', response.status);
      console.error('[VoiceModel] Transcription error response:', errorText);
      return null;
    }

    const responseText = await response.text();

    try {
      const parsed = JSON.parse(responseText) as { text?: unknown };

      if (typeof parsed.text === 'string') {
        return parsed.text.trim();
      }
    } catch {
      // fall through to raw text handling
    }

    return responseText.trim() || null;
  }

  async parseVoiceText(text: string): Promise<ParsedVoicePayload> {
    const { endpoint, apiKey, model } = readEnv();

    if (!endpoint || !apiKey) {
      console.log('[VoiceModel] No credentials found, using local parser');
      return voiceParserService.parse(text);
    }

    console.log('[VoiceModel] Calling model:', { endpoint, model, keyPreview: maskKey(apiKey) });
    console.log('[VoiceModel] Input text:', text);

    const requestBody = {
      model: model ?? DEFAULT_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Devolvé únicamente JSON válido para automatizar transacciones de un ERP. No agregues texto explicativo.',
        },
        {
          role: 'user',
          content: buildPrompt(text),
        },
      ],
    };

    console.log('[VoiceModel] Request body:', JSON.stringify(requestBody, null, 2));

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    console.log('[VoiceModel] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[VoiceModel] Request failed with status', response.status);
      console.error('[VoiceModel] Error response:', errorText);
      return voiceParserService.parse(text);
    }

    const data = (await response.json()) as unknown;
    console.log('[VoiceModel] Raw response:', data);

    const content = extractContent(data);

    if (!content) {
      console.warn('[VoiceModel] Could not extract content, falling back to local parser');
      return voiceParserService.parse(text);
    }

    console.log('[VoiceModel] Extracted content:', content);

    const parsed = voiceParserService.parseModelJson(stripCodeFences(content));

    if (!parsed) {
      console.warn('[VoiceModel] Failed to parse JSON, falling back to local parser');
      return voiceParserService.parse(text);
    }

    console.log('[VoiceModel] Successfully parsed model response:', parsed);
    return parsed;
  }
}

export const voiceModelService = new VoiceModelService();