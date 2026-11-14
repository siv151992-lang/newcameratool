-- Which cameras each member may see. 'all' (the default) or 'limited' to the locations (sites)
-- and cameras listed in member_camera_access. Org Admins always see every camera.
ALTER TABLE organization_members
  ADD COLUMN camera_access text NOT NULL DEFAULT 'all' CHECK (camera_access IN ('all', 'limited'));

CREATE TABLE member_camera_access (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  camera_id       uuid REFERENCES cameras(id) ON DELETE CASCADE,
  location        text,
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE,
  CHECK ((camera_id IS NULL) <> (location IS NULL))
);
CREATE UNIQUE INDEX member_camera_access_camera ON member_camera_access (organization_id, user_id, camera_id) WHERE camera_id IS NOT NULL;
CREATE UNIQUE INDEX member_camera_access_location ON member_camera_access (organization_id, user_id, location) WHERE location IS NOT NULL;
