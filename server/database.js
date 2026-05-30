import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE_PATH = path.join(__dirname, 'data', 'erpvoice.sqlite');

const DEFAULT_PRODUCTS = [
  {
    id: 'product-boca-titular-2026',
    name: 'Camiseta Boca Titular 2026',
    stockAvailable: 0,
    stockReserved: 0,
    price: 50000,
  },
  {
    id: 'product-argentina-suplente',
    name: 'Camiseta Argentina Suplente',
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

let sqlJsPromise;

const getSqlJs = async () => {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    });
  }

  return sqlJsPromise;
};

const createEmptyDatabase = async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();

  ensureSchema(db);

  const insertProduct = db.prepare('INSERT INTO products (id, name, stockAvailable, stockReserved, price) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_PRODUCTS.forEach((product) => insertProduct.run([product.id, product.name, product.stockAvailable, product.stockReserved, product.price]));
  insertProduct.free();

  const insertClient = db.prepare('INSERT INTO clients (id, name, debt) VALUES (?, ?, ?)');
  DEFAULT_CLIENTS.forEach((client) => insertClient.run([client.id, client.name, client.debt]));
  insertClient.free();

  return db;
};

const ensureSchema = (db) => {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stockAvailable INTEGER NOT NULL,
      stockReserved INTEGER NOT NULL,
      price INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      debt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      sourceText TEXT NOT NULL,
      summary TEXT NOT NULL,
      actionsJson TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twilio_events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      fromNumber TEXT,
      body TEXT,
      numMedia INTEGER NOT NULL,
      kind TEXT,
      sourceText TEXT,
      transcript TEXT,
      replyText TEXT,
      error TEXT,
      actionsJson TEXT,
      processed INTEGER NOT NULL DEFAULT 0
    );
  `);
};

const loadDatabase = async () => {
  if (!fs.existsSync(DB_FILE_PATH)) {
    return createEmptyDatabase();
  }

  const SQL = await getSqlJs();
  const buffer = fs.readFileSync(DB_FILE_PATH);
  const db = new SQL.Database(buffer);
  ensureSchema(db);
  return db;
};

const saveDatabase = (db) => {
  fs.mkdirSync(path.dirname(DB_FILE_PATH), { recursive: true });
  fs.writeFileSync(DB_FILE_PATH, Buffer.from(db.export()));
};

const ensureSeed = (db) => {
  const productCount = db.exec('SELECT COUNT(*) AS count FROM products')[0]?.values[0]?.[0] ?? 0;
  const clientCount = db.exec('SELECT COUNT(*) AS count FROM clients')[0]?.values[0]?.[0] ?? 0;

  if (!productCount) {
    const insertProduct = db.prepare('INSERT INTO products (id, name, stockAvailable, stockReserved, price) VALUES (?, ?, ?, ?, ?)');
    DEFAULT_PRODUCTS.forEach((product) => insertProduct.run([product.id, product.name, product.stockAvailable, product.stockReserved, product.price]));
    insertProduct.free();
  }

  if (!clientCount) {
    const insertClient = db.prepare('INSERT INTO clients (id, name, debt) VALUES (?, ?, ?)');
    DEFAULT_CLIENTS.forEach((client) => insertClient.run([client.id, client.name, client.debt]));
    insertClient.free();
  }
};

const rowsToObjects = (result) => {
  if (!result.length) {
    return [];
  }

  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
};

const queryAll = (db, sql, params = []) => {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];

  while (statement.step()) {
    rows.push(statement.getAsObject());
  }

  statement.free();
  return rows;
};

const normalizeText = (value) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const tokenize = (value) =>
  normalizeText(value)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 2 && !['para', 'con', 'del', 'las', 'los', 'una', 'uno', 'por', 'les'].includes(token));

const slugify = (value) =>
  normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'nuevo-producto';

const resolveProduct = (products, actionName) => {
  const actionTokens = tokenize(actionName);
  const actionLower = normalizeText(String(actionName ?? ''));

  if (!actionTokens.length) {
    return null;
  }

  let bestProduct;
  let bestScore = 0;

  for (const product of products) {
    const productTokens = tokenize(product.name);
    const productLower = normalizeText(String(product.name ?? ''));

    // Exact-ish substring match: prefer strong textual containment
    if (productLower.includes(actionLower) || actionLower.includes(productLower)) {
      console.log(`[DB] resolveProduct: substring match '${actionName}' -> '${product.name}'`);
      return product;
    }

    const score = actionTokens.filter((token) => productTokens.includes(token)).length;

    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  }

  // Fallback: require at least 2 matching tokens to consider it the same product.
  if (bestScore < 2) {
    console.log(`[DB] resolveProduct: no confident match for '${actionName}' (bestScore=${bestScore})`);
    return null;
  }

  console.log(`[DB] resolveProduct: matched '${actionName}' -> '${bestProduct?.name}' (score=${bestScore})`);
  return bestProduct ?? null;
};

const createProduct = (name, index) => ({
  id: `product-${slugify(name)}-${index + 1}-${Math.random().toString(36).slice(2, 6)}`,
  name: String(name ?? '').trim(),
  stockAvailable: 0,
  stockReserved: 0,
  price: 0,
});

const ensureProduct = (products, productName) => {
  const resolvedProduct = resolveProduct(products, productName);

  if (resolvedProduct) {
    return resolvedProduct;
  }

  const product = createProduct(productName, products.length);
  console.log(`[DB] ensureProduct: creating new product '${product.name}' (id=${product.id})`);
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

const mapSnapshot = (db) => ({
  products: queryAll(db, 'SELECT id, name, stockAvailable, stockReserved, price FROM products ORDER BY name ASC'),
  clients: queryAll(db, 'SELECT id, name, debt FROM clients ORDER BY name ASC'),
  transactions: queryAll(db, 'SELECT id, timestamp, sourceText, summary, actionsJson FROM transactions ORDER BY timestamp DESC').map((row) => ({
    ...row,
    actions: JSON.parse(row.actionsJson),
  })),
});

const replaceStateTables = (db, products, clients) => {
  db.run('DELETE FROM products');
  db.run('DELETE FROM clients');

  const insertProduct = db.prepare('INSERT INTO products (id, name, stockAvailable, stockReserved, price) VALUES (?, ?, ?, ?, ?)');
  products.forEach((product) => insertProduct.run([product.id, product.name, product.stockAvailable, product.stockReserved, product.price]));
  insertProduct.free();

  const insertClient = db.prepare('INSERT INTO clients (id, name, debt) VALUES (?, ?, ?)');
  clients.forEach((client) => insertClient.run([client.id, client.name, client.debt]));
  insertClient.free();
};

export const getStateSnapshot = async () => {
  const db = await loadDatabase();
  ensureSeed(db);
  const snapshot = mapSnapshot(db);
  saveDatabase(db);
  return snapshot;
};

export const applyActionsToDatabase = async (actions, sourceText) => {
  const db = await loadDatabase();
  ensureSeed(db);

  const currentSnapshot = mapSnapshot(db);
  const nextProducts = currentSnapshot.products.map((product) => ({ ...product }));
  const nextClients = currentSnapshot.clients.map((client) => ({ ...client }));
  const newTransactions = [];

  const lastSellAction = [...actions].reverse().find((action) => action.type === 'sell');
  const computedDebtAmount = lastSellAction ? calculateSaleDebt(nextProducts, lastSellAction) : null;

  actions.forEach((action, index) => {
    if (action.type === 'add_stock') {
      const product = ensureProduct(nextProducts, action.productName);
      product.stockAvailable += action.qty;
    }

    if (action.type === 'reserve_stock') {
      const product = ensureProduct(nextProducts, action.productName);
      const reservationQty = Math.min(product.stockAvailable, action.qty);
      product.stockAvailable -= reservationQty;
      product.stockReserved += reservationQty;
    }

    if (action.type === 'sell') {
      const product = ensureProduct(nextProducts, action.productName);
      const sellQty = Math.min(product.stockAvailable, action.qty);
      product.stockAvailable -= sellQty;
    }

    if (action.type === 'add_debt') {
      const client = nextClients.find((entry) => entry.name.toLowerCase() === action.clientName.toLowerCase()) ?? nextClients[0];
      if (client) {
        const productDebtAmount = calculateProductDebt(nextProducts, action);
        const amountToApply = productDebtAmount && productDebtAmount > 0
          ? productDebtAmount
          : computedDebtAmount && computedDebtAmount > 0
            ? computedDebtAmount
            : action.amount;
        client.debt += amountToApply;
        action = {
          ...action,
          amount: amountToApply,
        };
      }
    }

    if (action.type === 'payment_received') {
      const client = nextClients.find((entry) => entry.name.toLowerCase() === action.clientName.toLowerCase()) ?? nextClients[0];
      if (client) {
        client.debt = Math.max(0, client.debt - action.amount);
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

  db.run('BEGIN');
  try {
    replaceStateTables(db, nextProducts, nextClients);

    const insertTransaction = db.prepare('INSERT INTO transactions (id, timestamp, sourceText, summary, actionsJson) VALUES (?, ?, ?, ?, ?)');
    newTransactions.forEach((transaction) => insertTransaction.run([
      transaction.id,
      transaction.timestamp,
      transaction.sourceText,
      transaction.summary,
      JSON.stringify(transaction.actions),
    ]));
    insertTransaction.free();

    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }

  saveDatabase(db);
  return mapSnapshot(db);
};

export const saveTwilioEvent = async (event) => {
  const db = await loadDatabase();
  ensureSeed(db);

  const existing = queryAll(db, 'SELECT * FROM twilio_events WHERE id = ?', [event.id])[0];

  if (existing) {
    return existing;
  }

  const statement = db.prepare(`
    INSERT INTO twilio_events (id, at, fromNumber, body, numMedia, kind, sourceText, transcript, replyText, error, actionsJson, processed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  statement.run([
    event.id,
    event.at,
    event.fromNumber ?? null,
    event.body ?? null,
    event.numMedia,
    event.kind ?? null,
    event.sourceText ?? null,
    event.transcript ?? null,
    event.replyText ?? null,
    event.error ?? null,
    event.actionsJson ?? null,
    event.processed ? 1 : 0,
  ]);
  statement.free();

  saveDatabase(db);
  return event;
};

