import dotenv from 'dotenv';
import crypto from 'crypto';
import { Pool } from 'pg';
import { normalizePhone, getWhatsAppVariants } from './phone.js';
import { productMatchKey, normalizeProductMetadata } from './productIdentity.js';
import { validateStockDraft, hasExplicitStockSize, productFingerprint, stockReferenceIssues, explicitIdentityConflict } from './voiceStockEngine.js';
import { INVENTORY_SCHEMA_SQL, executeInventoryPlanInTransaction, inventoryRowToProduct } from './inventoryPostgres.js';
import { validateOperationPlan, InventoryOperationError } from './inventoryOperations.js';
import { resolvedStockBatchToPlan, confirmedStockActionsToPlan, productUpdateActions } from './stockOperationAdapter.js';
import { inventoryResultActions, inventoryResultReply } from './inventoryResults.js';
import { normalizeSelectionRequest, selectionRequestDigest, buildSelectionPreview, requireReviewedUpdateSelection } from './inventorySelections.js';
import { parseMetaSelectionCommand, parseMetaDeactivationCommand, metaDeactivationReceiptReply } from './inventoryMetaSelections.js';
import { META_SELECTION_SCHEMA_SQL, prepareMetaSelectionInTransaction, processMetaSelectionInTransaction } from './inventoryMetaSelectionPostgres.js';
import { productCreationToPlan } from './productCreationAdapter.js';
import { ORDER_SCHEMA_SQL, orderRowToPedido, executeOrderInTransaction } from './orderPostgres.js';
import { canonicalIdentityText } from './inventoryDomain.js';
import { orderRequestDigest } from './orderOperations.js';
import { ACCOUNT_SCHEMA_SQL, executeAccountPlanInTransaction } from './accountPostgres.js';
import { operationRequestDigest } from './operationHash.js';
import { operationResultActions } from './operationResults.js';
import { recoverLegacyPanelOperation } from './operationRecovery.js';
import { validateAccountPlan } from './accountOperations.js';
import { mergeClientsInTransaction } from './clientMergePostgres.js';
import { UNIVERSAL_SCHEMA_SQL, executeUniversalPlanInTransaction } from './universalPostgres.js';
import { prepareUniversalOperation } from './universalOperations.js';
import { interpretUniversalIntent } from './universalIntentInterpreter.js';
import { buildUniversalOperationReview } from './universalOperationReview.js';
import { authorizeUniversalQueries } from './universalQueries.js';
import { parseUniversalMetaCommand } from './universalMetaOperations.js';
import { isRetiredMetaControl, LEGACY_META_RETIRED_REPLY, replayLegacyMetaBatch } from './legacyMetaRetirement.js';
import { UNIVERSAL_META_SCHEMA_SQL, normalizeUniversalMetaInput, findUniversalMetaCommand,
  findUniversalMetaDraft, executeUniversalMetaInTransaction } from './universalMetaPostgres.js';
import { PRODUCT_FAMILY_SCHEMA_SQL, authorizeProductFamilies, loadProductFamilySchemas, publishProductFamilyInTransaction } from './productFamilyPostgres.js';
import { UNIVERSAL_CONVERSATION_SCHEMA_SQL, authorizeUniversalConversation, normalizeDraftRequest,
  findDraftCommand, readUniversalDraft, persistUniversalInterpretation,
  confirmUniversalDraftInTransaction, cancelUniversalDraftInTransaction } from './universalConversationPostgres.js';
import { PARTY_SCHEMA_SQL, executePartyPlanInTransaction, partyRowToEntity } from './partyPostgres.js';
import { partyCreationToPlan, partyUpdateToPlan, partyDeleteToPlan, supplierMergeToPlan, validatePartyPlan } from './partyOperations.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const DEFAULT_OWNER_PHONE = '__default__';
const AUTH_OTP_TTL_MS = Math.max(5, Number(process.env.AUTH_OTP_TTL_MINUTES ?? 10)) * 60 * 1000;
const AUTH_OTP_MAX_ATTEMPTS = 5;
const BUSINESS_INVITE_TTL_MS = Math.max(1, Number(process.env.BUSINESS_INVITE_TTL_DAYS ?? 7)) * 24 * 60 * 60 * 1000;

const memoryMembers = new Map();
const memoryInvites = new Map();
const memoryVoiceStockBatchModes = new Map();

export class TeamError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TeamError';
    this.status = status;
  }
}

const normalizeOwnerPhone = (value) => {
  const normalized = normalizePhone(value);
  return normalized.length ? normalized : DEFAULT_OWNER_PHONE;
};


const normalizeAuthPhoneNumber = normalizePhone;

const createOtpCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const createChallengeId = () => `otp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const createChallengeHash = (phoneNumber, otpCode, salt) =>
  crypto.createHash('sha256').update(`${phoneNumber}:${otpCode}:${salt}`).digest('hex');

const isSameHex = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ''), 'hex');
  const rightBuffer = Buffer.from(String(right ?? ''), 'hex');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const tenantSuffix = (ownerPhone) =>
  normalizeOwnerPhone(ownerPhone)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'default';

export const hasDatabaseConfig = () => Boolean(getConnectionString());

const getConnectionString = () =>
  process.env.SUPABASE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_CONNECTION_STRING ||
  '';

const shouldUseSsl = () => {
  const connectionString = getConnectionString();
  if (process.env.POSTGRES_SSL === 'false') {
    return false;
  }

  if (/sslmode=require/i.test(connectionString) || /supabase\.co/i.test(connectionString)) {
    return true;
  }

  if (process.env.POSTGRES_SSL === 'true') {
    return true;
  }

  if (!connectionString) {
    return false;
  }

  return !/localhost|127\.0\.0\.1|::1/i.test(connectionString);
};

let pool;
let initializePromise;

const getPool = () => {
  const connectionString = getConnectionString();

  if (!connectionString) {
    throw new Error('Missing PostgreSQL connection string. Set SUPABASE_DATABASE_URL or DATABASE_URL in your environment.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false,
    });
  }

  return pool;
};

const ensureReady = async () => {
  if (!initializePromise) {
    initializePromise = initializeDatabase().catch((error) => {
      initializePromise = undefined;
      throw error;
    });
  }

  return initializePromise;
};

export const migrateDatabase = () => ensureReady();

const withClient = async (callback) => {
  const client = await getPool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
};

const normalizeText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const titleCase = (value) =>
  String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

const singularizeProductType = (value) => {
  const trimmed = String(value ?? '').trim();

  if (trimmed.length <= 3) {
    return titleCase(trimmed);
  }

  if (trimmed.endsWith('es')) {
    return titleCase(trimmed.slice(0, -2));
  }

  if (trimmed.endsWith('s')) {
    return titleCase(trimmed.slice(0, -1));
  }

  return titleCase(trimmed);
};

const composeProductName = ({ productType, productModel, size, fallback }) => {
  const values = [productType, productModel, size]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  if (values.length) {
    return values.join(' ');
  }

  return String(fallback ?? '').trim();
};

const parseProductDescriptor = (value) => {
  const normalized = normalizeText(value).replace(/\s+/g, ' ').trim();
  const sizeMatch = normalized.match(/(?:,\s*|\s+)(?:talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes)\s+([a-z0-9\/]+)\b/i);
  const size = sizeMatch ? sizeMatch[1].toUpperCase() : undefined;
  const withoutSize = normalized.replace(/(?:,\s*|\s+)(?:talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes)\s+[a-z0-9\/]+\b/i, '').trim();
  const garmentMatch = withoutSize.match(/^(camisetas?|buzos?|shorts?|remeras?|pantalones?|camperas?)\s+(?:de(?:l)?\s+)?(.+)$/i);
  const rawProductType = garmentMatch ? garmentMatch[1] : (withoutSize.split(/\s+de\s+/i)[0] ?? withoutSize);
  const rawProductModel = garmentMatch
    ? garmentMatch[2]
    : withoutSize.split(/\s+de\s+/i).slice(1).join(' de ') || undefined;

  const productType = rawProductType ? singularizeProductType(rawProductType) : undefined;
  const productModel = rawProductModel ? titleCase(rawProductModel) : undefined;

  return {
    productType,
    productModel,
    size,
    productName: composeProductName({ productType, productModel, size, fallback: value }),
  };
};

const slugify = (value) =>
  normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'nuevo-producto';

const normalizeNullableString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const normalizeInteger = (value, defaultValue = 0) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : defaultValue;
};

const parseJsonValue = (value) => {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
};

const toJsonbParam = (value) => {
  if (value == null) {
    return null;
  }

  return JSON.stringify(parseJsonValue(value));
};

const rowToProduct = (row) => {
  const product = {
  id: row.id,
  ownerPhone: row.owner_phone,
  name: row.name,
  productType: row.product_type,
  productModel: row.product_model,
  size: row.size,
  stockAvailable: Number(row.stock_available ?? 0),
  stockReserved: Number(row.stock_reserved ?? 0),
  price: Number(row.price ?? 0),
  attributes: row.attributes_json ?? {},
  unit: row.inventory_unit ?? 'unit',
  status: row.inventory_status ?? 'active',
  revision: Number(row.inventory_revision ?? 0),
  priceCurrency: row.price_currency ?? 'XXX',
  ...(row.family_id == null ? {} : {family:{id:row.family_id,version:Number(row.family_version)}}),
  };
  return { ...normalizeProductMetadata(product), identityFingerprint: productFingerprint(product) };
};

const rowToClient = (row) => partyRowToEntity(row,true);
const rowToProveedor = (row) => partyRowToEntity(row,false);

const rowToPedido = orderRowToPedido;

const rowToTransaction = (row) => ({
  id: row.id,
  ownerPhone: row.owner_phone,
  timestamp: row.timestamp,
  sourceText: row.source_text,
  summary: row.summary,
  actions: parseJsonValue(row.actions_json) ?? [],
});

const rowToMetaEvent = (row) => ({
  id: row.id,
  ownerPhone: row.owner_phone,
  at: row.at,
  from: row.from_number,
  body: row.body,
  numMedia: Number(row.num_media ?? 0),
  kind: row.kind,
  sourceText: row.source_text,
  transcript: row.transcript,
  replyText: row.reply_text,
  error: row.error,
  actions: parseJsonValue(row.actions_json),
  parseContext: parseJsonValue(row.parse_context_json),
  processed: Boolean(row.processed),
});


const queryRows = async (text, params = [], client = null) => {
  const executor = client ?? getPool();
  const result = await executor.query(text, params);
  return result.rows;
};

const queryRow = async (text, params = [], client = null) => {
  const rows = await queryRows(text, params, client);
  return rows[0] ?? null;
};

const initializeDatabase = async () => {
  const poolInstance = getPool();

  await poolInstance.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL DEFAULT '__default__',
      name TEXT NOT NULL,
      product_type TEXT,
      product_model TEXT,
      size TEXT,
      stock_available INTEGER NOT NULL DEFAULT 0,
      stock_reserved INTEGER NOT NULL DEFAULT 0,
      price INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL DEFAULT '__default__',
      name TEXT NOT NULL,
      debt INTEGER NOT NULL DEFAULT 0,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS proveedores (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL DEFAULT '__default__',
      name TEXT NOT NULL,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL DEFAULT '__default__',
      cliente_id TEXT NOT NULL,
      proveedor_id TEXT,
      producto TEXT NOT NULL,
      product_type TEXT,
      product_model TEXT,
      talle TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      fecha_pedido TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL DEFAULT '__default__',
      timestamp TIMESTAMPTZ NOT NULL,
      source_text TEXT NOT NULL,
      summary TEXT NOT NULL,
      actions_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_stock_batches (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL,
      sender_phone TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source_text TEXT NOT NULL,
      business_category TEXT,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      reply_text TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(owner_phone, source_message_id)
    );

    CREATE TABLE IF NOT EXISTS meta_message_claims (
      message_id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL,
      sender_phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS meta_reply_outbox (
      event_id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );
    ALTER TABLE meta_reply_outbox ADD COLUMN IF NOT EXISTS stock_batch_id TEXT;
    ALTER TABLE meta_reply_outbox ADD COLUMN IF NOT EXISTS question_id TEXT;
    ALTER TABLE meta_reply_outbox ADD COLUMN IF NOT EXISTS provider_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS meta_reply_provider_ids_idx ON meta_reply_outbox USING GIN (provider_message_ids);

    CREATE TABLE IF NOT EXISTS voice_stock_batch_settings (
      owner_phone TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('active', 'shadow', 'disabled')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS voice_stock_shadow_runs (
      message_id TEXT PRIMARY KEY, owner_phone TEXT NOT NULL,
      proposed_json JSONB NOT NULL, baseline_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

        CREATE TABLE IF NOT EXISTS meta_events (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL DEFAULT '__default__',
      at TIMESTAMPTZ NOT NULL,
      from_number TEXT,
      body TEXT,
      num_media INTEGER NOT NULL DEFAULT 0,
      kind TEXT,
      source_text TEXT,
      transcript TEXT,
      reply_text TEXT,
      error TEXT,
      actions_json JSONB,
      parse_context_json JSONB,
      processed BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS auth_users (
      phone_number TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      business_name TEXT,
      business_category TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_otp_challenges (
      id TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_wa_challenges (
      login_token TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      phone_number TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      authenticated_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ
    );

    ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS notas TEXT;
    ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS notas TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS batch_id TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS item_id TEXT;
    ALTER TABLE meta_message_claims ADD COLUMN IF NOT EXISTS raw_body_json JSONB;
    ALTER TABLE meta_message_claims ADD COLUMN IF NOT EXISTS transcript TEXT;
    ALTER TABLE meta_message_claims ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE meta_message_claims ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE meta_message_claims ADD COLUMN IF NOT EXISTS last_error TEXT;
    ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS parse_context_json JSONB;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS proveedor_id TEXT;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS business_name TEXT;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS business_category TEXT;

    CREATE TABLE IF NOT EXISTS business_members (
      tenant_phone TEXT NOT NULL,
      member_phone TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_phone, member_phone)
    );

    CREATE TABLE IF NOT EXISTS business_invites (
      id TEXT PRIMARY KEY,
      tenant_phone TEXT NOT NULL,
      invited_phone TEXT NOT NULL,
      invited_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_business_members_member_phone ON business_members (member_phone);
    CREATE INDEX IF NOT EXISTS idx_business_members_tenant_phone ON business_members (tenant_phone);
    CREATE INDEX IF NOT EXISTS idx_business_invites_invited_phone ON business_invites (invited_phone);
    CREATE INDEX IF NOT EXISTS idx_business_invites_tenant_phone ON business_invites (tenant_phone);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_business_invites_pending_phone ON business_invites (invited_phone) WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_products_owner_phone ON products (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_clients_owner_phone ON clients (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_proveedores_owner_phone ON proveedores (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_pedidos_owner_phone ON pedidos (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id ON pedidos (cliente_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_proveedor_id ON pedidos (proveedor_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos (estado);
    CREATE INDEX IF NOT EXISTS idx_transactions_owner_phone ON transactions (owner_phone);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_batch_item ON transactions (batch_id, item_id) WHERE batch_id IS NOT NULL AND item_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_voice_stock_batches_sender ON voice_stock_batches (owner_phone, sender_phone, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_stock_batches_active_sender ON voice_stock_batches (owner_phone, sender_phone) WHERE status IN ('awaiting_choice', 'awaiting_correction', 'ready');
    CREATE INDEX IF NOT EXISTS idx_meta_events_at ON meta_events (at DESC);
    CREATE INDEX IF NOT EXISTS idx_meta_events_owner_phone ON meta_events (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_auth_otp_phone_number ON auth_otp_challenges (phone_number);
    CREATE INDEX IF NOT EXISTS idx_auth_otp_expires_at ON auth_otp_challenges (expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_wa_expires_at ON auth_wa_challenges (expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_wa_status ON auth_wa_challenges (status);

    ${INVENTORY_SCHEMA_SQL}
    ${ORDER_SCHEMA_SQL}
    ${ACCOUNT_SCHEMA_SQL}
    ${PARTY_SCHEMA_SQL}
    ${UNIVERSAL_SCHEMA_SQL}
    ${UNIVERSAL_CONVERSATION_SCHEMA_SQL}
    ${UNIVERSAL_META_SCHEMA_SQL}
    ${PRODUCT_FAMILY_SCHEMA_SQL}
    ${META_SELECTION_SCHEMA_SQL}

    DO $$
    DECLARE
      tbl text;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'products',
        'clients',
        'proveedores',
        'pedidos',
        'transactions',
        'voice_stock_batches',
        'inventory_operations',
        'party_operations',
        'universal_operations',
        'universal_drafts',
        'universal_draft_commands',
        'universal_meta_commands',
        'product_family_schemas',
        'product_family_operations',
        'order_operations',
        'account_operations',
        'account_movements',
        'inventory_selections',
        'meta_selection_commands',
        'inventory_movements',
        'meta_message_claims',
        'meta_reply_outbox',
        'voice_stock_batch_settings',
        'voice_stock_shadow_runs',
        'meta_events',
        'auth_users',
        'auth_otp_challenges',
        'auth_wa_challenges',
        'business_members',
        'business_invites'
      ]
      LOOP
        IF to_regclass(format('public.%I', tbl)) IS NULL THEN
          CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', tbl);
        END IF;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', tbl);
        END IF;
      END LOOP;
    END $$;
  `);

  await withClient(async (client) => {
    await ensureTenantState(client, DEFAULT_OWNER_PHONE);
  });
};

const normalizeTextArray = (values) => values.filter(Boolean);

