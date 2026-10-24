-- Camera priority: cameras in critical areas are listed first and their problems are raised as critical.
ALTER TABLE cameras ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical', 'normal'));
CREATE INDEX cameras_priority_idx ON cameras (organization_id) WHERE priority = 'critical' AND deleted_at IS NULL;
