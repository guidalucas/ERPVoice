import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const DEFAULT_PRODUCTS = [
  {
    id: 'product-boca-titular-2026',
    name: 'Camiseta Boca Titular 2026',
    productType: 'Camiseta',
    productModel: 'Boca Titular 2026',
    size: null,
    stockAvailable: 0,
    stockReserved: 0,
    price: 50000,
  },
  {
    id: 'product-argentina-suplente',
    name: 'Camiseta Argentina Suplente',
    productType: 'Camiseta',
    productModel: 'Argentina Suplente',
    size: null,
    stockAvailable: 0,
    stockReserved: 0,
    price: 55000,
  },
];

const DEFAULT_CLIENTS = [
  {
    id: 'client-gimnasio-el-refugio',
    name: 'Gimnasio El Refugio',
    debt: 0,
  },
];

const DEFAULT_STATE_SNAPSHOT = {
  products: DEFAULT_PRODUCTS.map((product) => ({
    id: product.id,
    name: product.name,
    productType: product.productType,
    productModel: product.productModel,
    size: product.size,
    stockAvailable: product.stockAvailable,
    stockReserved: product.stockReserved,
    price: product.price,
  })),
  clients: DEFAULT_CLIENTS.map((client) => ({
    id: client.id,
    name: client.name,
    debt: client.debt,
  })),
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
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
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
  name: row.name,
  debt: Number(row.debt ?? 0),
});

const rowToTransaction = (row) => ({
  id: row.id,
  timestamp: row.timestamp,
  sourceText: row.source_text,
  summary: row.summary,
  actions: parseJsonValue(row.actions_json) ?? [],
});

const rowToMetaEvent = (row) => ({
  id: row.id,
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
      name TEXT NOT NULL,
      debt INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      source_text TEXT NOT NULL,
      summary TEXT NOT NULL,
      actions_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta_events (
      id TEXT PRIMARY KEY,
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

    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_meta_events_at ON meta_events (at DESC);
  `);

  await withClient(async (client) => {
    const productCount = Number((await client.query('SELECT COUNT(*)::int AS count FROM products')).rows[0]?.count ?? 0);
    const clientCount = Number((await client.query('SELECT COUNT(*)::int AS count FROM clients')).rows[0]?.count ?? 0);

    if (!productCount) {
      for (const product of DEFAULT_PRODUCTS) {
        await client.query(
          `
            INSERT INTO products (id, name, product_type, product_model, size, stock_available, stock_reserved, price)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            product.id,
            product.name,
            product.productType,
            product.productModel,
            product.size,
            product.stockAvailable,
            product.stockReserved,
            product.price,
          ],
        );
      }
    }

    if (!clientCount) {
      for (const entry of DEFAULT_CLIENTS) {
        await client.query(
          `
            INSERT INTO clients (id, name, debt)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO NOTHING
          `,
          [entry.id, entry.name, entry.debt],
        );
      }
    }
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

const queryAllState = async (client = null) => {
  const [productsRows, clientsRows, transactionsRows] = await Promise.all([
    queryRows(
      'SELECT id, name, product_type, product_model, size, stock_available, stock_reserved, price FROM products ORDER BY name ASC',
      [],
      client,
    ),
    queryRows('SELECT id, name, debt FROM clients ORDER BY name ASC', [], client),
    queryRows('SELECT id, timestamp, source_text, summary, actions_json FROM transactions ORDER BY timestamp DESC', [], client),
  ]);

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
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 2 && !['para', 'con', 'del', 'las', 'los', 'una', 'uno', 'por', 'les'].includes(token));

const resolveProduct = (products, actionName) => {
  const actionTokens = normalizeTextList(actionName);
  const actionLower = normalizeText(actionName);

  if (!actionTokens.length) {
    return null;
  }

  let bestProduct;
  let bestScore = 0;

  for (const product of products) {
    const productTokens = normalizeTextList(product.name);
    const productLower = normalizeText(product.name);

    if (productLower.includes(actionLower) || actionLower.includes(productLower)) {
      return product;
    }

    const score = actionTokens.filter((token) => productTokens.includes(token)).length;
    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  }

  if (bestScore < 2) {
    return null;
  }

  return bestProduct ?? null;
};