const getOwnerPhoneVariants = (ownerPhone) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const rawPhone = normalizePhone(ownerPhone);
  const variants = new Set([normalizedOwnerPhone]);

  if (rawPhone) {
    for (const variant of getWhatsAppVariants(rawPhone)) {
      if (variant) {
        variants.add(variant);
      }
    }
  }

  return [...variants];
};

const ensureTenantState = async (client, ownerPhone) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const variants = getOwnerPhoneVariants(ownerPhone).filter((value) => value !== normalizedOwnerPhone);

  if (variants.length) {
    const tables = ['products', 'clients', 'proveedores', 'pedidos', 'transactions', 'meta_events'];
    for (const table of tables) {
      await client.query(
        `UPDATE ${table} SET owner_phone = $1 WHERE owner_phone = ANY($2)`,
        [normalizedOwnerPhone, variants],
      );
    }
  }

  return normalizedOwnerPhone;
};

const queryAllState = async (ownerPhone = DEFAULT_OWNER_PHONE, client = null, { includeInactive = false } = {}) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  const productsRows = await queryRows(
    "SELECT * FROM products WHERE owner_phone = ANY($1) AND ($2 OR inventory_status='active') ORDER BY name ASC",
    [ownerPhoneVariants, includeInactive],
    client,
  );
  const clientsRows = await queryRows(
    'SELECT * FROM clients WHERE owner_phone = ANY($1) ORDER BY name ASC',
    [ownerPhoneVariants],
    client,
  );
  const proveedoresRows = await queryRows(
    'SELECT * FROM proveedores WHERE owner_phone = ANY($1) ORDER BY name ASC',
    [ownerPhoneVariants],
    client,
  );
  const pedidosRows = await queryRows(
    `SELECT *
     FROM pedidos WHERE owner_phone = ANY($1)
     ORDER BY fecha_pedido DESC`,
    [ownerPhoneVariants],
    client,
  );
  const transactionsRows = await queryRows(
      'SELECT id, owner_phone, timestamp, source_text, summary, actions_json FROM transactions WHERE owner_phone = ANY($1) ORDER BY timestamp DESC',
      [ownerPhoneVariants],
      client,
    );

  return {
    products: productsRows.map(rowToProduct),
    clients: clientsRows.map(rowToClient),
    proveedores: proveedoresRows.map(rowToProveedor),
    pedidos: pedidosRows.map(rowToPedido),
    transactions: transactionsRows.map(rowToTransaction),
  };
};

const normalizeTextList = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 2 && !['para', 'con', 'del', 'las', 'los', 'una', 'uno', 'por', 'les', 'de', 'el', 'la', 'y', 's', 'm', 'l', 'xl', 'xxl', 'titular', 'suplente', 'camiseta', 'talle'].includes(token));

const resolveProduct = (products, actionName) => {
  const actionGarmentKey = productMatchKey(actionName);
  if (actionGarmentKey) {
    const actionSize = normalizeNullableString(actionName.size);
    const exactGarments = products.filter((product) =>
      productMatchKey(product) === actionGarmentKey &&
      (!actionSize || normalizeText(product.size) === normalizeText(actionSize)),
    );
    if (exactGarments.length === 1) {
      return exactGarments[0];
    }
  }
  const actionTokens = normalizeTextList(actionName.productName);
  const actionLower = normalizeText(actionName.productName);
  const hasMetadata = Boolean(
    normalizeNullableString(actionName.productType) ||
    normalizeNullableString(actionName.productModel) ||
    normalizeNullableString(actionName.size)
  );

  if (!actionTokens.length) {
    return null;
  }

  let bestProduct = null;
  let bestScore = 0;
  let bestSpecificScore = 0;

  for (const product of products) {
    const normalizedProduct = normalizeProductMetadata(product);
    if (hasMetadata) {
      const productType = normalizeNullableString(normalizedProduct.productType);
      const productModel = normalizeNullableString(normalizedProduct.productModel);
      const productSize = normalizeNullableString(product.size);
      const actionSize = normalizeNullableString(actionName.size);

      if (normalizeNullableString(actionName.productType) && productType !== normalizeNullableString(actionName.productType)) {
        continue;
      }

      if (normalizeNullableString(actionName.productModel) && productModel !== normalizeNullableString(actionName.productModel)) {
        continue;
      }

      if (actionSize && normalizeText(productSize) !== normalizeText(actionSize)) {
        continue;
      }
    }

    const productTokens = normalizeTextList(product.name);
    const productLower = normalizeText(product.name);

    if (productLower.includes(actionLower) || actionLower.includes(productLower)) {
      return product;
    }

    const matchingTokens = actionTokens.filter((token) => productTokens.includes(token));
    const score = matchingTokens.length;
    const exactSizeMatch = normalizeNullableString(actionName.size) && normalizeNullableString(product.size)
      ? normalizeNullableString(actionName.size) === normalizeNullableString(product.size)
      : false;
    const specificScore = matchingTokens.length + (exactSizeMatch ? 1 : 0);

    if (score > bestScore || (score === bestScore && specificScore > bestSpecificScore)) {
      bestScore = score;
      bestSpecificScore = specificScore;
      bestProduct = product;
    }
  }

  if (hasMetadata) {
    return bestProduct;
  }

  if (bestScore < 2 || bestSpecificScore < 1) {
    return null;
  }

  return bestProduct;
};

const scoreNameMatch = (candidateName, queryName) => {
  const candidate = normalizeText(candidateName).replace(/\bde\b/g, ' ').replace(/\s+/g, ' ').trim();
  const query = normalizeText(queryName).replace(/\bde\b/g, ' ').replace(/\s+/g, ' ').trim();

  if (!candidate || !query) {
    return 0;
  }

  if (candidate === query || candidate.includes(query) || query.includes(candidate)) {
    return 100;
  }

  const candidateTokens = candidate.split(/\s+/).filter((token) => token.length > 1);
  const queryTokens = query.split(/\s+/).filter((token) => token.length > 1);
  if (!queryTokens.length) {
    return 0;
  }

  const matches = queryTokens.filter((token) => candidateTokens.some((part) => part.includes(token) || token.includes(part)));
  return matches.length;
};

const resolveProductFlexible = (products, action) => {
  const wantedName = normalizeText(action.productName).replace(/\s+/g, ' ').trim();
  const exactNames = products.filter((product) =>
    normalizeText(product.name).replace(/\s+/g, ' ').trim() === wantedName,
  );
  if (exactNames.length === 1) {
    return exactNames[0];
  }

  const exact = resolveProduct(products, action);
  if (exact) {
    return exact;
  }

  let best = null;
  let bestScore = 0;

  for (const product of products) {
    const score = Math.max(
      scoreNameMatch(product.name, action.productName),
      scoreNameMatch([product.productType, product.productModel, product.size].filter(Boolean).join(' '), action.productName),
    );
    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }

  return bestScore >= 1 ? best : null;
};

const includesNormalized = (candidate, query) => {
  const candidateNorm = normalizeText(candidate).replace(/\s+/g, ' ').trim();
  const queryNorm = normalizeText(query).replace(/\s+/g, ' ').trim();
  if (!candidateNorm || !queryNorm) {
    return false;
  }
  return candidateNorm.includes(queryNorm) || queryNorm.includes(candidateNorm);
};

const MATCH_STOPWORDS = new Set([
  'para',
  'con',
  'del',
  'las',
  'los',
  'una',
  'uno',
  'por',
  'les',
  'de',
  'el',
  'la',
  'y',
  'en',
  'un',
  'the',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'camiseta',
  'camisetas',
  'talle',
  'talles',
  'version',
  'producto',
  'productos',
]);

const queryTokensFrom = (value) =>
  normalizeText(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 1 && !MATCH_STOPWORDS.has(token));

const productContainsAllTokens = (product, tokens) => {
  if (!tokens.length) {
    return false;
  }

  const hay = normalizeText(
    [product.name, product.productType, product.productModel, product.size].filter(Boolean).join(' '),
  );
  const hayTokens = hay
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);

  return tokens.every(
    (token) =>
      hay.includes(token) ||
      hayTokens.some(
        (part) => part === token || (token.length >= 3 && part.length >= 3 && (part.includes(token) || token.includes(part))),
      ),
  );
};

const filterByExplicitSize = (products, action) => {
  const explicitSize = normalizeNullableString(action.size);
  if (!explicitSize || explicitSize === '*') {
    return products;
  }
  return products.filter((product) => {
    const productSize = normalizeNullableString(product.size);
    return productSize && (productSize === explicitSize || includesNormalized(productSize, explicitSize));
  });
};

const LIST_ALL_STOCK_NAMES = new Set([
  '*',
  'all',
  'todo',
  'todos',
  'todas',
  'inventario',
  'productos',
  'stock',
  'todos los productos',
  'todas los productos',
  'todo el stock',
  'todo el inventario',
  'el inventario',
  'el stock',
  'stock completo',
  'inventario completo',
]);

const MAX_STOCK_REPLY_CHARS = 3800;
const SIZE_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];

export const isListAllStockQuery = (action) => {
  if (!action || action.productType || action.productModel) {
    return false;
  }
  const name = normalizeText(String(action.productName ?? '')).replace(/\s+/g, ' ').trim();
  return LIST_ALL_STOCK_NAMES.has(name);
};

const truncateStockReply = (text) => {
  if (String(text ?? '').length <= MAX_STOCK_REPLY_CHARS) {
    return text;
  }
  return `${String(text).slice(0, Math.max(0, MAX_STOCK_REPLY_CHARS - 22)).trim()}\n… (listado recortado)`;
};

const compareSizes = (left, right) => {
  const leftSize = normalizeText(left ?? '');
  const rightSize = normalizeText(right ?? '');
  const leftIndex = SIZE_ORDER.indexOf(leftSize);
  const rightIndex = SIZE_ORDER.indexOf(rightSize);
  if (leftIndex >= 0 && rightIndex >= 0) {
    return leftIndex - rightIndex;
  }
  if (leftIndex >= 0) {
    return -1;
  }
  if (rightIndex >= 0) {
    return 1;
  }
  return String(left ?? '').localeCompare(String(right ?? ''), 'es', { numeric: true });
};

export const matchProductsForQuery = (products, action) => {
  if (!Array.isArray(products) || !products.length || !action) {
    return [];
  }

  const actionType = normalizeNullableString(action.productType);
  const actionModel = normalizeNullableString(action.productModel);
  const actionName = String(action.productName ?? '').trim();

  if (isListAllStockQuery(action)) {
    return filterByExplicitSize(products.slice(), action);
  }

  const matchesType = (product) => {
    const productType = normalizeNullableString(product.productType);
    const productName = String(product.name ?? '');
    return !actionType
      || (productType && includesNormalized(productType, actionType))
      || includesNormalized(productName, actionType);
  };

  if (actionType || actionModel) {
    const modelTokens = actionModel ? queryTokensFrom(actionModel) : [];
    const filtered = products.filter((product) => {
      if (!matchesType(product)) {
        return false;
      }
      if (!actionModel) {
        return true;
      }
      if (modelTokens.length) {
        return productContainsAllTokens(product, modelTokens);
      }
      const productModel = normalizeNullableString(product.productModel);
      const productName = String(product.name ?? '');
      return (productModel && includesNormalized(productModel, actionModel))
        || includesNormalized(productName, actionModel);
    });
    return filterByExplicitSize(filtered, action);
  }

  if (!actionName) {
    return [];
  }

  const nameTokens = queryTokensFrom(actionName);
  if (nameTokens.length) {
    const subset = products.filter((product) => productContainsAllTokens(product, nameTokens));
    if (subset.length) {
      return filterByExplicitSize(subset, action);
    }
  }

  const actionTokens = normalizeTextList(actionName);
  const scored = [];

  for (const product of products) {
    const score = Math.max(
      scoreNameMatch(product.name, actionName),
      scoreNameMatch([product.productType, product.productModel, product.size].filter(Boolean).join(' '), actionName),
      actionTokens.length
        ? actionTokens.filter((token) => normalizeTextList(product.name).includes(token)).length
        : 0,
    );

    if (score >= 1) {
      scored.push({ product, score });
    }
  }

  if (!scored.length) {
    return [];
  }

  const bestScore = Math.max(...scored.map((entry) => entry.score));
  return filterByExplicitSize(
    scored.filter((entry) => entry.score === bestScore).map((entry) => entry.product),
    action,
  );
};

/** Match all variants for update/delete. Without size → every talle of that model. With size → only that talle. */
export const matchProductsForUpdate = (products, action) => {
  if (!Array.isArray(products) || !products.length || !action) {
    return [];
  }

  const descriptor = parseProductDescriptor(String(action.productName ?? ''));
  const productType = normalizeNullableString(action.productType) || descriptor.productType || undefined;
  const productModel = normalizeNullableString(action.productModel) || descriptor.productModel || undefined;
  const explicitSize = normalizeNullableString(action.size) || descriptor.size || null;
  const productName = composeProductName({
    productType,
    productModel,
    fallback: action.productName,
  });

  let matches = matchProductsForQuery(products, {
    productName,
    productType,
    productModel,
  });

  if (explicitSize) {
    matches = matches.filter((product) => {
      const productSize = normalizeNullableString(product.size);
      return productSize && (productSize === explicitSize || includesNormalized(productSize, explicitSize));
    });
  }

  return matches;
};

export const answerStockQuery = (products, action, options = {}) => {
  const whatsapp = options.whatsapp === true;
  const listAll = isListAllStockQuery(action);
  const label = listAll ? 'inventario' : String(action?.productName ?? 'producto').trim() || 'producto';
  const matches = matchProductsForQuery(products, action);
  const variantWord = typeof options.variantLabel === 'string' && options.variantLabel.trim()
    ? options.variantLabel.trim().toLowerCase()
    : 'variante';
  const missingVariant = `sin ${variantWord}`;

  if (!matches.length) {
    if (whatsapp) {
      return listAll
        ? '📦 *Inventario*\n\nTodavía no hay productos cargados.'
        : `🔎 *Stock de ${label}*\n\nNo encontré productos que coincidan.`;
    }
    return listAll
      ? 'No hay productos cargados en tu inventario.'
      : `No encontré stock de "${label}" en tu inventario.`;
  }

  const totalAvailable = matches.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
  const totalReserved = matches.reduce((sum, product) => sum + Number(product.stockReserved ?? 0), 0);
  const reservedLine = totalReserved > 0
    ? `\nAdemás hay ${totalReserved} unidad${totalReserved === 1 ? '' : 'es'} reservada${totalReserved === 1 ? '' : 's'}.`
    : '';
  const productLabel = (product) => {
    const model = normalizeNullableString(product.productModel);
    if (model && !/^\d{2,4}$/.test(normalizeText(model))) {
      return model;
    }
    const name = String(product.name ?? '').trim();
    const size = normalizeNullableString(product.size);
    const withoutSize =
      size && name.toLowerCase().endsWith(` ${size.toLowerCase()}`)
        ? name.slice(0, name.length - size.length).trim()
        : name;
    return withoutSize || name || model || normalizeNullableString(product.productType) || 'Producto';
  };

  if (action.groupBy === 'size') {
    const groups = new Map();
    for (const product of matches) {
      const groupKey = normalizeNullableString(product.size) || missingVariant;
      const existing = groups.get(groupKey) ?? [];
      existing.push(product);
      groups.set(groupKey, existing);
    }

    const lines = [];
    const sortedKeys = [...groups.keys()].sort((left, right) => {
      if (left === missingVariant) {
        return 1;
      }
      if (right === missingVariant) {
        return -1;
      }
      return compareSizes(left, right);
    });

    for (const sizeLabel of sortedKeys) {
      const groupProducts = (groups.get(sizeLabel) ?? []).slice().sort((left, right) =>
        productLabel(left).localeCompare(productLabel(right), 'es'),
      );
      const items = groupProducts.map((product) => whatsapp
        ? `• ${productLabel(product)} — *${Number(product.stockAvailable ?? 0)}*`
        : `- ${productLabel(product)}: ${Number(product.stockAvailable ?? 0)}`);
      const heading = sizeLabel === missingVariant ? sizeLabel : `${titleCase(variantWord)} ${sizeLabel}`;
      lines.push(whatsapp ? `*${heading}*\n${items.join('\n')}` : `${heading}:\n${items.join('\n')}`);
    }

    if (whatsapp) {
      const reserved = totalReserved > 0 ? `\n🔒 Reservadas: *${totalReserved}*` : '';
      return truncateStockReply(`📦 *Inventario por ${variantWord}*\nDisponibles: *${totalAvailable}*${reserved}\n\n${lines.join('\n\n')}`);
    }
    const header = `Inventario por ${variantWord} (${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'}):`;
    return truncateStockReply(`${header}\n\n${lines.join('\n\n')}${reservedLine}`);
  }

  const groups = new Map();

  for (const product of matches) {
    const groupKey = productLabel(product);
    const existing = groups.get(groupKey) ?? [];
    existing.push(product);
    groups.set(groupKey, existing);
  }

  const lines = [];

  for (const [groupName, groupProducts] of groups.entries()) {
    const groupTotal = groupProducts.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
    const sizeParts = groupProducts
      .slice()
      .sort((left, right) => compareSizes(left.size, right.size))
      .map((product) => {
        const sizeLabel = normalizeNullableString(product.size) || missingVariant;
        return `${sizeLabel}: ${Number(product.stockAvailable ?? 0)}`;
      });

    lines.push(whatsapp
      ? `• *${groupName}* — ${groupTotal}\n  ${sizeParts.join(' · ')}`
      : `${groupName}: ${sizeParts.join(', ')} (total ${groupTotal})`);
  }

  if (whatsapp) {
    const title = listAll ? 'Inventario' : `Stock de ${label}`;
    const reserved = totalReserved > 0 ? `\n🔒 Reservadas: *${totalReserved}*` : '';
    return truncateStockReply(`📦 *${title}*\nDisponibles: *${totalAvailable}*${reserved}\n\n${lines.join('\n')}`);
  }
  const header = listAll
    ? `Inventario: ${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'}:`
    : `Tenés ${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'} de ${label}:`;

  return truncateStockReply(`${header}\n${lines.join('\n')}${reservedLine}`);
};

