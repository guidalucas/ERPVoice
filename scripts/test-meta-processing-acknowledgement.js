import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeMetaMessages } from '../server/metaProcessingAcknowledgement.js';

const body = (...groups) => ({ entry: groups.map(messages => ({ changes: [{ value: { messages } }] })) });
const message = (id, type = 'audio') => ({ id, type, from: '5491100000000' });

test('acknowledges every accepted audio and text across a batched webhook before continuing', async () => {
  const sent = [], events = [];
  const ids = await acknowledgeMetaMessages(body([message('audio'), message('text', 'text')], [message('second'), message('audio')]), async reply => {
    events.push('sending');
    await Promise.resolve();
    sent.push(reply); events.push('sent');
  });
  events.push('processing');
  assert.deepEqual([...ids], ['audio', 'text', 'second']);
  assert.equal(sent.length, 3);
  assert.match(sent[0].text, /Recibí tu audio.*procesando/);
  assert.match(sent[1].text, /Recibí tu mensaje.*procesando/);
  assert.deepEqual(events, ['sending', 'sent', 'sending', 'sent', 'sending', 'sent', 'processing']);
});

test('delivery errors do not prevent processing and unsupported messages are skipped', async () => {
  const errors = [], sent = [];
  await acknowledgeMetaMessages(body([message('failed'), message('photo', 'image'), {}, message('next', 'text')]), async reply => {
    sent.push(reply);
    if (sent.length === 1) throw new Error('delivery failed');
  }, error => errors.push(error.message));
  assert.equal(sent.length, 2);
  assert.deepEqual(errors, ['delivery failed']);
  assert.equal((await acknowledgeMetaMessages({}, assert.fail)).size, 0);
});
