import { createMetaWebhookSignatureMiddleware, hasMetaWebhookAppSecret } from './metaWebhookSecurity.js';
import express from 'express';
import dotenv from 'dotenv';
import { InventoryOperationError } from './inventoryOperations.js';
import { buildMetaVerificationResponse, buildConversationTurnsFromEvents, processMetaWebhook, sendMetaReply } from './metaWebhookProcessor.js';
import { transcribeAudio, MAX_AUDIO_BYTES, TranscriptionError } from './audioTranscription.js';
import { acknowledgeMetaMessages } from './metaProcessingAcknowledgement.js';
import { operationErrorMessage } from './interpretationRecovery.js';
import { universalOperationDetail } from './universalMetaOperations.js';
import { requireReviewedUpdateSelection } from './inventorySelections.js';
import { createCommerceRouter } from './commerce/router.js';
import { createPublicCatalogRouters } from './catalog/router.js';
import {
  createProductRecord,
  createProductModelRecords,
  createClientRecord,
  createProveedorRecord,
  createPedidoRecord,
  deleteProductRecord,
  deleteProductRecords,
  deleteClientRecord,
  deleteProveedorRecord,
  deletePedidoRecord,
  recoverPanelOperation,
  executeInventoryOperation,
  executeUniversalOperation,
  publishProductFamily,
  listProductFamilies,
  prepareUniversalDraft,
  processMetaUniversalMessage,
  replayCommittedMetaMessage,
  processRetiredMetaMessage,
  replyUniversalDraft,
  getUniversalDraft,
  confirmUniversalDraft,
  cancelUniversalDraft,
  executeAccountOperation,
  executeOrderOperation,
  findMetaEventById,
  claimMetaMessage,
  completeMetaMessageClaim,
  loadMetaTranscript,
  saveMetaTranscript,
  failMetaMessageClaim,
  claimRecoverableMetaMessages,
  claimPendingMetaReplies,
  enqueueMetaReply,
  finishMetaReply,
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
  previewInventorySelection,
  confirmInventorySelection,
  updateProductModelRecords,
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
  stockyDatabaseRuntime,
} from './postgresDatabase.js';
import { extractBearerToken, getJwtSecret, issueJwt, normalizePhone, verifyJwt } from './auth.js';
import {
  authenticateWaLoginFromWebhook,
  buildWhatsAppLoginUrl,
  claimWaLoginSession,
  createWaLoginSession,
  getWhatsAppLoginNumber,
  isWaLoginCreateRateLimited,
  looksLikeWaLoginMessage,
  parseWaLoginToken,
} from './waLogin.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const app = express();
const port = Number(process.env.PORT || process.env.META_WEBHOOK_PORT || 8080);
const allowedOrigins = new Set([
  'https://erp-voice.vercel.app',
  'http://localhost:5173',
  'http://localhost:5175',
  'http://localhost:4173',
  'http://localhost:3000',
]);
if (process.env.COMMERCE_STUDIO_ORIGIN) {
  const studioOrigin = new URL(process.env.COMMERCE_STUDIO_ORIGIN);
  if (!['https:', 'http:'].includes(studioOrigin.protocol) || studioOrigin.origin !== process.env.COMMERCE_STUDIO_ORIGIN) {
    throw new Error('COMMERCE_STUDIO_ORIGIN must be one exact HTTP(S) origin without a trailing slash.');
  }
  allowedOrigins.add(studioOrigin.origin);
}
const metaVerifyToken = process.env.META_VERIFY_TOKEN || 'erpvoice_token_secreto';
const authEnabled = true;
const DEV_LOGIN_PHONE = normalizePhone(process.env.AUTH_DEV_PHONE || '5491100000000') || '5491100000000';
const isAuthDevBypassEnabled = () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') return false;
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

const metaMessageText = (message) => (typeof message?.text?.body === 'string' ? message.text.body : '');

