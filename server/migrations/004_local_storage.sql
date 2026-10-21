-- Cameras that record elsewhere (e.g. to an NVR) and have no SD card or local storage by design.
-- Such cameras are still checked for reachability, but storage and recording alerts do not apply.
ALTER TABLE cameras ADD COLUMN local_storage boolean NOT NULL DEFAULT true;
