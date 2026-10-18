-- Initial schema for the CCTV storage monitor.
-- Current state (cameras, camera_status, storage_devices, alerts) is kept separate
-- from history (storage_checks, connection_events, alert_events, audit_logs).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users & roles
CREATE TABLE roles (
  name         text PRIMARY KEY,
  description  text NOT NULL,
  permissions  text[] NOT NULL
);

INSERT INTO roles (name, description, permissions) VALUES
  ('admin', 'Full access: cameras, credentials, settings and users',
    ARRAY['cameras:read','cameras:write','cameras:check','alerts:read','alerts:manage',
          'settings:read','settings:write','users:manage','audit:read']),
  ('operator', 'Monitor cameras, run checks and manage alerts',
    ARRAY['cameras:read','cameras:check','alerts:read','alerts:manage','settings:read']),
  ('viewer', 'Read-only access to dashboards and alerts',
    ARRAY['cameras:read','alerts:read']);

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL,
  display_name        text,
  password_hash       text NOT NULL,
  role                text NOT NULL REFERENCES roles(name),
  is_active           boolean NOT NULL DEFAULT true,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_unique ON users (lower(username));

CREATE TABLE sessions (
  id            text PRIMARY KEY,          -- SHA-256 of the session token, never the token itself
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- brands
CREATE TABLE camera_brands (
  key                 text PRIMARY KEY,
  display_name        text NOT NULL,
  support_status      text NOT NULL CHECK (support_status IN ('supported','unverified','planned')),
  auth_methods        text[] NOT NULL DEFAULT '{}',
  default_http_port   integer,
  default_https_port  integer,
  capabilities        text[] NOT NULL DEFAULT '{}',
  notes               text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- cameras
CREATE TABLE cameras (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  host                text NOT NULL,       -- normalised (lower-case, no brackets)
  port                integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol            text NOT NULL CHECK (protocol IN ('http','https')),
  brand_key           text NOT NULL REFERENCES camera_brands(key),
  model               text,
  location            text,
  monitoring_enabled  boolean NOT NULL DEFAULT true,
  warning_threshold   numeric(5,2) CHECK (warning_threshold BETWEEN 1 AND 100),
  critical_threshold  numeric(5,2) CHECK (critical_threshold BETWEEN 1 AND 100),
  ca_certificate      text,                -- optional PEM to trust a camera's self-signed certificate
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,         -- soft delete keeps history and alerts
  CHECK (warning_threshold IS NULL OR critical_threshold IS NULL OR warning_threshold < critical_threshold)
);
CREATE UNIQUE INDEX cameras_unique_endpoint ON cameras (brand_key, host, port) WHERE deleted_at IS NULL;
CREATE INDEX cameras_active_idx ON cameras (monitoring_enabled) WHERE deleted_at IS NULL;

CREATE TABLE camera_credentials (
  camera_id           uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  username            text NOT NULL,
  password_encrypted  text NOT NULL,       -- AES-256-GCM: v<keyVersion>:<iv>:<tag>:<ciphertext> (base64)
  key_version         integer NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Current, frequently-read state for the dashboard (one row per camera).
CREATE TABLE camera_status (
  camera_id                 uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  connection_status         text NOT NULL DEFAULT 'unknown' CHECK (connection_status IN ('unknown','online','offline')),
  storage_health            text NOT NULL DEFAULT 'unknown' CHECK (storage_health IN ('unknown','healthy','warning','critical')),
  last_error_code           text,
  last_error_message        text,
  last_attempt_at           timestamptz,
  last_success_at           timestamptz,
  consecutive_failures      integer NOT NULL DEFAULT 0,
  consecutive_auth_failures integer NOT NULL DEFAULT 0,
  total_bytes               bigint,
  used_bytes                bigint,
  free_bytes                bigint,
  used_percentage           numeric(6,2),
  device_model              text,
  device_serial             text,
  firmware_version          text,
  device_info_at            timestamptz,
  next_check_at             timestamptz,
  check_lock_until          timestamptz,
  check_lock_owner          text,
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX camera_status_due_idx ON camera_status (next_check_at);

CREATE TABLE storage_devices (
  id               bigserial PRIMARY KEY,
  camera_id        uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  vendor_id        text NOT NULL,
  name             text,
  type             text,
  health_status    text NOT NULL,          -- normalised: healthy | degraded | unhealthy | unknown
  raw_status       text,                   -- status string as reported by the camera
  total_bytes      bigint,
  free_bytes       bigint,
  used_bytes       bigint,
  used_percentage  numeric(6,2),
  writable         boolean,
  property         text,
  format_type      text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (camera_id, vendor_id)
);

-- ---------------------------------------------------------------- history
CREATE TABLE storage_checks (
  id               bigserial PRIMARY KEY,
  camera_id        uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  checked_at       timestamptz NOT NULL DEFAULT now(),
  trigger          text NOT NULL CHECK (trigger IN ('scheduled','manual')),
  outcome          text NOT NULL,          -- success or an error code
  duration_ms      integer NOT NULL,
  attempts         integer NOT NULL,
  storage_health   text,
  total_bytes      bigint,
  used_bytes       bigint,
  free_bytes       bigint,
  used_percentage  numeric(6,2),
  devices          jsonb,
  error_message    text
);
CREATE INDEX storage_checks_camera_time_idx ON storage_checks (camera_id, checked_at DESC);
CREATE INDEX storage_checks_time_idx ON storage_checks (checked_at);

CREATE TABLE connection_events (
  id           bigserial PRIMARY KEY,
  camera_id    uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  reason       text
);
CREATE INDEX connection_events_camera_idx ON connection_events (camera_id, occurred_at DESC);

-- ---------------------------------------------------------------- alerts
CREATE TABLE alerts (
  id                bigserial PRIMARY KEY,
  camera_id         uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  type              text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('info','warning','critical')),
  status            text NOT NULL CHECK (status IN ('active','acknowledged','resolved')),
  title             text NOT NULL,
  description       text NOT NULL,
  context           jsonb NOT NULL DEFAULT '{}',
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  occurrence_count  integer NOT NULL DEFAULT 1,
  acknowledged_at   timestamptz,
  acknowledged_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_note   text
);
-- At most one open alert per camera and type: recurring conditions update it instead of duplicating.
CREATE UNIQUE INDEX alerts_one_open_per_type ON alerts (camera_id, type) WHERE status <> 'resolved';
CREATE INDEX alerts_status_idx ON alerts (status, last_seen_at DESC);

CREATE TABLE alert_events (
  id             bigserial PRIMARY KEY,
  alert_id       bigint NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  event_type     text NOT NULL,            -- opened | escalated | deescalated | acknowledged | resolved | auto_resolved
  severity       text,
  message        text,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, created_at);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notification_channels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                text NOT NULL CHECK (type IN ('email')),
  name                text NOT NULL,
  enabled             boolean NOT NULL DEFAULT true,
  config              jsonb NOT NULL DEFAULT '{}',   -- non-secret config only (e.g. recipients)
  min_severity        text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info','warning','critical')),
  cooldown_minutes    integer NOT NULL DEFAULT 60 CHECK (cooldown_minutes >= 0),
  notify_on_recovery  boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_deliveries (
  id          bigserial PRIMARY KEY,
  channel_id  uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  alert_id    bigint REFERENCES alerts(id) ON DELETE CASCADE,
  event       text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_alert_idx ON notification_deliveries (alert_id, channel_id, created_at DESC);

-- ---------------------------------------------------------------- audit & settings
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_username text,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  details        jsonb NOT NULL DEFAULT '{}',
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_time_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
