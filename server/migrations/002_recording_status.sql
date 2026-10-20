-- Live recording status per camera, read on each successful check.
ALTER TABLE camera_status
  ADD COLUMN recording_state      text NOT NULL DEFAULT 'unknown'
                                  CHECK (recording_state IN ('unknown','recording','idle','error')),
  ADD COLUMN recording_detail     text,          -- what the camera reported, or why it could not be read
  ADD COLUMN recording_checked_at timestamptz;

ALTER TABLE storage_checks ADD COLUMN recording_state text;
