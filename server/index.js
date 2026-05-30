import express from 'express';
import dotenv from 'dotenv';
import { buildTwilioXmlResponse, processTwilioWebhook } from './twilioVoiceProcessor.js';
import {
  applyActionsToDatabase,
  findTwilioEventById,
  getStateSnapshot,
  getTwilioEvents,
  markTwilioEventProcessed,
  saveTwilioEvent,
} from './database.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const app = express();
const port = Number(process.env.TWILIO_WEBHOOK_PORT || 3001);

const createEventId = () => `twilio-event-${Math.random().toString(36).slice(2, 10)}`;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

const recentEvents = [];

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'twilio-webhook', port });
});

app.get('/api/state', async (_req, res) => {
  try {
    const snapshot = await getStateSnapshot();
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/twilio-events', (_req, res) => {
  getTwilioEvents()
    .then((events) => res.json(events))
    .catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
});

app.post('/api/state/apply', async (req, res) => {
  try {
    const sourceText = typeof req.body?.sourceText === 'string' ? req.body.sourceText : '';
    const actions = Array.isArray(req.body?.actions) ? req.body.actions : [];
    const snapshot = await applyActionsToDatabase(actions, sourceText);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/twilio-webhook', async (req, res) => {
  try {
    const incomingId = req.body?.MessageSid ?? req.body?.SmsMessageSid ?? null;
    if (incomingId) {
      const existingEvent = await findTwilioEventById(incomingId);

      if (existingEvent?.processed && existingEvent.replyText) {
        res.type('application/xml').status(200).send(buildTwilioXmlResponse(existingEvent.replyText));
        return;
      }
    }

    const result = await processTwilioWebhook(req.body ?? {});
    const eventRecord = {
      id: incomingId ?? `twilio-event-${Math.random().toString(36).slice(2, 10)}`,
      at: new Date().toISOString(),
      fromNumber: req.body?.From ?? null,
      body: req.body?.Body ?? null,
      numMedia: Number(req.body?.NumMedia ?? 0),
      kind: result.kind,
      sourceText: result.sourceText,
      transcript: result.transcript ?? null,
      replyText: result.replyText,
      error: null,
      actionsJson: result.parsed ? JSON.stringify(result.parsed.actions ?? []) : null,
      processed: Boolean(result.parsed?.actions?.length),
    };

    if (result.parsed?.actions?.length) {
      await applyActionsToDatabase(result.parsed.actions, result.sourceText);
    }

    await saveTwilioEvent(eventRecord);
    await markTwilioEventProcessed(eventRecord.id, { processed: eventRecord.processed });

    console.log('[TwilioWebhook] processed event:', {
      from: req.body?.From,
      kind: result.kind,
      sourceText: result.sourceText,
      actions: result.parsed?.actions?.length ?? 0,
    });

    res.type('application/xml').status(200).send(buildTwilioXmlResponse(result.replyText));
  } catch (error) {
    console.error('[TwilioWebhook] processing failed:', error);

    const incomingId = req.body?.MessageSid ?? req.body?.SmsMessageSid ?? `twilio-event-${Math.random().toString(36).slice(2, 10)}`;
    await saveTwilioEvent({
      id: incomingId,
      at: new Date().toISOString(),
      fromNumber: req.body?.From ?? null,
      body: req.body?.Body ?? null,
      numMedia: Number(req.body?.NumMedia ?? 0),
      error: error instanceof Error ? error.message : String(error),
      processed: false,
    });

    res.type('application/xml').status(200).send(buildTwilioXmlResponse('Recibí tu mensaje, pero falló el procesamiento.'));
  }
});

app.listen(port, () => {
  console.log(`[TwilioWebhook] listening on http://localhost:${port}`);
  console.log('[TwilioWebhook] POST /api/twilio-webhook for Twilio WhatsApp messages');
});