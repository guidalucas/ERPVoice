export async function inspectWhatsAppPhotoSchema(client) {
  const { rows: [row] } = await client.query(`SELECT
    to_regclass('public.commerce_whatsapp_photo_chats') IS NOT NULL
    AND to_regclass('public.commerce_whatsapp_photo_jobs') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='meta_message_claims' AND column_name='commerce_photo_handled') AS ready`);
  return row;
}

export async function migrateWhatsAppPhotos(client) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:whatsapp-photos:migration'))");
    await client.query(`ALTER TABLE meta_message_claims ADD COLUMN IF NOT EXISTS commerce_photo_handled BOOLEAN;
      CREATE TABLE IF NOT EXISTS commerce_whatsapp_photo_chats (
        owner_phone TEXT NOT NULL, actor_id TEXT NOT NULL, state JSONB NOT NULL,
        due_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_phone, actor_id)
      );
      CREATE INDEX IF NOT EXISTS commerce_whatsapp_photo_due_idx ON commerce_whatsapp_photo_chats(due_at) WHERE due_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS commerce_whatsapp_photo_expiry_idx ON commerce_whatsapp_photo_chats(expires_at);
      CREATE TABLE IF NOT EXISTS commerce_whatsapp_photo_jobs (
        id TEXT PRIMARY KEY, owner_phone TEXT NOT NULL, actor_id TEXT NOT NULL, product JSONB NOT NULL,
        photos JSONB NOT NULL, results JSONB NOT NULL DEFAULT '[]'::jsonb, attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_token UUID, lease_until TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS commerce_whatsapp_photo_jobs_available_idx ON commerce_whatsapp_photo_jobs(available_at);
      CREATE INDEX IF NOT EXISTS commerce_whatsapp_photo_jobs_chat_idx ON commerce_whatsapp_photo_jobs(owner_phone,actor_id,created_at,id);
      ALTER TABLE commerce_whatsapp_photo_chats ENABLE ROW LEVEL SECURITY;
      ALTER TABLE commerce_whatsapp_photo_jobs ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE commerce_whatsapp_photo_chats,commerce_whatsapp_photo_jobs FROM PUBLIC;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
          REVOKE ALL ON TABLE commerce_whatsapp_photo_chats,commerce_whatsapp_photo_jobs FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
          REVOKE ALL ON TABLE commerce_whatsapp_photo_chats,commerce_whatsapp_photo_jobs FROM authenticated;
        END IF;
      END $$;`);
    const result = await inspectWhatsAppPhotoSchema(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
