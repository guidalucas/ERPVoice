CREATE TABLE commerce_auto_story_settings (
  owner_phone text PRIMARY KEY REFERENCES commerce_profiles(owner_phone) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  instagram_id text UNIQUE,
  instagram_username text,
  connection_status text NOT NULL DEFAULT 'pending'
    CHECK (connection_status IN ('pending','connected','expired','revoked','error')),
  authorization_at timestamptz,
  refreshed_token text,
  token_source text,
  token_expires_at timestamptz,
  CHECK (NOT enabled OR (instagram_id IS NOT NULL AND authorization_at IS NOT NULL))
);

CREATE TABLE commerce_auto_story_jobs (
  id uuid PRIMARY KEY,
  owner_phone text NOT NULL REFERENCES commerce_auto_story_settings(owner_phone),
  instagram_id text NOT NULL,
  business_date date NOT NULL,
  product_id uuid,
  cycle integer,
  snapshot jsonb,
  status text NOT NULL CHECK (status IN ('rendering','ready','creating','publishing','published','skipped','failed','unknown')),
  error_code text,
  lease_until timestamptz,
  container_id text,
  media_id text,
  published_at timestamptz,
  jpeg bytea CHECK (octet_length(jpeg) <= 8388608),
  jpeg_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX commerce_auto_story_daily_publication ON commerce_auto_story_jobs (owner_phone, instagram_id, business_date)
  WHERE status = 'published';
CREATE UNIQUE INDEX commerce_auto_story_active ON commerce_auto_story_jobs (owner_phone)
  WHERE status IN ('rendering','ready','creating','publishing','unknown');
CREATE INDEX commerce_auto_story_history ON commerce_auto_story_jobs (owner_phone, created_at DESC);
CREATE INDEX commerce_auto_story_rotation ON commerce_auto_story_jobs (owner_phone, instagram_id, cycle DESC, product_id)
  WHERE status = 'published';
CREATE INDEX commerce_auto_story_expired_jpeg ON commerce_auto_story_jobs (jpeg_expires_at) WHERE jpeg IS NOT NULL;

CREATE TABLE commerce_auto_story_requests (
  owner_phone text NOT NULL,
  nonce uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_phone, nonce)
);
CREATE INDEX commerce_auto_story_requests_expiry ON commerce_auto_story_requests (expires_at);

ALTER TABLE commercial_products ADD COLUMN auto_story_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE commerce_auto_story_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_auto_story_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_auto_story_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce_auto_story_settings, commerce_auto_story_jobs, commerce_auto_story_requests FROM PUBLIC;

DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON commerce_auto_story_settings, commerce_auto_story_jobs, commerce_auto_story_requests FROM %I', role_name);
  END LOOP;
END $$;
