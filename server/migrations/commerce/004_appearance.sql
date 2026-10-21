ALTER TABLE commerce_profiles ADD COLUMN appearance JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(appearance) = 'object');

CREATE TABLE commerce_brand_assets (
  owner_phone TEXT NOT NULL REFERENCES commerce_profiles(owner_phone),
  id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'cover')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
  content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1048576),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_phone, id)
);
ALTER TABLE commerce_brand_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commerce_brand_assets FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON commerce_brand_assets FROM %I', role_name);
  END LOOP;
END $$;
