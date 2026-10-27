-- How far the camera's clock is from the server's (camera minus server, in seconds), read at most hourly.
ALTER TABLE camera_status
  ADD COLUMN clock_offset_seconds integer,
  ADD COLUMN clock_checked_at timestamptz,
  ADD COLUMN clock_error text;
