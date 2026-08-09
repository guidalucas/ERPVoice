import express from 'express';
import dotenv from 'dotenv';
import { buildMetaVerificationResponse, buildConversationTurnsFromEvents, parseVoiceText, processMetaWebhook, sendMetaReply } from './metaWebhookProcessor.js';
import { getBusinessCategoryPreset } from './businessCategories.js';
import {
  createAuthOtpChallenge,
  createProductRecord,
  createClientRecord,
  createProveedorRecord,
  createPedidoRecord,
  deleteProductRecord,
  deleteClientRecord,
  deleteProveedorRecord,
  deletePedidoRecord,
  applyActionsToDatabase,
  answerStockQuery,
  findMetaEventById,
  revokeAuthOtpChallenge,
  getAuthUserProfile,
  getStateSnapshot,
  getMetaEvents,
  markMetaEventProcessed,
  mergeClientRecords,
  mergeProveedorRecords,
  saveBusinessProfile,
  saveMetaEvent,
  upsertAuthUser,
  verifyAuthOtpChallenge,
  hasDatabaseConfig,
  updateProductRecord,
  updateClientRecord,
  updateProveedorRecord,
  updatePedidoRecord,
} from './postgresDatabase.js';
import { extractBearerToken, issueJwt, normalizePhone, verifyJwt } from './auth.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const app = express();
const port = Number(process.env.PORT || process.env.META_WEBHOOK_PORT || 8080);
const allowedOrigins = new Set([
  'https://erp-voice.vercel.app',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
]);
const metaVerifyToken = process.env.META_VERIFY_TOKEN || 'erpvoice_token_secreto';
const authEnabled = true;
const DEV_LOGIN_PHONE = normalizePhone(process.env.AUTH_DEV_PHONE || '5491100000000') || '5491100000000';
const memoryOtpChallenges = new Map();

const isAuthDevBypassEnabled = () => {
  const flag = String(process.env.AUTH_DEV_BYPASS ?? '').trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(flag)) {
    return false;
  }

  // Local por defecto (Node/Vercel producción lo desactivan).
  return process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1';
};

const createMemoryOtpCode = () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

