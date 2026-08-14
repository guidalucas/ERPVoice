import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

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

  if (process.env.POSTGRES_SSL === 'true') {
    return true;
  }

  return /sslmode=require/i.test(connectionString) || /supabase\.co/i.test(connectionString);
};

const main = async () => {
  const connectionString = getConnectionString();

  if (!connectionString) {
    throw new Error('Missing PostgreSQL connection string. Set SUPABASE_DATABASE_URL or DATABASE_URL.');
  }

  const pool = new Pool({
    connectionString,
    ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false,
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
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

      CREATE TABLE IF NOT EXISTS proveedores (
        id TEXT PRIMARY KEY,
        owner_phone TEXT NOT NULL DEFAULT '__default__',
        name TEXT NOT NULL,
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

      ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
      ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
      ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS notas TEXT;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
      ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS owner_phone TEXT NOT NULL DEFAULT '__default__';
      ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS proveedor_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_products_owner_phone ON products (owner_phone);
      CREATE INDEX IF NOT EXISTS idx_clients_owner_phone ON clients (owner_phone);
      CREATE INDEX IF NOT EXISTS idx_transactions_owner_phone ON transactions (owner_phone);
      CREATE INDEX IF NOT EXISTS idx_meta_events_at ON meta_events (at DESC);
      CREATE INDEX IF NOT EXISTS idx_auth_otp_phone_number ON auth_otp_challenges (phone_number);
      CREATE INDEX IF NOT EXISTS idx_auth_otp_expires_at ON auth_otp_challenges (expires_at);
    `);

    await client.query("UPDATE products SET owner_phone = '__default__' WHERE owner_phone IS NULL");
    await client.query("UPDATE clients SET owner_phone = '__default__' WHERE owner_phone IS NULL");
    await client.query("UPDATE transactions SET owner_phone = '__default__' WHERE owner_phone IS NULL");
    await client.query("UPDATE meta_events SET owner_phone = '__default__' WHERE owner_phone IS NULL");

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});