const createProduct = (name, index, metadata = {}) => ({
  id: `product-${slugify(name)}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`,
  name: String(name ?? '').trim(),
  productType: metadata.productType ?? null,
  productModel: metadata.productModel ?? null,
  size: metadata.size ?? null,
  stockAvailable: 0,
  stockReserved: 0,
  price: 0,
});

const ensureProduct = (products, action) => {
  const resolvedProduct = resolveProduct(products, action.productName);

  if (resolvedProduct) {
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

const replaceStateTables = async (client, products, clients) => {
  await client.query('DELETE FROM products');
  await client.query('DELETE FROM clients');

  for (const product of products) {
    await client.query(
      `
        INSERT INTO products (id, name, product_type, product_model, size, stock_available, stock_reserved, price)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        product.id,
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
        INSERT INTO clients (id, name, debt)
        VALUES ($1, $2, $3)
      `,
      [clientEntry.id, clientEntry.name, clientEntry.debt],
    );
  }
};

export const createProductRecord = async (productInput) => {
  await ensureReady();

  const id = `product-${slugify(normalizeProductNameFromInput(productInput))}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const result = await getPool().query(
    `
      INSERT INTO products (id, name, product_type, product_model, size, stock_available, stock_reserved, price)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, product_type, product_model, size, stock_available, stock_reserved, price
    `,
    [
      id,
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

export const updateProductRecord = async (productId, updates) => {
  await ensureReady();

  const existing = await queryRow(
    'SELECT id, name, product_type, product_model, size, stock_available, stock_reserved, price FROM products WHERE id = $1',
    [productId],
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
      WHERE id = $8
      RETURNING id, name, product_type, product_model, size, stock_available, stock_reserved, price
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
    ],
  );

  return result.rows[0] ? rowToProduct(result.rows[0]) : null;
};

export const deleteProductRecord = async (productId) => {
  await ensureReady();
  const result = await getPool().query('DELETE FROM products WHERE id = $1 RETURNING id', [productId]);
  return result.rowCount > 0;
};

export const getStateSnapshot = async () => {
  try {
    await ensureReady();
    return queryAllState();
  } catch (error) {
    console.warn('[postgresDatabase] Falling back to default state snapshot:', error instanceof Error ? error.message : error);
    return cloneDefaultStateSnapshot();
  }
};

export const applyActionsToDatabase = async (actions, sourceText) => {
  await ensureReady();

  return withTransaction(async (client) => {
    const currentSnapshot = await queryAllState(client);
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

    await replaceStateTables(client, nextProducts, nextClients);

    for (const transaction of newTransactions) {
      await client.query(
        `
          INSERT INTO transactions (id, timestamp, source_text, summary, actions_json)
          VALUES ($1, $2, $3, $4, $5::jsonb)
        `,
        [
          transaction.id,
          transaction.timestamp,
          transaction.sourceText,
          transaction.summary,
          toJsonbParam(transaction.actions),
        ],
      );
    }

    return queryAllState(client);
  });
};

export const saveMetaEvent = async (event) => {
  await ensureReady();

  const existing = await findMetaEventById(event.id);
  if (existing) {
    return existing;
  }

  const result = await getPool().query(
    `
      INSERT INTO meta_events (id, at, from_number, body, num_media, kind, source_text, transcript, reply_text, error, actions_json, processed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      RETURNING *
    `,
    [
      event.id,
      event.at,
      event.fromNumber ?? null,
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

export const getMetaEvents = async (limit = 50) => {
  await ensureReady();
  const safeLimit = Math.max(1, Math.min(normalizeInteger(limit, 50), 500));
  const rows = await queryRows('SELECT * FROM meta_events ORDER BY at DESC LIMIT $1', [safeLimit]);

  return rows.map(rowToMetaEvent);
};

export const findMetaEventById = async (eventId) => {
  await ensureReady();
  const row = await queryRow('SELECT * FROM meta_events WHERE id = $1', [eventId]);
  return row ? rowToMetaEvent(row) : null;
};
