-- Camera password policy: when each camera's password was last changed, and how it falls short of
-- its organization's policy (recomputed by the api when it starts and when the policy changes).
ALTER TABLE camera_credentials
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN password_issues text[] NOT NULL DEFAULT '{}';
UPDATE camera_credentials SET password_changed_at = updated_at;
ALTER TABLE camera_credentials
  ALTER COLUMN password_changed_at SET NOT NULL,
  ALTER COLUMN password_changed_at SET DEFAULT now();
