-- Invite-only access: every account starts unapproved; an admin flips users.approved to let them in.
--   Pending:  SELECT id, login, display_name, created_at FROM users WHERE NOT approved ORDER BY created_at;
--   Approve:  UPDATE users SET approved = true, approved_at = now() WHERE login = 'person@example.com';
--   Revoke:   UPDATE users SET approved = false WHERE login = 'person@example.com';
--   Open to everyone (skip approval entirely):  UPDATE app_config SET value = 'false' WHERE key = 'approval_required';
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_pending ON users (created_at) WHERE NOT approved;

INSERT INTO app_config (key, value) VALUES ('approval_required', 'true') ON CONFLICT (key) DO NOTHING;