const consumeWaLoginMessage = async (message, rawBody) => {
  const textBody = metaMessageText(message);
  const loginToken = parseWaLoginToken(textBody);
  const fromNumber = typeof message.from === 'string' ? message.from : '';
  const messageId = typeof message.id === 'string' ? message.id : null;
  if (!loginToken && !looksLikeWaLoginMessage(textBody)) {
    return;
  }

  let claimed = true;
  if (hasDatabaseConfig() && messageId && fromNumber) {
    const ownerPhone = await resolveTenant(fromNumber);
    claimed = await claimMetaMessage({ messageId, ownerPhone, senderPhone: fromNumber, rawBody });
  }

  if (!claimed) {
    return;
  }

  const result = await authenticateWaLoginFromWebhook(loginToken, fromNumber);
  const replyText = waLoginReplyText(result);
  console.log('[auth:wa-login] webhook', {
    token: loginToken,
    from: fromNumber,
    ok: result?.ok,
    reason: result?.reason,
    messageId,
  });

  if (hasDatabaseConfig() && messageId && fromNumber) {
    await enqueueMetaReply(messageId, fromNumber, replyText);
    await completeMetaMessageClaim(messageId);
    return;
  }

  try {
    const replyResult = await sendMetaReply({ to: fromNumber, text: replyText });
    if (!replyResult?.sent) {
      console.warn('[auth:wa-login] reply not sent:', replyResult);
    }
  } catch (error) {
    console.error('[auth:wa-login] reply failed:', error);
  }
};

const stripAndConsumeWaLoginMessages = async (body) => {
  if (!body || body.object !== 'whatsapp_business_account') {
    return body;
  }

  const remaining = JSON.parse(JSON.stringify(body));
  for (const entry of remaining.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!Array.isArray(value?.messages)) {
        continue;
      }

      const kept = [];
      for (const message of value.messages) {
        if (message?.type !== 'text' || !looksLikeWaLoginMessage(metaMessageText(message))) {
          kept.push(message);
          continue;
        }

        try {
          await consumeWaLoginMessage(message, {
            object: body.object,
            entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [message] } }] }],
          });
        } catch (error) {
          console.error('[auth:wa-login] webhook handler failed:', error);
        }
      }
      value.messages = kept;
    }
  }

  return remaining;
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

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use('/api/meta-webhook', express.json({
  inflate: false,
  verify: (req, _res, body) => { req.rawBody = Buffer.from(body); },
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((error, req, res, next) => {
  if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && Number(error.status) === 400)) {
    console.warn('[http] invalid JSON body', { method: req.method, path: req.path });
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }
  next(error);
});

const recentEvents = [];

app.use('/api/commerce/v1', authenticateRequest, createCommerceRouter({ runtime: stockyDatabaseRuntime,
  contextOf: req => ({ businessId: tenantPhoneOf(req), actorId: authPhoneOf(req),
    role: tenantPhoneOf(req) === authPhoneOf(req) ? 'owner' : 'member' }) }));
const publicCatalog = createPublicCatalogRouters(stockyDatabaseRuntime);
app.use('/api/catalog/v1', publicCatalog.api);
app.use(publicCatalog.pages);

app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'meta-webhook', port });
});

app.get('/api/health', (_req, res) => {
  let authReady = true;
  try { getJwtSecret(); } catch { authReady = false; }
  res.json({ ok: true, service: 'meta-webhook', port,
    deployment: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT_SHA || null,
    operationContractVersion: 1,
    metaWebhookReady: hasMetaWebhookAppSecret(process.env.META_APP_SECRET),
    authReady,
  });
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

app.all('/api/settings/voice-stock-batches',authenticateRequest,(_req,res)=>{
  res.status(410).json({code:'LEGACY_WRITER_RETIRED',error:'El modo de lotes anterior fue retirado. Las operaciones usan el flujo universal.'});
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
    res.status(503).json({ error: operationErrorMessage({code:'STATE_UNAVAILABLE'}), code:'STATE_UNAVAILABLE' });
  }
});

app.post('/api/products/model', authenticateRequest, async (req, res) => {
  try {
    const products = await createProductModelRecords(req.body, tenantPhoneOf(req), { actorId: authPhoneOf(req) });
    res.status(201).json(products);
  } catch (error) {
    const status = ['OPERATION_ID_REQUIRED', 'INVALID_OPERATION_PLAN'].includes(error.code) ? 400 : error.name === 'InventoryOperationError' ? 409 : 500;
    res.status(status).json({ error: operationErrorMessage(error), code: error.code });
  }
});

app.post('/api/products', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = tenantPhoneOf(req);

    const product = await createProductRecord(req.body, clientPhone, { actorId: authPhoneOf(req) });

    if (!product) {
      res.status(400).json({ error: operationErrorMessage({code:'INVALID_OPERATION_PLAN'}) });
      return;
    }

    res.status(201).json(product);
  } catch (error) {
    const status = ['OPERATION_ID_REQUIRED', 'INVALID_OPERATION_PLAN'].includes(error.code) ? 400 : error.name === 'InventoryOperationError' ? 409 : 500;
    res.status(status).json({ error: operationErrorMessage(error), code: error.code });
  }
});

