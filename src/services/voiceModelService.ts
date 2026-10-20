import { requestJson } from './apiClient';

export class VoiceModelService {
  async transcribeAudio(audioBlob: Blob): Promise<string> {
    const result = await requestJson<{ text: string }>('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': audioBlob.type || 'audio/webm' },
      body: audioBlob,
    });
    if (typeof result?.text !== 'string' || !result.text.trim()) {
      throw Object.assign(new Error('No pude transcribir el audio. Probá de nuevo.'), { code: 'TRANSCRIPTION_INVALID' });
    }
    return result.text.trim();
  }
}

export const voiceModelService = new VoiceModelService();
