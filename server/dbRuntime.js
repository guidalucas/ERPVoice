import { Pool } from 'pg';

/** Connection/transaction primitives only: never bootstraps schemas or normalizes tenants. */
export function createDatabaseRuntime({ connectionString, ssl = false, poolFactory = options => new Pool(options) }) {
  let pool;
  const getPool = () => {
    const value = typeof connectionString === 'function' ? connectionString() : connectionString;
    if (!value) throw Object.assign(new Error('Database connection is not configured.'), { code: 'DATABASE_NOT_CONFIGURED' });
    pool ??= poolFactory({ connectionString: value, ssl: typeof ssl === 'function' ? ssl() : ssl,
      connectionTimeoutMillis: 10_000 });
    return pool;
  };
  const withClient = async callback => {
    const client = await getPool().connect();
    try { return await callback(client); } finally { client.release(); }
  };
  const transaction = async (callback, { readOnly = false, repeatableRead = false } = {}) => withClient(async client => {
    await client.query(`BEGIN${repeatableRead ? ' ISOLATION LEVEL REPEATABLE READ' : ''}${readOnly ? ' READ ONLY' : ''}`);
    try { const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  const close = async () => { if (pool) await pool.end(); pool = undefined; };
  return { getPool, withClient, transaction, close };
}

/** Fail closed in production without running DDL from an HTTP request. */
export async function inspectStockyFoundation(client) {
  const expected = {
    products: ['id', 'owner_phone', 'stock_available', 'stock_reserved', 'price_currency', 'inventory_revision', 'family_id', 'family_version'],
    clients: ['account_revision', 'metadata_revision'], proveedores: ['metadata_revision'],
    pedidos: ['product_id', 'stock_posting_json', 'revision'], transactions: ['batch_id', 'item_id'],
    auth_users: ['phone_number'], business_members: ['tenant_phone', 'member_phone'], business_invites: ['id'],
    auth_otp_challenges: ['id'], voice_stock_batches: ['payload_json'], voice_stock_batch_settings: ['mode'],
    voice_stock_shadow_runs: ['proposed_json'],
    auth_wa_challenges: ['login_token'], meta_events: ['owner_phone'], meta_message_claims: ['raw_body_json'],
    meta_reply_outbox: ['provider_message_ids'], inventory_operations: ['request_hash'], inventory_movements: ['sku_id'],
    inventory_selections: ['cancelled_at'], account_operations: ['operation_id'], account_movements: ['client_id'],
    order_operations: ['operation_id'], party_operations: ['operation_id'], universal_operations: ['operation_id'],
    universal_drafts: ['preview_json'], universal_draft_commands: ['draft_id'], universal_meta_commands: ['message_id'],
    product_family_schemas: ['schema_json'], product_family_operations: ['operation_id'], meta_selection_commands: ['message_id'],
  };
  const rows = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`, [Object.keys(expected)])).rows;
  const missing = Object.entries(expected).flatMap(([table, columns]) => columns
    .filter(column => !rows.some(row => row.table_name === table && row.column_name === column))
    .map(column => `${table}.${column}`));
  if (missing.length) throw Object.assign(new Error('Stocky schema migration must be applied explicitly before serving requests.'),
    { code: 'STOCKY_SCHEMA_NOT_READY', missing });
  return { ready: true };
}
