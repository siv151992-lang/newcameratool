-- NVRs: a device can be a camera or an NVR. An NVR's channels (the cameras recorded on it) are kept
-- with whether each has video and is recording, read on every check.
ALTER TABLE cameras ADD COLUMN device_type text NOT NULL DEFAULT 'camera' CHECK (device_type IN ('camera', 'nvr'));
CREATE INDEX cameras_device_type_idx ON cameras (organization_id, device_type) WHERE deleted_at IS NULL;

CREATE TABLE nvr_channels (
  camera_id   uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  channel     integer NOT NULL CHECK (channel >= 1),
  name        text,
  online      boolean,
  recording   text CHECK (recording IN ('recording', 'idle', 'error', 'unknown')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (camera_id, channel)
);

ALTER TABLE camera_status ADD COLUMN channels_error text, ADD COLUMN channels_at timestamptz;
