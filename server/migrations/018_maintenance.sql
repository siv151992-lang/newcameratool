-- Maintenance mode: until this time the camera is checked as usual but opens no new alerts and
-- sends no notifications (planned work, a camera being replaced).
ALTER TABLE cameras ADD COLUMN maintenance_until timestamptz, ADD COLUMN maintenance_note text;
