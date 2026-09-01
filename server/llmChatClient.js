/**
 * Cliente OpenAI-compatible para el parser de intents (WhatsApp / panel).
 *
 * Cadena de proveedores:
 *   1. Primario según LLM_PROVIDER (default: gemini)
 *   2. El otro proveedor, si tiene API key
 *   3. parseLocalText en el caller — nunca se llama desde acá
 *
 * Gemini (endpoint OpenAI-compat, docs: https://ai.google.dev/gemini-api/docs/openai )
 *   POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *   Authorization: Bearer GEMINI_API_KEY
 *   model: gemini-3.5-flash-lite  (fallback de modelo: gemini-3.1-flash-lite)
 *
 * Compatibilidad verificada contra esa doc (sep 2026):
 *   - role "system": soportado (mismo shape que OpenAI)
 *   - response_format json_object y json_schema / parse(): soportados
 *   - function calling / tools: soportado por la capa; este parser NO usa tools
 *   - max_tokens: aceptado por la capa de compatibilidad
 *
 * Groq (secundario, no borrar):
 *   POST VITE_VOICE_MODEL_ENDPOINT (default api.groq.com/.../chat/completions)
 *   Authorization: Bearer VITE_VOICE_MODEL_API_KEY | GROQ_API_KEY
 *
 * Rate limits Gemini: no hay números fijos públicos; varían por proyecto/tier.
 * Ver el dashboard del proyecto: https://aistudio.google.com/rate-limit
 * Referencia pública de TPM (no RPM): Gemini 3.5 Flash-Lite ~10M TPM.
 */

const GEMINI_CHAT_COMPLETIONS = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GROQ_CHAT_COMPLETIONS = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
const REQUEST_TIMEOUT_MS = 25000;
const PRIMARY_RETRIES = 2;
const SECONDARY_RETRIES = 2;

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) {
      return text;
    }
  }
  return '';
};

export const stripCodeFences = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

const extractTextFromContent = (content) => {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') {
            return part.text;
          }
          if (typeof part.content === 'string') {
            return part.content;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

export const extractChatContent = (responseData) => {
  if (!responseData || typeof responseData !== 'object') {
    return '';
  }

  if (Array.isArray(responseData.choices)) {
    const firstChoice = responseData.choices[0];
    const message = firstChoice?.message;
    const fromMessage = extractTextFromContent(message?.content);
    if (fromMessage) {
      return fromMessage;
    }
    if (typeof firstChoice?.text === 'string' && firstChoice.text.trim()) {
      return firstChoice.text;
    }
  }

  if (typeof responseData.output_text === 'string' && responseData.output_text.trim()) {
    return responseData.output_text;
  }

  return '';
};

export const parseModelJsonContent = (content) => {
  const stripped = stripCodeFences(content);
  if (!stripped) {
    return { ok: false, error: 'empty_content', raw: content };
  }

  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') {
      return { ok: true, json: parsed, raw: stripped };
    }
    return { ok: false, error: 'json_not_object', raw: stripped };
  } catch (firstError) {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const sliced = stripped.slice(start, end + 1);
      try {
        const parsed = JSON.parse(sliced);
        if (parsed && typeof parsed === 'object') {
          return { ok: true, json: parsed, raw: sliced, recovered: true };
        }
      } catch {
        // fall through
      }
    }
    return {
      ok: false,
      error: firstError instanceof Error ? firstError.message : String(firstError),
      raw: stripped,
    };
  }
};

