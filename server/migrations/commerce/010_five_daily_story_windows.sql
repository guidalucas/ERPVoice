-- Keep every historical window number and its unique publication index intact.
-- Recomputing the generated column would merge old 09:17 and 12:17 publications.
ALTER TABLE commerce_auto_story_jobs ALTER COLUMN publication_window DROP EXPRESSION;
ALTER TABLE commerce_auto_story_jobs ALTER COLUMN publication_window SET NOT NULL;
ALTER TABLE commerce_auto_story_jobs ADD CONSTRAINT commerce_auto_story_window_range
  CHECK (publication_window BETWEEN 1 AND 5);

-- During deployment, older backend processes still omit the window on INSERT.
-- Preserve their original schedule until the new backend supplies it explicitly.
CREATE FUNCTION commerce_auto_story_legacy_window() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.publication_window IS NULL THEN
    NEW.publication_window := CASE
      WHEN (NEW.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= TIME '20:17' THEN 4
      WHEN (NEW.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= TIME '16:17' THEN 3
      WHEN (NEW.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= TIME '12:17' THEN 2
      ELSE 1
    END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_auto_story_legacy_window
  BEFORE INSERT ON commerce_auto_story_jobs
  FOR EACH ROW EXECUTE FUNCTION commerce_auto_story_legacy_window();
