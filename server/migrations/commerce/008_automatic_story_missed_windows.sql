ALTER TABLE commerce_auto_story_settings ADD COLUMN enabled_at timestamptz;

-- Verification time is the best available starting point for existing activations.
UPDATE commerce_auto_story_settings SET enabled_at = authorization_at WHERE enabled;