export const markTwilioEventProcessed = async (eventId, updates) => {
  const db = await loadDatabase();
  ensureSeed(db);

  const statement = db.prepare(`
    UPDATE twilio_events
    SET at = COALESCE(?, at),
        fromNumber = COALESCE(?, fromNumber),
        body = COALESCE(?, body),
        numMedia = COALESCE(?, numMedia),
        kind = COALESCE(?, kind),
        sourceText = COALESCE(?, sourceText),
        transcript = COALESCE(?, transcript),
        replyText = COALESCE(?, replyText),
        error = COALESCE(?, error),
        actionsJson = COALESCE(?, actionsJson),
        processed = COALESCE(?, processed)
    WHERE id = ?
  `);

  statement.run([
    updates.at ?? null,
    updates.fromNumber ?? null,
    updates.body ?? null,
    typeof updates.numMedia === 'number' ? updates.numMedia : null,
    updates.kind ?? null,
    updates.sourceText ?? null,
    updates.transcript ?? null,
    updates.replyText ?? null,
    updates.error ?? null,
    updates.actionsJson ?? null,
    typeof updates.processed === 'boolean' ? (updates.processed ? 1 : 0) : null,
    eventId,
  ]);
  statement.free();

  saveDatabase(db);
};

export const getTwilioEvents = async (limit = 50) => {
  const db = await loadDatabase();
  ensureSeed(db);
  const rows = queryAll(db, 'SELECT * FROM twilio_events ORDER BY at DESC LIMIT ?', [limit]);

  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    from: row.fromNumber,
    body: row.body,
    numMedia: row.numMedia,
    kind: row.kind,
    sourceText: row.sourceText,
    transcript: row.transcript,
    replyText: row.replyText,
    error: row.error,
    actions: row.actionsJson ? JSON.parse(row.actionsJson) : null,
    processed: Boolean(row.processed),
  }));
};

export const findTwilioEventById = async (eventId) => {
  const db = await loadDatabase();
  ensureSeed(db);
  const rows = queryAll(db, 'SELECT * FROM twilio_events WHERE id = ?', [eventId]);
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    at: row.at,
    from: row.fromNumber,
    body: row.body,
    numMedia: row.numMedia,
    kind: row.kind,
    sourceText: row.sourceText,
    transcript: row.transcript,
    replyText: row.replyText,
    error: row.error,
    actions: row.actionsJson ? JSON.parse(row.actionsJson) : null,
    processed: Boolean(row.processed),
  };
};
