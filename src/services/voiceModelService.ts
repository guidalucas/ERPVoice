import type { ParsedVoicePayload } from '../domain/types';
import { requestJson } from './apiClient';
import { voiceParserService } from './voiceParserService';

const DEFAULT_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

const readEnv = () => ({
  transcriptionEndpoint: import.meta.env.VITE_VOICE_TRANSCRIPTION_ENDPOINT as string | undefined,
  transcriptionApiKey: (import.meta.env.VITE_VOICE_TRANSCRIPTION_API_KEY || import.meta.env.VITE_VOICE_MODEL_API_KEY) as
    | string
    | undefined,
  transcriptionModel: import.meta.env.VITE_VOICE_TRANSCRIPTION_MODEL as string | undefined,
});

const maskKey = (k?: string) => (k ? `${k.slice(0, 8)}...` : 'none');

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
    formData.append('language', 'es');
    formData.append('prompt', 'Transcripción en español rioplatense. Inventario, camisetas, talles, stock, pedidos.');

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
    const trimmed = text.trim();

    try {
      // Same parser path as WhatsApp webhook (server-side model + local fallback).
      const parsed = await requestJson<ParsedVoicePayload>('/api/voice/parse', {
        method: 'POST',
        body: JSON.stringify({ text: trimmed }),
      });

      if (parsed && Array.isArray(parsed.actions)) {
        return parsed;
      }
    } catch (error) {
      console.warn('[VoiceModel] Server parse failed, using local parser', error);
    }

    return voiceParserService.parse(trimmed);
  }
}

export const voiceModelService = new VoiceModelService();