const summarizeAction = (action) => {
  if (action.type === 'withdraw_stock') return `Retiro de ${action.qty} ${action.unit}: ${action.productName}; disponible ${action.stockAvailable}; reservado ${action.stockReserved}`;
  if (action.type === 'create_product') return `Producto creado: ${action.productName}; disponible ${action.stockAvailable}; reservado ${action.stockReserved}`;
  if (action.type === 'add_stock') {
    return `+${action.qty} stock para ${action.productName}`;
  }

  if (action.type === 'reserve_stock') {
    return `-${action.qty} reservado para ${action.productName}`;
  }

  if (action.type === 'sell') {
    return `-${action.qty} vendidos de ${action.productName}`;
  }

  if (action.type === 'payment_received') {
    return `-$${action.amount.toLocaleString('es-AR')} cobrado a ${action.clientName}`;
  }

  if (action.type === 'client_order') {
    const qty = action.qty && action.qty > 0 ? action.qty : 1;
    const sizeLabel = action.size ? ` ${action.size}` : '';
    return `${qty} ${action.productName}${sizeLabel}`;
  }

  if (action.type === 'update_product') {
    const parts = [];
    if (Number.isFinite(action.price) && action.price > 0) {
      parts.push(`precio $${Number(action.price).toLocaleString('es-AR')}`);
    }
    if (Number.isFinite(action.stockAvailable) && action.stockAvailable >= 0) {
      parts.push(`stock ${action.stockAvailable}`);
    }
    const scope = action.size ? `variante ${action.size}` : 'todas las variantes';
    return `Actualizar ${action.productName} (${scope})${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  if (action.type === 'update_pedido') {
    const parts = [];
    if (Number.isFinite(action.qty) && action.qty > 0) {
      parts.push(`cantidad ${action.qty}`);
    }
    if (typeof action.size === 'string' && action.size.trim()) {
      parts.push(`variante ${action.size.trim().toUpperCase()}`);
    }
    if (action.estado) {
      parts.push(`estado ${action.estado}`);
    }
    return `Actualizar pedido ${action.productName}${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  if (action.type === 'delete_pedido') {
    return `Eliminar pedido ${action.productName}`;
  }

  if (action.type === 'delete_product') {
    if (action.productName === '*') {
      return 'Desactivar los productos de la selección revisada';
    }
    return `Desactivar producto ${action.productName}`;
  }

  return `+$${action.amount.toLocaleString('es-AR')} en cuenta de ${action.clientName}`;
};

const withTransaction = async (callback) => {
  return withClient(async (client) => {
    await client.query('BEGIN');

    try {
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const createProductRecord = async (productInput, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  const businessId = normalizeOwnerPhone(ownerPhone);
  const result = await executeInventoryOperation(productCreationToPlan(productInput, businessId, options), {
    businessId, actorId: options.actorId ?? businessId, permissions: ['inventory:create', 'inventory:reserve'],
  });
  return result.items[0].product;
};

export const createProductModelRecords = async (input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  const businessId = normalizeOwnerPhone(ownerPhone);
  const result = await executeInventoryOperation(productCreationToPlan(input, businessId, options, true), {
    businessId, actorId: options.actorId ?? businessId, permissions: ['inventory:create', 'inventory:reserve'],
  });
  return result.items.map((item) => item.product);
};

export const updateProductRecord = async (productId, updates, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  if (typeof options.operationId !== 'string' || !options.operationId.trim()) throw new InventoryOperationError('OPERATION_ID_REQUIRED', 'La edición necesita un ID estable para reintentar.');
  const businessId = normalizeOwnerPhone(ownerPhone);
  const result = await executeInventoryOperation({ contractVersion: 1, businessId,
    operationId: `product-edit:${options.operationId}`,
    source: { channel: options.channel ?? 'panel', text: options.reason ?? 'Edición manual de inventario' },
    actions: productUpdateActions(productId, updates, options),
  }, { businessId, actorId: options.actorId ?? businessId,
    permissions: ['inventory:update', 'inventory:adjust'] });
  return result.items.at(-1).product;
};

export const updateProductModelRecords = async (input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  if (!input?.selectionId || !input?.digest || Object.keys(input).some((key) => !['selectionId', 'digest'].includes(key))) throw new InventoryOperationError('SELECTION_REQUIRED', 'Revisá y confirmá una selección de productos antes de editar el modelo.');
  const businessId = normalizeOwnerPhone(ownerPhone);
  const result = await confirmInventorySelection(input.selectionId, input.digest, {
    businessId, actorId: options.actorId ?? businessId, permissions: ['inventory:update'],
  }, { mutationType: 'sku.update' });
  return result.items.map((item) => item.product);
};

export const deleteProductRecord = async (productId, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  const result = await confirmInventorySelection(options.selectionId, options.digest, {
    businessId: normalizeOwnerPhone(ownerPhone), actorId: options.actorId ?? normalizeOwnerPhone(ownerPhone), permissions: ['inventory:deactivate'],
  }, { mutationType: 'sku.deactivate', skuIds: [productId], requireReference: true });
  return options.returnResult ? result : true;
};

export const deleteProductRecords = async (idsInput, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  if (!idsInput || Array.isArray(idsInput) || Object.keys(idsInput).some((key) => !['selectionId', 'digest'].includes(key))) throw new InventoryOperationError('SELECTION_REQUIRED', 'Revisá una selección antes de dar de baja los productos.');
  const result = await confirmInventorySelection(idsInput.selectionId, idsInput.digest, {
    businessId: normalizeOwnerPhone(ownerPhone), actorId: options.actorId ?? normalizeOwnerPhone(ownerPhone), permissions: ['inventory:deactivate'],
  }, { mutationType: 'sku.deactivate', requireReference: true });
  return options.returnResult ? result : result.items.length;
};

export const executePartyOperation = async (plan, context) => {
  const normalized = validatePartyPlan(plan, context);
  await ensureReady();
  return withTransaction((client) => executePartyPlanInTransaction(client, normalized, {...context,ownerPhoneVariants:getOwnerPhoneVariants(context.businessId)}));
};

const createPartyRecord = async (kind, input, ownerPhone, options) => {
  const businessId = normalizeOwnerPhone(ownerPhone);
  const plan = partyCreationToPlan(kind, input, businessId);
  const result = await executePartyOperation(plan, { businessId, actorId: options.actorId ?? businessId,
    permissions: [kind === 'client' ? 'clients:create' : 'suppliers:create'] });
  return result.items[0].party;
};

export const createClientRecord = async (input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) =>
  createPartyRecord('client', input, ownerPhone, options);

const updatePartyRecord = async (kind, partyId, input, ownerPhone, options) => {
  const businessId = normalizeOwnerPhone(ownerPhone);
  const result = await executePartyOperation(partyUpdateToPlan(kind,partyId,input,businessId), {
    businessId,actorId:options.actorId ?? businessId,permissions:[kind === 'client' ? 'clients:update' : 'suppliers:update'] });
  return result.items[0].party;
};

export const updateClientRecord = async (id, input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) =>
  updatePartyRecord('client', id, input, ownerPhone, options);

const deletePartyRecord = async (kind, partyId, input, ownerPhone, options) => {
  const businessId = normalizeOwnerPhone(ownerPhone);
  return executePartyOperation(partyDeleteToPlan(kind,partyId,input,businessId),{
    businessId,actorId:options.actorId ?? businessId,permissions:[kind === 'client' ? 'clients:delete' : 'suppliers:delete'] });
};

export const deleteClientRecord = async (id, ownerPhone = DEFAULT_OWNER_PHONE, input = {}, options = {}) =>
  deletePartyRecord('client',id,input,ownerPhone,options);

export const mergeClientRecords = async (keepId, mergeId, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  await ensureReady();
  const businessId = normalizeOwnerPhone(ownerPhone);
  return withTransaction(async (client) => {
    const operationResult = await mergeClientsInTransaction(client,keepId,mergeId,options,{
      businessId,actorId:options.actorId ?? businessId,permissions:['clients:merge','accounts:transfer'],ownerPhoneVariants:getOwnerPhoneVariants(businessId),
    });
    return {...await queryAllState(businessId,client),operationResult};
  });
};

export const createProveedorRecord = async (input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) =>
  createPartyRecord('supplier', input, ownerPhone, options);

export const updateProveedorRecord = async (id, input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) =>
  updatePartyRecord('supplier', id, input, ownerPhone, options);

export const deleteProveedorRecord = async (id, ownerPhone = DEFAULT_OWNER_PHONE, input = {}, options = {}) =>
  deletePartyRecord('supplier',id,input,ownerPhone,options);

export const mergeProveedorRecords = async (keepId,mergeId,ownerPhone = DEFAULT_OWNER_PHONE,input = {},options = {}) => {
  const businessId = normalizeOwnerPhone(ownerPhone);
  const context = {businessId,actorId:options.actorId ?? businessId,permissions:['suppliers:merge'],ownerPhoneVariants:getOwnerPhoneVariants(businessId)};
  const plan = validatePartyPlan(supplierMergeToPlan(keepId,mergeId,input,businessId),context);
  await ensureReady();
  return withTransaction(async (client) => {
    const operationResult = await executePartyPlanInTransaction(client,plan,context);
    return {...await queryAllState(businessId,client),operationResult};
  });
};

export const executeOrderOperation = async (kind, pedidoId, input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  await ensureReady();
  const businessId = normalizeOwnerPhone(ownerPhone);
  return withTransaction((client) => executeOrderInTransaction(client, kind, pedidoId, input, {
    businessId, actorId: options.actorId ?? businessId, channel: options.channel ?? 'panel',
    permissions: ['orders:create', 'orders:update', 'orders:delete', 'orders:reconcile', 'inventory:receive', 'inventory:withdraw', 'inventory:adjust'],
    ownerPhoneVariants: getOwnerPhoneVariants(businessId),
  }, persistInventoryTransactions));
};

export const createPedidoRecord = async (input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) =>
  (await executeOrderOperation('create', null, input, ownerPhone, options)).pedido;

export const updatePedidoRecord = async (pedidoId, input, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) =>
  (await executeOrderOperation('update', pedidoId, input, ownerPhone, options)).pedido;

export const deletePedidoRecord = async (pedidoId, ownerPhone = DEFAULT_OWNER_PHONE, input = {}, options = {}) =>
  executeOrderOperation('delete', pedidoId, input, ownerPhone, options);

export const executeUniversalOperation = async (input, context) => {
  const {plan} = prepareUniversalOperation(input,context);
  await ensureReady();
  return withTransaction((client) => executeUniversalPlanInTransaction(client,plan,{
    ...context,ownerPhoneVariants:getOwnerPhoneVariants(context.businessId),
  },persistInventoryTransactions));
};

export const recoverPanelOperation = async (input,context) => {
  await ensureReady();
  return withTransaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return recoverLegacyPanelOperation(client,input,{...context,
      businessId:normalizeOwnerPhone(context.businessId),actorId:normalizePhone(context.actorId)});
  });
};

// Interpretation happens outside any SQL transaction. Only validated, frozen
// drafts reach the existing universal executor after an explicit confirmation.
const interpretUniversalDraft = async (text,draftId,context,options,clarifications=[],previous=null) => {
  const {catalog,observedAt}=await withTransaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const observedAt=(await client.query('SELECT CURRENT_TIMESTAMP AS observed_at')).rows[0].observed_at.toISOString();
    const owners=[getOwnerPhoneVariants(context.businessId)],catalog={};
    // Use stored identities, never presentation-normalized product metadata.
    catalog.products=(await client.query("SELECT * FROM products WHERE owner_phone=ANY($1) AND inventory_status='active' ORDER BY id",owners)).rows.map(inventoryRowToProduct);
    catalog.clients=(await client.query('SELECT * FROM clients WHERE owner_phone=ANY($1) ORDER BY id',owners)).rows.map(rowToClient);
    catalog.proveedores=(await client.query('SELECT * FROM proveedores WHERE owner_phone=ANY($1) ORDER BY id',owners)).rows.map(rowToProveedor);
    catalog.pedidos=(await client.query('SELECT * FROM pedidos WHERE owner_phone=ANY($1) ORDER BY id',owners)).rows.map(rowToPedido);
    catalog.familySchemas=await loadProductFamilySchemas(client,owners[0]);
    return {catalog,observedAt};
  });
  const result=await interpretUniversalIntent({sourceText:text,catalog,clarifications,
    context:{...context,internalConversationOperation:true},operationId:`draft-operation:${draftId}`,
    ...(previous?.plan ? {revision:{plan:previous.plan,evidence:previous.evidence,replyText:text.slice(previous.text.length+1)}} : {}),
    channel:context.channel ?? 'panel',...(options?.complete ? {complete:options.complete} : {})});
  if (result.kind==='invalid') throw new InventoryOperationError('INTERPRETATION_INVALID','La interpretación no cumple el contrato. No apliqué cambios.',{reason:result.reason});
  if (result.kind==='unavailable') throw new InventoryOperationError('INTERPRETATION_UNAVAILABLE','No pude interpretar la solicitud. Conservá el mensaje para reintentar.',{reason:result.reason});
  if (result.kind==='answer') return {...result,answer:{...result.answer,observedAt}};
  return result.kind==='ready' ? {...result,review:buildUniversalOperationReview(result.plan,catalog)}
    : result.plan ? {...result,review:previous.review} : result;
};

export const prepareUniversalDraft = async (input,context,options={}) => {
  authorizeUniversalConversation(context);
  const request=normalizeDraftRequest(input);
  requirePublicDraftRequest(request);
  await ensureReady();
  const prior=await withTransaction(client=>findDraftCommand(client,request,context));
  if (prior.response) {
    if(prior.response.status==='answered') authorizeUniversalQueries(prior.response.queries,context);
    return prior.response;
  }
  const draftId=crypto.randomUUID();
  const interpretation=await interpretUniversalDraft(request.text,draftId,context,options);
  return withTransaction(client=>persistUniversalInterpretation(client,request,interpretation,context,{draftId}));
};
export const replyUniversalDraft = async (draftId,input,context,options={}) => {
  authorizeUniversalConversation(context);
  const request=normalizeDraftRequest(input,true);
  requirePublicDraftRequest(request);
  await ensureReady();
  const pending=await withTransaction(client=>loadUniversalDraftReply(client,draftId,request,context));
  if (pending.response) {
    if(pending.response.status==='answered') authorizeUniversalQueries(pending.response.queries,context);
    return pending.response;
  }
  const interpretation=await interpretUniversalDraft(pending.text,draftId,context,options,pending.clarifications,pending.previous);
  return withTransaction(client=>persistUniversalInterpretation(client,request,interpretation,context,{draftId,reply:true}));
};
const requirePublicDraftRequest = request => {
  if (request.requestId.startsWith('universal-meta:')) throw new InventoryOperationError('INVALID_DRAFT_REQUEST','El ID del mensaje está reservado para el canal WhatsApp.');
};
const loadUniversalDraftReply = async (client,draftId,request,context) => {
    const command=await findDraftCommand(client,request,context,'reply',draftId);
    if (command.response) return {response:command.response};
    const row=await readUniversalDraft(client,draftId,context);
    if (row.version!==request.version) throw new InventoryOperationError('DRAFT_VERSION_MISMATCH','El borrador cambió. Revisá la versión actual.');
    if (!row.status.startsWith('awaiting_')) throw new InventoryOperationError('DRAFT_NOT_PENDING','El borrador ya tiene un resultado definitivo.');
    if (row.expired) throw new InventoryOperationError('DRAFT_EXPIRED','El borrador venció. Prepará uno nuevo.');
    const text=`${row.preview_json.text}\n${request.text}`;
    if (row.version>=20 || text.length>12000) throw new InventoryOperationError('INVALID_DRAFT_REQUEST','La conversación excede el límite. Prepará un borrador nuevo.');
    return {text,previous:row.preview_json,clarifications:[...(row.preview_json.clarifications ?? []),
      ...(row.preview_json.question ? [{question:row.preview_json.question,answer:request.text}] : [])]};
};

/** The caller supplies the tenant resolved from the authenticated Meta sender.
 * Ordinary messages and explicit controls share the draft/executor boundary;
 * provider calls never hold an SQL transaction open. */
export const processMetaUniversalMessage = async (input,options={}) => {
  const explicitCommand=parseUniversalMetaCommand(input?.sourceText);
  let command=options.legacyRetired===true ? {kind:'retired'} : explicitCommand ?? (options.ordinary===true && typeof input?.sourceText==='string' ? {kind:'prepare',text:input.sourceText.trim()} : null);
  if (!command) return null;
  const context={businessId:normalizeOwnerPhone(input.ownerPhone),actorId:normalizePhone(input.senderPhone),channel:'whatsapp',permissions:[
    'inventory:read','orders:read','accounts:read','inventory:receive','inventory:sell','inventory:reserve','inventory:adjust','inventory:update','inventory:deactivate','inventory:create',
    'accounts:charge','accounts:payment','accounts:adjust','accounts:transfer',
    'clients:create','clients:update','clients:delete','suppliers:create','suppliers:update','suppliers:delete','suppliers:merge',
    'orders:create','orders:update','orders:delete','orders:reconcile',
  ]};
  authorizeUniversalConversation(context);
  const requestInput=normalizeUniversalMetaInput(input);
  await ensureReady();
  const prior=await withTransaction(client=>findUniversalMetaCommand(client,requestInput,context));
  if (prior.response) return prior.response;
  let prepared,preparationError;
  // Bind conversational replies and short controls to this sender's latest
  // conversation. A completed/expired conversation must not expose an older
  // pending draft to a second short confirmation. The digest guards changes.
  if (options.ordinary===true && !explicitCommand && command.kind==='prepare') {
    const control=/^(confirmar|cancelar)[.!]?$/i.exec(command.text)?.[1]?.toLowerCase();
    const pending=await withTransaction(async client=>(await client.query(`SELECT preview_json,expires_at>NOW() AS active
      FROM universal_drafts WHERE owner_phone=$1 AND actor_id=$2 ORDER BY
          (SELECT MAX(created_at) FROM universal_draft_commands AS commands WHERE commands.owner_phone=universal_drafts.owner_phone
            AND commands.actor_id=universal_drafts.actor_id AND commands.draft_id=universal_drafts.draft_id) DESC NULLS LAST,
          created_at DESC,draft_id DESC LIMIT 1`,[context.businessId,context.actorId])).rows[0]);
    if (pending?.active && ['awaiting_clarification','awaiting_confirmation'].includes(pending.preview_json?.status) && pending.preview_json.digest)
      command={kind:control==='confirmar'?'confirm':control==='cancelar'?'cancel':'reply',code:pending.preview_json.digest.slice(0,8),text:command.text};
    else if (control) preparationError=new InventoryOperationError('DRAFT_NOT_FOUND','No hay una operación pendiente vigente en este chat. Enviá la instrucción completa para preparar una nueva.');
  }
  try {
    if (preparationError) throw preparationError;
    const requestId=`universal-meta:${operationRequestDigest([context.businessId,context.actorId,requestInput.messageId])}`;
    if (command.kind==='invalid') throw new InventoryOperationError('INVALID_DRAFT_REQUEST',
      'Respondé directamente con la aclaración o corrección. Para aplicar una propuesta escribí «confirmar» y para descartarla, «cancelar».');
    if (command.kind==='prepare') {
      const request=normalizeDraftRequest({requestId,text:command.text}),draftId=crypto.randomUUID();
      const interpretation=await interpretUniversalDraft(request.text,draftId,context,options);
      prepared={request,draftId,interpretation};
    } else if (command.kind==='reply') {
      const pending=await withTransaction(async client=>{
        const row=await findUniversalMetaDraft(client,command.code,context);
        const request=normalizeDraftRequest({requestId,text:command.text,version:row.version},true);
        return {request,draftId:row.draft_id,...await loadUniversalDraftReply(client,row.draft_id,request,context)};
      });
      const interpretation=await interpretUniversalDraft(pending.text,pending.draftId,context,options,pending.clarifications,pending.previous);
      prepared={request:pending.request,draftId:pending.draftId,interpretation};
    }
  } catch(error) {
    if (error.name!=='InventoryOperationError') throw error;
    preparationError=error;
  }
  return withTransaction(client=>executeUniversalMetaInTransaction(client,requestInput,context,async transaction=>{
    if (preparationError) throw preparationError;
    if (command.kind==='retired') throw new InventoryOperationError('LEGACY_WRITER_RETIRED',LEGACY_META_RETIRED_REPLY);
    if (command.kind==='prepare') return persistUniversalInterpretation(transaction,prepared.request,prepared.interpretation,context,{draftId:prepared.draftId});
    const row=await findUniversalMetaDraft(transaction,command.code,context);
    if (command.kind==='reply') {
      if (row.draft_id!==prepared.draftId || row.version!==prepared.request.version) throw new InventoryOperationError('DRAFT_VERSION_MISMATCH','El borrador cambió. Revisá la versión actual.');
      return persistUniversalInterpretation(transaction,prepared.request,prepared.interpretation,context,{draftId:prepared.draftId,reply:true});
    }
    const confirmation={version:row.version,digest:row.preview_json.digest};
    if (command.kind==='cancel') return cancelUniversalDraftInTransaction(transaction,row.draft_id,confirmation,context);
    return confirmUniversalDraftInTransaction(transaction,row.draft_id,confirmation,
      {...context,ownerPhoneVariants:getOwnerPhoneVariants(context.businessId)},persistInventoryTransactions);
  },{retiredBatchId:options.retiredBatchId,retiredSelectionId:options.retiredSelectionId}));
};

/** Guard the retired namespace and replies bound to historical questions. Reads
 * never expire, resume or modify legacy rows; only the terminal command/outbox
 * is persisted through the same atomic boundary as current Meta commands. */
export const processRetiredMetaMessage = async input => {
  const batch=await getRetiredMetaBatchForMessage(input);
  const quoted=input.replyToMessageId ? await getMetaReplyQuestion(input.replyToMessageId,input.ownerPhone,input.senderPhone) : null;
  const selection=await getRetiredMetaSelectionForMessage(input);
  if (!batch && !quoted && !selection && !isRetiredMetaControl(input.sourceText)) return null;
  return processMetaUniversalMessage(input,{legacyRetired:true,retiredBatchId:batch?.id ?? quoted?.batchId,retiredSelectionId:selection?.selection_id});
};
export const getUniversalDraft = async (draftId,context) => {
  authorizeUniversalConversation(context); await ensureReady();
  return withTransaction(async client=>{
    const row=await readUniversalDraft(client,draftId,context);
    if (row.preview_json.plan) prepareUniversalOperation(row.preview_json.plan,{...context,internalConversationOperation:true});
    if (row.status==='answered') authorizeUniversalQueries(row.preview_json.queries,context);
    return row.preview_json;
  });
};
export const confirmUniversalDraft = async (draftId,input,context) => {
  authorizeUniversalConversation(context); await ensureReady();
  return withTransaction(client=>confirmUniversalDraftInTransaction(client,draftId,input,
    {...context,ownerPhoneVariants:getOwnerPhoneVariants(context.businessId)},persistInventoryTransactions));
};
export const cancelUniversalDraft = async (draftId,input,context) => {
  authorizeUniversalConversation(context); await ensureReady();
  return withTransaction(client=>cancelUniversalDraftInTransaction(client,draftId,input,context));
};

export const executeInventoryOperation = async (plan, context) => {
  const normalized = validateOperationPlan(plan, context);
  await ensureReady();
  return withTransaction(async (client) => {
    const result = await executeInventoryPlanInTransaction(client, normalized, {
      ...context, ownerPhoneVariants: getOwnerPhoneVariants(context.businessId),
    });
    await persistInventoryTransactions(client, normalized, result);
    return result;
  });
};

export const publishProductFamily = async (input,context) => {
  authorizeProductFamilies(context,true); await ensureReady();
  return withTransaction(client=>publishProductFamilyInTransaction(client,input,context));
};
export const listProductFamilies = async context => {
  authorizeProductFamilies(context); await ensureReady();
  return withTransaction(client=>loadProductFamilySchemas(client,getOwnerPhoneVariants(context.businessId)));
};

const authorizeInventorySelection = (context, mutationType = 'sku.update') => validateOperationPlan({ contractVersion: 1,
  businessId: context?.businessId, operationId: 'selection-authorization',
  actions: [{ itemId: 'authorization', type: mutationType, target: { kind: 'existing', skuId: 'authorization', expectedRevision: 0 },
    ...(mutationType === 'sku.update' ? { changes: { price: 0 } } : mutationType === 'stock.adjust' ? {balances:{available:0}} : {}), reason: 'Authorization only' }],
}, context);

const previewInventorySelectionInTransaction = async (client,input,context) => {
  const request = normalizeSelectionRequest(input), requestHash = selectionRequestDigest(request);
  authorizeInventorySelection(context,request.mutation.type);

    const scope = [context.businessId, context.actorId, request.requestId];
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['selection-preview', ...scope])]);
    const existing = await queryRow('SELECT request_hash,preview_json FROM inventory_selections WHERE owner_phone=$1 AND actor_id=$2 AND request_id=$3', scope, client);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID de previsualización ya corresponde a otros cambios.');
      return parseJsonValue(existing.preview_json);
    }
    await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
    const rows = await client.query('SELECT * FROM products WHERE owner_phone=ANY($1) ORDER BY id FOR UPDATE', [getOwnerPhoneVariants(context.businessId)]);
    // Keep raw persisted metadata; presentation normalization cannot select another identity.
    const products = rows.rows.map(inventoryRowToProduct);
    const expiresAt = (await client.query("SELECT NOW() + INTERVAL '15 minutes' AS expires_at")).rows[0].expires_at.toISOString();
    const usesFamilies=products.some(product=>product.family)||request.mutation.changes?.family;
    const familySchemas=usesFamilies ? await loadProductFamilySchemas(client,getOwnerPhoneVariants(context.businessId)) : [];
    const { preview, plan } = buildSelectionPreview(request, products, { ...context, familySchemas,selectionId: `selection-${crypto.randomUUID()}`, expiresAt });
    await client.query(`INSERT INTO inventory_selections (owner_phone,selection_id,request_id,actor_id,request_hash,preview_json,plan_json,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [context.businessId,preview.selectionId,request.requestId,context.actorId,requestHash,JSON.stringify(preview),JSON.stringify(plan),expiresAt]);
    return preview;

};

export const previewInventorySelection = async (input,context) => {
  const request = normalizeSelectionRequest(input);
  authorizeInventorySelection(context,request.mutation.type);
  if (/^meta-(?:selection|deactivate):/.test(request.requestId)) throw new InventoryOperationError('FORBIDDEN','Las selecciones conversacionales se preparan desde el mensaje original.');
  await ensureReady();
  return withTransaction((client) => previewInventorySelectionInTransaction(client,request,context));
};

const confirmInventorySelectionInTransaction = async (client,selectionId,digest,context,options = {}) => {
  if (!context || !context.businessId || !context.actorId) throw new InventoryOperationError('BUSINESS_SCOPE_REQUIRED', 'Falta el contexto autorizado de negocio y actor.');
  if (typeof selectionId !== 'string' || !selectionId.trim() || typeof digest !== 'string' || !digest.trim()) throw new InventoryOperationError(options.requireReference ? 'SELECTION_REQUIRED' : 'SELECTION_CONFIRMATION_MISMATCH', 'Falta la confirmación de la selección revisada.');

    const selected = await queryRow(`SELECT *,expires_at <= NOW() AS expired FROM inventory_selections
      WHERE owner_phone=$1 AND selection_id=$2 AND actor_id=$3 FOR UPDATE`, [context.businessId,selectionId,context.actorId], client);
    if (!selected) throw new InventoryOperationError('SELECTION_NOT_FOUND', 'La selección no está disponible para esta sesión.');
    if (parseJsonValue(selected.preview_json).digest !== digest) throw new InventoryOperationError('SELECTION_CONFIRMATION_MISMATCH', 'La confirmación no corresponde al conjunto y los cambios revisados.');
    const plan = parseJsonValue(selected.plan_json);
    if (options.mutationType && plan.actions.some((action) => action.type !== options.mutationType)) throw new InventoryOperationError('SELECTION_OPERATION_MISMATCH', 'La selección revisada corresponde a otra operación.');
    if (options.skuIds && (plan.actions.length !== options.skuIds.length || plan.actions.some((action) => !options.skuIds.includes(action.target.skuId)))) throw new InventoryOperationError('SELECTION_SCOPE_MISMATCH', 'La selección no corresponde a los productos de esta operación.');
    validateOperationPlan(plan, context);
    if (selected.cancelled_at) throw new InventoryOperationError('SELECTION_CANCELLED', 'La selección fue cancelada. Pedí una nueva selección antes de confirmar.');
    let result;
    if (selected.status === 'applied') result = parseJsonValue(selected.result_json);
    else {
      if (selected.expired) throw new InventoryOperationError('SELECTION_EXPIRED', 'La selección venció. Revisá una nueva previsualización antes de confirmar.');
      result = await executeInventoryPlanInTransaction(client, plan, { ...context, ownerPhoneVariants: getOwnerPhoneVariants(context.businessId) });
      await persistInventoryTransactions(client, plan, result);
      await client.query("UPDATE inventory_selections SET status='applied',result_json=$3::jsonb WHERE owner_phone=$1 AND selection_id=$2", [context.businessId,selectionId,JSON.stringify(result)]);
    }
    if (options.messageId && options.recipient) await client.query(`INSERT INTO meta_reply_outbox(event_id,recipient,reply_text) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING`,
      [options.messageId,normalizePhone(options.recipient),options.mutationType === 'sku.deactivate' ? metaDeactivationReceiptReply(result) : inventoryResultReply(result)]);
    return result;

};

export const confirmInventorySelection = async (selectionId,digest,context,options = {}) => {
  if (!context || !context.businessId || !context.actorId) throw new InventoryOperationError('BUSINESS_SCOPE_REQUIRED','Falta el contexto autorizado.');
  await ensureReady();
  return withTransaction((client) => confirmInventorySelectionInTransaction(client,selectionId,digest,context,options));
};

const metaSelectionContext = ({ownerPhone,senderPhone}) => ({businessId:normalizeOwnerPhone(ownerPhone),actorId:normalizePhone(senderPhone),
  permissions:['inventory:deactivate','inventory:update','inventory:adjust']});

export const prepareMetaInventorySelection = async (input) => {
  await ensureReady();
  return withTransaction((client) => prepareMetaSelectionInTransaction(client,input,metaSelectionContext(input),previewInventorySelectionInTransaction));
};

export const resumeMetaInventorySelection = async (input) => {
  const result = await prepareMetaInventorySelection({...input,resumeOnly:true});
  if (!result) return null;
  return {...result,handled:true,requiresConfirmation:true};
};

export const prepareMetaDeactivation = async (input) => {
  if (!Array.isArray(input.actions) || input.actions.some((action) => action.type !== 'delete_product')) throw new InventoryOperationError('UNSUPPORTED_MIXED_OPERATION','La baja necesita una selección independiente.');
  return prepareMetaInventorySelection(input);
};

export const processMetaInventorySelectionCommand = async (input) => {
  const command = parseMetaSelectionCommand(input.sourceText);
  if (!command) return null;
  await ensureReady();
  return withTransaction((client) => processMetaSelectionInTransaction(client,input,command,metaSelectionContext(input),confirmInventorySelectionInTransaction));
};

export const processMetaDeactivationCommand = async (input) => parseMetaDeactivationCommand(input.sourceText) ? processMetaInventorySelectionCommand(input) : null;

// All channels read the same persisted snapshot; storage failures are never empty inventory.
export const getStateSnapshot = (ownerPhone = DEFAULT_OWNER_PHONE) => getStateSnapshotStrict(ownerPhone);

const persistInventoryTransactions = async (client, plan, result, originalActions = []) => {
  const appliedActions = inventoryResultActions(result, originalActions);
  for (const [index, item] of result.items.entries()) {
    const transactionId = `inventory-${crypto.createHash('sha256').update(JSON.stringify([plan.businessId,plan.operationId,item.itemId])).digest('hex')}`;
    await client.query(`INSERT INTO transactions (id,owner_phone,timestamp,source_text,summary,actions_json,batch_id,item_id)
      SELECT $1,$2,created_at,$3,$4,$5::jsonb,$6,$7 FROM inventory_operations
      WHERE owner_phone=$2 AND operation_id=$8 ON CONFLICT (id) DO NOTHING`,
    [transactionId,plan.businessId,plan.source?.text ?? '',summarizeAction(appliedActions[index]),JSON.stringify([appliedActions[index]]),
      `${plan.businessId}:${plan.operationId}`,item.itemId,plan.operationId]);
  }
};

const applyConfirmedStockActions = async (actions, sourceText, ownerPhone, options) => {
  const operationId = options.operationId ?? options.messageId;
  if (typeof operationId !== 'string' || !operationId.trim()) {
    throw new InventoryOperationError('OPERATION_ID_REQUIRED', 'La operación necesita un ID estable para poder reintentarse sin duplicar efectos.');
  }
  await ensureReady();
  const businessId = normalizeOwnerPhone(ownerPhone);
  const id = `${options.channel ?? 'confirmed'}:${operationId}`;
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ actions, sourceText })).digest('hex');
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([businessId, id])]);
    const prior = await queryRow('SELECT plan_json,result_json FROM inventory_operations WHERE owner_phone=$1 AND operation_id=$2', [businessId, id], client);
    if (prior) {
      if (parseJsonValue(prior.plan_json)?.source?.requestHash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID ya corresponde a otra operación.');
      const result = parseJsonValue(prior.result_json);
      const sent = options.messageId ? await queryRow('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1 AND recipient=$2',
        [options.messageId, normalizePhone(options.recipient)], client) : null;
      return { ...await queryAllState(businessId, client), operationResult: result,
        replyText: sent?.reply_text ?? [options.replyPrefix, inventoryResultReply(result)].filter(Boolean).join('\n\n') };
    }
    await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
    const snapshot = await queryAllState(businessId, client);
    const plan = confirmedStockActionsToPlan({ actions, sourceText, ownerPhone: businessId, operationId: id, products: snapshot.products });
    requireReviewedUpdateSelection(plan);
    plan.source.channel = options.channel ?? 'confirmed';
    plan.source.requestHash = requestHash;
    const result = await executeInventoryPlanInTransaction(client, plan, {
      businessId, actorId: options.actorId ?? ownerPhone, permissions: ['inventory:receive', 'inventory:sell', 'inventory:reserve', 'inventory:adjust', 'inventory:update'],
      ownerPhoneVariants: getOwnerPhoneVariants(ownerPhone),
    });
    await persistInventoryTransactions(client, plan, result, actions);
    const replyText = [options.replyPrefix, inventoryResultReply(result)].filter(Boolean).join('\n\n');
    if (options.messageId && options.recipient) {
      await client.query(`INSERT INTO meta_reply_outbox (event_id,recipient,reply_text) VALUES ($1,$2,$3)
        ON CONFLICT (event_id) DO NOTHING`, [options.messageId,normalizePhone(options.recipient),replyText]);
    }
    return { ...await queryAllState(businessId, client), operationResult: result, replyText };
  });
};

export const executeAccountOperation = async (plan, context) => {
    const normalized = validateAccountPlan(plan, context);
    await ensureReady();
    return withTransaction((client) => executeAccountPlanInTransaction(client, normalized, { ...context, ownerPhoneVariants: getOwnerPhoneVariants(context.businessId) }));
};
const applyAccountActions = async (actions, sourceText, ownerPhone, options) => {
    const operationId = options.operationId ?? options.messageId;
    if (typeof operationId !== 'string' || !operationId.trim())
        throw new InventoryOperationError('OPERATION_ID_REQUIRED', 'La cuenta necesita un ID estable para reintentar.');
    await ensureReady();
    const businessId = normalizeOwnerPhone(ownerPhone), id = `account-compat:${options.channel ?? 'confirmed'}:${operationId}`;
    const requestHash = operationRequestDigest({ actions, sourceText });
    return withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['account', businessId, id])]);
        const prior = await queryRow('SELECT plan_json,result_json FROM account_operations WHERE owner_phone=$1 AND operation_id=$2', [businessId, id], client);
        let result;
        if (prior) {
            if (parseJsonValue(prior.plan_json)?.source?.requestHash !== requestHash)
                throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID ya corresponde a otra operación de cuenta.');
            result = parseJsonValue(prior.result_json);
        }
        else {
            await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
            const rows = (await client.query('SELECT * FROM clients WHERE owner_phone=ANY($1) ORDER BY id FOR UPDATE', [getOwnerPhoneVariants(businessId)])).rows;
            const interpreted = ['meta', 'whatsapp'].includes(options.channel);
            const plan = { contractVersion: 1, businessId, operationId: id, source: { channel: options.channel ?? 'confirmed', text: sourceText || 'Movimiento de cuenta confirmado', requestHash }, actions: actions.map((action, index) => {
                    const candidates = !interpreted && action.clientId ? rows.filter((row) => row.id === action.clientId)
                        : rows.filter((row) => typeof action.clientName === 'string' && canonicalIdentityText(row.name) === canonicalIdentityText(action.clientName));
                    if (candidates.length !== 1)
                        throw new InventoryOperationError('CLIENT_SELECTION_REQUIRED', 'Elegí un cliente único y explícito; no asigné el movimiento a otra cuenta.');
                    return { itemId: `account-${index + 1}`, type: action.type === 'add_debt' ? 'account.charge' : 'account.payment', target: { kind: 'existing', clientId: candidates[0].id },
                        amount: { value: action.amount, unit: 'legacy-money' }, reason: sourceText || 'Movimiento de cuenta confirmado' };
                }) };
            result = await executeAccountPlanInTransaction(client, plan, { businessId, actorId: options.actorId ?? businessId, permissions: ['accounts:charge', 'accounts:payment'],
                ownerPhoneVariants: getOwnerPhoneVariants(businessId), replyPrefix: options.replyPrefix });
        }
        if (options.messageId && options.recipient)
            await client.query('INSERT INTO meta_reply_outbox(event_id,recipient,reply_text) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING', [options.messageId, normalizePhone(options.recipient), result.replyText]);
        return { ...await queryAllState(businessId, client), operationResult: result, replyText: result.replyText };
    });
};

const applyOrderActions = async (actions, sourceText, ownerPhone, options) => {
  const operationId = options.operationId ?? options.messageId;
  if (typeof operationId !== 'string' || !operationId.trim()) throw new InventoryOperationError('OPERATION_ID_REQUIRED', 'El lote de pedidos necesita un ID estable.');
  if (!actions.length || actions.length > 100) throw new InventoryOperationError('INVALID_ORDER_OPERATION', 'El lote admite de 1 a 100 pedidos.');
  await ensureReady();
  const businessId = normalizeOwnerPhone(ownerPhone), batchId = `batch:${options.channel ?? 'orders'}:${operationId}`;
  const requestHash = orderRequestDigest({ actions, sourceText });
  const interpreted = ['meta','whatsapp'].includes(options.channel);
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['order', businessId, batchId])]);
    const prior = await queryRow('SELECT request_hash,result_json FROM order_operations WHERE owner_phone=$1 AND operation_id=$2', [businessId,batchId], client);
    let result;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new InventoryOperationError('IDEMPOTENCY_CONFLICT', 'El ID del lote ya corresponde a otros cambios.');
      result = parseJsonValue(prior.result_json);
    } else {
      const context = { businessId, actorId: options.actorId ?? businessId, channel: options.channel ?? 'orders', internalOrderBatch: true,
        permissions: ['orders:create','orders:update','orders:delete','inventory:receive','inventory:withdraw','clients:create','suppliers:create'], ownerPhoneVariants: getOwnerPhoneVariants(businessId) };
      await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
      const receipts = [];
      for (const [index, action] of actions.entries()) {
        const snapshot = await queryAllState(businessId, client);
        const itemId = `order-batch-item:${crypto.createHash('sha256').update(JSON.stringify([businessId,batchId,index])).digest('hex')}`;
        // Compatibility grounding occurs once, before the explicit-ID order writer.
        const party = async (kind, id, name) => {
          const rows = kind === 'client' ? snapshot.clients : snapshot.proveedores;
          if (id) return id;
          if (typeof name !== 'string' || !name.trim()) throw new InventoryOperationError('PARTY_SELECTION_REQUIRED', 'Indicá el cliente/proveedor exacto del pedido.');
          const found = rows.filter((entry) => canonicalIdentityText(entry.name) === canonicalIdentityText(name));
          if (found.length > 1) throw new InventoryOperationError('PARTY_SELECTION_REQUIRED', 'Hay varios clientes/proveedores con ese nombre. Elegí su ID.');
          if (found.length) return found[0].id;
          const partyId = `order-party:${crypto.createHash('sha256').update(JSON.stringify([businessId,batchId,index,kind])).digest('hex')}`;
          const partyResult = await executePartyPlanInTransaction(client, {contractVersion:1,businessId,operationId:partyId,
            source:{channel:context.channel,text:sourceText || 'Participante del pedido'},
            actions:[{itemId:'party-1',type:kind === 'client' ? 'client.create' : 'supplier.create',name}]}, context);
          return partyResult.items[0].party.id;
        };
        let receipt;
        if (action.type === 'client_order') {
          const clienteId = await party('client', interpreted ? undefined : action.clienteId, action.clientName);
          const proveedorId = (!interpreted && action.proveedorId) || action.proveedorName ? await party('supplier', interpreted ? undefined : action.proveedorId, action.proveedorName) : null;
          receipt = await executeOrderInTransaction(client, 'create', null, {
            operationId: itemId, clienteId, proveedorId, producto: action.productName, productType: action.productType,
            productModel: action.productModel, talle: action.size, qty: action.qty, notas: action.notas,
            productId: interpreted ? undefined : action.productId,
          }, context, persistInventoryTransactions);
        } else {
          let pedido;
          if (action.pedidoId && !interpreted) pedido = snapshot.pedidos.find((entry) => entry.id === action.pedidoId);
          else {
            const candidates = snapshot.pedidos.filter((entry) => typeof action.productName === 'string'
              && canonicalIdentityText(entry.producto) === canonicalIdentityText(action.productName)
              && (!action.clientName || canonicalIdentityText(snapshot.clients.find((c) => c.id === entry.clienteId)?.name ?? '') === canonicalIdentityText(action.clientName)));
            if (candidates.length !== 1) throw new InventoryOperationError('ORDER_SELECTION_REQUIRED', 'El pedido no es único. Indicá el pedido y cliente exactos.');
            pedido = candidates[0];
          }
          if (!pedido) throw new InventoryOperationError('ORDER_NOT_FOUND', 'Pedido no encontrado.');
          receipt = await executeOrderInTransaction(client, action.type === 'delete_pedido' ? 'delete' : 'update', pedido.id,
            { operationId: itemId, expectedRevision: interpreted || !action.pedidoId ? pedido.revision : action.expectedRevision,
              ...(action.type === 'update_pedido' ? { estado: action.estado, qty: action.qty, talle: action.size,
                productId: interpreted ? undefined : action.productId } : {}) }, context, persistInventoryTransactions);
        }
        receipts.push(receipt);
      }
      const receiptReply = receipts.map(({ pedido, deleted, inventoryResult }) => [
        `${deleted ? 'Pedido eliminado' : 'Pedido guardado'}: ${pedido.producto}; ${pedido.estado}; cantidad ${pedido.qty}.`,
        inventoryResult ? inventoryResultReply(inventoryResult) : '',
      ].filter(Boolean).join('\n')).join('\n');
      const replyText = [options.replyPrefix, receiptReply].filter(Boolean).join('\n\n');
      result = { contractVersion: 1, operationId: batchId, businessId, status: 'applied', receipts, replyText };
      await client.query('INSERT INTO order_operations(owner_phone,operation_id,actor_id,request_hash,request_json,result_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
        [businessId,batchId,context.actorId,requestHash,JSON.stringify({ actions,sourceText }),JSON.stringify(result)]);
    }
    if (options.messageId && options.recipient) await client.query('INSERT INTO meta_reply_outbox(event_id,recipient,reply_text) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING', [options.messageId,normalizePhone(options.recipient),result.replyText]);
    return { ...await queryAllState(businessId, client), operationResult: result, replyText: result.replyText };
  });
};

export const applyActionsToDatabase = async (actions, sourceText, ownerPhone = DEFAULT_OWNER_PHONE, options = {}) => {
  if (actions.some((action) => ['create_product','withdraw_stock'].includes(action.type))) throw new InventoryOperationError('UNSUPPORTED_OPERATION', 'Un evento de historial no es un comando de escritura.');
  const orders = new Set(['client_order','update_pedido','delete_pedido']);
  if (actions.some((action) => orders.has(action.type))) {
    if (actions.some((action) => !orders.has(action.type))) throw new InventoryOperationError('UNSUPPORTED_MIXED_OPERATION', 'El lote mezcla pedidos y otras operaciones; no apliqué cambios.');
    return applyOrderActions(actions, sourceText, ownerPhone, options);
  }
  if (actions.some((action) => action.type === 'delete_product')) {
    if (actions.some((action) => action.type !== 'delete_product')) throw new InventoryOperationError('UNSUPPORTED_MIXED_OPERATION', 'La baja necesita una selección independiente; no apliqué el lote mixto.');
    const ids = actions.every((action) => typeof action.productId === 'string' && action.productId.trim()) ? actions.map((action) => action.productId) : undefined;
    const result = await confirmInventorySelection(options.selectionId, options.digest, {
      businessId: normalizeOwnerPhone(ownerPhone), actorId: options.actorId ?? normalizeOwnerPhone(ownerPhone), permissions: ['inventory:deactivate'],
    }, { mutationType: 'sku.deactivate', skuIds: ids, requireReference: true, messageId: options.messageId, recipient: options.recipient });
    return { ...await getStateSnapshotStrict(ownerPhone), operationResult: result, replyText: inventoryResultReply(result) };
  }
  const migrated = new Set(['add_stock', 'sell', 'reserve_stock', 'update_product']);
  if (actions.some((action) => migrated.has(action.type))) {
    if (actions.some((action) => !migrated.has(action.type))) throw new InventoryOperationError('UNSUPPORTED_MIXED_OPERATION', 'El lote combina operaciones todavía no migradas; no apliqué cambios.');
    return applyConfirmedStockActions(actions, sourceText, ownerPhone, options);
  }
  if (actions.some((action) => !['add_debt','payment_received','query_stock','query_pedidos'].includes(action.type))) throw new InventoryOperationError('UNSUPPORTED_OPERATION', 'Operación no reconocida; no apliqué cambios.');
  const mutations = actions.filter((action) => ['add_debt','payment_received'].includes(action.type));
  if (!mutations.length) return getStateSnapshotStrict(ownerPhone);
  return applyAccountActions(mutations, sourceText, ownerPhone, options);
};

const rowToVoiceStockBatch = (row) => row ? ({
  id: row.id,
  ownerPhone: row.owner_phone,
  senderPhone: row.sender_phone,
  sourceMessageId: row.source_message_id,
  status: row.status,
  sourceText: row.source_text,
  businessCategory: row.business_category,
  payload: parseJsonValue(row.payload_json) ?? {},
  replyText: row.reply_text,
  version: Number(row.version ?? 1),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}) : null;

const getRetiredMetaBatchForMessage = async ({ownerPhone,senderPhone,messageId},executor=null) => {
  if (!executor) await ensureReady();
  const row=await queryRow(`SELECT * FROM voice_stock_batches WHERE owner_phone=$1 AND sender_phone=$2
    AND (source_message_id=$3 OR payload_json->'handledMessages' @> $4::jsonb
      OR payload_json->>'replyMessageId'=$3 OR payload_json->'pendingChoiceReply'->>'messageId'=$3
      OR payload_json->'pendingDraftAnswer'->>'messageId'=$3 OR payload_json->'pendingDraftPatch'->>'messageId'=$3)
    ORDER BY created_at DESC LIMIT 1`,
  [normalizeOwnerPhone(ownerPhone),normalizePhone(senderPhone),String(messageId),JSON.stringify([{messageId:String(messageId)}])],executor);
  return rowToVoiceStockBatch(row);
};

const getRetiredMetaSelectionForMessage = async ({ownerPhone,senderPhone,messageId,replyToMessageId},executor=null) => {
  if (!executor) await ensureReady();
  return queryRow(`SELECT selection.* FROM inventory_selections AS selection
    WHERE selection.owner_phone=$1 AND selection.actor_id=$2
      AND (selection.request_id=ANY($3) OR ($4::text IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_reply_outbox AS reply WHERE reply.recipient=$2
          AND selection.request_id=ANY(ARRAY['meta-selection:'||reply.event_id,'meta-deactivate:'||reply.event_id])
          AND reply.provider_message_ids @> $5::jsonb)))
    ORDER BY selection.created_at DESC LIMIT 1`,
  [normalizeOwnerPhone(ownerPhone),normalizePhone(senderPhone),[`meta-selection:${messageId}`,`meta-deactivate:${messageId}`],
    replyToMessageId ?? null,JSON.stringify([String(replyToMessageId)])],executor);
};

export const getActiveVoiceStockBatch = async (ownerPhone, senderPhone) => {
  await ensureReady();
  await getPool().query(
    `UPDATE voice_stock_batches SET status = 'expired', version = version + 1, updated_at = NOW()
     WHERE owner_phone = $1 AND sender_phone = $2
       AND status IN ('awaiting_choice', 'awaiting_correction', 'ready')
       AND updated_at < NOW() - INTERVAL '7 days'`,
    [normalizeOwnerPhone(ownerPhone), normalizePhone(senderPhone)],
  );
  const rows = await queryRows(
    `SELECT * FROM voice_stock_batches
     WHERE owner_phone = $1 AND sender_phone = $2
       AND status IN ('awaiting_choice', 'awaiting_correction', 'ready')
     ORDER BY updated_at DESC LIMIT 1`,
    [normalizeOwnerPhone(ownerPhone), normalizePhone(senderPhone)],
  );
  return rowToVoiceStockBatch(rows[0]);
};

export const getVoiceStockBatchByMessage = async (ownerPhone, messageId, senderPhone = null) => {
  await ensureReady();
  const row = await queryRow(
    `SELECT * FROM voice_stock_batches WHERE owner_phone = $1
       AND ($4::text IS NULL OR sender_phone = $4)
       AND (source_message_id = $2 OR payload_json->'handledMessages' @> $3::jsonb)
       ORDER BY created_at DESC LIMIT 1`,
    [normalizeOwnerPhone(ownerPhone), String(messageId), JSON.stringify([{ messageId: String(messageId) }]), senderPhone == null ? null : normalizePhone(senderPhone)],
  );
  return rowToVoiceStockBatch(row);
};

export const createVoiceStockBatch = async (batch) => {
  await ensureReady();
  const result = await getPool().query(
    `INSERT INTO voice_stock_batches
       (id, owner_phone, sender_phone, source_message_id, status, source_text, business_category, payload_json, reply_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (owner_phone, source_message_id) DO NOTHING
     RETURNING *`,
    [
      batch.id,
      normalizeOwnerPhone(batch.ownerPhone),
      normalizePhone(batch.senderPhone),
      String(batch.sourceMessageId),
      batch.status,
      batch.sourceText,
      batch.businessCategory ?? null,
      toJsonbParam(batch.payload ?? {}),
      batch.replyText ?? null,
    ],
  );
  if (result.rows[0]) return rowToVoiceStockBatch(result.rows[0]);
  return getVoiceStockBatchByMessage(batch.ownerPhone, batch.sourceMessageId);
};

export const updateVoiceStockBatch = async (batchId, updates) => {
  await ensureReady();
  return withTransaction(async (client) => {
    const current = await queryRow('SELECT * FROM voice_stock_batches WHERE id = $1 FOR UPDATE', [batchId], client);
    if (!current || ['applied', 'cancelled', 'expired'].includes(current.status) || current.version !== updates.expectedVersion) return null;
    const transitions = {
      awaiting_choice: ['awaiting_choice', 'ready', 'awaiting_correction', 'cancelled'],
      awaiting_correction: ['awaiting_correction', 'ready', 'cancelled'],
      ready: ['ready', 'awaiting_choice', 'awaiting_correction', 'cancelled'],
    };
    if (updates.status && !transitions[current.status]?.includes(updates.status)) throw new Error('Transición de lote inválida.');
    const row = await queryRow(
      `UPDATE voice_stock_batches
       SET status = COALESCE($2, status), payload_json = COALESCE($3::jsonb, payload_json),
           reply_text = COALESCE($4, reply_text), version = version + 1, updated_at = NOW()
       WHERE id = $1 AND status <> 'applied' AND ($5::integer IS NULL OR version = $5)
       RETURNING *`,
      [batchId, updates.status ?? null, toJsonbParam(updates.payload), updates.replyText ?? null, updates.expectedVersion], client,
    );
    if (row && updates.replyText) {
      const payload = parseJsonValue(row.payload_json);
      await client.query(`INSERT INTO meta_reply_outbox (event_id, recipient, reply_text, stock_batch_id, question_id)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING`,
      [payload.replyMessageId ?? row.source_message_id, row.sender_phone, updates.replyText, row.id,
        row.status === 'awaiting_choice' ? payload.pendingQuestion?.id ?? null
          : row.status === 'awaiting_correction' ? payload.pendingDraftQuestionSetId ?? null : null]);
    }
    return rowToVoiceStockBatch(row);
  });
};

export const applyResolvedVoiceStockBatch = async (batchId, ownerPhone) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);

  return withTransaction(async (client) => {
    const batchRow = await queryRow(
      'SELECT * FROM voice_stock_batches WHERE id = $1 AND owner_phone = $2 FOR UPDATE',
      [batchId, normalizedOwnerPhone],
      client,
    );
    if (!batchRow) throw new Error('No encontré el lote de ingreso pendiente.');
    const batch = rowToVoiceStockBatch(batchRow);
    if (batch.status === 'applied') return batch.payload?.resultSnapshot ?? null;
    if (batch.status !== 'ready') throw new Error('El lote todavía tiene decisiones pendientes.');
    const actions = Array.isArray(batch.payload?.actions) ? batch.payload.actions : [];
    if (!batch.payload.coverageVerified || !validateStockDraft(batch.payload.evidenceSourceText ?? batch.sourceText, actions).ok ||
      new Set(actions.map((action) => action.itemId)).size !== actions.length || actions.some((action) => !action.itemId) ||
      actions.some((action) => !['existing', 'new'].includes(action.resolution?.kind))) {
      throw new Error('El lote tiene productos sin resolución final.');
    }
    if (batch.businessCategory === 'indumentaria' && actions.some((action) => !hasExplicitStockSize(action))) {
      throw new Error('Falta confirmar el talle de uno o más productos de indumentaria.');
    }
    if (stockReferenceIssues(actions, batch.payload.evidenceSourceText ?? batch.sourceText).length
      || actions.some((action) => /^anterior$/i.test(String(action.productModel ?? '').trim())
        || /\b(?:la|el|las|los)\s+anterior(?:es)?\b/i.test(action.productName))) {
      const error = new Error('Una referencia al producto anterior podría duplicar stock.');
      error.code = 'STOCK_REFERENCE_UNVERIFIED';
      throw error;
    }

    // Serialize with the legacy state writer, which still replaces tenant rows.
    await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
    await ensureTenantState(client, normalizedOwnerPhone);
    const snapshot = await queryAllState(normalizedOwnerPhone, client);
    for (const action of actions) {
      if (action.resolution.kind !== 'existing') continue;
      const product = snapshot.products.find((entry) => entry.id === action.resolution.productId);
      if (!product || !action.resolution.fingerprint || productFingerprint(product) !== action.resolution.fingerprint) {
        throw new Error(`El producto elegido cambió o ya no está disponible: ${action.productName}.`);
      }
      if (explicitIdentityConflict(action, product)) throw new Error(`La variante elegida no coincide con la medida o los datos de ${action.productName}.`);
    }
    const operationResult = await executeInventoryPlanInTransaction(client, resolvedStockBatchToPlan(batch), {
      businessId: normalizedOwnerPhone, actorId: batch.senderPhone, permissions: ['inventory:receive'],
      ownerPhoneVariants: getOwnerPhoneVariants(ownerPhone),
    });
    const appliedActions = actions.map((action) => {
      const result = operationResult.items.find((item) => item.itemId === action.itemId);
      return { ...action, resolvedProductId: result.skuId, price: result.price, priceCurrency: result.currency };
    });
    const timestamp = new Date().toISOString();
    for (let index = 0; index < appliedActions.length; index += 1) {
      const action = appliedActions[index];
      const itemId = String(action.itemId ?? `item-${index + 1}`);
      await client.query(
        `INSERT INTO transactions (id, owner_phone, timestamp, source_text, summary, actions_json, batch_id, item_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          `transaction-${batch.id}-${itemId}`,
          normalizedOwnerPhone,
          timestamp,
          batch.sourceText,
          summarizeAction(action),
          toJsonbParam([action]),
          batch.id,
          itemId,
        ],
      );
    }

    const resultSnapshot = await queryAllState(normalizedOwnerPhone, client);
    const nextProducts = resultSnapshot.products;
    const replyText = `Ingreso aplicado:\n${appliedActions.map((action) => {
      const product = nextProducts.find((entry) => entry.id === action.resolvedProductId);
      return `• ${product.name}${product.size ? ` — ${product.size}` : ''}: +${action.qty} (stock ${product.stockAvailable})${action.price != null ? `, $${action.price.toLocaleString('es-AR')} c/u` : ''}`;
    }).join('\n')}`;
    const replyMessageId = batch.payload.replyMessageId ?? batch.sourceMessageId;
    const payload = { ...batch.payload, appliedActions, resultSnapshot, operationResult,
      handledMessages: [...(batch.payload.handledMessages ?? []).filter((entry) => entry.messageId !== replyMessageId), { messageId: replyMessageId, replyText }],
    };
    await client.query(
      `UPDATE voice_stock_batches SET status = 'applied', payload_json = $2::jsonb, reply_text = $3,
         version = version + 1, updated_at = NOW() WHERE id = $1`,
      [batch.id, toJsonbParam(payload), replyText],
    );
    await client.query(`INSERT INTO meta_reply_outbox (event_id, recipient, reply_text) VALUES ($1, $2, $3)
      ON CONFLICT (event_id) DO NOTHING`, [replyMessageId, batch.senderPhone, replyText]);
    return resultSnapshot;
  });
};

