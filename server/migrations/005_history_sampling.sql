-- When a camera's last history row was written: with many cameras, routine successful checks
-- are kept at most once per historyIntervalMinutes (failures and changes are always kept).
ALTER TABLE camera_status ADD COLUMN last_history_at timestamptz;

-- Usage history of successful checks, readable from the index alone (AI forecasts read 14 days
-- for every camera; with 20 000 cameras this is ~9x faster than visiting the table).
CREATE INDEX storage_checks_usage_idx ON storage_checks (camera_id, checked_at)
  INCLUDE (used_percentage, used_bytes, total_bytes)
  WHERE outcome = 'success' AND used_percentage IS NOT NULL;
