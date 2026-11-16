-- Use the time the job was claimed, including for existing jobs and older runners.
ALTER TABLE commerce_auto_story_jobs ADD COLUMN publication_window smallint
  GENERATED ALWAYS AS (
    CASE
      WHEN (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= TIME '20:17' THEN 4
      WHEN (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= TIME '16:17' THEN 3
      WHEN (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= TIME '12:17' THEN 2
      ELSE 1
    END
  ) STORED;

CREATE UNIQUE INDEX commerce_auto_story_window_publication
  ON commerce_auto_story_jobs (owner_phone, instagram_id, business_date, publication_window)
  WHERE status = 'published';
DROP INDEX commerce_auto_story_daily_publication;
