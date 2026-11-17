-- Indexes for the links checked when a user or notification channel is deleted. Accounts are
-- deleted (by their owner, and unverified sign-ups daily); each delete looks for rows that still
-- point at the account, which without these reads the whole audit log and alert history (tables
-- that grow for as long as they are kept). Partial: most rows have no person (the system acted).
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alert_events_actor_idx ON alert_events (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_acknowledged_by_idx ON alerts (acknowledged_by) WHERE acknowledged_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_resolved_by_idx ON alerts (resolved_by) WHERE resolved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_deliveries_channel_idx ON notification_deliveries (channel_id);