app.put('/api/products/model', authenticateRequest, async (req, res) => {
  try {
    const products = await updateProductModelRecords(req.body, tenantPhoneOf(req), { actorId: authPhoneOf(req) });
    res.json(products);
  } catch (error) {
    const status = ['SELECTION_REQUIRED', 'INVALID_SELECTION', 'INVALID_OPERATION_PLAN'].includes(error.code) ? 400
      : error.name === 'InventoryOperationError' ? 409 : 500;
    res.status(status).json({ error: operationErrorMessage(error), code: error.code });
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
      priceCurrency: req.body?.priceCurrency,
      attributes: req.body?.attributes,
      family: req.body?.family,
    }, clientPhone, { operationId: req.body?.operationId, expectedRevision: req.body?.expectedRevision,
      expectedFingerprint: req.body?.expectedFingerprint, reason: req.body?.reason, actorId: authPhoneOf(req) });

    if (!product) {
      res.status(404).json({ error: operationErrorMessage({code:'SKU_NOT_FOUND'}) });
      return;
    }

    res.json(product);
  } catch (error) {
    const status = error.code === 'SKU_NOT_FOUND' ? 404
      : ['OPERATION_ID_REQUIRED', 'INVALID_OPERATION_PLAN'].includes(error.code) ? 400
        : error.name === 'InventoryOperationError' ? 409 : 500;
    res.status(status).json({ error: operationErrorMessage(error), code: error.code });
  }
});

app.delete('/api/products/batch', authenticateRequest, async (req, res) => {
  try {
    const result = await deleteProductRecords(req.body, tenantPhoneOf(req), { actorId: authPhoneOf(req), returnResult: true });
    res.json({ deleted: result.items.length, operationResult: result });
  } catch (error) {
    res.status(error.name === 'InventoryOperationError' ? 409 : 500).json({ error: operationErrorMessage(error), code: error.code });
  }
});

app.delete('/api/products/:id', authenticateRequest, async (req, res) => {
  try {
    const clientPhone = tenantPhoneOf(req);
    if (!req.body || Object.keys(req.body).some((key) => !['selectionId', 'digest'].includes(key))) {
      res.status(409).json({ error: operationErrorMessage({code:'SELECTION_REQUIRED'}), code: 'SELECTION_REQUIRED' }); return;
    }
    const deleted = await deleteProductRecord(req.params.id, clientPhone, { ...req.body, actorId: authPhoneOf(req), returnResult: true });

    if (!deleted) {
      res.status(404).json({ error: operationErrorMessage({code:'SKU_NOT_FOUND'}) });
      return;
    }

    res.json({ deleted: 1, operationResult: deleted });
  } catch (error) {
    res.status(error.name === 'InventoryOperationError' ? 409 : 500).json({ error: operationErrorMessage(error), code: error.code });
  }
});

const accountHttpError = (res,error) => res.status(error.name === 'InventoryOperationError'
  ? error.code === 'INVALID_ACCOUNT_OPERATION' ? 400 : error.code === 'CLIENT_NOT_FOUND' ? 404 : 409 : 500)
  .json({error:operationErrorMessage(error),code:error.code});

app.post('/api/accounts/operations',authenticateRequest,async(req,res)=>{
  try {
    const result=await executeAccountOperation(req.body,{businessId:tenantPhoneOf(req),actorId:authPhoneOf(req),permissions:['accounts:charge','accounts:payment','accounts:adjust','accounts:transfer']});
    res.json(result);
  } catch(error){accountHttpError(res,error);}
});

const partyHttpError = (res, error) => {
  const known = error.name === 'InventoryOperationError';
  const status = !known ? 500 : ['OPERATION_ID_REQUIRED','INVALID_PARTY_OPERATION'].includes(error.code) ? 400
    : ['BUSINESS_SCOPE_REQUIRED','BUSINESS_SCOPE_MISMATCH','FORBIDDEN'].includes(error.code) ? 403 : error.code === 'PARTY_NOT_FOUND' ? 404 : 409;
  return res.status(status).json({error:operationErrorMessage(error),...(known ? {code:error.code} : {})});
};

app.post('/api/clients', authenticateRequest, async (req, res) => {
  try {
    const client = await createClientRecord(req.body, tenantPhoneOf(req), {actorId:authPhoneOf(req)});
    res.status(201).json(client);
  } catch (error) { partyHttpError(res,error); }
});

