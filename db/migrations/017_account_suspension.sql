-- Account suspension (moderation). An admin suspends someone with:
--   UPDATE users SET suspended_at = now(), suspended_reason = 'Repeated harassment in chats' WHERE login = 'someone@mail.com';
-- and lifts it with:
--   UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE login = 'someone@mail.com';
-- It takes effect within ~20 s: every request, sign-in, token refresh and realtime connection is refused with
-- 403 ACCOUNT_SUSPENDED (the app then signs out and shows the reason).
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
