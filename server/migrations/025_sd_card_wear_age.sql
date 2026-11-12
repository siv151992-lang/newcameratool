-- SD card wear (how much of its expected life is used, as the camera reports it: Axis WearLevel)
-- and since when the card in a camera has been in use (first seen, or when it was replaced).
ALTER TABLE storage_devices ADD COLUMN wear_percent numeric(6,1);
ALTER TABLE camera_status ADD COLUMN card_installed_at timestamptz;