app.put('/api/clients/:id', authenticateRequest, async (req, res) => {
  try {
    res.json(await updateClientRecord(req.params.id,req.body,tenantPhoneOf(req),{actorId:authPhoneOf(req)}));
  } catch (error) { partyHttpError(res,error); }
});

app.delete('/api/clients/:id', authenticateRequest, async (req, res) => {
  try { res.json(await deleteClientRecord(req.params.id,tenantPhoneOf(req),req.body,{actorId:authPhoneOf(req)})); }
  catch (error) { partyHttpError(res,error); }
});

app.post('/api/clients/merge', authenticateRequest, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => !['keepId','mergeId','operationId','expectedKeepRevision','expectedMergeRevision','expectedKeepMetadataRevision','expectedMergeMetadataRevision'].includes(key)))
      throw new InventoryOperationError('INVALID_ACCOUNT_OPERATION','La fusión contiene campos inválidos.');
    const clientPhone = tenantPhoneOf(req);
    const snapshot = await mergeClientRecords(req.body?.keepId, req.body?.mergeId, clientPhone, {
      operationId:req.body?.operationId,expectedKeepRevision:req.body?.expectedKeepRevision,
      expectedMergeRevision:req.body?.expectedMergeRevision,actorId:authPhoneOf(req),
      expectedKeepMetadataRevision:req.body?.expectedKeepMetadataRevision,expectedMergeMetadataRevision:req.body?.expectedMergeMetadataRevision,
    });

    if (!snapshot) {
      res.status(400).json({ error: 'No se pudieron fusionar los clientes' });
      return;
    }

    res.json(snapshot);
  } catch (error) {
    accountHttpError(res,error);
  }
});

app.post('/api/proveedores', authenticateRequest, async (req, res) => {
  try {
    const proveedor = await createProveedorRecord(req.body, tenantPhoneOf(req), {actorId:authPhoneOf(req)});
    res.status(201).json(proveedor);
  } catch (error) { partyHttpError(res,error); }
});

app.put('/api/proveedores/:id', authenticateRequest, async (req, res) => {
  try {
    res.json(await updateProveedorRecord(req.params.id,req.body,tenantPhoneOf(req),{actorId:authPhoneOf(req)}));
  } catch (error) { partyHttpError(res,error); }
});

app.delete('/api/proveedores/:id', authenticateRequest, async (req, res) => {
  try { res.json(await deleteProveedorRecord(req.params.id,tenantPhoneOf(req),req.body,{actorId:authPhoneOf(req)})); }
  catch (error) { partyHttpError(res,error); }
});

app.post('/api/proveedores/merge', authenticateRequest, async (req, res) => {
  try {
    const {keepId,mergeId,...input} = req.body ?? {};
    res.json(await mergeProveedorRecords(keepId,mergeId,tenantPhoneOf(req),input,{actorId:authPhoneOf(req)}));
  } catch (error) { partyHttpError(res,error); }
});

