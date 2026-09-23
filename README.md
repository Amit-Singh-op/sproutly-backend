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

- Products `plus_monthly` ($5) and `plus_yearly` ($50), entitlement `plus`, offering `default`. The app uses our user id as `appUserID`.
- Webhook: point RevenueCat at `POST /v1/webhooks/revenuecat` with the Authorization header set to `REVENUECAT_WEBHOOK_AUTH`. Events are deduplicated by id and ordered by timestamp.
- `POST /v1/purchases/sync`: the app calls this right after a purchase/restore; the server reads the subscriber from RevenueCat's REST API (needs `REVENUECAT_SECRET_KEY`) so Plus unlocks without waiting for the webhook.
- Downgrade rules (doc section 4) run in the `entitlement-sync` job. An hourly job also expires Plus if an EXPIRATION webhook was ever lost.

## Not configured by default

- **OTP delivery:** email via `SMTP_URL`. There is no SMS provider; in production, phone sign-in returns `OTP_UNAVAILABLE`. In development the code is logged and returned as `devCode` (`OTP_DEV_CODE`).
- **Push:** set `FCM_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`; otherwise pushes are logged, not sent.
