-- Per member: live view, recordings (playback and clip export) and camera actions (refresh,
-- ping, test connection, maintenance) can each be turned off. They never go beyond the role
-- (a Viewer has no live view or camera actions). Where on, they apply to the cameras the member
-- may open (camera_access: all, or the chosen locations and cameras).
ALTER TABLE organization_members
  ADD COLUMN can_live        boolean NOT NULL DEFAULT true,
  ADD COLUMN can_recordings  boolean NOT NULL DEFAULT true,
  ADD COLUMN can_actions     boolean NOT NULL DEFAULT true;