const orderHttpError = (res, error) => {
  const status = ['OPERATION_ID_REQUIRED', 'INVALID_ORDER_OPERATION'].includes(error.code) ? 400
    : ['ORDER_NOT_FOUND', 'CLIENT_NOT_FOUND', 'SUPPLIER_NOT_FOUND'].includes(error.code) ? 404
    : error.name === 'InventoryOperationError' ? 409 : 500;
  res.status(status).json({ error: operationErrorMessage(error), code: error.code });
};
app.post('/api/pedidos', authenticateRequest, async (req, res) => {
  try {
    const pedido = await createPedidoRecord(req.body, tenantPhoneOf(req), { actorId: authPhoneOf(req) });
    res.status(201).json(pedido);
  } catch (error) { orderHttpError(res, error); }
});
app.put('/api/pedidos/:id', authenticateRequest, async (req, res) => {
  try {
    const pedido = await updatePedidoRecord(req.params.id, req.body, tenantPhoneOf(req), { actorId: authPhoneOf(req) });
    res.json(pedido);
  } catch (error) { orderHttpError(res, error); }
});
app.post('/api/pedidos/:id/reconcile',authenticateRequest,async(req,res)=>{
  try {
    const result=await executeOrderOperation('reconcile',req.params.id,req.body,tenantPhoneOf(req),{actorId:authPhoneOf(req)});
    res.json(result);
  } catch(error){orderHttpError(res,error);}
});
app.delete('/api/pedidos/:id', authenticateRequest, async (req, res) => {
  try {
    const receipt = await deletePedidoRecord(req.params.id, tenantPhoneOf(req), req.body, { actorId: authPhoneOf(req) });
    res.json(receipt);
  } catch (error) { orderHttpError(res, error); }
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

const universalRequestContext = (req) => ({
  businessId:tenantPhoneOf(req),actorId:authPhoneOf(req),channel:'panel',permissions:[
    'inventory:read','orders:read','accounts:read','inventory:schema','inventory:receive','inventory:sell','inventory:reserve','inventory:adjust','inventory:update','inventory:deactivate','inventory:create',
    'accounts:charge','accounts:payment','accounts:adjust','accounts:transfer',
    'clients:create','clients:update','clients:delete','suppliers:create','suppliers:update','suppliers:delete','suppliers:merge',
    'orders:create','orders:update','orders:delete','orders:reconcile',
  ],
});
const universalHttpError = (res,error) => {
  const known = ['InventoryOperationError','ProductFamilySchemaError'].includes(error.name);
  const status = !known ? 500 : ['FORBIDDEN','BUSINESS_SCOPE_MISMATCH'].includes(error.code) ? 403
    : error.code==='INTERPRETATION_UNAVAILABLE' ? 503 : error.code==='INTERPRETATION_INVALID' ? 422
    : ['INVALID_OPERATION_PLAN','INVALID_ACCOUNT_OPERATION','INVALID_PARTY_OPERATION','INVALID_ORDER_OPERATION','INVALID_ORDER_CLIENT_REFERENCE','INVALID_OPERATION_REFERENCE','INVALID_DRAFT_REQUEST','INVALID_PRODUCT_SCHEMA','BUSINESS_SCOPE_REQUIRED','UNSUPPORTED_OPERATION','OPERATION_ID_REQUIRED','MIXED_OPERATION_PLAN_UNSUPPORTED','UNSUPPORTED_OPERATION_ORDER'].includes(error.code) ? 400
    : ['CLIENT_NOT_FOUND','PARTY_NOT_FOUND','SKU_NOT_FOUND','ORDER_NOT_FOUND','SUPPLIER_NOT_FOUND','DRAFT_NOT_FOUND','PRODUCT_SCHEMA_NOT_FOUND'].includes(error.code) ? 404 : 409;
  res.status(status).json({error:operationErrorMessage(known ? error : {code:'OPERATION_UNAVAILABLE'}),code:known ? error.code : 'OPERATION_UNAVAILABLE'});
};
app.post('/api/operation-drafts', authenticateRequest, async (req,res) => {
  try { res.json(await prepareUniversalDraft(req.body,universalRequestContext(req))); }
  catch(error) { universalHttpError(res,error); }
});
app.get('/api/operation-drafts/:id', authenticateRequest, async (req,res) => {
  try { res.json(await getUniversalDraft(req.params.id,universalRequestContext(req))); }
  catch(error) { universalHttpError(res,error); }
});
app.get('/api/operation-drafts/:id/detail', authenticateRequest, async (req,res) => {
  try { res.json(universalOperationDetail(await getUniversalDraft(req.params.id,universalRequestContext(req)))); }
  catch(error) { universalHttpError(res,error); }
});
app.post('/api/operation-drafts/:id/replies', authenticateRequest, async (req,res) => {
  try { res.json(await replyUniversalDraft(req.params.id,req.body,universalRequestContext(req))); }
  catch(error) { universalHttpError(res,error); }
});
app.post('/api/operation-drafts/:id/confirm', authenticateRequest, async (req,res) => {
  try { res.json(await confirmUniversalDraft(req.params.id,req.body,universalRequestContext(req))); }
  catch(error) { universalHttpError(res,error); }
});
app.post('/api/operation-drafts/:id/cancel', authenticateRequest, async (req,res) => {
  try { res.json(await cancelUniversalDraft(req.params.id,req.body,universalRequestContext(req))); }
  catch(error) { universalHttpError(res,error); }
});
app.post('/api/operations', authenticateRequest, async (req,res) => {
  try {
    const result = await executeUniversalOperation(req.body,universalRequestContext(req));
    res.json(result);
  } catch (error) {
    universalHttpError(res,error);
  }
});

app.get('/api/inventory/families', authenticateRequest, async (req,res) => {
  try { res.json({families:await listProductFamilies(universalRequestContext(req))}); }
  catch(error) { universalHttpError(res,error); }
});
app.post('/api/inventory/families', authenticateRequest, async (req,res) => {
  try { res.json(await publishProductFamily(req.body,universalRequestContext(req))); }
  catch(error) { universalHttpError(res,error); }
});

app.post('/api/inventory/operations', authenticateRequest, async (req, res) => {
  try {
    requireReviewedUpdateSelection(req.body);
    const result = await executeInventoryOperation(req.body, {
      businessId: tenantPhoneOf(req), actorId: authPhoneOf(req), permissions: ['inventory:receive', 'inventory:sell', 'inventory:reserve', 'inventory:adjust', 'inventory:update', 'inventory:deactivate', 'inventory:create'],
    });
    res.json(result);
  } catch (error) {
    const status = ['FORBIDDEN', 'BUSINESS_SCOPE_MISMATCH'].includes(error.code) ? 403
      : ['INVALID_OPERATION_PLAN', 'BUSINESS_SCOPE_REQUIRED', 'UNSUPPORTED_OPERATION'].includes(error.code) ? 400
        : error.name === 'InventoryOperationError' ? 409 : 500;
    res.status(status).json({ error: operationErrorMessage(error),
      code: error.name === 'InventoryOperationError' ? error.code : 'INVENTORY_UNAVAILABLE' });
  }
});

app.post('/api/inventory/selections', authenticateRequest, async (req, res) => {
  try {
    const preview = await previewInventorySelection(req.body, {
      businessId: tenantPhoneOf(req), actorId: authPhoneOf(req), permissions: ['inventory:update', 'inventory:deactivate','inventory:adjust'],
    });
    res.json(preview);
  } catch (error) {
    const status = ['FORBIDDEN', 'BUSINESS_SCOPE_MISMATCH'].includes(error.code) ? 403
      : ['INVALID_SELECTION', 'INVALID_OPERATION_PLAN', 'BUSINESS_SCOPE_REQUIRED', 'UNSUPPORTED_OPERATION'].includes(error.code) ? 400
        : error.name === 'InventoryOperationError' ? 409 : 500;
    res.status(status).json({ error: operationErrorMessage(error), code: error.code });
  }
});

app.post('/api/inventory/selections/:id/confirm', authenticateRequest, async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).some((key) => key !== 'digest')) {
      res.status(400).json({ error: operationErrorMessage({code:'INVALID_SELECTION'}), code: 'INVALID_SELECTION' }); return;
    }
    const result = await confirmInventorySelection(req.params.id, req.body.digest, {
      businessId: tenantPhoneOf(req), actorId: authPhoneOf(req), permissions: ['inventory:update', 'inventory:deactivate','inventory:adjust'],
    });
    res.json(result);
  } catch (error) {
    const status = error.name === 'InventoryOperationError' ? 409 : 500;
    res.status(status).json({ error: operationErrorMessage(error), code: error.code });
  }
});

