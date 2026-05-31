import express from 'express';
import dotenv from 'dotenv';
import { buildMetaVerificationResponse, processMetaWebhook, sendMetaReply } from './metaWebhookProcessor.js';
import {
  createProductRecord,
  deleteProductRecord,
  applyActionsToDatabase,
  findMetaEventById,
  getStateSnapshot,
  getMetaEvents,
  markMetaEventProcessed,
  saveMetaEvent,
  updateProductRecord,
} from './postgresDatabase.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);
const allowedOrigins = new Set([
  'https://erp-voice.vercel.app',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
]);
const metaVerifyToken = process.env.META_VERIFY_TOKEN || 'erpvoice_token_secreto';

const createEventId = () => `meta-event-${Math.random().toString(36).slice(2, 10)}`;

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;

  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const recentEvents = [];

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'meta-webhook', port });
});

app.get('/api/state', async (_req, res) => {
  try {
    const snapshot = await getStateSnapshot();
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const product = await createProductRecord({
      name: req.body?.name,
      productType: req.body?.productType,
      productModel: req.body?.productModel,
      size: req.body?.size,
      stockAvailable: req.body?.stockAvailable,
      stockReserved: req.body?.stockReserved,
      price: req.body?.price,
    });

    if (!product) {
      res.status(400).json({ error: 'No se pudo crear el producto' });
      return;
    }

    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const product = await updateProductRecord(req.params.id, {
      name: req.body?.name,
      productType: req.body?.productType,
      productModel: req.body?.productModel,
      size: req.body?.size,
      stockAvailable: req.body?.stockAvailable,
      stockReserved: req.body?.stockReserved,
      price: req.body?.price,
    });

    if (!product) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const deleted = await deleteProductRecord(req.params.id);

    if (!deleted) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/meta-events', (_req, res) => {
  getMetaEvents()
    .then((events) => res.json(events))
    .catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
});

app.get('/api/meta-webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === metaVerifyToken) {
    console.log('[MetaWebhook] verification succeeded');
    res.status(200).send(buildMetaVerificationResponse(challenge));
    return;
  }

  res.sendStatus(403);
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

const handleMetaWebhook = async (req, res) => {
  res.sendStatus(200);
  const fastRepliedMessageIds = new Set();

  // Enviar ACK rápido para mensajes de texto para que el usuario reciba respuesta inmediata
  try {
    const body = req.body ?? {};
    if (body.object === 'whatsapp_business_account') {
      const entry = Array.isArray(body.entry) ? body.entry[0] : null;
      const changes = entry?.changes?.[0]?.value;
      const message = changes?.messages?.[0];

      if (message && message.type === 'text') {
        const fromNumber = message.from;
        const messageId = typeof message.id === 'string' ? message.id : null;
        const senderName = changes?.contacts?.[0]?.profile?.name || 'Usuario';
        const textBody = message?.text?.body ?? '';

        console.log(`Texto recibido. Intentando responder a: ${fromNumber}`);

        const responseText = `¡Recibido, ${senderName}! Procesando comando: "${textBody}"`;

        // no await, pero capturamos errores para no bloquear el flujo
        sendMetaReply({ to: fromNumber, text: responseText })
          .then((r) => console.log('[MetaWebhook] fast-reply result:', r))
          .catch((err) => {
            console.error('[MetaWebhook] fast-reply failed:', err);
          });

        if (messageId) {
          fastRepliedMessageIds.add(messageId);
        }
      }
    }
  } catch (err) {
    console.error('[MetaWebhook] failed to send fast-reply:', err);
  }

  try {
    const results = await processMetaWebhook(req.body ?? {});

    for (const result of results) {
      const incomingId = result.messageId ?? createEventId();
      const existingEvent = await findMetaEventById(incomingId);

      if (existingEvent?.processed && existingEvent.replyText) {
        continue;
      }

      const eventRecord = {
        id: incomingId,
        at: new Date().toISOString(),
        fromNumber: result.fromNumber ?? null,
        body: result.rawMessage ? JSON.stringify(result.rawMessage) : null,
        numMedia: result.kind === 'audio' ? 1 : 0,
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

      console.log('[MetaWebhook] response debug:', {
        messageId: incomingId,
        from: result.fromNumber,
        kind: result.kind,
        sourceText: result.sourceText,
        transcript: result.transcript ?? null,
        replyText: result.replyText,
        actions: result.parsed?.actions ?? [],
      });

      await saveMetaEvent(eventRecord);
      await markMetaEventProcessed(eventRecord.id, { processed: eventRecord.processed });

      const alreadyFastReplied = result.kind === 'text' && result.messageId && fastRepliedMessageIds.has(result.messageId);

      if (!alreadyFastReplied) {
        try {
          const replyResult = await sendMetaReply({
            to: result.fromNumber,
            text: result.replyText,
          });
          if (!replyResult?.sent) {
            console.warn('[MetaWebhook] reply not sent:', replyResult);
          }
        } catch (replyError) {
          console.error('[MetaWebhook] reply failed for event:', incomingId, replyError);
        }
      } else {
        console.log('[MetaWebhook] skipped duplicate text reply for message:', result.messageId);
      }

      console.log('[MetaWebhook] processed event:', {
        from: result.fromNumber,
        kind: result.kind,
        sourceText: result.sourceText,
        actions: result.parsed?.actions?.length ?? 0,
      });
    }
  } catch (error) {
    console.error('[MetaWebhook] processing failed:', error);
  }
};

app.post('/api/meta-webhook', handleMetaWebhook);

app.listen(port, '0.0.0.0', () => {
  console.log(`[MetaWebhook] listening on port ${port}`);
  console.log('[MetaWebhook] GET /api/meta-webhook for verification');
  console.log('[MetaWebhook] POST /api/meta-webhook for WhatsApp Cloud API messages');
});