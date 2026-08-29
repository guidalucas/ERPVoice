import dotenv from 'dotenv';
import crypto from 'crypto';
import { Pool } from 'pg';
import { normalizePhone, getWhatsAppVariants } from './phone.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const DEFAULT_OWNER_PHONE = '__default__';
const AUTH_OTP_TTL_MS = Math.max(5, Number(process.env.AUTH_OTP_TTL_MINUTES ?? 10)) * 60 * 1000;
const AUTH_OTP_MAX_ATTEMPTS = 5;
const BUSINESS_INVITE_TTL_MS = Math.max(1, Number(process.env.BUSINESS_INVITE_TTL_DAYS ?? 7)) * 24 * 60 * 60 * 1000;

const memoryMembers = new Map();
const memoryInvites = new Map();

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

const DEFAULT_STATE_SNAPSHOT = {
  products: [],
  clients: [],
  proveedores: [],
  pedidos: [],
  transactions: [],
};

const PEDIDO_ESTADOS = new Set(['pendiente', 'conseguido', 'descartado']);

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
    initializePromise = initializeDatabase();
  }

  return initializePromise;
};

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
  const descriptorParts = withoutSize.split(/\s+de\s+/i);
  const rawProductType = descriptorParts[0] ?? withoutSize;
  const rawProductModel = descriptorParts.slice(1).join(' de ') || undefined;

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

const rowToProduct = (row) => ({
  id: row.id,
  ownerPhone: row.owner_phone,
  name: row.name,
  productType: row.product_type,
  productModel: row.product_model,
  size: row.size,
  stockAvailable: Number(row.stock_available ?? 0),
  stockReserved: Number(row.stock_reserved ?? 0),
  price: Number(row.price ?? 0),
});

const rowToClient = (row) => ({
  id: row.id,
  ownerPhone: row.owner_phone,
  name: row.name,
  debt: Number(row.debt ?? 0),
  notas: row.notas ?? null,
});

const rowToProveedor = (row) => ({
  id: row.id,
  ownerPhone: row.owner_phone,
  name: row.name,
  notas: row.notas ?? null,
});

