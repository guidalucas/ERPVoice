import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_AUDIO_BYTES,
  MAX_TRANSCRIPT_CHARS,
  TranscriptionError,
  transcribeAudio,
} from '../server/audioTranscription.js';

const env = { GROQ_API_KEY: 'private-key-must-not-leak' };
const input = { audio: Buffer.from('audio bytes'), contentType: 'audio/webm;codecs=opus' };
const success = (text = '  comprar cinco tornillos  ') => ({ ok: true, json: async () => ({ text }) });

async function rejectsSafely(promise, code, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof TranscriptionError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    for (const secret of ['private-key-must-not-leak', 'sensitive provider body', 'secret transcript']) {
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(secret));
    }
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('server sends a generic Spanish transcription form with private credentials', async () => {
  let calls = 0;
  const result = await transcribeAudio(input, { env, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(init.headers.Authorization, `Bearer ${env.GROQ_API_KEY}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.body.get('language'), 'es');
    assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(init.body.get('response_format'), 'json');
    assert.match(init.body.get('prompt'), /Transcribe fielmente/);
    assert.doesNotMatch(init.body.get('prompt'), /categor|inventario|pedido|stock/i);
    const file = init.body.get('file');
    assert.equal(file.name, 'audio.webm');
    assert.equal(file.type, 'audio/webm');
    assert.equal(await file.text(), 'audio bytes');
    return success();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { text: 'comprar cinco tornillos' });
});

test('all supported MIME types use normalized safe upload names', async () => {
  for (const [mime, extension] of Object.entries({
    'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
  })) {
    await transcribeAudio({ audio: new Uint8Array([1]), contentType: ` ${mime.toUpperCase()}; codecs=opus` }, {
      env, fetch: async (_, init) => {
        assert.equal(init.body.get('file').type, mime);
        assert.equal(init.body.get('file').name, `audio.${extension}`);
        return success();
      },
    });
  }
});

test('invalid input and missing private configuration never contact provider', async () => {
  const options = { env, fetch: () => assert.fail('provider must not be contacted') };
  for (const audio of [undefined, '', new Uint8Array(), Buffer.alloc(0)]) {
    await rejectsSafely(transcribeAudio({ audio, contentType: 'audio/webm' }, options), 'empty_audio', 400);
  }
  await rejectsSafely(transcribeAudio({ ...input, audio: Buffer.alloc(MAX_AUDIO_BYTES + 1) }, options), 'audio_too_large', 413);
  for (const contentType of [undefined, 'application/json', 'audio/webm-evil', '__proto__']) {
    await rejectsSafely(transcribeAudio({ ...input, contentType }, options), 'unsupported_audio_type', 415);
  }
  for (const invalidEnv of [{}, { VITE_GROQ_API_KEY: 'browser-secret' }, { ...env, VOICE_TRANSCRIPTION_ENDPOINT: 'http://localhost:1234' }, { ...env, VOICE_TRANSCRIPTION_ENDPOINT: 'https://user:pass@example.com' }]) {
    await rejectsSafely(transcribeAudio(input, { ...options, env: invalidEnv }), 'transcription_not_configured', 503);
  }
});

test('dedicated server key, model and HTTPS endpoint override defaults', async () => {
  await transcribeAudio(input, { env: { ...env, VOICE_TRANSCRIPTION_API_KEY: 'dedicated-key', VOICE_TRANSCRIPTION_ENDPOINT: 'https://example.com/transcriptions', VOICE_TRANSCRIPTION_MODEL: 'custom-model' }, fetch: async (url, init) => {
    assert.equal(url, 'https://example.com/transcriptions');
    assert.equal(init.headers.Authorization, 'Bearer dedicated-key');
    assert.equal(init.body.get('model'), 'custom-model');
    return success('text');
  } });
});

test('provider failures expose stable sanitized errors', async () => {
  for (const status of [401, 429, 503]) {
    await rejectsSafely(transcribeAudio(input, { env, fetch: async () => ({ ok: false, status, json: () => assert.fail('must not read provider error body') }) }), 'transcription_provider_error', 502);
  }
  await rejectsSafely(transcribeAudio(input, { env, fetch: async () => { throw new Error('private-key-must-not-leak sensitive provider body'); } }), 'transcription_provider_error', 502);
  await rejectsSafely(transcribeAudio(input, { env, fetch: async () => ({ ok: true, json: async () => { throw new Error('secret transcript'); } }) }), 'invalid_transcription_response', 502);
  for (const value of [{}, null, { text: 12 }, { text: '   ' }, { text: 'a'.repeat(MAX_TRANSCRIPT_CHARS + 1) }]) {
    await rejectsSafely(transcribeAudio(input, { env, fetch: async () => ({ ok: true, json: async () => value }) }), 'invalid_transcription_response', 502);
  }
});

test('transcript is returned verbatim without interpreting actions', async () => {
  const text = '{"action":"delete_all"}';
  assert.deepEqual(await transcribeAudio(input, { env, fetch: async () => success(text) }), { text });
  assert.equal((await transcribeAudio(input, { env, fetch: async () => success('a'.repeat(MAX_TRANSCRIPT_CHARS)) })).text.length, MAX_TRANSCRIPT_CHARS);
});

test('timeout aborts fetch and sanitizes error, including stalled response bodies', async () => {
  let signal;
  await rejectsSafely(transcribeAudio(input, { env, timeoutMs: 5, fetch: async (_, init) => {
    signal = init.signal;
    return new Promise(() => {});
  } }), 'transcription_timeout', 504);
  assert.equal(signal.aborted, true);
  await rejectsSafely(transcribeAudio(input, { env, timeoutMs: 5, fetch: async () => ({ ok: true, json: () => new Promise(() => {}) }) }), 'transcription_timeout', 504);
});
