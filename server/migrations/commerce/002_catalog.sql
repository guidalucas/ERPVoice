CREATE TABLE commerce_catalogs (
  owner_phone TEXT PRIMARY KEY REFERENCES commerce_profiles(owner_phone), id UUID NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 64),
  public_enabled BOOLEAN NOT NULL DEFAULT false, revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE commercial_publications (
  owner_phone TEXT NOT NULL, commercial_product_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'hidden' CHECK(status IN ('hidden','published')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  updated_by TEXT NOT NULL, published_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_phone,commercial_product_id),
  CHECK(status<>'published' OR published_at IS NOT NULL),
  FOREIGN KEY(owner_phone,commercial_product_id) REFERENCES commercial_products(owner_phone,id)
);
CREATE INDEX idx_commercial_publications_visible ON commercial_publications(owner_phone,commercial_product_id) WHERE status='published';
