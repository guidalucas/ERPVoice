import dotenv from 'dotenv';
import crypto from 'crypto';
import { Pool } from 'pg';
import { normalizePhone, getWhatsAppVariants } from './phone.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const DEFAULT_OWNER_PHONE = '__default__';
const AUTH_OTP_TTL_MS = Math.max(5, Number(process.env.AUTH_OTP_TTL_MINUTES ?? 10)) * 60 * 1000;
const AUTH_OTP_MAX_ATTEMPTS = 5;

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
  transactions: [],
};

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
  const sizeMatch = normalized.match(/(?:,\s*|\s+)talle\s+([a-z0-9]+)\b/i);
  const size = sizeMatch ? sizeMatch[1].toUpperCase() : undefined;
  const withoutSize = normalized.replace(/(?:,\s*|\s+)talle\s+[a-z0-9]+\b/i, '').trim();
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
      debt INTEGER NOT NULL DEFAULT 0
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
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_products_owner_phone ON products (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_clients_owner_phone ON clients (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_transactions_owner_phone ON transactions (owner_phone);
        CREATE INDEX IF NOT EXISTS idx_meta_events_at ON meta_events (at DESC);
    CREATE INDEX IF NOT EXISTS idx_meta_events_owner_phone ON meta_events (owner_phone);
    CREATE INDEX IF NOT EXISTS idx_auth_otp_phone_number ON auth_otp_challenges (phone_number);

    CREATE INDEX IF NOT EXISTS idx_auth_otp_expires_at ON auth_otp_challenges (expires_at);

    ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
    ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
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
    const tables = ['products', 'clients', 'transactions', 'meta_events'];
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
  const clientsRows = await queryRows('SELECT id, owner_phone, name, debt FROM clients WHERE owner_phone = ANY($1) ORDER BY name ASC', [ownerPhoneVariants], client);
  const transactionsRows = await queryRows(
      'SELECT id, owner_phone, timestamp, source_text, summary, actions_json FROM transactions WHERE owner_phone = ANY($1) ORDER BY timestamp DESC',
      [ownerPhoneVariants],
      client,
    );

  return {
    products: productsRows.map(rowToProduct),
    clients: clientsRows.map(rowToClient),
    transactions: transactionsRows.map(rowToTransaction),
  };
};

const cloneDefaultStateSnapshot = () => ({
  products: DEFAULT_STATE_SNAPSHOT.products.map((product) => ({ ...product })),
  clients: DEFAULT_STATE_SNAPSHOT.clients.map((client) => ({ ...client })),
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
  });
  products.push(product);
  return product;
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

const replaceStateTables = async (client, ownerPhone, products, clients) => {
  const normalizedOwnerPhone = normalizeOwnerPhone(ownerPhone);
  const ownerPhoneVariants = getOwnerPhoneVariants(ownerPhone);

  await client.query('DELETE FROM products WHERE owner_phone = ANY($1)', [ownerPhoneVariants]);
  await client.query('DELETE FROM clients WHERE owner_phone = ANY($1)', [ownerPhoneVariants]);

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
        INSERT INTO clients (id, owner_phone, name, debt)
        VALUES ($1, $2, $3, $4)
      `,
      [clientEntry.id, normalizedOwnerPhone, clientEntry.name, clientEntry.debt],
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
    const newTransactions = [];

    const lastSellAction = [...actions].reverse().find((action) => action.type === 'sell');
    const computedDebtAmount = lastSellAction ? calculateSaleDebt(nextProducts, lastSellAction) : null;

    actions.forEach((action, index) => {
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

      newTransactions.push({
        id: `transaction-${Date.now()}-${index + 1}`,
        timestamp: new Date().toISOString(),
        sourceText,
        summary: summarizeAction(action),
        actions: [action],
      });
    });

    await replaceStateTables(client, normalizedOwnerPhone, nextProducts, nextClients);

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

export const saveMetaEvent = async (event) => {
  await ensureReady();

  const existing = await findMetaEventById(event.id);
  if (existing) {
    return existing;
  }

  const normalizedFrom = normalizePhone(event.fromNumber);

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
      normalizedFrom || DEFAULT_OWNER_PHONE,
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

export const getMetaEvents = async (limit = 50, fromNumber = null) => {
  await ensureReady();
  const safeLimit = Math.max(1, Math.min(normalizeInteger(limit, 50), 500));
  const fromPhoneVariants = fromNumber ? getOwnerPhoneVariants(fromNumber) : null;

  const rows = fromPhoneVariants
    ? await queryRows(
        'SELECT * FROM meta_events WHERE from_number = ANY($1) OR owner_phone = ANY($1) ORDER BY at DESC LIMIT $2',
        [fromPhoneVariants, safeLimit],
      )
    : await queryRows('SELECT * FROM meta_events ORDER BY at DESC LIMIT $1', [safeLimit]);

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

  await getPool().query(
    `
      INSERT INTO auth_users (phone_number, created_at, last_login_at)
      VALUES ($1, NOW(), NOW())
      ON CONFLICT (phone_number) DO UPDATE
      SET last_login_at = NOW()
    `,
    [normalizedPhoneNumber],
  );

  return { ok: true, phoneNumber: normalizedPhoneNumber, challengeId: challenge.id };
};