const rowToPedido = (row) => ({
  id: row.id,
  ownerPhone: row.owner_phone,
  clienteId: row.cliente_id,
  proveedorId: row.proveedor_id ?? null,
  producto: row.producto,
  productType: row.product_type,
  productModel: row.product_model,
  talle: row.talle,
  qty: Number(row.qty ?? 1),
  estado: PEDIDO_ESTADOS.has(row.estado) ? row.estado : 'pendiente',
  fechaPedido: row.fecha_pedido,
  notas: row.notas ?? null,
});

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
    ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
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
    CREATE INDEX IF NOT EXISTS idx_meta_events_at ON meta_events (at DESC);
    CREATE INDEX IF NOT EXISTS idx_meta_events_owner_phone ON meta_events (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_auth_otp_phone_number ON auth_otp_challenges (phone_number);
    CREATE INDEX IF NOT EXISTS idx_auth_otp_expires_at ON auth_otp_challenges (expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_wa_expires_at ON auth_wa_challenges (expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_wa_status ON auth_wa_challenges (status);
  `);

  await withClient(async (client) => {
    await ensureTenantState(client, DEFAULT_OWNER_PHONE);
  });
};

const normalizeProductNameFromInput = (productInput) => {
  const explicitName = String(productInput?.name ?? '').trim();
  if (explicitName) {
    return explicitName;
  }

  const productType = normalizeNullableString(productInput?.productType);
  const productModel = normalizeNullableString(productInput?.productModel);
  const size = normalizeNullableString(productInput?.size);
  const composed = composeProductName({ productType, productModel, size, fallback: '' }).trim();

  return composed || 'Nuevo Producto';
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

const queryAllState = async (ownerPhone = DEFAULT_OWNER_PHONE, client = null) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  const productsRows = await queryRows(
    'SELECT id, owner_phone, name, product_type, product_model, size, stock_available, stock_reserved, price FROM products WHERE owner_phone = ANY($1) ORDER BY name ASC',
    [ownerPhoneVariants],
    client,
  );
  const clientsRows = await queryRows(
    'SELECT id, owner_phone, name, debt, notas FROM clients WHERE owner_phone = ANY($1) ORDER BY name ASC',
    [ownerPhoneVariants],
    client,
  );
  const proveedoresRows = await queryRows(
    'SELECT id, owner_phone, name, notas FROM proveedores WHERE owner_phone = ANY($1) ORDER BY name ASC',
    [ownerPhoneVariants],
    client,
  );
  const pedidosRows = await queryRows(
    `SELECT id, owner_phone, cliente_id, proveedor_id, producto, product_type, product_model, talle, qty, estado, fecha_pedido, notas
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

const cloneDefaultStateSnapshot = () => ({
  products: DEFAULT_STATE_SNAPSHOT.products.map((product) => ({ ...product })),
  clients: DEFAULT_STATE_SNAPSHOT.clients.map((client) => ({ ...client })),
  proveedores: DEFAULT_STATE_SNAPSHOT.proveedores.map((proveedor) => ({ ...proveedor })),
  pedidos: [],
  transactions: [],
});

const normalizeTextList = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 2 && !['para', 'con', 'del', 'las', 'los', 'una', 'uno', 'por', 'les', 'de', 'el', 'la', 'y', 's', 'm', 'l', 'xl', 'xxl', 'titular', 'suplente', 'camiseta', 'talle'].includes(token));

const resolveProduct = (products, actionName) => {
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
    if (hasMetadata) {
      const productType = normalizeNullableString(product.productType);
      const productModel = normalizeNullableString(product.productModel);
      const productSize = normalizeNullableString(product.size);
      const actionSize = normalizeNullableString(actionName.size);

      if (normalizeNullableString(actionName.productType) && productType !== normalizeNullableString(actionName.productType)) {
        continue;
      }

      if (normalizeNullableString(actionName.productModel) && productModel !== normalizeNullableString(actionName.productModel)) {
        continue;
      }

      if (actionSize && productSize && productSize !== actionSize) {
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

export const matchProductsForQuery = (products, action) => {
  if (!Array.isArray(products) || !products.length || !action) {
    return [];
  }

  const actionType = normalizeNullableString(action.productType);
  const actionModel = normalizeNullableString(action.productModel);
  const actionName = String(action.productName ?? '').trim();

  if (actionType || actionModel) {
    return products.filter((product) => {
      const productType = normalizeNullableString(product.productType);
      const productModel = normalizeNullableString(product.productModel);
      const productName = String(product.name ?? '');

      const typeOk = !actionType
        || (productType && includesNormalized(productType, actionType))
        || includesNormalized(productName, actionType);

      if (!typeOk) {
        return false;
      }

      if (!actionModel) {
        return true;
      }

      return (
        (productModel && includesNormalized(productModel, actionModel))
        || includesNormalized(productName, actionModel)
      );
    });
  }

  if (!actionName) {
    return [];
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
  return scored.filter((entry) => entry.score === bestScore).map((entry) => entry.product);
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
  const label = String(action?.productName ?? 'producto').trim() || 'producto';
  const matches = matchProductsForQuery(products, action);
  const variantWord = typeof options.variantLabel === 'string' && options.variantLabel.trim()
    ? options.variantLabel.trim().toLowerCase()
    : 'variante';
  const missingVariant = `sin ${variantWord}`;

  if (!matches.length) {
    return `No encontré stock de "${label}" en tu inventario.`;
  }

  const totalAvailable = matches.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
  const totalReserved = matches.reduce((sum, product) => sum + Number(product.stockReserved ?? 0), 0);

  const groups = new Map();

  for (const product of matches) {
    const groupKey = normalizeNullableString(product.productModel)
      || normalizeNullableString(product.productType)
      || product.name
      || 'Producto';
    const existing = groups.get(groupKey) ?? [];
    existing.push(product);
    groups.set(groupKey, existing);
  }

  const lines = [];
  const sizeOrder = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];

  for (const [groupName, groupProducts] of groups.entries()) {
    const groupTotal = groupProducts.reduce((sum, product) => sum + Number(product.stockAvailable ?? 0), 0);
    const sizeParts = groupProducts
      .slice()
      .sort((left, right) => {
        const leftSize = normalizeText(left.size ?? '');
        const rightSize = normalizeText(right.size ?? '');
        const leftIndex = sizeOrder.indexOf(leftSize);
        const rightIndex = sizeOrder.indexOf(rightSize);
        if (leftIndex >= 0 && rightIndex >= 0) {
          return leftIndex - rightIndex;
        }
        if (leftIndex >= 0) {
          return -1;
        }
        if (rightIndex >= 0) {
          return 1;
        }
        return String(left.size ?? '').localeCompare(String(right.size ?? ''), 'es', { numeric: true });
      })
      .map((product) => {
        const sizeLabel = normalizeNullableString(product.size) || missingVariant;
        return `${sizeLabel}: ${Number(product.stockAvailable ?? 0)}`;
      });

    lines.push(`${groupName}: ${sizeParts.join(', ')} (total ${groupTotal})`);
  }

  const header = `Tenés ${totalAvailable} unidad${totalAvailable === 1 ? '' : 'es'} disponible${totalAvailable === 1 ? '' : 's'} de ${label}:`;
  const reservedLine = totalReserved > 0
    ? `\nAdemás hay ${totalReserved} unidad${totalReserved === 1 ? '' : 'es'} reservada${totalReserved === 1 ? '' : 's'}.`
    : '';

  return `${header}\n${lines.join('\n')}${reservedLine}`;
};

const resolvePedidoFlexible = (pedidos, productName, clientName) => {
  const pendingFirst = [...pedidos].sort((left, right) => {
    if (left.estado === 'pendiente' && right.estado !== 'pendiente') return -1;
    if (right.estado === 'pendiente' && left.estado !== 'pendiente') return 1;
    return 0;
  });

  let best = null;
  let bestScore = 0;

  for (const pedido of pendingFirst) {
    let score = Math.max(
      scoreNameMatch(pedido.producto, productName),
      scoreNameMatch([pedido.productType, pedido.productModel, pedido.talle].filter(Boolean).join(' '), productName),
    );

    if (clientName?.trim()) {
      // slight preference only; client match isn't available on pedido without clients list here
      score += 0;
    }

    if (score > bestScore) {
      bestScore = score;
      best = pedido;
    }
  }

  return bestScore >= 1 ? best : null;
};

const createProduct = (name, index, metadata = {}) => ({
  id: `product-${slugify(name)}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`,
  name: String(name ?? '').trim(),
  productType: metadata.productType ?? null,
  productModel: metadata.productModel ?? null,
  size: metadata.size ?? null,
  stockAvailable: 0,
  stockReserved: 0,
  price: Number.isFinite(metadata.price) && metadata.price > 0 ? metadata.price : 0,
});

const ensureProduct = (products, action) => {
  const resolvedProduct = resolveProduct(products, action);

  if (resolvedProduct) {
    if (Number.isFinite(action.price) && action.price > 0 && (!resolvedProduct.price || resolvedProduct.price === 0)) {
      resolvedProduct.price = action.price;
    }
    return resolvedProduct;
  }

  const product = createProduct(action.productName, products.length, {
    productType: action.productType,
    productModel: action.productModel,
    size: action.size,
    price: Number.isFinite(action.price) && action.price > 0 ? action.price : undefined,
  });
  products.push(product);
  return product;
};

/**
 * Al pasar un pedido a "conseguido" suma stock; al salir de "conseguido" lo resta.
 * Mutates `products` in place. Returns effect metadata or null if no stock change.
 */
const applyPedidoEstadoStockEffect = (products, pedido, previousEstado, nextEstado) => {
  if (!pedido || previousEstado === nextEstado) {
    return null;
  }

  const enteredConseguido = previousEstado !== 'conseguido' && nextEstado === 'conseguido';
  const leftConseguido = previousEstado === 'conseguido' && nextEstado !== 'conseguido';

  if (!enteredConseguido && !leftConseguido) {
    return null;
  }

  const qty = Math.max(1, Math.trunc(Number(pedido.qty) || 1));
  const matchInput = {
    productName: pedido.producto,
    productType: pedido.productType,
    productModel: pedido.productModel,
    size: pedido.talle,
  };

  const existingIds = new Set(products.map((entry) => entry.id));
  const product = ensureProduct(products, matchInput);
  const created = !existingIds.has(product.id);

  if (enteredConseguido) {
    product.stockAvailable += qty;
  } else {
    product.stockAvailable = Math.max(0, product.stockAvailable - qty);
  }

  const sizeLabel = pedido.talle ? ` (${pedido.talle})` : '';
  const productLabel = pedido.producto || product.name;
  const summary = enteredConseguido
    ? `Pedido conseguido: +${qty} stock de ${productLabel}${sizeLabel}`
    : `Pedido revertido: -${qty} stock de ${productLabel}${sizeLabel}`;

  const action = enteredConseguido
    ? {
        type: 'add_stock',
        productName: productLabel,
        productType: pedido.productType || undefined,
        productModel: pedido.productModel || undefined,
        size: pedido.talle || undefined,
        qty,
      }
    : {
        type: 'update_pedido',
        productName: productLabel,
        estado: nextEstado,
        qty,
        size: pedido.talle || undefined,
      };

  return {
    product,
    created,
    qty,
    enteredConseguido,
    summary,
    action,
    sourceText: enteredConseguido
      ? `Pedido marcado como conseguido: ${productLabel}${sizeLabel}`
      : `Pedido revertido de conseguido: ${productLabel}${sizeLabel}`,
  };
};

const calculateSaleDebt = (products, sellAction) => {
  const product = resolveProduct(products, sellAction.productName);

  if (!product) {
    return 0;
  }

  return Number(product.price) * sellAction.qty;
};

const calculateProductDebt = (products, debtAction) => {
  if (!debtAction.productName || typeof debtAction.qty !== 'number' || debtAction.qty <= 0) {
    return null;
  }

  const product = resolveProduct(products, debtAction.productName);

  if (!product) {
    return null;
  }

  return Number(product.price) * debtAction.qty;
};

const summarizeAction = (action) => {
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
    return `Eliminar producto ${action.productName}`;
  }

  return `+$${action.amount.toLocaleString('es-AR')} en cuenta de ${action.clientName}`;
};

const ANONYMOUS_PEDIDO_CLIENT = 'Sin cliente';

const resolveOrCreateClientByName = (clients, clientName) => {
  const resolvedName = String(clientName ?? '').trim() || ANONYMOUS_PEDIDO_CLIENT;
  const target = normalizeText(resolvedName).trim();
  const exactMatches = clients.filter((entry) => normalizeText(entry.name).trim() === target);

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const created = {
    id: `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: titleCase(resolvedName),
    debt: 0,
    notas: resolvedName === ANONYMOUS_PEDIDO_CLIENT ? 'Pedidos sin cliente asignado' : null,
  };
  clients.push(created);
  return created;
};

const resolveOrCreateProveedorByName = (proveedores, proveedorName) => {
  const resolvedName = String(proveedorName ?? '').trim();
  if (!resolvedName) {
    return null;
  }

  const target = normalizeText(resolvedName).trim();
  const exactMatches = proveedores.filter((entry) => normalizeText(entry.name).trim() === target);

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const created = {
    id: `proveedor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: titleCase(resolvedName),
    notas: null,
  };
  proveedores.push(created);
  return created;
};

const buildPedidoProductoLabel = (action) => {
  const fromParts = composeProductName({
    productType: action.productType,
    productModel: action.productModel,
    size: undefined,
    fallback: '',
  }).trim();

  if (fromParts) {
    return fromParts;
  }

  const rawName = String(action.productName ?? '').trim();
  if (!rawName) {
    return 'Producto';
  }

  return rawName.replace(/(?:,\s*|\s+)(?:talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes)\s+[a-z0-9\/]+\b/i, '').trim() || rawName;
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

const replaceStateTables = async (client, ownerPhone, products, clients, proveedores = []) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  await client.query('DELETE FROM products WHERE owner_phone = ANY($1)', [ownerPhoneVariants]);
  await client.query('DELETE FROM clients WHERE owner_phone = ANY($1)', [ownerPhoneVariants]);
  await client.query('DELETE FROM proveedores WHERE owner_phone = ANY($1)', [ownerPhoneVariants]);

  for (const product of products) {
    await client.query(
      `
        INSERT INTO products (id, owner_phone, name, product_type, product_model, size, stock_available, stock_reserved, price)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        product.id,
        normalizedOwnerPhone,
        product.name,
        product.productType ?? null,
        product.productModel ?? null,
        product.size ?? null,
        product.stockAvailable,
        product.stockReserved,
        product.price,
      ],
    );
  }

  for (const clientEntry of clients) {
    await client.query(
      `
        INSERT INTO clients (id, owner_phone, name, debt, notas)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [clientEntry.id, normalizedOwnerPhone, clientEntry.name, clientEntry.debt, clientEntry.notas ?? null],
    );
  }

  for (const proveedorEntry of proveedores) {
    await client.query(
      `
        INSERT INTO proveedores (id, owner_phone, name, notas)
        VALUES ($1, $2, $3, $4)
      `,
      [proveedorEntry.id, normalizedOwnerPhone, proveedorEntry.name, proveedorEntry.notas ?? null],
    );
  }
};

export const createProductRecord = async (productInput, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);

  await withClient(async (client) => {
    await ensureTenantState(client, normalizedOwnerPhone);
  });

  const id = `product-${slugify(normalizeProductNameFromInput(productInput))}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const result = await getPool().query(
    `
      INSERT INTO products (id, owner_phone, name, product_type, product_model, size, stock_available, stock_reserved, price)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, owner_phone, name, product_type, product_model, size, stock_available, stock_reserved, price
    `,
    [
      id,
      normalizedOwnerPhone,
      normalizeProductNameFromInput(productInput),
      normalizeNullableString(productInput.productType),
      normalizeNullableString(productInput.productModel),
      normalizeNullableString(productInput.size),
      normalizeInteger(productInput.stockAvailable, 0),
      normalizeInteger(productInput.stockReserved, 0),
      normalizeInteger(productInput.price, 0),
    ],
  );

  return rowToProduct(result.rows[0]);
};

export const updateProductRecord = async (productId, updates, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  const existing = await queryRow(
    'SELECT id, owner_phone, name, product_type, product_model, size, stock_available, stock_reserved, price FROM products WHERE id = $1 AND owner_phone = ANY($2)',
    [productId, ownerPhoneVariants],
  );

  if (!existing) {
    return null;
  }

  const nextProduct = {
    ...rowToProduct(existing),
    ...updates,
    name: typeof updates.name === 'string' && updates.name.trim().length ? updates.name.trim() : rowToProduct(existing).name,
    productType: updates.productType === undefined ? rowToProduct(existing).productType : normalizeNullableString(updates.productType),
    productModel: updates.productModel === undefined ? rowToProduct(existing).productModel : normalizeNullableString(updates.productModel),
    size: updates.size === undefined ? rowToProduct(existing).size : normalizeNullableString(updates.size),
    stockAvailable: normalizeInteger(updates.stockAvailable, rowToProduct(existing).stockAvailable),
    stockReserved: normalizeInteger(updates.stockReserved, rowToProduct(existing).stockReserved),
    price: normalizeInteger(updates.price, rowToProduct(existing).price),
  };

  const result = await getPool().query(
    `
      UPDATE products
      SET name = $1,
          product_type = $2,
          product_model = $3,
          size = $4,
          stock_available = $5,
          stock_reserved = $6,
          price = $7
      WHERE id = $8 AND owner_phone = $9
      RETURNING id, owner_phone, name, product_type, product_model, size, stock_available, stock_reserved, price
    `,
    [
      nextProduct.name,
      nextProduct.productType,
      nextProduct.productModel,
      nextProduct.size,
      nextProduct.stockAvailable,
      nextProduct.stockReserved,
      nextProduct.price,
      productId,
      normalizedOwnerPhone,
    ],
  );

  return result.rows[0] ? rowToProduct(result.rows[0]) : null;
};

export const deleteProductRecord = async (productId, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);
  const result = await getPool().query('DELETE FROM products WHERE id = $1 AND owner_phone = ANY($2) RETURNING id', [productId, ownerPhoneVariants]);
  return result.rowCount > 0;
};

export const createClientRecord = async (clientInput, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const name = String(clientInput?.name ?? '').trim();

  if (!name) {
    return null;
  }

  const id = `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await getPool().query(
    `
      INSERT INTO clients (id, owner_phone, name, debt, notas)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, owner_phone, name, debt, notas
    `,
    [id, normalizedOwnerPhone, titleCase(name), normalizeInteger(clientInput?.debt, 0), normalizeNullableString(clientInput?.notas)],
  );

  return rowToClient(result.rows[0]);
};

export const updateClientRecord = async (clientId, updates, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);
  const existing = await queryRow(
    'SELECT id, owner_phone, name, debt, notas FROM clients WHERE id = $1 AND owner_phone = ANY($2)',
    [clientId, ownerPhoneVariants],
  );

  if (!existing) {
    return null;
  }

  const current = rowToClient(existing);
  const nextName = typeof updates.name === 'string' && updates.name.trim() ? titleCase(updates.name.trim()) : current.name;
  const nextNotas = updates.notas === undefined ? current.notas : normalizeNullableString(updates.notas);
  const nextDebt = updates.debt === undefined ? current.debt : normalizeInteger(updates.debt, current.debt);

  const result = await getPool().query(
    `
      UPDATE clients
      SET name = $1, notas = $2, debt = $3
      WHERE id = $4 AND owner_phone = $5
      RETURNING id, owner_phone, name, debt, notas
    `,
    [nextName, nextNotas, nextDebt, clientId, normalizedOwnerPhone],
  );

  return result.rows[0] ? rowToClient(result.rows[0]) : null;
};

export const deleteClientRecord = async (clientId, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  return withTransaction(async (client) => {
    await client.query('DELETE FROM pedidos WHERE cliente_id = $1 AND owner_phone = ANY($2)', [clientId, ownerPhoneVariants]);
    const result = await client.query('DELETE FROM clients WHERE id = $1 AND owner_phone = ANY($2) RETURNING id', [clientId, ownerPhoneVariants]);
    return result.rowCount > 0;
  });
};

export const mergeClientRecords = async (keepId, mergeId, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  if (!keepId || !mergeId || keepId === mergeId) {
    return null;
  }

  return withTransaction(async (client) => {
    const keep = await queryRow(
      'SELECT id, owner_phone, name, debt, notas FROM clients WHERE id = $1 AND owner_phone = ANY($2)',
      [keepId, ownerPhoneVariants],
      client,
    );
    const merge = await queryRow(
      'SELECT id, owner_phone, name, debt, notas FROM clients WHERE id = $1 AND owner_phone = ANY($2)',
      [mergeId, ownerPhoneVariants],
      client,
    );

    if (!keep || !merge) {
      return null;
    }

    await client.query(
      'UPDATE pedidos SET cliente_id = $1 WHERE cliente_id = $2 AND owner_phone = ANY($3)',
      [keepId, mergeId, ownerPhoneVariants],
    );

    const keepClient = rowToClient(keep);
    const mergeClient = rowToClient(merge);
    const mergedNotas = [keepClient.notas, mergeClient.notas].filter(Boolean).join('\n').trim() || null;

    await client.query(
      'UPDATE clients SET debt = $1, notas = $2 WHERE id = $3',
      [keepClient.debt + mergeClient.debt, mergedNotas, keepId],
    );
    await client.query('DELETE FROM clients WHERE id = $1 AND owner_phone = ANY($2)', [mergeId, ownerPhoneVariants]);

    return queryAllState(normalizeOwnerPhone(ownerPhone), client);
  });
};

export const createProveedorRecord = async (proveedorInput, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const name = String(proveedorInput?.name ?? '').trim();

  if (!name) {
    return null;
  }

  const id = `proveedor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await getPool().query(
    `
      INSERT INTO proveedores (id, owner_phone, name, notas)
      VALUES ($1, $2, $3, $4)
      RETURNING id, owner_phone, name, notas
    `,
    [id, normalizedOwnerPhone, titleCase(name), normalizeNullableString(proveedorInput?.notas)],
  );

  return rowToProveedor(result.rows[0]);
};

export const updateProveedorRecord = async (proveedorId, updates, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);
  const existing = await queryRow(
    'SELECT id, owner_phone, name, notas FROM proveedores WHERE id = $1 AND owner_phone = ANY($2)',
    [proveedorId, ownerPhoneVariants],
  );

  if (!existing) {
    return null;
  }

  const current = rowToProveedor(existing);
  const nextName = typeof updates.name === 'string' && updates.name.trim() ? titleCase(updates.name.trim()) : current.name;
  const nextNotas = updates.notas === undefined ? current.notas : normalizeNullableString(updates.notas);

  const result = await getPool().query(
    `
      UPDATE proveedores
      SET name = $1, notas = $2
      WHERE id = $3 AND owner_phone = $4
      RETURNING id, owner_phone, name, notas
    `,
    [nextName, nextNotas, proveedorId, normalizedOwnerPhone],
  );

  return result.rows[0] ? rowToProveedor(result.rows[0]) : null;
};

export const deleteProveedorRecord = async (proveedorId, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  return withTransaction(async (client) => {
    await client.query('UPDATE pedidos SET proveedor_id = NULL WHERE proveedor_id = $1 AND owner_phone = ANY($2)', [
      proveedorId,
      ownerPhoneVariants,
    ]);
    const result = await client.query('DELETE FROM proveedores WHERE id = $1 AND owner_phone = ANY($2) RETURNING id', [
      proveedorId,
      ownerPhoneVariants,
    ]);
    return result.rowCount > 0;
  });
};

export const mergeProveedorRecords = async (keepId, mergeId, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  if (!keepId || !mergeId || keepId === mergeId) {
    return null;
  }

  return withTransaction(async (client) => {
    const keep = await queryRow(
      'SELECT id, owner_phone, name, notas FROM proveedores WHERE id = $1 AND owner_phone = ANY($2)',
      [keepId, ownerPhoneVariants],
      client,
    );
    const merge = await queryRow(
      'SELECT id, owner_phone, name, notas FROM proveedores WHERE id = $1 AND owner_phone = ANY($2)',
      [mergeId, ownerPhoneVariants],
      client,
    );

    if (!keep || !merge) {
      return null;
    }

    await client.query(
      'UPDATE pedidos SET proveedor_id = $1 WHERE proveedor_id = $2 AND owner_phone = ANY($3)',
      [keepId, mergeId, ownerPhoneVariants],
    );

    const keepProveedor = rowToProveedor(keep);
    const mergeProveedor = rowToProveedor(merge);
    const mergedNotas = [keepProveedor.notas, mergeProveedor.notas].filter(Boolean).join('\n').trim() || null;

    await client.query('UPDATE proveedores SET notas = $1 WHERE id = $2', [mergedNotas, keepId]);
    await client.query('DELETE FROM proveedores WHERE id = $1 AND owner_phone = ANY($2)', [mergeId, ownerPhoneVariants]);

    return queryAllState(normalizeOwnerPhone(ownerPhone), client);
  });
};

export const createPedidoRecord = async (pedidoInput, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const clienteId = String(pedidoInput?.clienteId ?? '').trim();
  const producto = String(pedidoInput?.producto ?? '').trim();

  if (!clienteId || !producto) {
    return null;
  }

  const estado = PEDIDO_ESTADOS.has(pedidoInput?.estado) ? pedidoInput.estado : 'pendiente';
  const proveedorId = normalizeNullableString(pedidoInput?.proveedorId);
  const id = `pedido-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await getPool().query(
    `
      INSERT INTO pedidos (id, owner_phone, cliente_id, proveedor_id, producto, product_type, product_model, talle, qty, estado, fecha_pedido, notas)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
      RETURNING id, owner_phone, cliente_id, proveedor_id, producto, product_type, product_model, talle, qty, estado, fecha_pedido, notas
    `,
    [
      id,
      normalizedOwnerPhone,
      clienteId,
      proveedorId,
      producto,
      normalizeNullableString(pedidoInput?.productType),
      normalizeNullableString(pedidoInput?.productModel),
      normalizeNullableString(pedidoInput?.talle),
      Math.max(1, normalizeInteger(pedidoInput?.qty, 1)),
      estado,
      normalizeNullableString(pedidoInput?.notas),
    ],
  );

  return rowToPedido(result.rows[0]);
};

export const updatePedidoRecord = async (pedidoId, updates, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  return withTransaction(async (client) => {
    await ensureTenantState(client, normalizedOwnerPhone);

    const existing = await queryRow(
      `SELECT id, owner_phone, cliente_id, proveedor_id, producto, product_type, product_model, talle, qty, estado, fecha_pedido, notas
       FROM pedidos WHERE id = $1 AND owner_phone = ANY($2)`,
      [pedidoId, ownerPhoneVariants],
      client,
    );

    if (!existing) {
      return null;
    }

    const current = rowToPedido(existing);
    const nextEstado = updates.estado && PEDIDO_ESTADOS.has(updates.estado) ? updates.estado : current.estado;
    const nextClienteId =
      typeof updates.clienteId === 'string' && updates.clienteId.trim() ? updates.clienteId.trim() : current.clienteId;
    const nextProveedorId =
      updates.proveedorId === undefined
        ? current.proveedorId
        : updates.proveedorId === null || updates.proveedorId === ''
          ? null
          : normalizeNullableString(updates.proveedorId);
    const nextProducto =
      typeof updates.producto === 'string' && updates.producto.trim() ? updates.producto.trim() : current.producto;
    const nextProductType = updates.productType === undefined ? current.productType : normalizeNullableString(updates.productType);
    const nextProductModel =
      updates.productModel === undefined ? current.productModel : normalizeNullableString(updates.productModel);
    const nextTalle = updates.talle === undefined ? current.talle : normalizeNullableString(updates.talle);
    const nextQty = updates.qty === undefined ? current.qty : Math.max(1, normalizeInteger(updates.qty, current.qty));
    const nextNotas = updates.notas === undefined ? current.notas : normalizeNullableString(updates.notas);

    const snapshot = await queryAllState(normalizedOwnerPhone, client);
    const nextProducts = snapshot.products.map((product) => ({ ...product }));
    const qtyForStock =
      current.estado === 'conseguido' && nextEstado !== 'conseguido' ? current.qty : nextQty;
    const stockEffect = applyPedidoEstadoStockEffect(
      nextProducts,
      {
        producto: nextProducto,
        productType: nextProductType,
        productModel: nextProductModel,
        talle: nextTalle,
        qty: qtyForStock,
      },
      current.estado,
      nextEstado,
    );

    const result = await client.query(
      `
        UPDATE pedidos
        SET cliente_id = $1,
            proveedor_id = $2,
            producto = $3,
            product_type = $4,
            product_model = $5,
            talle = $6,
            qty = $7,
            estado = $8,
            notas = $9
        WHERE id = $10 AND owner_phone = $11
        RETURNING id, owner_phone, cliente_id, proveedor_id, producto, product_type, product_model, talle, qty, estado, fecha_pedido, notas
      `,
      [
        nextClienteId,
        nextProveedorId,
        nextProducto,
        nextProductType,
        nextProductModel,
        nextTalle,
        nextQty,
        nextEstado,
        nextNotas,
        pedidoId,
        normalizedOwnerPhone,
      ],
    );

    if (stockEffect) {
      const product = stockEffect.product;
      if (stockEffect.created) {
        await client.query(
          `
            INSERT INTO products (id, owner_phone, name, product_type, product_model, size, stock_available, stock_reserved, price)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            product.id,
            normalizedOwnerPhone,
            product.name,
            product.productType ?? null,
            product.productModel ?? null,
            product.size ?? null,
            product.stockAvailable,
            product.stockReserved,
            product.price,
          ],
        );
      } else {
        await client.query(
          `
            UPDATE products
            SET stock_available = $1,
                stock_reserved = $2,
                price = $3,
                product_type = $4,
                product_model = $5,
                size = $6,
                name = $7
            WHERE id = $8 AND owner_phone = ANY($9)
          `,
          [
            product.stockAvailable,
            product.stockReserved,
            product.price,
            product.productType ?? null,
            product.productModel ?? null,
            product.size ?? null,
            product.name,
            product.id,
            ownerPhoneVariants,
          ],
        );
      }

      await client.query(
        `
          INSERT INTO transactions (id, owner_phone, timestamp, source_text, summary, actions_json)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          `transaction-${Date.now()}-pedido-stock`,
          normalizedOwnerPhone,
          new Date().toISOString(),
          stockEffect.sourceText,
          stockEffect.summary,
          toJsonbParam([stockEffect.action]),
        ],
      );
    }

    return result.rows[0] ? rowToPedido(result.rows[0]) : null;
  });
};

export const deletePedidoRecord = async (pedidoId, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);
  const result = await getPool().query('DELETE FROM pedidos WHERE id = $1 AND owner_phone = ANY($2) RETURNING id', [pedidoId, ownerPhoneVariants]);
  return result.rowCount > 0;
};

export const getStateSnapshot = async (ownerPhone = DEFAULT_OWNER_PHONE) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);

  try {
    await ensureReady();

    await withClient(async (client) => {
      await ensureTenantState(client, normalizedOwnerPhone);
    });

    return queryAllState(normalizedOwnerPhone);
  } catch (error) {
    console.warn('[postgresDatabase] Falling back to default state snapshot:', error instanceof Error ? error.message : error);
    return cloneDefaultStateSnapshot();
  }
};

