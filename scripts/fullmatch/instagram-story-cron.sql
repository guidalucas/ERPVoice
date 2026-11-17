CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS stocky_automation;
REVOKE ALL ON SCHEMA stocky_automation FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS stocky_automation.instagram_story_dispatches (
  request_id bigint PRIMARY KEY,
  scheduled_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  dry_run boolean NOT NULL,
  http_status integer,
  http_error text,
  responded_at timestamptz
);
ALTER TABLE stocky_automation.instagram_story_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stocky_automation.instagram_story_dispatches FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION stocky_automation.collect_instagram_story_responses()
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE collected integer;
BEGIN
  UPDATE stocky_automation.instagram_story_dispatches AS dispatch
  SET http_status = response.status_code,
      http_error = CASE
        WHEN response.timed_out THEN 'GITHUB_REQUEST_TIMEOUT'
        WHEN response.error_msg IS NOT NULL THEN 'GITHUB_REQUEST_FAILED'
        WHEN response.status_code NOT IN (200, 204) THEN 'GITHUB_HTTP_' || response.status_code::text
      END,
      responded_at = now()
  FROM net._http_response AS response
  WHERE response.id = dispatch.request_id AND dispatch.responded_at IS NULL;
  GET DIAGNOSTICS collected = ROW_COUNT;
  RETURN collected;
END;
$$;
REVOKE ALL ON FUNCTION stocky_automation.collect_instagram_story_responses() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION stocky_automation.dispatch_instagram_story(utc_hour integer, dry_run boolean DEFAULT true)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  token text;
  scheduled_at timestamptz;
  request_id bigint;
BEGIN
  IF utc_hour NOT IN (12, 15, 19, 23) OR utc_hour IS NULL OR dry_run IS NULL THEN
    RAISE EXCEPTION 'INVALID_STORY_SCHEDULE';
  END IF;
  scheduled_at := (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    + make_interval(hours => utc_hour, mins => 17);
  IF scheduled_at > now() THEN
    scheduled_at := scheduled_at - interval '1 day';
  END IF;
  SELECT decrypted_secret INTO token FROM vault.decrypted_secrets
    WHERE name = 'stocky_instagram_actions_token';
  IF token IS NULL OR token = '' THEN
    RAISE EXCEPTION 'GITHUB_DISPATCH_TOKEN_REQUIRED';
  END IF;
  PERFORM stocky_automation.collect_instagram_story_responses();
  SELECT net.http_post(
    url := 'https://api.github.com/repos/guidalucas/ERPVoice/actions/workflows/instagram-auto-story.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'Stocky-Supabase-Cron',
      'X-GitHub-Api-Version', '2026-03-10'
    ),
    body := jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object('dry_run', dry_run,
        'scheduled_at', to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    ),
    timeout_milliseconds := 15000
  ) INTO request_id;
  INSERT INTO stocky_automation.instagram_story_dispatches(request_id, scheduled_at, dry_run)
    VALUES(request_id, scheduled_at, dry_run);
  RETURN request_id;
END;
$$;
REVOKE ALL ON FUNCTION stocky_automation.dispatch_instagram_story(integer, boolean) FROM PUBLIC, anon, authenticated;

-- Reapplying configuration preserves each job's current activation state.
DO $$
DECLARE
  utc_hour integer;
  job_name text;
  job_id bigint;
  was_active boolean;
BEGIN
  FOREACH utc_hour IN ARRAY ARRAY[12, 15, 19, 23] LOOP
    job_name := 'stocky-instagram-story-' || utc_hour::text;
    SELECT active INTO was_active FROM cron.job WHERE jobname = job_name AND username = current_user;
    SELECT cron.schedule(job_name, format('17,37,57 %s * * *', utc_hour),
      format('SELECT stocky_automation.dispatch_instagram_story(%s, false);', utc_hour)) INTO job_id;
    PERFORM cron.alter_job(job_id, active := COALESCE(was_active, false));
  END LOOP;
  SELECT cron.schedule('stocky-instagram-story-responses', '*/5 * * * *',
    'SELECT stocky_automation.collect_instagram_story_responses();') INTO job_id;
END;
$$;