const createInviteId = () => `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const expireStaleInvites = async (executor = null) => {
  if (!hasDatabaseConfig()) {
    const now = Date.now();
    for (const [id, invite] of memoryInvites.entries()) {
      if (invite.status === 'pending' && new Date(invite.expiresAt).getTime() < now) {
        memoryInvites.set(id, { ...invite, status: 'expired' });
      }
    }
    return;
  }

  if (!executor) {
    await ensureReady();
  }

  const run = executor ?? getPool();
  await run.query(
    `UPDATE business_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()`,
  );
};

export const resolveTenant = async (phoneNumber) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);

  if (!normalizedPhoneNumber) {
    return DEFAULT_OWNER_PHONE;
  }

  if (!hasDatabaseConfig()) {
    return memoryMembers.get(normalizedPhoneNumber)?.tenantPhone ?? normalizedPhoneNumber;
  }

  await ensureReady();
  const row = await queryRow('SELECT tenant_phone FROM business_members WHERE member_phone = $1', [
    normalizedPhoneNumber,
  ]);
  return row?.tenant_phone ?? normalizedPhoneNumber;
};

export const claimMetaMessage = async ({ messageId, ownerPhone, senderPhone, rawBody }) => {
  await ensureReady();
  const result = await getPool().query(
    `INSERT INTO meta_message_claims (message_id, owner_phone, sender_phone, status, claimed_at, raw_body_json)
     VALUES ($1, $2, $3, 'processing', NOW(), $4::jsonb)
     ON CONFLICT (message_id) DO UPDATE
       SET status = 'processing', claimed_at = NOW(), completed_at = NULL, attempts = meta_message_claims.attempts + 1,
         raw_body_json = COALESCE(meta_message_claims.raw_body_json, EXCLUDED.raw_body_json)
       WHERE meta_message_claims.status <> 'completed'
         AND meta_message_claims.claimed_at < NOW() - INTERVAL '5 minutes'
     RETURNING message_id`,
    [String(messageId), normalizeOwnerPhone(ownerPhone), normalizePhone(senderPhone), toJsonbParam(rawBody)],
  );
  return result.rowCount > 0;
};

// A legacy domain write and its outbox commit together, before meta_events is
// saved. Recover that receipt before the new ordinary-message interpreter runs.
// The claim binds the globally unique message/outbox ID to both tenant and actor.
export const replayCommittedMetaMessage = async ({messageId,ownerPhone,senderPhone,sourceText}) => {
  await ensureReady();
  const owner=normalizeOwnerPhone(ownerPhone),sender=normalizePhone(senderPhone);
  return withTransaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const claim=await queryRow(`SELECT claim.*,reply.recipient,reply.reply_text,event.source_text,event.actions_json,event.error
      FROM meta_message_claims AS claim
      LEFT JOIN meta_reply_outbox AS reply ON reply.event_id=claim.message_id
      LEFT JOIN meta_events AS event ON event.id=claim.message_id AND event.owner_phone=claim.owner_phone AND event.from_number=claim.sender_phone
      WHERE claim.message_id=$1`,[messageId],client);
    const conflict=()=>{throw new InventoryOperationError('IDEMPOTENCY_CONFLICT','El ID del mensaje ya corresponde a otra instrucción, negocio o remitente.');};
    if (claim && (claim.owner_phone!==owner || claim.sender_phone!==sender || (claim.recipient && claim.recipient!==sender))) conflict();
    const raw=parseJsonValue(claim?.raw_body_json);
    const original=(raw?.entry ?? []).flatMap(entry=>(entry.changes ?? []).flatMap(change=>change.value?.messages ?? []))
      .find(message=>message.id===messageId && normalizePhone(message.from)===sender);
    // Match the normalization at extractMetaMessages, while keeping saved
    // transcripts and domain source text exact for idempotency checks.
    const originalText=typeof original?.text?.body==='string' ? original.text.body.trim() : undefined;
    const storedText=claim?.transcript ?? originalText ?? claim?.source_text;
    if (storedText!=null && storedText!==sourceText) conflict();
    const universal=await queryRow('SELECT actor_id,request_hash,result_json FROM universal_meta_commands WHERE owner_phone=$1 AND message_id=$2',[owner,messageId],client);
    if (universal) {
      if (universal.actor_id!==sender || universal.request_hash!==operationRequestDigest({actorId:sender,sourceText})) conflict();
      return parseJsonValue(universal.result_json);
    }
    const selection=await queryRow('SELECT actor_id,request_hash,result_json FROM meta_selection_commands WHERE owner_phone=$1 AND message_id=$2',[owner,messageId],client);
    if (selection) {
      const command=parseMetaSelectionCommand(sourceText);
      if (selection.actor_id!==sender || !command || selection.request_hash!==operationRequestDigest({actorId:sender,command})) conflict();
      return parseJsonValue(selection.result_json);
    }
    const batch=await getRetiredMetaBatchForMessage({ownerPhone:owner,senderPhone:sender,messageId},client);
    if (batch) {
      const batchText=batch.sourceMessageId===messageId ? batch.sourceText :
        [...(batch.payload.clarifications ?? []),batch.payload.pendingChoiceReply,batch.payload.pendingDraftAnswer]
          .find(entry=>entry?.messageId===messageId)?.text;
      if (batchText!=null && batchText!==sourceText) conflict();
      if (batch.status==='applied' && storedText==null && batchText==null) conflict();
      // Immutable historical facts only: never finish a ready transition or
      // resolve a pending answer against the current product catalog.
      return replayLegacyMetaBatch(batch,messageId,claim?.reply_text);
    }
    const oldSelection=await getRetiredMetaSelectionForMessage({ownerPhone:owner,senderPhone:sender,messageId},client);
    if (oldSelection) {
      if (parseJsonValue(oldSelection.preview_json)?.mutation?.reason!==sourceText) conflict();
      return null;
    }
    if (claim?.reply_text==null) return null;
    const domain=await queryRow(`SELECT plan_json AS request_json,result_json FROM inventory_operations
        WHERE owner_phone=$1 AND actor_id=$2 AND operation_id=ANY($3)
      UNION ALL SELECT plan_json,result_json FROM account_operations
        WHERE owner_phone=$1 AND actor_id=$2 AND operation_id=ANY($4)
      UNION ALL SELECT request_json,result_json FROM order_operations
        WHERE owner_phone=$1 AND actor_id=$2 AND operation_id=ANY($5)`,
    [owner,sender,[`whatsapp:${messageId}`,`meta:${messageId}`],
      [`account-compat:whatsapp:${messageId}`,`account-compat:meta:${messageId}`],
      [`batch:whatsapp:${messageId}`,`batch:meta:${messageId}`]],client);
    const request=parseJsonValue(domain?.request_json),result=parseJsonValue(domain?.result_json);
    const domainText=request?.source?.text ?? request?.sourceText;
    if (domainText!=null && domainText!==sourceText) conflict();
    // An outbox without source evidence still prevents a new interpretation.
    // Fail closed instead of assigning an old receipt to different text.
    if (storedText==null && domainText==null) conflict();
    return {handled:true,intent:'mixed',requiresConfirmation:false,replyText:claim.reply_text,
      actions:result ? operationResultActions(result) : parseJsonValue(claim.actions_json) ?? [],
      ...(result ? {operationResult:result} : {}),...(claim.error ? {errorCode:claim.error} : {})};
  });
};

export const loadMetaTranscript = async (messageId) => {
  await ensureReady();
  const row = await queryRow('SELECT transcript FROM meta_message_claims WHERE message_id = $1', [messageId]);
  return row?.transcript ?? null;
};
export const saveMetaTranscript = async (messageId, transcript) => {
  await ensureReady();
  await getPool().query('UPDATE meta_message_claims SET transcript = COALESCE(transcript, $2) WHERE message_id = $1', [messageId, transcript]);
};
export const failMetaMessageClaim = async (messageId, error) => {
  await ensureReady();
  await getPool().query(`UPDATE meta_message_claims SET status = 'pending', last_error = $2,
    next_attempt_at = NOW() + LEAST(60, attempts) * INTERVAL '30 seconds'
    WHERE message_id = $1 AND status <> 'completed'`, [messageId, String(error).slice(0, 500)]);
};
export const claimRecoverableMetaMessages = async () => {
  await ensureReady();
  return withTransaction(async (client) => {
    const result = await client.query(`WITH ready AS (
      SELECT message_id FROM meta_message_claims WHERE raw_body_json IS NOT NULL
      AND ((status = 'pending' AND next_attempt_at <= NOW()) OR (status = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes'))
      ORDER BY claimed_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      UPDATE meta_message_claims AS job SET status = 'processing', claimed_at = NOW(), attempts = attempts + 1
      FROM ready WHERE job.message_id = ready.message_id RETURNING job.message_id, job.raw_body_json`);
    return result.rows;
  });
};

export const getStateSnapshotStrict = async (ownerPhone) => {
  await ensureReady();
  return withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return queryAllState(normalizeOwnerPhone(ownerPhone),client);
  });
};

export const closeDatabase = async () => {
  if (pool) await pool.end();
  pool = undefined; initializePromise = undefined;
};

export const completeMetaMessageClaim = async (messageId) => {
  await ensureReady();
  await getPool().query(
    `UPDATE meta_message_claims SET status = 'completed', completed_at = NOW() WHERE message_id = $1`,
    [String(messageId)],
  );
};

export const enqueueMetaReply = async (eventId, recipient, replyText) => {
  await ensureReady();
  await getPool().query(
    `INSERT INTO meta_reply_outbox (event_id, recipient, reply_text)
     VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
    [String(eventId), normalizePhone(recipient), String(replyText)],
  );
};

export const claimPendingMetaReplies = async (limit = 20) => {
  await ensureReady();
  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH ready AS (
         SELECT event_id FROM meta_reply_outbox
         WHERE (status = 'pending' AND next_attempt_at <= NOW())
            OR (status = 'sending' AND claimed_at < NOW() - INTERVAL '2 minutes')
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE meta_reply_outbox AS outbox
       SET status = 'sending', attempts = attempts + 1, claimed_at = NOW()
       FROM ready WHERE outbox.event_id = ready.event_id
       RETURNING outbox.event_id, outbox.recipient, outbox.reply_text, outbox.attempts`,
      [Math.max(1, Math.min(100, normalizeInteger(limit, 20)))],
    );
    return result.rows;
  });
};

export const finishMetaReply = async (eventId, error = null, providerMessageId = null) => {
  await ensureReady();
  await getPool().query(
    `UPDATE meta_reply_outbox
     SET status = CASE WHEN $2::text IS NULL THEN 'sent' ELSE 'pending' END,
         sent_at = CASE WHEN $2::text IS NULL THEN NOW() ELSE sent_at END,
         last_error = $2,
         provider_message_ids = CASE WHEN $2::text IS NULL AND $3::text IS NOT NULL
           AND NOT provider_message_ids @> jsonb_build_array($3::text)
           THEN provider_message_ids || jsonb_build_array($3::text) ELSE provider_message_ids END,
         next_attempt_at = CASE WHEN $2::text IS NULL THEN next_attempt_at
           ELSE NOW() + LEAST(60, GREATEST(1, attempts * 2)) * INTERVAL '1 minute' END
     WHERE event_id = $1`,
    [String(eventId), error ? String(error).slice(0, 500) : null,
      typeof providerMessageId === 'string' && providerMessageId.trim() ? providerMessageId : null],
  );
};

// Bind an inbound quoted reply to the immutable question snapshot that was sent,
// rather than resolving its text against whichever question is current now.
export const getMetaReplyQuestion = async (providerMessageId, ownerPhone, senderPhone) => {
  await ensureReady();
  const row = await queryRow(`SELECT reply.stock_batch_id, reply.question_id
    FROM meta_reply_outbox AS reply JOIN voice_stock_batches AS batch ON batch.id = reply.stock_batch_id
    WHERE reply.provider_message_ids @> $1::jsonb AND batch.owner_phone = $2
      AND batch.sender_phone = $3 AND reply.recipient = $3 AND reply.question_id IS NOT NULL
    ORDER BY reply.created_at DESC LIMIT 1`,
  [JSON.stringify([String(providerMessageId)]), normalizeOwnerPhone(ownerPhone), normalizePhone(senderPhone)]);
  return row ? { batchId: row.stock_batch_id, questionId: row.question_id } : null;
};

const defaultVoiceStockBatchMode = () => {
  const configured = String(process.env.VOICE_STOCK_BATCHES_MODE ?? 'active').trim().toLowerCase();
  return ['active', 'shadow', 'disabled'].includes(configured) ? configured : 'active';
};

export const getVoiceStockBatchMode = async (ownerPhone) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  if (!hasDatabaseConfig()) return memoryVoiceStockBatchModes.get(normalizedOwnerPhone) ?? defaultVoiceStockBatchMode();
  await ensureReady();
  const row = await queryRow('SELECT mode FROM voice_stock_batch_settings WHERE owner_phone = $1', [normalizedOwnerPhone]);
  return row?.mode ?? defaultVoiceStockBatchMode();
};

export const setVoiceStockBatchMode = async (ownerPhone, mode) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  if (!['active', 'shadow', 'disabled'].includes(mode)) throw new Error('Modo de ingresos por voz inválido.');
  if (!hasDatabaseConfig()) {
    memoryVoiceStockBatchModes.set(normalizedOwnerPhone, mode);
    return mode;
  }
  await ensureReady();
  await getPool().query(
    `INSERT INTO voice_stock_batch_settings (owner_phone, mode, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (owner_phone) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()`,
    [normalizedOwnerPhone, mode],
  );
  return mode;
};

export const saveVoiceStockShadowRun = async (messageId, ownerPhone, result) => {
  await ensureReady();
  await getPool().query(`INSERT INTO voice_stock_shadow_runs (message_id, owner_phone, proposed_json)
    VALUES ($1, $2, $3::jsonb) ON CONFLICT (message_id) DO NOTHING`, [messageId, normalizeOwnerPhone(ownerPhone), toJsonbParam(result)]);
};
export const saveVoiceStockShadowBaseline = async (messageId, result) => {
  await ensureReady();
  await getPool().query('UPDATE voice_stock_shadow_runs SET baseline_json = $2::jsonb WHERE message_id = $1', [messageId, toJsonbParam(result)]);
};

export const saveMetaEvent = async (event) => {
  await ensureReady();

  const existing = await findMetaEventById(event.id);
  if (existing) {
    return existing;
  }

  const normalizedFrom = normalizePhone(event.fromNumber);
  let tenantPhone = normalizePhone(event.ownerPhone);
  if (!tenantPhone && normalizedFrom) {
    tenantPhone = await resolveTenant(normalizedFrom);
  }
  if (!tenantPhone) {
    tenantPhone = DEFAULT_OWNER_PHONE;
  }

  const result = await getPool().query(
    `
      INSERT INTO meta_events (id, at, from_number, owner_phone, body, num_media, kind, source_text, transcript, reply_text, error, actions_json, parse_context_json, processed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
      RETURNING *
    `,
    [
      event.id,
      event.at,
      normalizedFrom || null,
      tenantPhone,
      event.body ?? null,
      normalizeInteger(event.numMedia, 0),
      event.kind ?? null,
      event.sourceText ?? null,
      event.transcript ?? null,
      event.replyText ?? null,
      event.error ?? null,
      toJsonbParam(event.actionsJson),
      toJsonbParam(event.parseContextJson),
      Boolean(event.processed),
    ],
  );

  return rowToMetaEvent(result.rows[0]);
};


export const markMetaEventProcessed = async (eventId, updates) => {
  await ensureReady();

  await getPool().query(
    `
      UPDATE meta_events
      SET at = COALESCE($1, at),
          from_number = COALESCE($2, from_number),
          body = COALESCE($3, body),
          num_media = COALESCE($4, num_media),
          kind = COALESCE($5, kind),
          source_text = COALESCE($6, source_text),
          transcript = COALESCE($7, transcript),
          reply_text = COALESCE($8, reply_text),
          error = COALESCE($9, error),
          actions_json = COALESCE($10::jsonb, actions_json),
          processed = COALESCE($11, processed)
      WHERE id = $12
    `,
    [
      updates.at ?? null,
      updates.fromNumber ?? null,
      updates.body ?? null,
      typeof updates.numMedia === 'number' ? updates.numMedia : null,
      updates.kind ?? null,
      updates.sourceText ?? null,
      updates.transcript ?? null,
      updates.replyText ?? null,
      updates.error ?? null,
      toJsonbParam(updates.actionsJson),
      typeof updates.processed === 'boolean' ? updates.processed : null,
      eventId,
    ],
  );
};

export const getMetaEvents = async (limit = 50, ownerPhone = null, options = {}) => {
  await ensureReady();
  const safeLimit = Math.max(1, Math.min(normalizeInteger(limit, 50), 500));
  const senderPhone = options?.senderPhone ?? null;

  if (senderPhone) {
    const senderVariants = getOwnerPhoneVariants(senderPhone);
    const rows = await queryRows(
      'SELECT * FROM meta_events WHERE from_number = ANY($1) AND ($3::text[] IS NULL OR owner_phone = ANY($3)) ORDER BY at DESC LIMIT $2',
      [senderVariants, safeLimit, ownerPhone ? getOwnerPhoneVariants(ownerPhone) : null],
    );
    return rows.map(rowToMetaEvent);
  }

  if (ownerPhone) {
    const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);
    const rows = await queryRows(
      'SELECT * FROM meta_events WHERE owner_phone = ANY($1) ORDER BY at DESC LIMIT $2',
      [ownerPhoneVariants, safeLimit],
    );
    return rows.map(rowToMetaEvent);
  }

  const rows = await queryRows('SELECT * FROM meta_events ORDER BY at DESC LIMIT $1', [safeLimit]);
  return rows.map(rowToMetaEvent);
};


export const getClientPhones = async () => {
  await ensureReady();

    const rows = await queryRows(
    `
      SELECT owner_phone AS phone FROM products
      UNION
      SELECT owner_phone AS phone FROM clients
      UNION
      SELECT owner_phone AS phone FROM proveedores
      UNION
      SELECT owner_phone AS phone FROM transactions
      UNION
      SELECT owner_phone AS phone FROM meta_events
    `,
  );


  const phones = rows
    .map((row) => String(row.phone ?? '').trim())
    .filter((phone) => phone.length)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));

  if (!phones.includes(DEFAULT_OWNER_PHONE)) {
    phones.unshift(DEFAULT_OWNER_PHONE);
  }

  return phones;
};

export const findMetaEventById = async (eventId) => {
  await ensureReady();
  const row = await queryRow('SELECT * FROM meta_events WHERE id = $1', [eventId]);
  return row ? rowToMetaEvent(row) : null;
};

export const createAuthOtpChallenge = async (phoneNumber) => {
  await ensureReady();

  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);

  if (!normalizedPhoneNumber) {
    throw new Error('Missing phone number');
  }

  const challengeId = createChallengeId();
  const otpCode = createOtpCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const codeHash = createChallengeHash(normalizedPhoneNumber, otpCode, salt);
  const expiresAt = new Date(Date.now() + AUTH_OTP_TTL_MS).toISOString();

  await getPool().query(
    `
      UPDATE auth_otp_challenges
      SET consumed = TRUE
      WHERE phone_number = $1 AND consumed = FALSE
    `,
    [normalizedPhoneNumber],
  );

  await getPool().query(
    `
      INSERT INTO auth_otp_challenges (id, phone_number, code_hash, salt, expires_at, attempts, consumed)
      VALUES ($1, $2, $3, $4, $5, 0, FALSE)
    `,
    [challengeId, normalizedPhoneNumber, codeHash, salt, expiresAt],
  );

  return {
    challengeId,
    phoneNumber: normalizedPhoneNumber,
    otpCode,
    expiresAt,
    expiresInSeconds: Math.max(60, Math.round(AUTH_OTP_TTL_MS / 1000)),
  };
};

export const revokeAuthOtpChallenge = async (challengeId) => {
  await ensureReady();

  if (!challengeId) {
    return;
  }

  await getPool().query(
    `
      UPDATE auth_otp_challenges
      SET consumed = TRUE
      WHERE id = $1
    `,
    [challengeId],
  );
};

const VALID_BUSINESS_CATEGORIES = new Set([
  'indumentaria',
  'calzado',
  'ferreteria',
  'electronica',
  'kiosco',
  'general',
]);

const memoryBusinessProfiles = new Map();

const toAuthUserProfile = ({
  phoneNumber,
  tenantPhone = null,
  role = 'owner',
  businessName = null,
  businessCategory = null,
  pendingInvite = null,
  hasOwnBusiness = false,
}) => {
  const normalizedCategory =
    typeof businessCategory === 'string' && VALID_BUSINESS_CATEGORIES.has(businessCategory)
      ? businessCategory
      : null;
  const normalizedBusinessName =
    typeof businessName === 'string' && businessName.trim() ? businessName.trim() : null;

  return {
    phoneNumber,
    tenantPhone: tenantPhone || phoneNumber,
    role: role === 'member' ? 'member' : 'owner',
    businessName: normalizedBusinessName,
    businessCategory: normalizedCategory,
    needsOnboarding: !normalizedCategory,
    pendingInvite: pendingInvite ?? null,
    hasOwnBusiness: Boolean(hasOwnBusiness),
  };
};

const rowToPendingInvite = (row, businessName, hasOwnBusiness) => {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    tenantPhone: row.tenant_phone,
    businessName: typeof businessName === 'string' && businessName.trim() ? businessName.trim() : null,
    invitedByPhone: row.invited_by,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    hasOwnBusiness: Boolean(hasOwnBusiness),
  };
};

const loadPendingInviteForPhone = async (phoneNumber) => {
  await expireStaleInvites();

  if (!hasDatabaseConfig()) {
    const invite = [...memoryInvites.values()].find(
      (item) => item.invitedPhone === phoneNumber && item.status === 'pending',
    );
    if (!invite) {
      return null;
    }

    const ownerProfile = memoryBusinessProfiles.get(invite.tenantPhone);
    return {
      id: invite.id,
      tenantPhone: invite.tenantPhone,
      businessName: ownerProfile?.businessName ?? null,
      invitedByPhone: invite.invitedBy,
      expiresAt: invite.expiresAt,
    };
  }

  const row = await queryRow(
    `
      SELECT id, tenant_phone, invited_phone, invited_by, status, expires_at, created_at
      FROM business_invites
      WHERE invited_phone = $1 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [phoneNumber],
  );

  if (!row) {
    return null;
  }

  const ownerRow = await queryRow(
    'SELECT business_name FROM auth_users WHERE phone_number = $1',
    [row.tenant_phone],
  );

  return rowToPendingInvite(row, ownerRow?.business_name ?? null, false);
};

export const upsertAuthUser = async (phoneNumber) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);

  if (!normalizedPhoneNumber) {
    throw new Error('Número de teléfono inválido');
  }

  if (!hasDatabaseConfig()) {
    if (!memoryBusinessProfiles.has(normalizedPhoneNumber)) {
      memoryBusinessProfiles.set(normalizedPhoneNumber, {
        businessName: null,
        businessCategory: null,
      });
    }
    return { phoneNumber: normalizedPhoneNumber };
  }

  await ensureReady();
  await getPool().query(
    `
      INSERT INTO auth_users (phone_number, created_at, last_login_at)
      VALUES ($1, NOW(), NOW())
      ON CONFLICT (phone_number) DO UPDATE
      SET last_login_at = NOW()
    `,
    [normalizedPhoneNumber],
  );

  return { phoneNumber: normalizedPhoneNumber };
};

export const getAuthUserProfile = async (phoneNumber) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);

  if (!normalizedPhoneNumber) {
    throw new Error('Número de teléfono inválido');
  }

  const tenantPhone = await resolveTenant(normalizedPhoneNumber);
  const role = tenantPhone === normalizedPhoneNumber ? 'owner' : 'member';

  if (!hasDatabaseConfig()) {
    const tenantProfile = memoryBusinessProfiles.get(tenantPhone) ?? {
      businessName: null,
      businessCategory: null,
    };
    const ownProfile = memoryBusinessProfiles.get(normalizedPhoneNumber) ?? {
      businessName: null,
      businessCategory: null,
    };
    const hasOwnBusiness = VALID_BUSINESS_CATEGORIES.has(ownProfile.businessCategory);
    const pendingInvite = await loadPendingInviteForPhone(normalizedPhoneNumber);
    if (pendingInvite) {
      pendingInvite.hasOwnBusiness = hasOwnBusiness;
    }

    return toAuthUserProfile({
      phoneNumber: normalizedPhoneNumber,
      tenantPhone,
      role,
      businessName: tenantProfile.businessName,
      businessCategory: tenantProfile.businessCategory,
      pendingInvite,
      hasOwnBusiness,
    });
  }

  await ensureReady();
  await upsertAuthUser(normalizedPhoneNumber);

  const tenantRow = await queryRow(
    'SELECT phone_number, business_name, business_category FROM auth_users WHERE phone_number = $1',
    [tenantPhone],
  );
  const ownRow = await queryRow(
    'SELECT business_name, business_category FROM auth_users WHERE phone_number = $1',
    [normalizedPhoneNumber],
  );
  const hasOwnBusiness = VALID_BUSINESS_CATEGORIES.has(ownRow?.business_category);
  const pendingInvite = await loadPendingInviteForPhone(normalizedPhoneNumber);
  if (pendingInvite) {
    pendingInvite.hasOwnBusiness = hasOwnBusiness;
  }

  return toAuthUserProfile({
    phoneNumber: normalizedPhoneNumber,
    tenantPhone,
    role,
    businessName: tenantRow?.business_name ?? null,
    businessCategory: tenantRow?.business_category ?? null,
    pendingInvite,
    hasOwnBusiness,
  });
};

