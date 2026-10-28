/** Only accepted messages reach this function, after inbound deduplication. */
export async function acknowledgeMetaMessages(body, sendReply, onError = () => {}) {
  const acknowledged = new Set();
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from || !['text', 'audio'].includes(message.type) || acknowledged.has(message.id)) continue;
        acknowledged.add(message.id);
        try {
          await sendReply({ to: message.from, text: message.type === 'audio'
            ? 'Recibí tu audio. Lo estoy procesando…'
            : 'Recibí tu mensaje. Lo estoy procesando…' });
        } catch (error) {
          onError(error);
        }
      }
    }
  }
  return acknowledged;
}
