-- The store-review account (Google Play / App Store reviewers) always has Plus. New sign-ins of that account get it
-- automatically (src/core/review.ts); this grants it to the account if it already exists.
INSERT INTO subscriptions (user_id, product_id, status, period, trial, current_period_end, plus_since, store, will_renew, updated_at)
SELECT id, 'review_plus', 'active', 'yearly', FALSE, now() + interval '10 years', now(), 'review', TRUE, now()
  FROM users WHERE login = 'playreview@sproutly.app'
ON CONFLICT (user_id) DO UPDATE SET status = 'active', period = 'yearly',
  current_period_end = GREATEST(COALESCE(subscriptions.current_period_end, now()), now() + interval '1 year'),
  plus_since = COALESCE(subscriptions.plus_since, now()), billing_issue_at = NULL, updated_at = now();

INSERT INTO entitlements (user_id, plus_active, updated_at)
SELECT id, TRUE, now() FROM users WHERE login = 'playreview@sproutly.app'
ON CONFLICT (user_id) DO UPDATE SET plus_active = TRUE, updated_at = now();

UPDATE users SET approved = TRUE, approved_at = COALESCE(approved_at, now()) WHERE login = 'playreview@sproutly.app';
