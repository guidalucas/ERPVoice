export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'es';
export const TRANSCRIPTION_PROMPT =
  'Transcripción en español rioplatense de inventario, productos, variantes, ingresos, ventas y pedidos.';

export const UNUSABLE_AUDIO_REPLY = 'No entendí el audio. Grabalo de nuevo, más claro y en español.';

export const looksLikeUnusableTranscript = (text) => {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return true;
  }

  if (/[ðþæøÐÞÆØß]/.test(raw)) {
    return true;
  }

  if (/[\u0400-\u04FF\u3040-\u30ff\u3400-\u9fff]/.test(raw)) {
    return true;
  }

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    return false;
  }

  const spanishCue =
    /\b(?:el|la|los|las|de|del|que|me|te|un|una|y|en|con|por|para|es|hay|tengo|tenes|mostrame|mostrar|carga|cargame|vendi|vendiste|vendio|ingreso|ingresaron|entro|entraron|recibi|recibimos|compre|compramos|agrega|agregaron|cuanto|cuantas|stock|talle|numero|nro|medida|variante|pedido|producto|productos|unidades)\b/;
  return !spanishCue.test(normalized);
};

export const appendTranscriptionOptions = (formData, { language, prompt } = {}) => {
  formData.append('language', language || DEFAULT_TRANSCRIPTION_LANGUAGE);
  formData.append('prompt', prompt || TRANSCRIPTION_PROMPT);
  return formData;
};
