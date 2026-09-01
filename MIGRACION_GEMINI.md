# Migración del parser de intents: Groq → Gemini

## Qué cambió

El parseo de WhatsApp y del chat del panel (`parseVoiceText` → `/api/voice/parse` → `/api/state/apply`) ahora habla con un cliente LLM configurable (`server/llmChatClient.js`).

- **Primario:** Google Gemini vía el endpoint OpenAI-compatible
  (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`).
- **Modelo:** `gemini-3.5-flash-lite`. Si ese ID no existe en el proyecto, se reintenta
  `gemini-3.1-flash-lite`.
- **Secundario:** Groq (`openai/gpt-oss-20b`), igual que antes. No se borró.
- **Último fallback:** `parseLocalText`. Nunca se usa primero.

El prompt de parseo y el grounding de catálogo no se tocaron. El contrato JSON hacia
`/api/state/apply` es el mismo.

La transcripción de audio (Whisper) **sigue en Groq**. Esta migración es solo del
modelo que genera el intent.

### Compatibilidad OpenAI de Gemini (docs oficiales)

Fuente: [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) (revisada 2026-09-01).

| Feature del parser actual | ¿Compatible vía endpoint OpenAI? |
| --- | --- |
| `messages` con `role: "system"` | Sí |
| `response_format: { type: "json_object" }` | Sí (también soporta json_schema / `.parse()`) |
| Function calling / tools | Soportado por Gemini, **no lo usa este parser** |
| Auth `Authorization: Bearer` | Sí (`GEMINI_API_KEY` de AI Studio) |

No hizo falta el SDK nativo `@google/genai`. Si `json_object` es rechazado, el cliente
reintenta sin `response_format` y parsea el texto con `JSON.parse` defensivo (code fences
y primer bloque `{...}`). Si el JSON no es parseable, se loguea el texto crudo y se
prueba Groq antes de caer al parser local.

`reasoning_effort` se manda en `minimal` para recortar thinking/latencia en Flash-Lite.
Si el modelo lo rechaza, se reintenta sin ese campo.

## Variables de entorno (Render + `.env.local`)

Obligatorias para el primario:

```
LLM_PROVIDER=gemini
GEMINI_API_KEY=<key de aistudio.google.com>
```

Opcionales:

```
GEMINI_MODEL_NAME=gemini-3.5-flash-lite
GEMINI_MODEL_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
GEMINI_REASONING_EFFORT=minimal
```

Dejar Groq configurado (fallback y/o rollback sin redeploy de código):

```
VITE_VOICE_MODEL_ENDPOINT=https://api.groq.com/openai/v1/chat/completions
VITE_VOICE_MODEL_API_KEY=<key groq>
VITE_VOICE_MODEL_NAME=openai/gpt-oss-20b
```

Rollback inmediato en Render: `LLM_PROVIDER=groq` (sigue usando las vars `VITE_VOICE_MODEL_*`).
Si Gemini no tiene key, el cliente salta a Groq solo.

La transcripción de audio sigue usando `VITE_VOICE_TRANSCRIPTION_*` (Groq Whisper).

Para medir **solo** Gemini (sin caer a Groq): `LLM_DISABLE_FALLBACK=1`.

## Rate limits

Google **no publica RPM fijos** para el free tier: varían por proyecto y tier.
Dashboard: https://aistudio.google.com/rate-limit

Referencia pública de TPM (no RPM) al 2026-09: Gemini 3.5 Flash-Lite / 3.1 Flash Lite
~10.000.000 TPM. Completar acá los números reales del proyecto de Stocky cuando se cree
la key en AI Studio:

```
Proyecto AI Studio:
RPM:
TPM:
RPD:
Fecha de lectura:
```

## Latencia

El backend loguea cada parse LLM:

```
[MetaWebhook] LLM parse { provider, model, latencyMs, fallbackUsed }
```

Si `latencyMs >= 2000` sale como warning (`LLM parse lento`).

Medición local (2026-09-01):

- Prompt mínimo de JSON (`completeChatJson`): **~1.9 s** con `gemini-3.5-flash-lite`
- Mensaje real de alta de stock con el prompt de parseo + catálogo: **~22–24 s**
- Fallback Groq `openai/gpt-oss-20b` (1 mensaje equivalente, sin catálogo enorme): **~1.4 s**

La diferencia en el path real viene del prompt largo y del thinking de Flash-Lite
(`reasoning_effort=minimal`; en Gemini 3 no se puede apagar del todo). El flujo de
WhatsApp no es de respuesta en tiempo real estricto, pero ~20 s se va a notar.
Si molesta en producción, probar `GEMINI_MODEL_NAME=gemini-3.1-flash-lite` o
subir el tier / revisar thinking en AI Studio.

## Batería de 390 casos

No se corrió en esta migración. El script sigue igual:

```
node scripts/test-parser-robustness.js --delay-ms=500
```

Salida: `scripts/test-results.md` y `scripts/test-results.json` (gitignored).
Baseline local previo (24 FP): `scripts/test-results-local.json`.
