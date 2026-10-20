-- Brand integrations: built-in adapters (Mode B) and administrator-configured API integrations
-- (Mode A) share camera_brands. Existing brands become enabled built-in integrations; no camera,
-- history or alert row is touched.
ALTER TABLE camera_brands
  ADD COLUMN integration_type   text NOT NULL DEFAULT 'builtin' CHECK (integration_type IN ('builtin','configurable')),
  ADD COLUMN status             text NOT NULL DEFAULT 'enabled' CHECK (status IN ('draft','tested','enabled','disabled')),
  ADD COLUMN manufacturer       text,
  ADD COLUMN description        text,
  ADD COLUMN supported_models   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN default_protocol   text NOT NULL DEFAULT 'http' CHECK (default_protocol IN ('http','https')),
  ADD COLUMN integration_version text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN compatibility_notes text,
  ADD COLUMN active_version_id  uuid,
  ADD COLUMN last_test_at       timestamptz,
  ADD COLUMN last_test_ok       boolean,
  ADD COLUMN last_success_at    timestamptz,     -- last successful API test or storage retrieval
  ADD COLUMN created_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN deleted_at         timestamptz;     -- configurable integrations still referenced by removed cameras

-- Existing brands were created when they were first registered.
UPDATE camera_brands SET created_at = updated_at;

CREATE UNIQUE INDEX camera_brands_display_name_unique ON camera_brands (lower(display_name)) WHERE deleted_at IS NULL;

-- Every saved configuration of a configurable integration. Configurations hold no secrets: camera
-- credentials (password, API key or token) stay encrypted in camera_credentials.
CREATE TABLE brand_integration_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key     text NOT NULL REFERENCES camera_brands(key) ON DELETE CASCADE,
  version       integer NOT NULL,
  config        jsonb NOT NULL,
  test_status   text NOT NULL DEFAULT 'untested' CHECK (test_status IN ('untested','passed','failed')),
  tested_at     timestamptz,
  change_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (brand_key, version)
);

ALTER TABLE camera_brands
  ADD CONSTRAINT camera_brands_active_version_fk FOREIGN KEY (active_version_id) REFERENCES brand_integration_versions(id) ON DELETE SET NULL;

-- Result of each backend API test. Only sanitised diagnostics are stored, never credentials.
CREATE TABLE brand_integration_tests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key     text NOT NULL REFERENCES camera_brands(key) ON DELETE CASCADE,
  version_id    uuid REFERENCES brand_integration_versions(id) ON DELETE SET NULL,
  target_host   text NOT NULL,
  target_port   integer NOT NULL,
  camera_id     uuid REFERENCES cameras(id) ON DELETE SET NULL,
  ok            boolean NOT NULL,
  outcome       text NOT NULL,
  message       text NOT NULL,
  steps         jsonb NOT NULL DEFAULT '[]',
  storage       jsonb,
  duration_ms   integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX brand_integration_tests_brand_idx ON brand_integration_tests (brand_key, created_at DESC);

-- Which integration version produced each storage check.
ALTER TABLE storage_checks ADD COLUMN integration_version text;
