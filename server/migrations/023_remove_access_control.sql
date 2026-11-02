-- Access control was removed. On databases that had it (022_access_control): the access systems
-- added are removed (like a removed camera), their open alerts resolved, and the access tables and
-- columns dropped. On others this does nothing.
UPDATE alerts SET status = 'resolved', resolved_at = now(), resolution_note = 'Access control removed'
WHERE status <> 'resolved' AND camera_id IN (SELECT id FROM cameras WHERE device_type = 'access');
UPDATE cameras SET deleted_at = COALESCE(deleted_at, now()), monitoring_enabled = false, device_type = 'camera'
WHERE device_type = 'access';

DROP TABLE IF EXISTS access_events;
DROP TABLE IF EXISTS access_points;
ALTER TABLE camera_status
  DROP COLUMN IF EXISTS access_error,
  DROP COLUMN IF EXISTS access_at,
  DROP COLUMN IF EXISTS access_events_after;
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_device_type_check;
ALTER TABLE cameras ADD CONSTRAINT cameras_device_type_check CHECK (device_type IN ('camera', 'nvr'));