export const saveBusinessProfile = async (phoneNumber, { businessName, businessCategory }) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);
  const normalizedBusinessName = String(businessName ?? '').trim();
  const normalizedBusinessCategory = String(businessCategory ?? '').trim();

  if (!normalizedPhoneNumber) {
    throw new Error('Número de teléfono inválido');
  }

  if (!normalizedBusinessName) {
    throw new Error('El nombre del emprendimiento es obligatorio');
  }

  if (!VALID_BUSINESS_CATEGORIES.has(normalizedBusinessCategory)) {
    throw new Error('Categoría de negocio inválida');
  }

  const tenantPhone = await resolveTenant(normalizedPhoneNumber);
  if (tenantPhone !== normalizedPhoneNumber) {
    throw new TeamError('Solo el dueño puede cambiar el nombre y el rubro del negocio.');
  }

  if (!hasDatabaseConfig()) {
    memoryBusinessProfiles.set(normalizedPhoneNumber, {
      businessName: normalizedBusinessName,
      businessCategory: normalizedBusinessCategory,
    });
    return getAuthUserProfile(normalizedPhoneNumber);
  }

  await ensureReady();
  await upsertAuthUser(normalizedPhoneNumber);

  await getPool().query(
    `
      UPDATE auth_users
      SET business_name = $1,
          business_category = $2
      WHERE phone_number = $3
    `,
    [normalizedBusinessName, normalizedBusinessCategory, normalizedPhoneNumber],
  );

  return getAuthUserProfile(normalizedPhoneNumber);
};

