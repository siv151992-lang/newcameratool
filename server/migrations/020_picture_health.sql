-- Picture health: whether each camera's picture is usable (not black, covered, blurred, frozen or
-- moved), from a snapshot every few minutes compared with the camera's own earlier ones. Only
-- numbers and a 32 x 18 grey thumbnail are kept, never the snapshot.
ALTER TABLE cameras ADD COLUMN picture_checks boolean NOT NULL DEFAULT true;
ALTER TABLE camera_status
  ADD COLUMN picture_state text CHECK (picture_state IN ('ok', 'black', 'blank', 'blurred', 'frozen', 'moved')),
  ADD COLUMN picture_detail text,
  ADD COLUMN picture_error text,
  ADD COLUMN picture_checked_at timestamptz,
  ADD COLUMN picture_metrics jsonb,
  ADD COLUMN picture_baseline jsonb NOT NULL DEFAULT '{}',
  -- The problem seen at consecutive checks: it counts once seen twice in a row.
  ADD COLUMN picture_suspect text,
  ADD COLUMN picture_suspect_count integer NOT NULL DEFAULT 0;
CREATE INDEX camera_status_picture_problem ON camera_status (picture_state) WHERE picture_state IS NOT NULL AND picture_state <> 'ok';
