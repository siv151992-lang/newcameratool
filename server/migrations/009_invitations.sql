-- Invitations into an organization, and one-time email links (verify an email address, reset a password).
-- Only SHA-256 hashes of the link tokens are stored.

CREATE TABLE invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email            text NOT NULL CHECK (email = lower(email)),
  role             text NOT NULL REFERENCES roles(name),
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz NOT NULL DEFAULT now(),
  send_count       integer NOT NULL DEFAULT 1,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users(id) ON DELETE SET NULL
);
-- One open invitation per organization and address: inviting again re-sends it with a new link.
CREATE UNIQUE INDEX invitations_open_unique ON invitations (organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_email_idx ON invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, purpose);

-- Accounts created with "Create account" cannot sign in until their email address is confirmed.
ALTER TABLE users ADD COLUMN pending_verification boolean NOT NULL DEFAULT false;
