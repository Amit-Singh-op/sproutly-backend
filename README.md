# Sproutly backend

Server for the Sproutly app, built from `sproutly/docs/BACKEND.md`: REST API (Fastify), realtime (Socket.IO), and a BullMQ worker, over PostgreSQL + Redis.

## Layout

```
src/
  api/        Fastify app + routes (/v1)          -> deploy as "api"
  realtime/   Socket.IO server                     -> deploy as "realtime"
  worker/     BullMQ jobs + cron                   -> deploy as "worker"
  core/       business logic shared by all three
  shared/     types + rules shared with the app (types.ts mirrors sproutly/src/data/types.ts)
  lib/        db-agnostic helpers (jwt, redis, rate limits, presence, queues, emitter)
  db/         pool, migration runner, seed
db/migrations 001_init.sql (the spec schema) + 002_payments.sql
```

The doc suggests a multi-package repo (`services/*`, `packages/*`). This is one package with three entrypoints instead: same split at deploy time, less tooling. One Docker image; the command picks the service.

## Setup (when you're ready)

1. `cp .env.example .env` and fill in secrets (JWT secrets 32+ chars, `REVENUECAT_WEBHOOK_AUTH`, `REVENUECAT_SECRET_KEY`).
2. Start Postgres 15+ and Redis 7 (`docker compose up -d db redis` does both locally).
3. `npm run migrate && npm run seed`
4. `npm run dev` (all three services in one process), or `dev:api` / `dev:realtime` / `dev:worker` separately.
5. In the app's `.env`: `EXPO_PUBLIC_API_URL=http://<host>:4000/v1`, `EXPO_PUBLIC_RT_URL=http://<host>:4001`, plus the RevenueCat public keys.

## Payments (RevenueCat)

**Plus is "Coming soon".** The app (from 0.1.5) has `PLUS_ON_SALE = false` in `src/content.ts`: no prices, trials or restore are shown, and the app ignores `plus_enabled` in `app_config`. Turning that flag on in the database does nothing until a new app build ships with `PLUS_ON_SALE = true`.

**Giving Plus to someone by hand** (works while Plus is coming soon; they get every Plus feature):

```sql
-- forever (until you switch it off)
INSERT INTO entitlements (user_id, plus_active, updated_at)
SELECT id, TRUE, now() FROM users WHERE login = 'their@email.com'
ON CONFLICT (user_id) DO UPDATE SET plus_active = TRUE, updated_at = now();

-- or for a set time: also add a subscription row; the hourly expiry job ends it a day after the date
INSERT INTO subscriptions (user_id, product_id, status, period, trial, current_period_end, plus_since, store, will_renew, updated_at)
SELECT id, 'manual_plus', 'active', 'monthly', FALSE, now() + interval '30 days', now(), 'manual', FALSE, now() FROM users WHERE login = 'their@email.com'
ON CONFLICT (user_id) DO UPDATE SET status = 'active', current_period_end = EXCLUDED.current_period_end, store = 'manual', updated_at = now();

-- if they lost Plus before, let them write in Plus-only groups again (the upgrade job does this for store purchases)
UPDATE conversation_members m SET read_only = FALSE FROM conversations c
 WHERE c.id = m.conversation_id AND c.plus_only AND m.user_id = (SELECT id FROM users WHERE login = 'their@email.com');

-- take it away
UPDATE entitlements SET plus_active = FALSE, updated_at = now() WHERE user_id = (SELECT id FROM users WHERE login = 'their@email.com');
```

The app picks it up within about a minute (Plus is cached in Redis for 60 s), the next time it loads their profile. `/purchases/sync` keeps a hand-made grant (no subscription row, or store `manual`) even though RevenueCat has no purchase for that person. Switching rows by hand skips the upgrade/downgrade job (hence the `read_only` line above; taking Plus away by hand leaves their Plus outfit/character on until they change it).

- Products `plus_monthly` ($5) and `plus_yearly` ($50), entitlement `plus`, offering `default`. The app uses our user id as `appUserID`.
- Webhook: point RevenueCat at `POST /v1/webhooks/revenuecat` with the Authorization header set to `REVENUECAT_WEBHOOK_AUTH`. Events are deduplicated by id and ordered by timestamp.
- `POST /v1/purchases/sync`: the app calls this right after a purchase/restore; the server reads the subscriber from RevenueCat's REST API (needs `REVENUECAT_SECRET_KEY`) so Plus unlocks without waiting for the webhook.
- Downgrade rules (doc section 4) run in the `entitlement-sync` job. An hourly job also expires Plus if an EXPIRATION webhook was ever lost.

## Not configured by default

- **OTP delivery:** email via Gmail SMTP (`GMAIL_USER` + `GMAIL_APP_PASSWORD`). There is no SMS provider; in production, phone sign-in returns `OTP_UNAVAILABLE`. In development the code is logged and returned as `devCode` (`OTP_DEV_CODE`).
- **Push:** set `FCM_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`; otherwise pushes are logged, not sent.