export const applyActionsToDatabase = async (actions, sourceText, ownerPhone = DEFAULT_OWNER_PHONE) => {
  await ensureReady();
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);

  return withTransaction(async (client) => {
    await ensureTenantState(client, normalizedOwnerPhone);

    const currentSnapshot = await queryAllState(normalizedOwnerPhone, client);
    const nextProducts = currentSnapshot.products.map((product) => ({ ...product }));
    const nextClients = currentSnapshot.clients.map((clientEntry) => ({ ...clientEntry }));
    const nextProveedores = currentSnapshot.proveedores.map((proveedorEntry) => ({ ...proveedorEntry }));
    const nextPedidos = currentSnapshot.pedidos.map((pedido) => ({ ...pedido }));
    const newTransactions = [];
    const originalPedidoIds = new Set(currentSnapshot.pedidos.map((pedido) => pedido.id));

    const lastSellAction = [...actions].reverse().find((action) => action.type === 'sell');
    const computedDebtAmount = lastSellAction ? calculateSaleDebt(nextProducts, lastSellAction) : null;

    actions.forEach((action, index) => {
      if (action.type === 'query_stock' || action.type === 'query_pedidos') {
        return;
      }

      if (action.type === 'add_stock') {
        const product = ensureProduct(nextProducts, action);
        product.stockAvailable += action.qty;
      }

      if (action.type === 'reserve_stock') {
        const product = ensureProduct(nextProducts, action);
        const reservationQty = Math.min(product.stockAvailable, action.qty);
        product.stockAvailable -= reservationQty;
        product.stockReserved += reservationQty;
      }

      if (action.type === 'sell') {
        const product = ensureProduct(nextProducts, action);
        const sellQty = Math.min(product.stockAvailable, action.qty);
        product.stockAvailable -= sellQty;
      }

      if (action.type === 'add_debt') {
        const clientEntry = nextClients.find((entry) => entry.name.toLowerCase() === action.clientName.toLowerCase()) ?? nextClients[0];
        if (clientEntry) {
          const productDebtAmount = calculateProductDebt(nextProducts, action);
          const amountToApply = productDebtAmount && productDebtAmount > 0
            ? productDebtAmount
            : computedDebtAmount && computedDebtAmount > 0
              ? computedDebtAmount
              : action.amount;

          clientEntry.debt += amountToApply;
          action = {
            ...action,
            amount: amountToApply,
          };
        }
      }

      if (action.type === 'payment_received') {
        const clientEntry = nextClients.find((entry) => entry.name.toLowerCase() === action.clientName.toLowerCase()) ?? nextClients[0];
        if (clientEntry) {
          clientEntry.debt = Math.max(0, clientEntry.debt - action.amount);
        }
      }

      if (action.type === 'client_order' && typeof action.productName === 'string') {
        const clientEntry = resolveOrCreateClientByName(nextClients, action.clientName);
        const proveedorEntry = resolveOrCreateProveedorByName(nextProveedores, action.proveedorName);
        const qty = Number.isFinite(Number(action.qty)) && Number(action.qty) > 0 ? Math.trunc(Number(action.qty)) : 1;
        const productDescriptor = parseProductDescriptor(action.productName);
        nextPedidos.unshift({
          id: `pedido-${Date.now().toString(36)}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`,
          clienteId: clientEntry.id,
          proveedorId: proveedorEntry?.id ?? null,
          producto: buildPedidoProductoLabel({
            ...action,
            productType: action.productType || productDescriptor.productType,
            productModel: action.productModel || productDescriptor.productModel,
            productName: action.productName,
          }),
          productType: normalizeNullableString(action.productType || productDescriptor.productType),
          productModel: normalizeNullableString(action.productModel || productDescriptor.productModel),
          talle: normalizeNullableString(action.size || productDescriptor.size),
          qty,
          estado: 'pendiente',
          fechaPedido: new Date().toISOString(),
          notas: normalizeNullableString(action.notas),
        });
      }

      if (action.type === 'update_product' && typeof action.productName === 'string') {
        const productsToUpdate = matchProductsForUpdate(nextProducts, action);
        for (const product of productsToUpdate) {
          if (Number.isFinite(action.price) && action.price > 0) {
            product.price = Math.trunc(action.price);
          }
          if (Number.isFinite(action.stockAvailable) && action.stockAvailable >= 0) {
            product.stockAvailable = Math.trunc(action.stockAvailable);
          }
        }
      }

      if (action.type === 'update_pedido' && typeof action.productName === 'string') {
        const pedido = resolvePedidoFlexible(nextPedidos, action.productName, action.clientName);
        if (pedido) {
          const previousEstado = pedido.estado;
          const previousQty = pedido.qty;

          if (Number.isFinite(action.qty) && action.qty > 0) {
            pedido.qty = Math.trunc(action.qty);
          }
          if (typeof action.size === 'string' && action.size.trim()) {
            pedido.talle = action.size.trim().toUpperCase();
          }
          if (action.estado && PEDIDO_ESTADOS.has(action.estado)) {
            pedido.estado = action.estado;
          }

          const qtyForStock =
            previousEstado === 'conseguido' && pedido.estado !== 'conseguido' ? previousQty : pedido.qty;
          applyPedidoEstadoStockEffect(
            nextProducts,
            {
              producto: pedido.producto,
              productType: pedido.productType,
              productModel: pedido.productModel,
              talle: pedido.talle,
              qty: qtyForStock,
            },
            previousEstado,
            pedido.estado,
          );
        }
      }

      if (action.type === 'delete_pedido' && typeof action.productName === 'string') {
        const pedido = resolvePedidoFlexible(nextPedidos, action.productName, action.clientName);
        if (pedido) {
          const pedidoIndex = nextPedidos.findIndex((entry) => entry.id === pedido.id);
          if (pedidoIndex >= 0) {
            nextPedidos.splice(pedidoIndex, 1);
          }
        }
      }

      if (action.type === 'delete_product' && typeof action.productName === 'string') {
        const product = resolveProductFlexible(nextProducts, action);
        if (product) {
          const productIndex = nextProducts.findIndex((entry) => entry.id === product.id);
          if (productIndex >= 0) {
            nextProducts.splice(productIndex, 1);
          }
        }
      }

      newTransactions.push({
        id: `transaction-${Date.now()}-${index + 1}`,
        timestamp: new Date().toISOString(),
        sourceText,
        summary: summarizeAction(action),
        actions: [action],
      });
    });

    await replaceStateTables(client, normalizedOwnerPhone, nextProducts, nextClients, nextProveedores);

    const nextPedidoIds = new Set(nextPedidos.map((pedido) => pedido.id));

    for (const pedidoId of originalPedidoIds) {
      if (!nextPedidoIds.has(pedidoId)) {
        await client.query('DELETE FROM pedidos WHERE id = $1 AND owner_phone = ANY($2)', [
          pedidoId,
          getOwnerPhoneVariants(normalizedOwnerPhone),
        ]);
      }
    }

    for (const pedido of nextPedidos) {
      if (originalPedidoIds.has(pedido.id)) {
        await client.query(
          `
            UPDATE pedidos
            SET cliente_id = $1,
                proveedor_id = $2,
                producto = $3,
                product_type = $4,
                product_model = $5,
                talle = $6,
                qty = $7,
                estado = $8,
                notas = $9
            WHERE id = $10 AND owner_phone = ANY($11)
          `,
          [
            pedido.clienteId,
            pedido.proveedorId ?? null,
            pedido.producto,
            pedido.productType,
            pedido.productModel,
            pedido.talle,
            pedido.qty,
            pedido.estado,
            pedido.notas,
            pedido.id,
            getOwnerPhoneVariants(normalizedOwnerPhone),
          ],
        );
      } else {
        await client.query(
          `
            INSERT INTO pedidos (id, owner_phone, cliente_id, proveedor_id, producto, product_type, product_model, talle, qty, estado, fecha_pedido, notas)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            pedido.id,
            normalizedOwnerPhone,
            pedido.clienteId,
            pedido.proveedorId ?? null,
            pedido.producto,
            pedido.productType,
            pedido.productModel,
            pedido.talle,
            pedido.qty,
            pedido.estado,
            pedido.fechaPedido,
            pedido.notas,
          ],
        );
      }
    }

    for (const transaction of newTransactions) {
      await client.query(
        `
          INSERT INTO transactions (id, owner_phone, timestamp, source_text, summary, actions_json)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          transaction.id,
          normalizedOwnerPhone,
          transaction.timestamp,
          transaction.sourceText,
          transaction.summary,
          toJsonbParam(transaction.actions),
        ],
      );
    }

    return await queryAllState(normalizedOwnerPhone, client);
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
      INSERT INTO meta_events (id, at, from_number, owner_phone, body, num_media, kind, source_text, transcript, reply_text, error, actions_json, processed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
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
      'SELECT * FROM meta_events WHERE from_number = ANY($1) ORDER BY at DESC LIMIT $2',
      [senderVariants, safeLimit],
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
