-- Recording set-up as read from the camera (overwrite when full, continuous or event recording)
-- and the gaps in its last 24 hours of recordings.
ALTER TABLE camera_status
  ADD COLUMN recording_overwrite  boolean,
  ADD COLUMN recording_continuous boolean,
  ADD COLUMN recording_gaps       jsonb,
  ADD COLUMN recording_gaps_at    timestamptz,
  ADD COLUMN recording_gaps_error text;
