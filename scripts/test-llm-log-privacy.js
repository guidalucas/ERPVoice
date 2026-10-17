import assert from 'node:assert/strict';
import { completeChatJson } from '../server/llmChatClient.js';

const envKeys = [
  'LLM_PROVIDER',
  'LLM_DISABLE_FALLBACK',
  'GEMINI_API_KEY',
  'GEMINI_MODEL_ENDPOINT',
  'GEMINI_MODEL_NAME',
  'GROQ_API_KEY',
  'VITE_VOICE_MODEL_API_KEY',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

const markerSet = (marker) => {
  const logs = [];
  console.warn = (...args) => logs.push(args.map((arg) => (
    typeof arg === 'string' ? arg : JSON.stringify(arg)
  )).join(' '));
  return {
    logs,
    marker,
    assertRedacted() {
      assert.equal(logs.join('\n').includes(marker), false, `logs exposed ${marker}`);
    },
    assertTelemetry(expected) {
      const output = logs.join('\n');
      for (const value of expected) {
        assert.ok(output.includes(value), `logs missing telemetry ${value}: ${output}`);
      }
    },
  };
};

const response = ({ ok, status, body, data }) => ({
  ok,
  status,
  headers: { get: () => null },
  text: async () => body,
  json: async () => data,
});

try {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.LLM_DISABLE_FALLBACK = 'true';
  process.env.GEMINI_API_KEY = 'fake-test-key';
  process.env.GEMINI_MODEL_NAME = 'gemini-3.5-flash-lite';
  process.env.GEMINI_MODEL_ENDPOINT = 'https://fake.invalid/chat/completions';
  delete process.env.GROQ_API_KEY;
  delete process.env.VITE_VOICE_MODEL_API_KEY;

  const providerErrorMarker = 'PRIVATE_PROVIDER_BODY_8f3c';
  globalThis.fetch = async () => response({
    ok: false,
    status: 400,
    body: `provider rejected request: ${providerErrorMarker}`,
  });
  let capture = markerSet(providerErrorMarker);
  const providerFailure = await completeChatJson({ messages: [] });
  capture.assertRedacted();
  capture.assertTelemetry(['gemini', 'gemini-3.5-flash-lite', 'http_400', '400']);
  assert.equal(providerFailure.failures[0].reason, 'http_400');

  const networkMarker = 'PRIVATE_NETWORK_MESSAGE_71da';
  globalThis.fetch = async () => { throw new Error(networkMarker); };
  capture = markerSet(networkMarker);
  const networkFailure = await completeChatJson({ messages: [] });
  capture.assertRedacted();
  capture.assertTelemetry(['gemini', 'gemini-3.5-flash-lite', 'network', '"status":0']);
  assert.equal(networkFailure.failures[0].reason, 'network');

  const malformedMarker = 'PRIVATE_MALFORMED_CONTENT_25bc';
  globalThis.fetch = async () => response({
    ok: true,
    status: 200,
    data: { choices: [{ message: { content: `not json ${malformedMarker}` } }] },
  });
  capture = markerSet(malformedMarker);
  const malformedFailure = await completeChatJson({ messages: [] });
  capture.assertRedacted();
  capture.assertTelemetry(['gemini', 'gemini-3.5-flash-lite', 'invalid_model_json', '"status":200']);
  assert.equal(malformedFailure.failures[0].reason, 'invalid_model_json');

  const recoveredMarker = 'PRIVATE_RECOVERED_TEXT_49e1';
  globalThis.fetch = async () => response({
    ok: true,
    status: 200,
    data: { choices: [{ message: { content: `preamble ${recoveredMarker} {"ok":true} trailing` } }] },
  });
  capture = markerSet(recoveredMarker);
  const recoveredResult = await completeChatJson({ messages: [] });
  capture.assertRedacted();
  capture.assertTelemetry(['gemini', 'gemini-3.5-flash-lite', 'recovered_model_json', '"status":200']);
  assert.equal(recoveredResult.ok, true);
  assert.equal(recoveredResult.recoveredJson, true);

  originalWarn('LLM log privacy regression test passed');
} finally {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
}