app.post('/api/state/apply', authenticateRequest, async (req, res) => {
  res.status(410).json({code:'LEGACY_WRITER_RETIRED',error:operationErrorMessage({code:'LEGACY_WRITER_RETIRED'})});
});

app.post('/api/operations/recovery',authenticateRequest,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try {res.json(await recoverPanelOperation(req.body,universalRequestContext(req)));}
  catch(error) {
    if(error.code==='INVALID_RECOVERY_REQUEST') return res.status(400).json({code:error.code,error:operationErrorMessage(error)});
    universalHttpError(res,error);
  }
});

// Both historical execution and parsing are closed. Receipt recovery is read-only.
app.post('/api/voice/parse', authenticateRequest, (_req,res) => {
  res.status(410).json({code:'LEGACY_INTERPRETER_RETIRED',error:operationErrorMessage({code:'LEGACY_INTERPRETER_RETIRED'})});
});

const readVoiceAudio=express.raw({type:()=>true,limit:MAX_AUDIO_BYTES});
app.post('/api/voice/transcribe', authenticateRequest, (req,res,next) => {
  res.setHeader('Cache-Control','no-store');
  readVoiceAudio(req,res,error=>{
    if (error) return res.status(error.type==='entity.too.large' ? 413 : 400)
      .json({code:error.type==='entity.too.large' ? 'AUDIO_TOO_LARGE' : 'INVALID_AUDIO',error:operationErrorMessage({code:error.type==='entity.too.large' ? 'AUDIO_TOO_LARGE' : 'INVALID_AUDIO'})});
    next();
  });
}, async (req,res) => {
  try {
    res.json(await transcribeAudio({audio:req.body,contentType:req.get('Content-Type')}));
  } catch(error) {
    const typed=error instanceof TranscriptionError;
    res.status(typed ? error.status : 503).json({code:typed ? error.code : 'TRANSCRIPTION_UNAVAILABLE',
      error:operationErrorMessage(typed ? error : {code:'TRANSCRIPTION_UNAVAILABLE'})});
  }
});

