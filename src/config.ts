import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  OTP_DEV_CODE: z.string().regex(/^\d{6}$/).optional(),
  SMTP_URL: z.string().optional(),
  OTP_FROM: z.string().default('Sproutly <no-reply@sproutly.app>'),
  REVENUECAT_WEBHOOK_AUTH: z.string().min(8),
  REVENUECAT_SECRET_KEY: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  APPLE_AUDIENCE: z.string().default('ai.sproutly.app'),
  GOOGLE_AUDIENCES: z.string().default(''),
  API_PORT: z.coerce.number().default(4000),
  RT_PORT: z.coerce.number().default(4001),
  CORS_ORIGINS: z.string().default('*'),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const e = parsed.data;

export const config = {
  ...e,
  isProd: e.NODE_ENV === 'production',
  // The dev OTP is never honoured in production, even if set.
  otpDevCode: e.NODE_ENV === 'production' ? undefined : e.OTP_DEV_CODE,
  googleAudiences: e.GOOGLE_AUDIENCES.split(',').map((s) => s.trim()).filter(Boolean),
  accessTtlS: 15 * 60,
  refreshTtlS: 30 * 24 * 60 * 60,
};
