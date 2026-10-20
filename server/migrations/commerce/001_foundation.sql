-- Explicit, additive migration. Never imported by HTTP bootstrap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_owner_id_commerce ON products(owner_phone,id);

CREATE TABLE inventory_money_policies (
  owner_phone TEXT PRIMARY KEY,
  currency TEXT NOT NULL CHECK(currency IN ('ARS','UYU','USD')),
  storage_unit TEXT NOT NULL CHECK(storage_unit='major_integer'),
  fraction_digits SMALLINT NOT NULL CHECK(fraction_digits=2),
  revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
  confirmed_by TEXT NOT NULL, confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE commerce_profiles (
  owner_phone TEXT PRIMARY KEY, id UUID NOT NULL UNIQUE,
  brand_name TEXT NOT NULL CHECK(length(btrim(brand_name)) BETWEEN 1 AND 80),
  sales_whatsapp TEXT CHECK(sales_whatsapp IS NULL OR sales_whatsapp ~ '^[0-9]{8,15}$'),
  brand_preset TEXT NOT NULL DEFAULT 'fullmatch_v1' CHECK(brand_preset='fullmatch_v1'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE commercial_products (
  owner_phone TEXT NOT NULL REFERENCES commerce_profiles(owner_phone), id UUID NOT NULL,
  title TEXT NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=4000),
  team_key TEXT CHECK(team_key IS NULL OR team_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  team_name TEXT CHECK(team_name IS NULL OR length(btrim(team_name)) BETWEEN 1 AND 100),
  team_kind TEXT CHECK(team_kind IN ('club','national_team')),
  season TEXT CHECK(season IS NULL OR season ~ '^[0-9]{4}(/[0-9]{2}([0-9]{2})?)?$'),
  kit_key TEXT CHECK(kit_key IN ('home','away','third','goalkeeper','special')),
  version_key TEXT CHECK(version_key IN ('fan','player')),
  sleeve_key TEXT CHECK(sleeve_key IN ('short','long','sleeveless')),
  identity_key TEXT CHECK(identity_key IS NULL OR identity_key ~ '^[a-f0-9]{64}$'),
  slug TEXT NOT NULL CHECK(length(slug) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','archived')),
  cover_image_id UUID, revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), archived_at TIMESTAMPTZ,
  PRIMARY KEY(owner_phone,id), UNIQUE(owner_phone,slug),
  CHECK((status='archived')=(archived_at IS NOT NULL)),
  CHECK(status<>'ready' OR (identity_key IS NOT NULL AND team_key IS NOT NULL AND team_name IS NOT NULL
    AND team_kind IS NOT NULL AND season IS NOT NULL AND kit_key IS NOT NULL AND version_key IS NOT NULL AND sleeve_key IS NOT NULL))
);
CREATE UNIQUE INDEX idx_commercial_products_identity ON commercial_products(owner_phone,identity_key)
  WHERE identity_key IS NOT NULL AND status<>'archived';
CREATE INDEX idx_commercial_products_list ON commercial_products(owner_phone,status,updated_at DESC,id DESC);

CREATE TABLE commercial_product_skus (
  owner_phone TEXT NOT NULL, commercial_product_id UUID NOT NULL, sku_id TEXT NOT NULL,
  identity_fingerprint_at_link TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0), linked_by TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_phone,commercial_product_id,sku_id), UNIQUE(owner_phone,sku_id),
  FOREIGN KEY(owner_phone,commercial_product_id) REFERENCES commercial_products(owner_phone,id),
  FOREIGN KEY(owner_phone,sku_id) REFERENCES products(owner_phone,id)
);

CREATE TABLE commercial_product_images (
  owner_phone TEXT NOT NULL, id UUID NOT NULL, commercial_product_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed','deleted')),
  source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  source_size_bytes BIGINT NOT NULL CHECK(source_size_bytes>0 AND source_size_bytes<=12582912),
  master_key TEXT, thumbnail_key TEXT, master_sha256 TEXT,
  mime_type TEXT, width INTEGER, height INTEGER, stored_size_bytes BIGINT,
  alt_text TEXT NOT NULL DEFAULT '' CHECK(length(alt_text)<=300),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0),
  focal_x NUMERIC NOT NULL DEFAULT 0.5 CHECK(focal_x>=0 AND focal_x<=1),
  focal_y NUMERIC NOT NULL DEFAULT 0.5 CHECK(focal_y>=0 AND focal_y<=1),
  revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), attempt_id UUID, processing_started_at TIMESTAMPTZ,
  upload_expires_at TIMESTAMPTZ NOT NULL, product_identity_at_start TEXT, error_code TEXT,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ, purged_at TIMESTAMPTZ,
  PRIMARY KEY(owner_phone,id), UNIQUE(owner_phone,commercial_product_id,id),
  FOREIGN KEY(owner_phone,commercial_product_id) REFERENCES commercial_products(owner_phone,id),
  CHECK(status<>'ready' OR (master_key IS NOT NULL AND thumbnail_key IS NOT NULL AND master_sha256 IS NOT NULL
    AND mime_type IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND stored_size_bytes IS NOT NULL
    AND width>0 AND height>0 AND stored_size_bytes>0)),
  CHECK(status<>'processing' OR (attempt_id IS NOT NULL AND processing_started_at IS NOT NULL)),
  CHECK(master_sha256 IS NULL OR master_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK((status='deleted')=(deleted_at IS NOT NULL))
);
CREATE INDEX idx_commercial_images_gallery ON commercial_product_images(owner_phone,commercial_product_id,status,sort_order,id);
CREATE INDEX idx_commercial_images_maintenance ON commercial_product_images(status,updated_at);
ALTER TABLE commercial_products ADD CONSTRAINT commercial_product_cover_fk
  FOREIGN KEY(owner_phone,id,cover_image_id) REFERENCES commercial_product_images(owner_phone,commercial_product_id,id);

CREATE TABLE commercial_operations (
  owner_phone TEXT NOT NULL REFERENCES commerce_profiles(owner_phone), operation_id UUID NOT NULL,
  actor_id TEXT NOT NULL, operation_type TEXT NOT NULL, entity_id UUID,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  request_json JSONB NOT NULL, result_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_phone,operation_id)
);
CREATE INDEX idx_commercial_operations_entity ON commercial_operations(owner_phone,entity_id,created_at DESC);
