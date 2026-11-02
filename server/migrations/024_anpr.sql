-- ANPR (number plate) cameras: each plate the camera reads, as it reads it (over the camera's
-- event stream), counted as a vehicle entering or leaving by the camera's role at the gate.
ALTER TABLE cameras ADD COLUMN anpr_role text CHECK (anpr_role IN ('entry', 'exit', 'both', 'both_reversed'));

CREATE TABLE anpr_reads (
  id          bigserial PRIMARY KEY,
  camera_id   uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Upper case letters and digits only, for counting and search; plate_text as the camera read it.
  plate       text NOT NULL,
  plate_text  text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('in', 'out', 'unknown')),
  confidence  integer,
  vehicle_type text,
  vehicle_color text,
  -- On the organization's blocklist or allowlist when read (null: on neither).
  list_match  text CHECK (list_match IN ('block', 'allow'))
);
CREATE INDEX anpr_reads_camera_time ON anpr_reads (camera_id, occurred_at DESC);
CREATE INDEX anpr_reads_time ON anpr_reads (occurred_at);
CREATE INDEX anpr_reads_plate ON anpr_reads (plate, occurred_at DESC);

-- The camera's picture of the vehicle (or its plate), kept with the read.
CREATE TABLE anpr_snapshots (
  read_id    bigint PRIMARY KEY REFERENCES anpr_reads(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  jpeg       bytea NOT NULL
);

-- Blocklist and allowlist, per organization.
CREATE TABLE anpr_lists (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plate           text NOT NULL,
  list            text NOT NULL CHECK (list IN ('block', 'allow')),
  note            text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, plate)
);

CREATE TABLE anpr_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- Plates are personal data: reads (and their pictures) are deleted after this many days.
  retention_days  integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  keep_snapshots  boolean NOT NULL DEFAULT true,
  -- Alert when a vehicle not on the allowlist enters.
  unknown_vehicle_alerts boolean NOT NULL DEFAULT false
);