const dispatchPendingMetaReplies = async () => {
  const pending = await claimPendingMetaReplies(20);
  for (const item of pending) {
    try {
      const result = await sendMetaReply({ to: item.recipient, text: item.reply_text });
      if (result?.sent) {
        await finishMetaReply(item.event_id, null, result.messageId);
      } else {
        await finishMetaReply(item.event_id, result?.reason ?? 'send_failed');
      }
    } catch (error) {
      await finishMetaReply(item.event_id, error instanceof Error ? error.message : String(error));
    }
  }
};

const handleMetaWebhook = async (req, res) => {
  const body = req.body ?? {};
  let processingBody = body;

  try {
    processingBody = await stripAndConsumeWaLoginMessages(body);
  } catch (error) {
    console.error('[auth:wa-login] webhook handler failed:', error);
  }
  try {
    await dispatchPendingMetaReplies();
  } catch (error) {
    console.error('[auth:wa-login] outbox dispatch failed:', error);
  }

  try {
    if (processingBody.object === 'whatsapp_business_account') {
      processingBody = JSON.parse(JSON.stringify(processingBody));
      for (const entry of processingBody.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          if (!Array.isArray(value?.messages)) continue;
          const accepted = [];
          for (const message of value.messages) {
            if (!message?.id || !message?.from) {
              continue;
            }
            const ownerPhone = await resolveTenant(message.from);
            const rawBody = { ...processingBody, entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [message] } }] }] };
            const claimed = await claimMetaMessage({ messageId: message.id, ownerPhone, senderPhone: message.from, rawBody });
            if (claimed) accepted.push(message);
          }
          value.messages = accepted;
        }
      }
    }
  } catch (error) {
    console.error('[MetaWebhook] failed to claim inbound message:', error);
    res.sendStatus(503);
    return;
  }
  res.sendStatus(200);

  // Acknowledge every accepted text/audio before transcription or interpretation.
  const fastRepliedMessageIds = await acknowledgeMetaMessages(processingBody, sendMetaReply, error => {
    console.error('[MetaWebhook] fast-reply failed:', error);
  });

  await processClaimedMetaBody(processingBody, fastRepliedMessageIds);
};

