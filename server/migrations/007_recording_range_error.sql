-- Why the days of recordings could not be read (shown on the camera page), and whether the value is
-- only a lower bound (the camera answered a shorter search only, and has recordings from its start).
ALTER TABLE camera_status
  ADD COLUMN recording_range_error text,
  ADD COLUMN recording_days_at_least boolean NOT NULL DEFAULT false;