const assertOwner = async (phoneNumber) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);
  const tenantPhone = await resolveTenant(normalizedPhoneNumber);

  if (tenantPhone !== normalizedPhoneNumber) {
    throw new TeamError('Solo el dueño puede gestionar el equipo.');
  }

  return normalizedPhoneNumber;
};

const findPendingInviteByPhone = async (invitedPhone, executor = null) => {
  if (!hasDatabaseConfig()) {
    return [...memoryInvites.values()].find(
      (item) => item.invitedPhone === invitedPhone && item.status === 'pending',
    ) ?? null;
  }

  return queryRow(
    `
      SELECT id, tenant_phone, invited_phone, invited_by, status, expires_at, created_at
      FROM business_invites
      WHERE invited_phone = $1 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [invitedPhone],
    executor,
  );
};

export const createBusinessInvite = async (ownerPhone, invitedPhoneInput) => {
  const ownerPhoneNumber = await assertOwner(ownerPhone);
  const invitedPhone = normalizeAuthPhoneNumber(invitedPhoneInput);

  if (!invitedPhone) {
    throw new TeamError('Ingresá un número de celular válido.');
  }

  if (invitedPhone === ownerPhoneNumber) {
    throw new TeamError('No podés invitarte a vos mismo.');
  }

  await expireStaleInvites();

  if (!hasDatabaseConfig()) {
    if (memoryMembers.get(invitedPhone)?.tenantPhone === ownerPhoneNumber) {
      throw new TeamError('Ese número ya forma parte del equipo.');
    }

    const existing = [...memoryInvites.values()].find(
      (item) => item.invitedPhone === invitedPhone && item.status === 'pending',
    );

    if (existing && existing.tenantPhone !== ownerPhoneNumber) {
      throw new TeamError('Ese número ya tiene una invitación pendiente de otro negocio.');
    }

    const expiresAt = new Date(Date.now() + BUSINESS_INVITE_TTL_MS).toISOString();

    if (existing) {
      const updated = { ...existing, invitedBy: ownerPhoneNumber, expiresAt };
      memoryInvites.set(existing.id, updated);
      return { invite: updated, resent: true };
    }

    const invite = {
      id: createInviteId(),
      tenantPhone: ownerPhoneNumber,
      invitedPhone,
      invitedBy: ownerPhoneNumber,
      status: 'pending',
      expiresAt,
      createdAt: new Date().toISOString(),
    };
    memoryInvites.set(invite.id, invite);
    return { invite, resent: false };
  }

  await ensureReady();

  const existingMember = await queryRow(
    'SELECT member_phone FROM business_members WHERE tenant_phone = $1 AND member_phone = $2',
    [ownerPhoneNumber, invitedPhone],
  );
  if (existingMember) {
    throw new TeamError('Ese número ya forma parte del equipo.');
  }

  const existingPending = await findPendingInviteByPhone(invitedPhone);
  if (existingPending && existingPending.tenant_phone !== ownerPhoneNumber) {
    throw new TeamError('Ese número ya tiene una invitación pendiente de otro negocio.');
  }

  const expiresAt = new Date(Date.now() + BUSINESS_INVITE_TTL_MS).toISOString();

  if (existingPending) {
    await getPool().query(
      `
        UPDATE business_invites
        SET invited_by = $1,
            expires_at = $2
        WHERE id = $3
      `,
      [ownerPhoneNumber, expiresAt, existingPending.id],
    );

    return {
      invite: {
        id: existingPending.id,
        tenantPhone: existingPending.tenant_phone,
        invitedPhone: existingPending.invited_phone,
        invitedBy: ownerPhoneNumber,
        status: 'pending',
        expiresAt,
        createdAt: existingPending.created_at,
      },
      resent: true,
    };
  }

  const inviteId = createInviteId();
  await getPool().query(
    `
      INSERT INTO business_invites (id, tenant_phone, invited_phone, invited_by, status, expires_at)
      VALUES ($1, $2, $3, $4, 'pending', $5)
    `,
    [inviteId, ownerPhoneNumber, invitedPhone, ownerPhoneNumber, expiresAt],
  );

  return {
    invite: {
      id: inviteId,
      tenantPhone: ownerPhoneNumber,
      invitedPhone,
      invitedBy: ownerPhoneNumber,
      status: 'pending',
      expiresAt,
      createdAt: new Date().toISOString(),
    },
    resent: false,
  };
};

export const cancelBusinessInvite = async (ownerPhone, inviteId) => {
  const ownerPhoneNumber = await assertOwner(ownerPhone);
  const id = String(inviteId ?? '').trim();

  if (!id) {
    throw new TeamError('Invitación inválida.');
  }

  if (!hasDatabaseConfig()) {
    const invite = memoryInvites.get(id);
    if (!invite || invite.tenantPhone !== ownerPhoneNumber || invite.status !== 'pending') {
      throw new TeamError('No encontramos esa invitación.', 404);
    }
    memoryInvites.set(id, { ...invite, status: 'cancelled' });
    return { ok: true };
  }

  await ensureReady();
  const result = await getPool().query(
    `
      UPDATE business_invites
      SET status = 'cancelled'
      WHERE id = $1 AND tenant_phone = $2 AND status = 'pending'
      RETURNING id
    `,
    [id, ownerPhoneNumber],
  );

  if (!result.rowCount) {
    throw new TeamError('No encontramos esa invitación.', 404);
  }

  return { ok: true };
};

export const acceptBusinessInvite = async (phoneNumber, inviteId) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);
  const id = String(inviteId ?? '').trim();

  if (!normalizedPhoneNumber || !id) {
    throw new TeamError('Invitación inválida.');
  }

  await expireStaleInvites();

  if (!hasDatabaseConfig()) {
    const invite = memoryInvites.get(id);
    if (!invite || invite.invitedPhone !== normalizedPhoneNumber) {
      throw new TeamError('No encontramos esa invitación.', 404);
    }
    if (invite.status !== 'pending') {
      throw new TeamError('Esa invitación ya no está disponible.');
    }
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      memoryInvites.set(id, { ...invite, status: 'expired' });
      throw new TeamError('Esa invitación venció.');
    }

    memoryMembers.delete(normalizedPhoneNumber);
    memoryMembers.set(normalizedPhoneNumber, {
      tenantPhone: invite.tenantPhone,
      role: 'member',
      createdAt: new Date().toISOString(),
    });
    memoryInvites.set(id, { ...invite, status: 'accepted' });
    return getAuthUserProfile(normalizedPhoneNumber);
  }

  await ensureReady();

  return withClient(async (client) => {
    await expireStaleInvites(client);

    const invite = await queryRow(
      'SELECT * FROM business_invites WHERE id = $1',
      [id],
      client,
    );

    if (!invite || invite.invited_phone !== normalizedPhoneNumber) {
      throw new TeamError('No encontramos esa invitación.', 404);
    }
    if (invite.status !== 'pending') {
      throw new TeamError('Esa invitación ya no está disponible.');
    }
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      await client.query(`UPDATE business_invites SET status = 'expired' WHERE id = $1`, [id]);
      throw new TeamError('Esa invitación venció.');
    }

    await client.query('DELETE FROM business_members WHERE member_phone = $1', [normalizedPhoneNumber]);
    await client.query(
      `
        INSERT INTO business_members (tenant_phone, member_phone, role)
        VALUES ($1, $2, 'member')
        ON CONFLICT (tenant_phone, member_phone) DO NOTHING
      `,
      [invite.tenant_phone, normalizedPhoneNumber],
    );
    await client.query(`UPDATE business_invites SET status = 'accepted' WHERE id = $1`, [id]);
  }).then(() => getAuthUserProfile(normalizedPhoneNumber));
};

export const declineBusinessInvite = async (phoneNumber, inviteId) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);
  const id = String(inviteId ?? '').trim();

  if (!normalizedPhoneNumber || !id) {
    throw new TeamError('Invitación inválida.');
  }

  if (!hasDatabaseConfig()) {
    const invite = memoryInvites.get(id);
    if (!invite || invite.invitedPhone !== normalizedPhoneNumber || invite.status !== 'pending') {
      throw new TeamError('No encontramos esa invitación.', 404);
    }
    memoryInvites.set(id, { ...invite, status: 'declined' });
    return getAuthUserProfile(normalizedPhoneNumber);
  }

  await ensureReady();
  const result = await getPool().query(
    `
      UPDATE business_invites
      SET status = 'declined'
      WHERE id = $1 AND invited_phone = $2 AND status = 'pending'
      RETURNING id
    `,
    [id, normalizedPhoneNumber],
  );

  if (!result.rowCount) {
    throw new TeamError('No encontramos esa invitación.', 404);
  }

  return getAuthUserProfile(normalizedPhoneNumber);
};

export const leaveBusinessTeam = async (phoneNumber) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);

  if (!normalizedPhoneNumber) {
    throw new TeamError('Número de teléfono inválido.');
  }

  const tenantPhone = await resolveTenant(normalizedPhoneNumber);
  if (tenantPhone === normalizedPhoneNumber) {
    throw new TeamError('El dueño no puede salir de su propio negocio.');
  }

  if (!hasDatabaseConfig()) {
    memoryMembers.delete(normalizedPhoneNumber);
    return getAuthUserProfile(normalizedPhoneNumber);
  }

  await ensureReady();
  const result = await getPool().query('DELETE FROM business_members WHERE member_phone = $1 RETURNING member_phone', [
    normalizedPhoneNumber,
  ]);

  if (!result.rowCount) {
    throw new TeamError('No pertenecés a un equipo.');
  }

  return getAuthUserProfile(normalizedPhoneNumber);
};

export const removeBusinessMember = async (ownerPhone, memberPhoneInput) => {
  const ownerPhoneNumber = await assertOwner(ownerPhone);
  const memberPhone = normalizeAuthPhoneNumber(memberPhoneInput);

  if (!memberPhone) {
    throw new TeamError('Número de teléfono inválido.');
  }

  if (memberPhone === ownerPhoneNumber) {
    throw new TeamError('No podés sacarte a vos mismo del equipo.');
  }

  if (!hasDatabaseConfig()) {
    const membership = memoryMembers.get(memberPhone);
    if (!membership || membership.tenantPhone !== ownerPhoneNumber) {
      throw new TeamError('Ese número no forma parte del equipo.', 404);
    }
    memoryMembers.delete(memberPhone);
    return { ok: true };
  }

  await ensureReady();
  const result = await getPool().query(
    `
      DELETE FROM business_members
      WHERE tenant_phone = $1 AND member_phone = $2
      RETURNING member_phone
    `,
    [ownerPhoneNumber, memberPhone],
  );

  if (!result.rowCount) {
    throw new TeamError('Ese número no forma parte del equipo.', 404);
  }

  return { ok: true };
};

export const getBusinessTeam = async (phoneNumber) => {
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);

  if (!normalizedPhoneNumber) {
    throw new TeamError('Número de teléfono inválido.');
  }

  const profile = await getAuthUserProfile(normalizedPhoneNumber);
  const tenantPhone = profile.tenantPhone;
  const isOwner = profile.role === 'owner';

  if (!hasDatabaseConfig()) {
    const members = [
      {
        phoneNumber: tenantPhone,
        role: 'owner',
        createdAt: null,
      },
      ...[...memoryMembers.entries()]
        .filter(([, membership]) => membership.tenantPhone === tenantPhone)
        .map(([memberPhone, membership]) => ({
          phoneNumber: memberPhone,
          role: membership.role,
          createdAt: membership.createdAt,
        })),
    ];

    const invites = isOwner
      ? [...memoryInvites.values()]
          .filter((invite) => invite.tenantPhone === tenantPhone && invite.status === 'pending')
          .map((invite) => ({
            id: invite.id,
            phoneNumber: invite.invitedPhone,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
          }))
      : [];

    return {
      role: profile.role,
      tenantPhone,
      businessName: profile.businessName,
      members,
      invites,
    };
  }

  await ensureReady();
  await expireStaleInvites();

  const ownerRow = await queryRow(
    'SELECT phone_number, created_at FROM auth_users WHERE phone_number = $1',
    [tenantPhone],
  );
  const memberRows = await queryRows(
    `
      SELECT member_phone, role, created_at
      FROM business_members
      WHERE tenant_phone = $1
      ORDER BY created_at ASC
    `,
    [tenantPhone],
  );

  const members = [
    {
      phoneNumber: tenantPhone,
      role: 'owner',
      createdAt: ownerRow?.created_at instanceof Date ? ownerRow.created_at.toISOString() : ownerRow?.created_at ?? null,
    },
    ...memberRows.map((row) => ({
      phoneNumber: row.member_phone,
      role: row.role === 'owner' ? 'owner' : 'member',
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    })),
  ];

  let invites = [];
  if (isOwner) {
    const inviteRows = await queryRows(
      `
        SELECT id, invited_phone, created_at, expires_at
        FROM business_invites
        WHERE tenant_phone = $1 AND status = 'pending'
        ORDER BY created_at DESC
      `,
      [tenantPhone],
    );
    invites = inviteRows.map((row) => ({
      id: row.id,
      phoneNumber: row.invited_phone,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    }));
  }

  return {
    role: profile.role,
    tenantPhone,
    businessName: profile.businessName,
    members,
    invites,
  };
};

export const verifyAuthOtpChallenge = async ({ phoneNumber, otpCode, challengeId = null }) => {
  await ensureReady();

  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);
  const normalizedOtpCode = String(otpCode ?? '').trim();

  if (!normalizedPhoneNumber || !normalizedOtpCode) {
    return { ok: false, reason: 'missing_fields' };
  }

  const challenge = challengeId
    ? await queryRow(
        'SELECT * FROM auth_otp_challenges WHERE id = $1 AND phone_number = $2 ORDER BY created_at DESC LIMIT 1',
        [challengeId, normalizedPhoneNumber],
      )
    : await queryRow(
        'SELECT * FROM auth_otp_challenges WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1',
        [normalizedPhoneNumber],
      );

  if (!challenge) {
    return { ok: false, reason: 'challenge_not_found' };
  }

  if (challenge.consumed) {
    return { ok: false, reason: 'challenge_used' };
  }

  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    await getPool().query('UPDATE auth_otp_challenges SET consumed = TRUE WHERE id = $1', [challenge.id]);
    return { ok: false, reason: 'challenge_expired' };
  }

  const expectedHash = createChallengeHash(normalizedPhoneNumber, normalizedOtpCode, challenge.salt);

  if (!isSameHex(expectedHash, challenge.code_hash)) {
    const nextAttempts = Number(challenge.attempts ?? 0) + 1;
    await getPool().query(
      `
        UPDATE auth_otp_challenges
        SET attempts = $1,
            consumed = CASE WHEN $1 >= $2 THEN TRUE ELSE consumed END
        WHERE id = $3
      `,
      [nextAttempts, AUTH_OTP_MAX_ATTEMPTS, challenge.id],
    );

    return { ok: false, reason: nextAttempts >= AUTH_OTP_MAX_ATTEMPTS ? 'too_many_attempts' : 'invalid_code' };
  }

  await getPool().query(
    `
      UPDATE auth_otp_challenges
      SET consumed = TRUE
      WHERE id = $1
    `,
    [challenge.id],
  );

  await upsertAuthUser(normalizedPhoneNumber);

  return { ok: true, phoneNumber: normalizedPhoneNumber, challengeId: challenge.id };
};

const hashWaSecret = (secret) => crypto.createHash('sha256').update(String(secret ?? '')).digest('hex');

export const createWaLoginChallenge = async ({ loginToken, secretHash, expiresAt }) => {
  await ensureReady();

  await getPool().query(
    `
      INSERT INTO auth_wa_challenges (login_token, secret_hash, status, expires_at)
      VALUES ($1, $2, 'pending', $3)
    `,
    [loginToken, secretHash, expiresAt],
  );
};

export const authenticateWaLoginChallenge = async (loginToken, phoneNumber) => {
  await ensureReady();

  const token = String(loginToken ?? '').trim().toUpperCase();
  const normalizedPhoneNumber = normalizeAuthPhoneNumber(phoneNumber);

  if (!token || !normalizedPhoneNumber) {
    return { ok: false, reason: 'missing_fields' };
  }

  const challenge = await queryRow('SELECT * FROM auth_wa_challenges WHERE login_token = $1', [token]);

  if (!challenge) {
    return { ok: false, reason: 'not_found' };
  }

  if (challenge.status === 'consumed') {
    return { ok: false, reason: 'already_used' };
  }

  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  if (challenge.status === 'authenticated') {
    const existingPhone = normalizeAuthPhoneNumber(challenge.phone_number);
    if (existingPhone && getOwnerPhoneVariants(existingPhone).includes(normalizedPhoneNumber)) {
      return { ok: true, reason: 'already_authenticated', phoneNumber: existingPhone };
    }
    return { ok: false, reason: 'already_used' };
  }

  const updated = await queryRow(
    `
      UPDATE auth_wa_challenges
      SET status = 'authenticated',
          phone_number = $2,
          authenticated_at = NOW()
      WHERE login_token = $1 AND status = 'pending'
      RETURNING phone_number
    `,
    [token, normalizedPhoneNumber],
  );

  if (!updated) {
    return { ok: false, reason: 'already_used' };
  }

  return { ok: true, reason: 'authenticated', phoneNumber: normalizedPhoneNumber };
};

export const claimWaLoginChallenge = async (loginToken, sessionSecret) => {
  await ensureReady();

  const token = String(loginToken ?? '').trim().toUpperCase();
  const secretHash = hashWaSecret(sessionSecret);

  if (!token || !String(sessionSecret ?? '').trim()) {
    return { ok: false, reason: 'missing_fields' };
  }

  const challenge = await queryRow('SELECT * FROM auth_wa_challenges WHERE login_token = $1', [token]);

  if (!challenge) {
    return { ok: false, reason: 'not_found' };
  }

  if (!isSameHex(challenge.secret_hash, secretHash)) {
    return { ok: false, reason: 'invalid_secret' };
  }

  if (challenge.status === 'pending') {
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, status: 'pending' };
  }

  if (challenge.status !== 'authenticated' && challenge.status !== 'consumed') {
    return { ok: false, reason: 'not_found' };
  }

  const expiresAt = new Date(challenge.expires_at).getTime();
  const authenticatedAt = challenge.authenticated_at ? new Date(challenge.authenticated_at).getTime() : 0;
  const claimWindowOpen = Date.now() < expiresAt || (authenticatedAt > 0 && Date.now() - authenticatedAt < 60_000);

  if (!claimWindowOpen || !challenge.phone_number) {
    return { ok: false, reason: 'expired' };
  }

  await getPool().query(
    `
      UPDATE auth_wa_challenges
      SET status = 'consumed',
          consumed_at = COALESCE(consumed_at, NOW())
      WHERE login_token = $1 AND status IN ('authenticated', 'consumed')
    `,
    [token],
  );

  const phoneNumber = normalizeAuthPhoneNumber(challenge.phone_number);
  await upsertAuthUser(phoneNumber);
  return { ok: true, status: 'authenticated', phoneNumber };
};
