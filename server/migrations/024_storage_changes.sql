-- SD card replaced or formatted (its size changed, or its recordings suddenly dropped), and
-- an SD card stuck formatting, repairing or initialising.
ALTER TABLE camera_status
  ADD COLUMN storage_changed_at     timestamptz,
  ADD COLUMN storage_change         text,
  ADD COLUMN storage_degraded_since timestamptz;