const createMemoryChallenge = (phoneNumber) => {
  const challengeId = `dev-otp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const otpCode = createMemoryOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  memoryOtpChallenges.set(challengeId, {
    phoneNumber,
    otpCode,
    expiresAt,
  });

  return {
    challengeId,
    phoneNumber,
    otpCode,
    expiresAt,
    expiresInSeconds: 600,
  };
};

const verifyMemoryChallenge = ({ phoneNumber, otpCode, challengeId }) => {
  const challenge = memoryOtpChallenges.get(challengeId);

  if (!challenge || challenge.phoneNumber !== phoneNumber) {
    return { ok: false, reason: 'challenge_not_found' };
  }

  if (new Date(challenge.expiresAt).getTime() < Date.now()) {
    memoryOtpChallenges.delete(challengeId);
    return { ok: false, reason: 'challenge_expired' };
  }

  if (challenge.otpCode !== String(otpCode ?? '').trim()) {
    return { ok: false, reason: 'invalid_code' };
  }

  memoryOtpChallenges.delete(challengeId);
  return { ok: true, phoneNumber };
};

const createEventId = () => `meta-event-${Math.random().toString(36).slice(2, 10)}`;

const describeOtpSendFailure = (replyResult) => {
  const reason = replyResult?.reason;

  if (reason === 'missing_credentials_or_recipient') {
    return 'Faltan credenciales de Meta o el destinatario no es válido.';
  }

  if (reason === 'auth_error') {
    return 'Meta rechazó el token de acceso. Revisá META_ACCESS_TOKEN.';
  }

  if (reason === 'recipient_not_allowed') {
    return 'Meta no permite enviarle el mensaje a ese número. Agregalo como tester o usá un número habilitado.';
  }

  if (reason === 'recipient_unreachable') {
    return 'No se pudo resolver un formato válido del número de destino.';
  }

  return 'No se pudo enviar el código por WhatsApp.';
};

const getRequestIp = (req) => {
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  return forwarded.split(',')[0]?.trim() || req.ip || null;
};

const authenticateRequest = (req, res, next) => {
  if (!authEnabled) {
    next();
    return;
  }

  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }

  const payload = verifyJwt(token);

  if (!payload?.phoneNumber) {
    res.status(401).json({ error: 'Token inválido o vencido' });
    return;
  }

  req.auth = payload;
  next();
};

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

app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'meta-webhook', port });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'meta-webhook', port });
});

app.post('/api/auth/request-code', async (req, res) => {
  try {
    const phoneNumber = normalizePhone(req.body?.phoneNumber);

    if (!phoneNumber) {
      res.status(400).json({ error: 'Ingresá un número de celular válido' });
      return;
    }

    const devBypass = isAuthDevBypassEnabled();
    const useMemoryAuth = devBypass && !hasDatabaseConfig();

    const challenge = useMemoryAuth
      ? createMemoryChallenge(phoneNumber)
      : await createAuthOtpChallenge(phoneNumber);

    if (devBypass) {
      console.log(`[auth:dev] OTP para ${challenge.phoneNumber}: ${challenge.otpCode}`);
      res.json({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        expiresAt: challenge.expiresAt,
        expiresInSeconds: challenge.expiresInSeconds,
        devOtpCode: challenge.otpCode,
        devMode: true,
      });
      return;
    }

    const replyResult = await sendMetaReply({
      to: challenge.phoneNumber,
      text: `Tu código de acceso al panel es: ${challenge.otpCode}. Vence en 10 minutos.`,
    });

    if (!replyResult?.sent) {
      await revokeAuthOtpChallenge(challenge.challengeId);
      const statusByReason = {
        missing_credentials_or_recipient: 400,
        auth_error: 502,
        recipient_not_allowed: 403,
        recipient_unreachable: 502,
      };

      res.status(statusByReason[replyResult?.reason] ?? 500).json({
        error: describeOtpSendFailure(replyResult),
        reason: replyResult?.reason ?? 'unknown',
        metaError: replyResult?.metaError ?? null,
        recipientsTried: replyResult?.recipientsTried ?? [],
      });
      return;
    }

    res.json({
      challengeId: challenge.challengeId,
      phoneNumber: challenge.phoneNumber,
      expiresAt: challenge.expiresAt,
      expiresInSeconds: challenge.expiresInSeconds,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/auth/dev-login', async (req, res) => {
  try {
    if (!isAuthDevBypassEnabled()) {
      res.status(404).json({ error: 'Dev login deshabilitado' });
      return;
    }

    const requestedPhone = normalizePhone(req.body?.phoneNumber);
    const phoneNumber = requestedPhone || DEV_LOGIN_PHONE;

    if (hasDatabaseConfig()) {
      await upsertAuthUser(phoneNumber);
    }

    const token = issueJwt({ phoneNumber });
    console.log(`[auth:dev] Login local para ${phoneNumber}${hasDatabaseConfig() ? '' : ' (sin base de datos)'}`);

    res.json({
      token,
      tokenType: 'Bearer',
      phoneNumber,
      devMode: true,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/auth/dev-status', (_req, res) => {
  res.json({
    enabled: isAuthDevBypassEnabled(),
    defaultPhone: DEV_LOGIN_PHONE,
    databaseConfigured: hasDatabaseConfig(),
  });
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const phoneNumber = normalizePhone(req.body?.phoneNumber);
    const otpCode = String(req.body?.otpCode ?? '').trim();
    const challengeId = typeof req.body?.challengeId === 'string' ? req.body.challengeId.trim() : null;

    let verification;

    if (challengeId && memoryOtpChallenges.has(challengeId)) {
      verification = verifyMemoryChallenge({ phoneNumber, otpCode, challengeId });
    } else {
      verification = await verifyAuthOtpChallenge({
        phoneNumber,
        otpCode,
        challengeId,
      });
    }

    if (!verification.ok) {
      const statusByReason = {
        missing_fields: 400,
        challenge_not_found: 404,
        challenge_used: 400,
        challenge_expired: 400,
        invalid_code: 401,
        too_many_attempts: 429,
      };

      res.status(statusByReason[verification.reason] ?? 400).json({ error: 'No pudimos validar el código', reason: verification.reason });
      return;
    }

    // El verify de Postgres ya hace upsert; el challenge en memoria no.
    if (challengeId?.startsWith('dev-otp-') && hasDatabaseConfig()) {
      await upsertAuthUser(verification.phoneNumber);
    }

    const token = issueJwt({ phoneNumber: verification.phoneNumber });

    res.json({
      token,
      tokenType: 'Bearer',
      phoneNumber: verification.phoneNumber,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/auth/me', authenticateRequest, async (req, res) => {
  try {
    const phoneNumber = String(req.auth?.phoneNumber ?? '').trim();
    const profile = await getAuthUserProfile(phoneNumber);
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/business-profile', authenticateRequest, async (req, res) => {
  try {
    const phoneNumber = String(req.auth?.phoneNumber ?? '').trim();
    const businessName = String(req.body?.businessName ?? '').trim();
    const businessCategory = String(req.body?.businessCategory ?? '').trim();

    if (!businessName) {
      res.status(400).json({ error: 'El nombre del emprendimiento es obligatorio' });
      return;
    }

    const profile = await saveBusinessProfile(phoneNumber, { businessName, businessCategory });
    res.json(profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('inválida') || message.includes('obligatorio') ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

app.get('/api/state', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const snapshot = await getStateSnapshot(clientPhone);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/products', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();

    const product = await createProductRecord({
      name: req.body?.name,
      productType: req.body?.productType,
      productModel: req.body?.productModel,
      size: req.body?.size,
      stockAvailable: req.body?.stockAvailable,
      stockReserved: req.body?.stockReserved,
      price: req.body?.price,
    }, clientPhone);

    if (!product) {
      res.status(400).json({ error: 'No se pudo crear el producto' });
      return;
    }

    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/products/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();

    const product = await updateProductRecord(req.params.id, {
      name: req.body?.name,
      productType: req.body?.productType,
      productModel: req.body?.productModel,
      size: req.body?.size,
      stockAvailable: req.body?.stockAvailable,
      stockReserved: req.body?.stockReserved,
      price: req.body?.price,
    }, clientPhone);

    if (!product) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/products/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const deleted = await deleteProductRecord(req.params.id, clientPhone);

    if (!deleted) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/clients', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const client = await createClientRecord({
      name: req.body?.name,
      notas: req.body?.notas,
      debt: req.body?.debt,
    }, clientPhone);

    if (!client) {
      res.status(400).json({ error: 'Nombre de cliente requerido' });
      return;
    }

    res.status(201).json(client);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/clients/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const client = await updateClientRecord(req.params.id, {
      name: req.body?.name,
      notas: req.body?.notas,
      debt: req.body?.debt,
    }, clientPhone);

    if (!client) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    res.json(client);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/clients/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const deleted = await deleteClientRecord(req.params.id, clientPhone);

    if (!deleted) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/clients/merge', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const snapshot = await mergeClientRecords(req.body?.keepId, req.body?.mergeId, clientPhone);

    if (!snapshot) {
      res.status(400).json({ error: 'No se pudieron fusionar los clientes' });
      return;
    }

    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/proveedores', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const proveedor = await createProveedorRecord({
      name: req.body?.name,
      notas: req.body?.notas,
    }, clientPhone);

    if (!proveedor) {
      res.status(400).json({ error: 'Nombre de proveedor requerido' });
      return;
    }

    res.status(201).json(proveedor);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/proveedores/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const proveedor = await updateProveedorRecord(req.params.id, {
      name: req.body?.name,
      notas: req.body?.notas,
    }, clientPhone);

    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }

    res.json(proveedor);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/proveedores/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const deleted = await deleteProveedorRecord(req.params.id, clientPhone);

    if (!deleted) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/proveedores/merge', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const snapshot = await mergeProveedorRecords(req.body?.keepId, req.body?.mergeId, clientPhone);

    if (!snapshot) {
      res.status(400).json({ error: 'No se pudieron fusionar los proveedores' });
      return;
    }

    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/pedidos', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const pedido = await createPedidoRecord({
      clienteId: req.body?.clienteId,
      proveedorId: req.body?.proveedorId,
      producto: req.body?.producto,
      productType: req.body?.productType,
      productModel: req.body?.productModel,
      talle: req.body?.talle,
      qty: req.body?.qty,
      estado: req.body?.estado,
      notas: req.body?.notas,
    }, clientPhone);

    if (!pedido) {
      res.status(400).json({ error: 'Cliente y producto son requeridos' });
      return;
    }

    res.status(201).json(pedido);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/pedidos/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const pedido = await updatePedidoRecord(req.params.id, {
      clienteId: req.body?.clienteId,
      proveedorId: req.body?.proveedorId,
      producto: req.body?.producto,
      productType: req.body?.productType,
      productModel: req.body?.productModel,
      talle: req.body?.talle,
      qty: req.body?.qty,
      estado: req.body?.estado,
      notas: req.body?.notas,
    }, clientPhone);

    if (!pedido) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    res.json(pedido);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/pedidos/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const deleted = await deletePedidoRecord(req.params.id, clientPhone);

    if (!deleted) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/meta-events', authenticateRequest, (_req, res) => {
  const clientPhone = String(_req.auth?.phoneNumber ?? '').trim();

  getMetaEvents(50, clientPhone)
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

app.post('/api/state/apply', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = String(req.auth?.phoneNumber ?? '').trim();
    const sourceText = typeof req.body?.sourceText === 'string' ? req.body.sourceText : '';
    const actions = Array.isArray(req.body?.actions) ? req.body.actions : [];
    const mutationActions = actions.filter((action) => action?.type !== 'query_stock');
    const snapshot = await applyActionsToDatabase(mutationActions, sourceText, clientPhone);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/voice/parse', authenticateRequest, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) {
      res.status(400).json({ error: 'Texto vacío' });
      return;
    }

    const phoneNumber = String(req.auth?.phoneNumber ?? '').trim();
    let businessCategory = null;
    if (phoneNumber) {
      try {
        const profile = await getAuthUserProfile(phoneNumber);
        businessCategory = profile?.businessCategory ?? null;
      } catch (error) {
        console.warn('[voice/parse] failed to load business category:', error instanceof Error ? error.message : error);
      }
    }

    const parsed = await parseVoiceText(text, { businessCategory });

    if (!parsed) {
      res.json({
        schemaVersion: 1,
        sourceText: text,
        intent: 'unknown',
        confidence: 0,
        requiresConfirmation: true,
        actions: [],
      });
      return;
    }

    res.json(parsed);
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

        console.log(`Texto recibido. Intentando responder a: ${fromNumber}`);

        // ACK corto: la confirmación real del resultado se envía al terminar de procesar.
        const responseText = `Procesando tu mensaje, ${senderName}…`;

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
    const results = await processMetaWebhook(req.body ?? {}, {
      resolveBusinessCategory: async (fromNumber) => {
        try {
          const profile = await getAuthUserProfile(fromNumber);
          return profile?.businessCategory ?? null;
        } catch (error) {
          console.warn('[MetaWebhook] business category lookup failed:', error instanceof Error ? error.message : error);
          return null;
        }
      },
      resolveConversationHistory: async (fromNumber, messageId) => {
        try {
          const recentEvents = await getMetaEvents(8, fromNumber);
          return buildConversationTurnsFromEvents(recentEvents, {
            excludeMessageId: messageId,
            maxTurns: 3,
          });
        } catch (error) {
          console.warn('[MetaWebhook] conversation history lookup failed:', error instanceof Error ? error.message : error);
          return [];
        }
      },
    });

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

      const allActions = result.parsed?.actions ?? [];
      const queryActions = allActions.filter((action) => action.type === 'query_stock');
      const mutationActions = allActions.filter((action) => action.type !== 'query_stock');
      const categoryPreset = getBusinessCategoryPreset(result.businessCategory);

      let overrideReplyText = null;
      if (queryActions.length) {
        const snapshot = await getStateSnapshot(result.fromNumber);
        overrideReplyText = queryActions
          .map((action) => answerStockQuery(snapshot.products, action, { variantLabel: categoryPreset.variantLabel }))
          .join('\n\n');
      }

      if (mutationActions.length) {
        await applyActionsToDatabase(mutationActions, result.sourceText, result.fromNumber);
      }

      const finalReplyText = overrideReplyText
        ? (mutationActions.length
          ? `${overrideReplyText}\n\n${result.replyText}`
          : (result.transcript
            ? `${overrideReplyText}\n\nTexto: ${result.transcript}`
            : overrideReplyText))
        : result.replyText;

      eventRecord.replyText = finalReplyText;
      eventRecord.processed = Boolean(queryActions.length || mutationActions.length);

      console.log('[MetaWebhook] response debug:', {
        messageId: incomingId,
        from: result.fromNumber,
        kind: result.kind,
        sourceText: result.sourceText,
        transcript: result.transcript ?? null,
        replyText: finalReplyText,
        actions: result.parsed?.actions ?? [],
      });

      await saveMetaEvent(eventRecord);
      await markMetaEventProcessed(eventRecord.id, { processed: eventRecord.processed });

      // Siempre enviar el resultado final (aunque ya haya habido un ACK de "procesando").
      if (finalReplyText) {
        try {
          const replyResult = await sendMetaReply({
            to: result.fromNumber,
            text: finalReplyText,
          });
          if (!replyResult?.sent) {
            console.warn('[MetaWebhook] reply not sent:', replyResult);
          } else if (result.kind === 'text' && result.messageId && fastRepliedMessageIds.has(result.messageId)) {
            console.log('[MetaWebhook] sent result reply after fast ACK:', result.messageId);
          }
        } catch (replyError) {
          console.error('[MetaWebhook] reply failed for event:', incomingId, replyError);
        }
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
  if (isAuthDevBypassEnabled()) {
    console.log(`[auth:dev] Bypass local activo. Teléfono demo: ${DEV_LOGIN_PHONE}`);
  }
});