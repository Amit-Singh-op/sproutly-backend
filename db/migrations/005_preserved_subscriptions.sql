-- Preserve active subscriptions across account deletion so users can rejoin before expiry
CREATE TABLE IF NOT EXISTS preserved_subscriptions (
  login TEXT PRIMARY KEY,
  original_user_id UUID,
  product_id TEXT,
  status TEXT,
  period TEXT CHECK (period IN ('monthly','yearly')),
  trial BOOLEAN NOT NULL DEFAULT FALSE,
  current_period_end TIMESTAMPTZ,
  plus_since TIMESTAMPTZ,
  store TEXT,
  will_renew BOOLEAN NOT NULL DEFAULT TRUE,
  billing_issue_at TIMESTAMPTZ,
  last_event_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
