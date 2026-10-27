-- Webhook notification channels (Microsoft Teams, Slack, Google Chat, any HTTPS endpoint).
-- The webhook address is a secret, so it is kept encrypted, apart from the shown config.
ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_type_check;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_type_check CHECK (type IN ('email', 'webhook'));
ALTER TABLE notification_channels ADD COLUMN secret_encrypted text;
