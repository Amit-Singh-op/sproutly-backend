-- Sproutly initial schema (build plan section 10)
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle CITEXT UNIQUE NOT NULL,
  login CITEXT UNIQUE NOT NULL,                      -- phone or email used for OTP
  display_name TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#2B2340',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  read_receipts BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  family UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (family);

CREATE TABLE otp_codes (
  login CITEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  push_token TEXT NOT NULL,
  app_version TEXT,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, push_token)
);

CREATE TABLE friendships (
  user_id UUID REFERENCES users ON DELETE CASCADE,
  friend_id UUID REFERENCES users ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE subscriptions (
  user_id UUID PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  product_id TEXT,
  status TEXT,
  period TEXT CHECK (period IN ('monthly','yearly')),
  trial BOOLEAN NOT NULL DEFAULT FALSE,
  current_period_end TIMESTAMPTZ,
  plus_since TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE entitlements (
  user_id UUID PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  plus_active BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE webhook_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE companions (
  user_id UUID PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Mo',
  palette TEXT NOT NULL DEFAULT 'mo',
  level INT NOT NULL DEFAULT 1,
  energy INT NOT NULL DEFAULT 0 CHECK (energy BETWEEN 0 AND 999),
  equipped_outfit TEXT NOT NULL DEFAULT 'none',
  signature_move TEXT NOT NULL DEFAULT 'wave',
  room_theme TEXT NOT NULL DEFAULT 'basic',
  streak INT NOT NULL DEFAULT 0,
  last_active_day DATE,
  shield_used_at DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('outfit','move','decor','theme')),
  name TEXT NOT NULL,
  plus_only BOOLEAN NOT NULL,
  sort INT NOT NULL
);
CREATE TABLE user_items (
  user_id UUID REFERENCES users ON DELETE CASCADE,
  item_id TEXT REFERENCES catalog_items,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE companion_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  action TEXT NOT NULL,
  gain INT NOT NULL,
  day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON companion_actions (user_id, day, action);
CREATE TABLE quests_daily (
  user_id UUID REFERENCES users ON DELETE CASCADE,
  day DATE NOT NULL,
  quest_key TEXT NOT NULL,
  title TEXT NOT NULL,
  target INT NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  reward INT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, day, quest_key)
);

CREATE TABLE chat_styles (
  user_id UUID PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  bubble TEXT NOT NULL,
  text_color TEXT NOT NULL,
  border TEXT NOT NULL,
  design TEXT NOT NULL CHECK (design IN ('solid','dashed','double','dotted','glow')),
  avatar_color TEXT NOT NULL,
  animation TEXT NOT NULL CHECK (animation IN ('none','pop','float','shimmer','wiggle')),
  wallpaper TEXT NOT NULL DEFAULT 'lavender',
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('dm','group')),
  dm_key TEXT UNIQUE,                                   -- "<minUserId>:<maxUserId>" for DMs
  title TEXT,
  description TEXT,
  avatar_color TEXT NOT NULL DEFAULT '#2F8A6C',
  category TEXT,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  plus_only BOOLEAN NOT NULL DEFAULT FALSE,
  max_members INT NOT NULL DEFAULT 100,
  owner_id UUID REFERENCES users,
  last_seq BIGINT NOT NULL DEFAULT 0,
  last_message_id UUID,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_sender_id UUID,
  min_delivered_seq BIGINT NOT NULL DEFAULT 0,
  min_read_seq BIGINT NOT NULL DEFAULT 0,
  member_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (is_public, category);

CREATE TABLE conversation_members (
  conversation_id UUID REFERENCES conversations ON DELETE CASCADE,
  user_id UUID REFERENCES users ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_seq BIGINT NOT NULL DEFAULT 0,
  read_seq BIGINT NOT NULL DEFAULT 0,
  muted_until TIMESTAMPTZ,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  read_only BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX ON conversation_members (user_id);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  sender_id UUID REFERENCES users,
  client_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','sticker','poll','system')),
  body TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  UNIQUE (conversation_id, seq),
  UNIQUE (sender_id, client_id)
);
CREATE INDEX ON messages (conversation_id, seq DESC);

CREATE TABLE poll_votes (
  message_id UUID REFERENCES messages ON DELETE CASCADE,
  user_id UUID REFERENCES users ON DELETE CASCADE,
  option_idx SMALLINT NOT NULL,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE showcase_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  caption TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  cheer_count INT NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON showcase_posts (created_at DESC);
CREATE TABLE showcase_cheers (
  post_id UUID REFERENCES showcase_posts ON DELETE CASCADE,
  user_id UUID REFERENCES users ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE showcase_feed (
  user_id UUID REFERENCES users ON DELETE CASCADE,
  post_id UUID REFERENCES showcase_posts ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX ON showcase_feed (user_id, created_at DESC);
CREATE TABLE weekly_top (week_start DATE PRIMARY KEY, post_id UUID REFERENCES showcase_posts ON DELETE SET NULL);

CREATE TABLE room_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE room_cheers (
  owner_id UUID REFERENCES users ON DELETE CASCADE,
  user_id UUID REFERENCES users ON DELETE CASCADE,
  day DATE NOT NULL,
  PRIMARY KEY (owner_id, user_id, day)
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reward_item_id TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID REFERENCES users ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','message','post')),
  target_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id)
);
