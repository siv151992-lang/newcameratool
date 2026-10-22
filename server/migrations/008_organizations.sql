-- Organizations: every camera, notification channel, organization setting and audit entry belongs to
-- an organization, and people reach it through a membership with a role. Existing data moves into
-- one organization so the application keeps working unchanged after the upgrade.

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_name_unique ON organizations (lower(name)) WHERE is_active;

-- Roles are the existing ones, now held per organization: admin = Org Admin; operator and viewer = members.
CREATE TABLE organization_members (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL REFERENCES roles(name),
  invited_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

-- Per-organization settings (monitoring thresholds and detection, AI Mode); server-wide ones stay in app_settings.
CREATE TABLE organization_settings (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key              text NOT NULL,
  value            jsonb NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, key)
);

-- Users: an email for invitations and Google/Zoho sign-in; the role moves to memberships; a password
-- becomes optional (accounts that only sign in with Google or Zoho); the system administrator manages
-- what belongs to the server (organizations, brand integrations, camera networks, worker capacity).
ALTER TABLE users
  ADD COLUMN email text,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN is_system_admin boolean NOT NULL DEFAULT false,
  ALTER COLUMN password_hash DROP NOT NULL,
  ALTER COLUMN role DROP NOT NULL;
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE sessions ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE cameras ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE notification_channels ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE audit_logs ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

-- Move existing data into one organization (only when there is something to move).
DO $$
DECLARE org uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM cameras) THEN
    INSERT INTO organizations (name, created_by)
    VALUES ('My organization', (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1))
    RETURNING id INTO org;
    UPDATE cameras SET organization_id = org;
    UPDATE notification_channels SET organization_id = org;
    UPDATE audit_logs SET organization_id = org;
    INSERT INTO organization_members (organization_id, user_id, role, joined_at)
      SELECT org, id, role, created_at FROM users WHERE role IS NOT NULL;
    UPDATE sessions SET organization_id = org;
    INSERT INTO organization_settings (organization_id, key, value)
      SELECT org, key, value FROM app_settings WHERE key IN ('monitoring', 'ai');
    -- Today's administrators managed the whole server, so they keep doing so.
    UPDATE users SET is_system_admin = true WHERE role = 'admin';
  END IF;
END $$;

ALTER TABLE cameras ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE notification_channels ALTER COLUMN organization_id SET NOT NULL;

-- The same camera address may be registered by two organizations.
DROP INDEX cameras_unique_endpoint;
CREATE UNIQUE INDEX cameras_unique_endpoint ON cameras (organization_id, brand_key, host, port) WHERE deleted_at IS NULL;
CREATE INDEX cameras_organization_idx ON cameras (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX notification_channels_organization_idx ON notification_channels (organization_id);
CREATE INDEX audit_logs_organization_time_idx ON audit_logs (organization_id, created_at DESC);
