import express from 'express';
import dotenv from 'dotenv';
import { buildMetaVerificationResponse, buildConversationTurnsFromEvents, parseVoiceText, processMetaWebhook, sendMetaReply } from './metaWebhookProcessor.js';
import { getBusinessCategoryPreset } from './businessCategories.js';
import {
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
  getAuthUserProfile,
  getStateSnapshot,
  getMetaEvents,
  markMetaEventProcessed,
  mergeClientRecords,
  mergeProveedorRecords,
  saveBusinessProfile,
  saveMetaEvent,
  upsertAuthUser,
  hasDatabaseConfig,
  updateProductRecord,
  updateClientRecord,
  updateProveedorRecord,
  updatePedidoRecord,
  resolveTenant,
  TeamError,
  createBusinessInvite,
  cancelBusinessInvite,
  acceptBusinessInvite,
  declineBusinessInvite,
  leaveBusinessTeam,
  removeBusinessMember,
  getBusinessTeam,
} from './postgresDatabase.js';
import { extractBearerToken, issueJwt, normalizePhone, verifyJwt } from './auth.js';
import {
  authenticateWaLoginFromWebhook,
  buildWhatsAppLoginUrl,
  claimWaLoginSession,
  createWaLoginSession,
  getWhatsAppLoginNumber,
  isWaLoginCreateRateLimited,
  parseWaLoginToken,
} from './waLogin.js';

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

const createEventId = () => `meta-event-${Math.random().toString(36).slice(2, 10)}`;

const waLoginReplyText = (result) => {
  if (result?.ok && (result.reason === 'authenticated' || result.reason === 'already_authenticated')) {
    return 'Listo ✅ Ya podés volver al panel. Te vamos a dejar entrar ahora.';
  }

  if (result?.reason === 'expired') {
    return 'Ese código venció. Volvé al panel y generá uno nuevo.';
  }

  if (result?.reason === 'already_used') {
    return 'Ese código ya se usó. Si no entraste, generá uno nuevo en el panel.';
  }

  return 'No encontramos un inicio de sesión con ese código. Abrí el panel, tocá Iniciar sesión y mandá el mensaje nuevo.';
};

const handleIncomingWaLogin = async (body) => {
  if (!body || body.object !== 'whatsapp_business_account') {
    return false;
  }

  const entry = Array.isArray(body.entry) ? body.entry[0] : null;
  const changes = entry?.changes?.[0]?.value;
  const message = changes?.messages?.[0];

  if (!message || message.type !== 'text') {
    return false;
  }

  const textBody = typeof message.text?.body === 'string' ? message.text.body : '';
  const loginToken = parseWaLoginToken(textBody);

  if (!loginToken) {
    return false;
  }

  const fromNumber = typeof message.from === 'string' ? message.from : '';
  const result = await authenticateWaLoginFromWebhook(loginToken, fromNumber);
  const replyText = waLoginReplyText(result);

  console.log('[auth:wa-login] webhook', {
    token: loginToken,
    from: fromNumber,
    ok: result?.ok,
    reason: result?.reason,
  });

  try {
    const replyResult = await sendMetaReply({ to: fromNumber, text: replyText });
    if (!replyResult?.sent) {
      console.warn('[auth:wa-login] reply not sent:', replyResult);
    }
  } catch (error) {
    console.error('[auth:wa-login] reply failed:', error);
  }

  return true;
};

const getRequestIp = (req) => {
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  return forwarded.split(',')[0]?.trim() || req.ip || null;
};