const processClaimedMetaBody = async (processingBody, fastRepliedMessageIds = new Set()) => {
  try {
    processingBody = await stripAndConsumeWaLoginMessages(processingBody);
    await dispatchPendingMetaReplies();
  } catch (error) {
    console.error('[auth:wa-login] recovery handler failed:', error);
  }

  try {
    const results = await processMetaWebhook(processingBody, {
      loadTranscript: loadMetaTranscript,
      saveTranscript: saveMetaTranscript,
      processStockText: async ({ sourceText, metaMessage }) => {
        const scope = {sourceText,ownerPhone:await resolveTenant(metaMessage.fromNumber),senderPhone:metaMessage.fromNumber,
          messageId:metaMessage.messageId ?? createEventId(),replyToMessageId:metaMessage.replyToMessageId};
        const committedReply = await replayCommittedMetaMessage(scope);
        if (committedReply) return committedReply;
        const universalReply = await processMetaUniversalMessage(scope);
        if (universalReply) return universalReply;
        const retiredReply = await processRetiredMetaMessage(scope);
        if (retiredReply) return retiredReply;
        return processMetaUniversalMessage(scope,{ordinary:true});
      },
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
          const recentEvents = await getMetaEvents(8, await resolveTenant(fromNumber), { senderPhone: fromNumber });
          return buildConversationTurnsFromEvents(recentEvents, {
            excludeMessageId: messageId,
            maxTurns: 3,
          });
        } catch (error) {
          console.warn('[MetaWebhook] conversation history lookup failed:', error instanceof Error ? error.message : error);
          return [];
        }
      },
      resolveCatalog: async (fromNumber) => {
        try {
          const tenantPhone = await resolveTenant(fromNumber);
          return getStateSnapshot(tenantPhone || fromNumber);
        } catch (error) {
          console.warn('[MetaWebhook] catalog lookup failed:', error instanceof Error ? error.message : error);
          return null;
        }
      },
    });

    for (const result of results) {
      const incomingId = result.messageId ?? createEventId();
      const existingEvent = await findMetaEventById(incomingId);

      if (existingEvent?.processed && existingEvent.replyText) {
        await enqueueMetaReply(result.stockBatchResponse?.replyEventId ?? incomingId, result.fromNumber, existingEvent.replyText);
        await completeMetaMessageClaim(incomingId);
        await dispatchPendingMetaReplies();
        continue;
      }

      const tenantPhone = result.fromNumber ? await resolveTenant(result.fromNumber) : null;
      const stockBatchResponse = result.stockBatchResponse ?? null;

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
        parseContextJson: result.parsed ? JSON.stringify({
          intent: result.parsed.intent,
          missingFields: result.parsed.missingFields ?? [],
        }) : null,
        processed: Boolean(result.parsed?.actions?.length),
      };

      const finalReplyText = stockBatchResponse?.replyText ?? result.replyText;

      eventRecord.replyText = finalReplyText;
      eventRecord.error ??= stockBatchResponse?.errorCode ?? null;
      eventRecord.actionsJson = JSON.stringify(stockBatchResponse?.actions ?? []);
      eventRecord.processed = Boolean(stockBatchResponse);

      console.log('[MetaWebhook] response debug:', {
        messageId: incomingId,
        kind: result.kind,
        batchId: stockBatchResponse?.batchId,
        batchStatus: stockBatchResponse?.batchStatus,
        draftId: stockBatchResponse?.draftId,
        draftStatus: stockBatchResponse?.status,
        draftVersion: stockBatchResponse?.version,
        errorCode: stockBatchResponse?.errorCode,
        interpretationReason: stockBatchResponse?.interpretationReason,
        actionCount: (stockBatchResponse?.actions ?? result.parsed?.actions ?? []).length,
      });

      await saveMetaEvent(eventRecord);
      await markMetaEventProcessed(eventRecord.id, { processed: eventRecord.processed });
      if (finalReplyText) await enqueueMetaReply(stockBatchResponse?.replyEventId ?? incomingId, result.fromNumber, finalReplyText);
      await completeMetaMessageClaim(incomingId);

      // Siempre enviar el resultado final (aunque ya haya habido un ACK de "procesando").
      if (finalReplyText) {
        await dispatchPendingMetaReplies();
        if (result.kind === 'text' && result.messageId && fastRepliedMessageIds.has(result.messageId)) {
          console.log('[MetaWebhook] queued final reply after fast ACK:', result.messageId);
        }
      }

      console.log('[MetaWebhook] processed event:', {
        messageId: incomingId,
        kind: result.kind,
        actions: result.parsed?.actions?.length ?? 0,
      });
    }
  } catch (error) {
    console.error('[MetaWebhook] processing failed:', error);
    for (const entry of processingBody.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          if (message.id) await failMetaMessageClaim(message.id, error.message).catch(() => {});
        }
      }
    }
  }
};

app.post('/api/meta-webhook', createMetaWebhookSignatureMiddleware(), handleMetaWebhook);

setInterval(() => {
  dispatchPendingMetaReplies().catch((error) => {
    console.warn('[MetaWebhook] outbox retry failed:', error instanceof Error ? error.message : error);
  });
  claimRecoverableMetaMessages().then(async (jobs) => {
    for (const job of jobs) await processClaimedMetaBody(job.raw_body_json);
  }).catch((error) => console.warn('[MetaWebhook] inbound recovery failed:', error.message));
}, 30_000).unref();

app.listen(port, process.env.API_BIND_HOST || '0.0.0.0', () => {
  console.log(`[MetaWebhook] listening on port ${port}`);
  console.log('[MetaWebhook] GET /api/meta-webhook for verification');
  console.log('[MetaWebhook] POST /api/meta-webhook for WhatsApp Cloud API messages');
  if (!hasMetaWebhookAppSecret(process.env.META_APP_SECRET)) {
    console.error('[MetaWebhook] META_APP_SECRET no está configurado. Meta recibe 503 y el login por WhatsApp no entra.');
  }
  try {
    getJwtSecret();
  } catch {
    console.error('[auth] AUTH_JWT_SECRET ausente o corto. El panel no puede emitir la sesión después del LOGIN.');
  }
  if (isAuthDevBypassEnabled()) {
    console.log(`[auth:dev] Bypass local activo. Teléfono demo: ${DEV_LOGIN_PHONE}`);
  }
});
