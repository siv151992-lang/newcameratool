-- Sign in with Google and Zoho: the provider accounts linked to each user, and sign-ins in progress.

CREATE TABLE user_identities (
  provider     text NOT NULL CHECK (provider IN ('google', 'zoho')),
  -- The provider's stable account id ("sub"); the email can change, this does not.
  subject      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- One row per redirect to a provider, used once by the callback (state, PKCE verifier, nonce).
CREATE TABLE oauth_states (
  state_hash       text PRIMARY KEY,
  provider         text NOT NULL,
  code_verifier    text NOT NULL,
  nonce            text NOT NULL,
  -- Connecting a provider to a signed-in account (Settings → Account), or null to sign in.
  link_user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  invitation_token text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
