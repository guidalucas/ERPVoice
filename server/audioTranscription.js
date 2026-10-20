// Server-only boundary: provider credentials and raw audio never belong in the browser.
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 12000;
export const TRANSCRIPTION_TIMEOUT_MS = 45000;

const DEFAULT_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3-turbo';
const AUDIO_EXTENSIONS = Object.freeze({
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
});

export class TranscriptionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TranscriptionError';
    this.status = status;
    this.code = code;
  }
}

export function normalizeAudioContentType(contentType) {
  const mime = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  if (!Object.hasOwn(AUDIO_EXTENSIONS, mime)) {
    throw new TranscriptionError(415, 'unsupported_audio_type', 'Formato de audio no admitido.');
  }
  return mime;
}

function configuration(env) {
  const key = String(env.VOICE_TRANSCRIPTION_API_KEY || env.GROQ_API_KEY || '').trim();
  if (!key) {
    throw new TranscriptionError(503, 'transcription_not_configured', 'La transcripción de audio no está configurada.');
  }
  const endpoint = String(env.VOICE_TRANSCRIPTION_ENDPOINT || DEFAULT_ENDPOINT).trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new TranscriptionError(503, 'transcription_not_configured', 'La transcripción de audio no está configurada.');
  }
  const model = String(env.VOICE_TRANSCRIPTION_MODEL || DEFAULT_MODEL).trim();
  if (!model) {
    throw new TranscriptionError(503, 'transcription_not_configured', 'La transcripción de audio no está configurada.');
  }
  return { key, endpoint, model };
}

/**
 * Transcribe bytes without interpreting or executing their contents.
 * options is an internal dependency seam; callers must never copy request data into it.
 */
export async function transcribeAudio(input, options = {}) {
  const audio = input?.audio;
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
    throw new TranscriptionError(400, 'empty_audio', 'Se requiere un audio no vacío.');
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new TranscriptionError(413, 'audio_too_large', 'El audio supera el tamaño máximo permitido.');
  }
  const contentType = normalizeAudioContentType(input.contentType);
  const { key, endpoint, model } = configuration(options.env ?? process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : TRANSCRIPTION_TIMEOUT_MS;
  let timer;
  try {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: contentType }), `audio.${AUDIO_EXTENSIONS[contentType]}`);
    form.append('model', model);
    form.append('language', 'es');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('prompt', 'Transcribe fielmente el audio en español, conservando las palabras, nombres y números que se escuchan.');

    const request = async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new TranscriptionError(502, 'transcription_provider_error', 'No se pudo transcribir el audio.');
      }
      let result;
      try {
        result = await response.json();
      } catch {
        throw new TranscriptionError(502, 'invalid_transcription_response', 'El servicio de transcripción devolvió una respuesta inválida.');
      }
      const text = typeof result?.text === 'string' ? result.text.trim() : '';
      if (!text || text.length > MAX_TRANSCRIPT_CHARS) {
        throw new TranscriptionError(502, 'invalid_transcription_response', 'El servicio de transcripción devolvió una respuesta inválida.');
      }
      return { text };
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new TranscriptionError(504, 'transcription_timeout', 'La transcripción de audio tardó demasiado.'));
        controller.abort();
      }, timeoutMs);
    });
    return await Promise.race([request(), timeout]);
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    throw new TranscriptionError(502, 'transcription_provider_error', 'No se pudo transcribir el audio.');
  } finally {
    clearTimeout(timer);
  }
}
