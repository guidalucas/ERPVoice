-- Keep the stored title as fallback/custom copy; existing fichas follow Stocky.
ALTER TABLE commercial_products ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'inventory'
  CHECK (title_source IN ('inventory','custom'));
