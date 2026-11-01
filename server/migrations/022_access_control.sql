-- Access control: an access controller or terminal (Hikvision), or an access control server that
-- reports for its readers (Suprema BioStar 2, Gallagher Command Centre), is a device of its own
-- type. It is checked like a camera (reachable, login), and its readers and doors and their
-- events are read at each check.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_device_type_check;
ALTER TABLE cameras ADD CONSTRAINT cameras_device_type_check CHECK (device_type IN ('camera', 'nvr', 'access'));

ALTER TABLE camera_status
  ADD COLUMN access_error text,
  ADD COLUMN access_at timestamptz,
  -- Events are read from just after the newest one already read.
  ADD COLUMN access_events_after timestamptz;

-- The readers, doors and controllers of an access system, as last read.
CREATE TABLE access_points (
  id          bigserial PRIMARY KEY,
  camera_id   uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('reader', 'door', 'controller')),
  external_id text NOT NULL,
  name        text NOT NULL,
  model       text,
  -- null: not reported
  online      boolean,
  door_state  text CHECK (door_state IN ('open', 'closed', 'held_open', 'forced')),
  lock_state  text CHECK (lock_state IN ('locked', 'unlocked')),
  tamper      boolean,
  status_text text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (camera_id, kind, external_id)
);

-- Access events: granted and denied, door opened, forced or held open, tamper and faults.
CREATE TABLE access_events (
  id           bigserial PRIMARY KEY,
  camera_id    uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL,
  category     text NOT NULL CHECK (category IN ('granted', 'denied', 'door', 'alarm', 'tamper', 'fault', 'other')),
  description  text NOT NULL,
  person       text,
  point        text,
  external_key text NOT NULL,
  UNIQUE (camera_id, external_key)
);
CREATE INDEX access_events_camera ON access_events (camera_id, occurred_at DESC);
CREATE INDEX access_events_time ON access_events (occurred_at);
