-- Pages holding sensitive settings (Camera passwords) ask for the user's password again: when it
-- was last confirmed in this session.
ALTER TABLE sessions ADD COLUMN password_confirmed_at timestamptz;
