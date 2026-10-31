-- Camera events: tampering, video loss, disk errors and failed logins pushed by the camera over its
-- event stream (Hikvision alertStream, Dahua eventManager) as they happen, between checks.
ALTER TABLE cameras ADD COLUMN event_stream boolean NOT NULL DEFAULT true;
ALTER TABLE camera_status
  ADD COLUMN events_state text CHECK (events_state IN ('connected', 'unsupported', 'failed')),
  ADD COLUMN events_error text,
  ADD COLUMN events_since timestamptz,
  ADD COLUMN events_last_at timestamptz;

CREATE TABLE camera_events (
  id          bigserial PRIMARY KEY,
  camera_id   uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('tamper', 'video_loss', 'device_fault', 'illegal_login')),
  event_type  text NOT NULL,
  state       text NOT NULL CHECK (state IN ('active', 'inactive')),
  channel     integer,
  detail      text NOT NULL
);
CREATE INDEX camera_events_camera ON camera_events (camera_id, occurred_at DESC);
CREATE INDEX camera_events_time ON camera_events (occurred_at);
