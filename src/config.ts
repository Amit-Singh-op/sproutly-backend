import { existsSync } from 'node:fs';
import { z } from 'zod';

// Local development reads .env; hosts like Render inject real env vars and have no file. Existing vars win.
if (existsSync('.env')) process.loadEnvFile('.env');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  OTP_DEV_CODE: z.string().regex(/^\d{6}$/).optional(),
  // Store review: ONE email that signs in with a fixed code (reviewers can't receive our emails). Off unless both set.
  REVIEW_EMAIL: z.string().email().optional(),
  REVIEW_CODE: z.string().regex(/^\d{6}$/).optional(),
  // Sign-in emails go through Gmail SMTP. The password is a Google App Password (needs 2-Step Verification).
  GMAIL_USER: z.string().email().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  // Resend API key (re_...). When set, sign-in emails go over HTTPS instead of SMTP (Render free tier blocks SMTP).
  RESEND_API_KEY: z.string().optional(),
  // With Resend: an address on your verified domain. With Gmail SMTP: defaults to "Sproutly <GMAIL_USER>".
  OTP_FROM: z.string().optional(),
  // Where replies to sign-in emails go (e.g. a support inbox). Optional.
  OTP_REPLY_TO: z.string().email().optional(),
  // Public https URL of a square PNG logo (about 112x112) for emails. Without it, emails show a 🌱 badge.
  EMAIL_LOGO_URL: z.string().url().optional(),
  REVENUECAT_WEBHOOK_AUTH: z.string().min(8),
  REVENUECAT_SECRET_KEY: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  APPLE_AUDIENCE: z.string().default('ai.sproutly.app'),
  GOOGLE_AUDIENCES: z.string().default(''),
  // Render (and most hosts) tell each service which port to bind via PORT; it wins when set.
  PORT: z.coerce.number().optional(),
  API_PORT: z.coerce.number().default(4000),
  RT_PORT: z.coerce.number().default(4001),
  CORS_ORIGINS: z.string().default('*'),
});

// Blank values (e.g. "GMAIL_USER=") mean unset, not an invalid email/url.
const parsed = Env.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const e = parsed.data;

export const config = {
  ...e,
  apiPort: e.PORT ?? e.API_PORT,
  rtPort: e.PORT ?? e.RT_PORT,
  isProd: e.NODE_ENV === 'production',
  // The dev OTP is never honoured in production, even if set.
  otpDevCode: e.NODE_ENV === 'production' ? undefined : e.OTP_DEV_CODE,
  googleAudiences: e.GOOGLE_AUDIENCES.split(',').map((s) => s.trim()).filter(Boolean),
  accessTtlS: 15 * 60,
  refreshTtlS: 30 * 24 * 60 * 60,
};