export const getLlmProviderFlag = () => {
  const raw = String(process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();
  return raw === 'groq' ? 'groq' : 'gemini';
};

const geminiModels = () => {
  const primary = firstNonEmpty(process.env.GEMINI_MODEL_NAME, DEFAULT_GEMINI_MODEL) || DEFAULT_GEMINI_MODEL;
  const models = [primary];
  if (primary !== FALLBACK_GEMINI_MODEL) {
    models.push(FALLBACK_GEMINI_MODEL);
  }
  return models;
};

const buildGeminiProvider = () => {
  const apiKey = firstNonEmpty(process.env.GEMINI_API_KEY);
  if (!apiKey) {
    return null;
  }
  return {
    id: 'gemini',
    endpoint: firstNonEmpty(process.env.GEMINI_MODEL_ENDPOINT, GEMINI_CHAT_COMPLETIONS) || GEMINI_CHAT_COMPLETIONS,
    apiKey,
    models: geminiModels(),
    supportsJsonObject: true,
    reasoningEffort: firstNonEmpty(process.env.GEMINI_REASONING_EFFORT, 'minimal') || 'minimal',
    maxTokens: Number(process.env.GEMINI_MAX_TOKENS) || 8192,
  };
};

const buildGroqProvider = () => {
  const apiKey = firstNonEmpty(process.env.GROQ_API_KEY, process.env.VITE_VOICE_MODEL_API_KEY);
  if (!apiKey) {
    return null;
  }
  return {
    id: 'groq',
    endpoint: firstNonEmpty(process.env.VITE_VOICE_MODEL_ENDPOINT, GROQ_CHAT_COMPLETIONS) || GROQ_CHAT_COMPLETIONS,
    apiKey,
    models: [firstNonEmpty(process.env.VITE_VOICE_MODEL_NAME, DEFAULT_GROQ_MODEL) || DEFAULT_GROQ_MODEL],
    supportsJsonObject: true,
    reasoningEffort: '',
    maxTokens: Number(process.env.GROQ_MAX_TOKENS) || 2048,
  };
};

export const resolveProviderChain = () => {
  const gemini = buildGeminiProvider();
  const groq = buildGroqProvider();
  const flag = getLlmProviderFlag();
  const ordered = flag === 'groq' ? [groq, gemini] : [gemini, groq];
  const chain = ordered.filter(Boolean);
  const disableFallback = /^(1|true|yes)$/i.test(String(process.env.LLM_DISABLE_FALLBACK || '').trim());
  return disableFallback ? chain.slice(0, 1) : chain;
};

export const hasAnyLlmApiKey = () => resolveProviderChain().length > 0;

export const describeLlmSetup = () => {
  const chain = resolveProviderChain();
  return {
    flag: getLlmProviderFlag(),
    primary: chain[0]?.id ?? null,
    fallback: chain[1]?.id ?? null,
    models: chain.map((provider) => `${provider.id}:${provider.models.join('|')}`),
    hasKey: chain.length > 0,
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryableStatus = (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 413;

const looksLikeUnknownModel = (status, errorText) => {
  if (status === 404) {
    return true;
  }
  if (status !== 400) {
    return false;
  }
  return /model|not found|does not exist|unknown/i.test(errorText);
};

const looksLikeJsonFormatRejection = (status, errorText) =>
  status === 400 && /response_format|json_object|json schema|unsupported/i.test(errorText);

const describeRateLimit = (response) => ({
  retryAfter: response.headers.get('retry-after'),
  remainingRequests: response.headers.get('x-ratelimit-remaining-requests'),
  remainingTokens: response.headers.get('x-ratelimit-remaining-tokens'),
  resetRequests: response.headers.get('x-ratelimit-reset-requests'),
  resetTokens: response.headers.get('x-ratelimit-reset-tokens'),
});

const postChat = async (endpoint, apiKey, body) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const errorText = response.ok ? '' : await response.text();
  return { response, errorText };
};

const buildRequestBody = (provider, model, messages, options, { jsonObject, includeReasoning }) => {
  const body = {
    model,
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? provider.maxTokens,
    messages,
  };
  if (jsonObject && provider.supportsJsonObject) {
    body.response_format = { type: 'json_object' };
  }
  if (includeReasoning && provider.reasoningEffort) {
    body.reasoning_effort = provider.reasoningEffort;
  }
  return body;
};

const tryProvider = async (provider, messages, options, retries) => {
  const startedAt = Date.now();
  let lastFailure = { reason: 'unknown', status: 0 };

  for (let modelIndex = 0; modelIndex < provider.models.length; modelIndex += 1) {
    const model = provider.models[modelIndex];
    let jsonObject = true;
    let includeReasoning = Boolean(provider.reasoningEffort);

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const body = buildRequestBody(provider, model, messages, options, { jsonObject, includeReasoning });
      let response;
      let errorText = '';

      try {
        const posted = await postChat(provider.endpoint, provider.apiKey, body);
        response = posted.response;
        errorText = posted.errorText;
      } catch (error) {
        lastFailure = {
          reason: 'network',
          status: 0,
          error: error instanceof Error ? error.message : String(error),
          model,
        };
        console.warn(`[LLM] ${provider.id}/${model} network error`, lastFailure.error);
        break;
      }

      if (!response.ok) {
        lastFailure = {
          reason: `http_${response.status}`,
          status: response.status,
          error: errorText.slice(0, 500),
          model,
          rateLimit: describeRateLimit(response),
        };

        if (jsonObject && looksLikeJsonFormatRejection(response.status, errorText)) {
          console.warn(`[LLM] ${provider.id}/${model} rechazó response_format json_object; reintento sin él`);
          jsonObject = false;
          continue;
        }

        if (includeReasoning && response.status === 400 && /reasoning_effort|thinking/i.test(errorText)) {
          console.warn(`[LLM] ${provider.id}/${model} rechazó reasoning_effort; reintento sin él`);
          includeReasoning = false;
          continue;
        }

        if (looksLikeUnknownModel(response.status, errorText) && modelIndex < provider.models.length - 1) {
          console.warn(`[LLM] ${provider.id} modelo ${model} no disponible (${response.status}); pruebo ${provider.models[modelIndex + 1]}`);
          break;
        }

        if (retryableStatus(response.status) && attempt < retries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const hinted = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * attempt;
          const waitMs = Math.min(8000, hinted);
          console.warn(
            `[LLM] ${provider.id}/${model} HTTP ${response.status} — retry ${attempt}/${retries} in ${waitMs}ms`,
            describeRateLimit(response),
          );
          await sleep(waitMs);
          continue;
        }

        console.warn(`[LLM] ${provider.id}/${model} HTTP ${response.status}`, errorText.slice(0, 300));
        break;
      }

      let data;
      try {
        data = await response.json();
      } catch (error) {
        lastFailure = {
          reason: 'invalid_response_json',
          status: response.status,
          error: error instanceof Error ? error.message : String(error),
          model,
        };
        break;
      }

      const content = extractChatContent(data);
      if (!content) {
        lastFailure = { reason: 'empty_content', status: response.status, model };
        console.warn(`[LLM] ${provider.id}/${model} empty model content`);
        break;
      }

      const parsed = parseModelJsonContent(content);
      if (!parsed.ok) {
        lastFailure = { reason: 'invalid_model_json', status: response.status, model, error: parsed.error };
        console.warn(`[LLM] ${provider.id}/${model} JSON no parseable`, {
          error: parsed.error,
          contentPreview: String(parsed.raw || content).slice(0, 400),
        });
        break;
      }

      if (parsed.recovered) {
        console.warn(`[LLM] ${provider.id}/${model} JSON recuperado de texto extra`, {
          contentPreview: String(content).slice(0, 200),
        });
      }

      const latencyMs = Date.now() - startedAt;
      return {
        ok: true,
        provider: provider.id,
        model,
        content,
        json: parsed.json,
        latencyMs,
        recoveredJson: Boolean(parsed.recovered),
      };
    }
  }

  return {
    ok: false,
    provider: provider.id,
    latencyMs: Date.now() - startedAt,
    ...lastFailure,
  };
};

export const completeChatJson = async ({ messages, temperature = 0, maxTokens } = {}) => {
  const chain = resolveProviderChain();
  if (!chain.length) {
    return { ok: false, reason: 'missing_api_key' };
  }

  const failures = [];
  for (let index = 0; index < chain.length; index += 1) {
    const provider = chain[index];
    const retries = index === 0 ? PRIMARY_RETRIES : SECONDARY_RETRIES;
    const result = await tryProvider(provider, messages, { temperature, maxTokens }, retries);
    if (result.ok) {
      if (failures.length) {
        console.warn(`[LLM] ${provider.id} respondió después de fallar ${failures.map((item) => item.provider).join(' → ')}`);
      }
      return { ...result, fallbackUsed: failures.length > 0, attempted: [...failures.map((item) => item.provider), provider.id] };
    }
    failures.push(result);
    if (index < chain.length - 1) {
      console.warn(`[LLM] ${provider.id} falló (${result.reason}); pruebo ${chain[index + 1].id}`);
    }
  }

  return {
    ok: false,
    reason: 'all_providers_failed',
    failures,
  };
};
