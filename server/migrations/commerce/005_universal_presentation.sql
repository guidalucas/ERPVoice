-- Preserve all existing rows and sports identity fields/indexes. Only remove
-- the legacy requirement that every ready product have a football identity.
DO $$ DECLARE legacy_name TEXT; BEGIN
  SELECT conname INTO STRICT legacy_name FROM pg_constraint
    WHERE conrelid='public.commercial_products'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%ready%'
      AND pg_get_constraintdef(oid) LIKE '%identity_key%'
      AND pg_get_constraintdef(oid) LIKE '%team_kind%';
  EXECUTE format('ALTER TABLE public.commercial_products DROP CONSTRAINT %I', legacy_name);
END $$;
ALTER TABLE commercial_products ADD CONSTRAINT commercial_products_ready_title
  CHECK(status<>'ready' OR length(btrim(title))>0);
