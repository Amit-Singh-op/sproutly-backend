-- Who can message you privately: 'everyone' (anyone can start a chat, you can add them later) or 'friends'
-- (only friends; anyone else has to send a friend request first). Existing accounts keep today's behaviour.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dm_policy TEXT NOT NULL DEFAULT 'everyone' CHECK (dm_policy IN ('everyone', 'friends'));