const authenticateRequest = async (req, res, next) => {
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

  try {
    req.auth = {
      ...payload,
      tenantPhone: await resolveTenant(payload.phoneNumber),
    };
    next();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
};

const tenantPhoneOf = (req) => String(req.auth?.tenantPhone ?? req.auth?.phoneNumber ?? '').trim();
const authPhoneOf = (req) => String(req.auth?.phoneNumber ?? '').trim();

const sendTeamError = (res, error) => {
  if (error instanceof TeamError) {
    res.status(error.status || 400).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes('inválid') || message.includes('obligatorio') ? 400 : 500;
  res.status(status).json({ error: message });
};

const PUBLIC_APP_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || 'https://erp-voice.vercel.app').replace(/\/$/, '');

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

app.post('/api/auth/wa-login', async (req, res) => {
  try {
    if (isWaLoginCreateRateLimited(getRequestIp(req))) {
      res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto y volvé a probar.' });
      return;
    }

    const whatsappNumber = await getWhatsAppLoginNumber();

    if (!whatsappNumber) {
      res.status(503).json({
        error: 'Falta configurar el número de WhatsApp de Stocky (META_WHATSAPP_NUMBER).',
      });
      return;
    }

    const challenge = await createWaLoginSession();
    const whatsappUrl = buildWhatsAppLoginUrl(whatsappNumber, challenge.loginToken);

    res.json({
      loginToken: challenge.loginToken,
      sessionSecret: challenge.sessionSecret,
      expiresAt: challenge.expiresAt,
      expiresInSeconds: challenge.expiresInSeconds,
      whatsappNumber,
      whatsappUrl,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/auth/wa-login/poll', async (req, res) => {
  try {
    const loginToken = typeof req.body?.loginToken === 'string' ? req.body.loginToken : '';
    const sessionSecret = typeof req.body?.sessionSecret === 'string' ? req.body.sessionSecret : '';
    const claim = await claimWaLoginSession(loginToken, sessionSecret);

    if (!claim.ok) {
      if (claim.reason === 'invalid_secret') {
        res.status(403).json({ error: 'No pudimos validar esta sesión', reason: claim.reason });
        return;
      }

      if (claim.reason === 'missing_fields') {
        res.status(400).json({ error: 'Faltan datos de la sesión', reason: claim.reason });
        return;
      }

      res.json({ status: claim.reason === 'used' ? 'used' : claim.reason === 'expired' ? 'expired' : 'not_found' });
      return;
    }

    if (claim.status === 'pending') {
      res.json({ status: 'pending' });
      return;
    }

    const token = issueJwt({ phoneNumber: claim.phoneNumber });
    res.json({
      status: 'authenticated',
      token,
      tokenType: 'Bearer',
      phoneNumber: claim.phoneNumber,
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
    sendTeamError(res, error);
  }
});

app.get('/api/team', authenticateRequest, async (req, res) => {
  try {
    const team = await getBusinessTeam(authPhoneOf(req));
    res.json(team);
  } catch (error) {
    sendTeamError(res, error);
  }
});

app.post('/api/team/invites', authenticateRequest, async (req, res) => {
  try {
    const ownerPhone = authPhoneOf(req);
    const invitedPhone = normalizePhone(req.body?.phoneNumber);
    const { invite, resent } = await createBusinessInvite(ownerPhone, invitedPhone);
    const ownerProfile = await getAuthUserProfile(ownerPhone);
    const businessName = ownerProfile.businessName || 'un negocio en Stocky';
    const inviteText = `${businessName} te invitó a operar el stock en Stocky. Entrá al panel con este número para aceptar.\n${PUBLIC_APP_URL}`;

    if (isAuthDevBypassEnabled()) {
      console.log(`[team:dev] Invitación para ${invite.invitedPhone}: ${inviteText}`);
      res.status(resent ? 200 : 201).json({
        id: invite.id,
        phoneNumber: invite.invitedPhone,
        expiresAt: invite.expiresAt,
        resent,
        devMode: true,
      });
      return;
    }

    const replyResult = await sendMetaReply({
      to: invite.invitedPhone,
      text: inviteText,
    });

    if (!replyResult?.sent) {
      if (!resent) {
        await cancelBusinessInvite(ownerPhone, invite.id);
      }

      const statusByReason = {
        missing_credentials_or_recipient: 400,
        auth_error: 502,
        recipient_not_allowed: 403,
        recipient_unreachable: 502,
      };

      res.status(statusByReason[replyResult?.reason] ?? 500).json({
        error: describeOtpSendFailure(replyResult).replace('código', 'mensaje de invitación'),
        reason: replyResult?.reason ?? 'unknown',
      });
      return;
    }

    res.status(resent ? 200 : 201).json({
      id: invite.id,
      phoneNumber: invite.invitedPhone,
      expiresAt: invite.expiresAt,
      resent,
    });
  } catch (error) {
    sendTeamError(res, error);
  }
});

app.delete('/api/team/invites/:id', authenticateRequest, async (req, res) => {
  try {
    await cancelBusinessInvite(authPhoneOf(req), req.params.id);
    res.status(204).send();
  } catch (error) {
    sendTeamError(res, error);
  }
});

app.post('/api/team/invites/:id/accept', authenticateRequest, async (req, res) => {
  try {
    const profile = await acceptBusinessInvite(authPhoneOf(req), req.params.id);
    res.json(profile);
  } catch (error) {
    sendTeamError(res, error);
  }
});

app.post('/api/team/invites/:id/decline', authenticateRequest, async (req, res) => {
  try {
    const profile = await declineBusinessInvite(authPhoneOf(req), req.params.id);
    res.json(profile);
  } catch (error) {
    sendTeamError(res, error);
  }
});

app.delete('/api/team/members/:phone', authenticateRequest, async (req, res) => {
  try {
    await removeBusinessMember(authPhoneOf(req), req.params.phone);
    res.status(204).send();
  } catch (error) {
    sendTeamError(res, error);
  }
});

app.post('/api/team/leave', authenticateRequest, async (req, res) => {
  try {
    const profile = await leaveBusinessTeam(authPhoneOf(req));
    res.json(profile);
  } catch (error) {
    sendTeamError(res, error);
  }
});

app.get('/api/state', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = tenantPhoneOf(req);
    const snapshot = await getStateSnapshot(clientPhone);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/products', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = tenantPhoneOf(req);

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
    const clientPhone = tenantPhoneOf(req);

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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
    const clientPhone = tenantPhoneOf(req);
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
  const clientPhone = tenantPhoneOf(_req);

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
    const clientPhone = tenantPhoneOf(req);
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
  const body = req.body ?? {};

  try {
    const handledLogin = await handleIncomingWaLogin(body);
    if (handledLogin) {
      return;
    }
  } catch (error) {
    console.error('[auth:wa-login] webhook handler failed:', error);
  }

  // Enviar ACK rápido para mensajes de texto para que el usuario reciba respuesta inmediata
  try {
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
          const recentEvents = await getMetaEvents(8, null, { senderPhone: fromNumber });
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

      const tenantPhone = result.fromNumber ? await resolveTenant(result.fromNumber) : null;

      const eventRecord = {
        id: incomingId,
        at: new Date().toISOString(),
        fromNumber: result.fromNumber ?? null,
        ownerPhone: tenantPhone,
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
        const snapshot = await getStateSnapshot(tenantPhone || result.fromNumber);
        overrideReplyText = queryActions
          .map((action) => answerStockQuery(snapshot.products, action, { variantLabel: categoryPreset.variantLabel }))
          .join('\n\n');
      }

      if (mutationActions.length) {
        await applyActionsToDatabase(mutationActions, result.sourceText, tenantPhone || result.fromNumber);
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