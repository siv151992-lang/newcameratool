-- How far back the recordings on a camera's own storage go (refreshed every few hours).
ALTER TABLE camera_status
  ADD COLUMN recording_days numeric(7,2),          -- days between the oldest recording and the camera's time now
  ADD COLUMN recording_oldest text,                -- oldest recording, camera wall-clock time (YYYY-MM-DDTHH:MM:SS)
  ADD COLUMN recording_range_at timestamptz;       -- when it was last read
