import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logout, refresh, signInWithProvider, startOtp, verifyOtp } from '../../core/auth.js';
import { deviceBanned, deviceIdOf, event } from '../../core/moderation.js';
import { AppError } from '../../lib/errors.js';

const Login = z.object({ phoneOrEmail: z.string().min(3).max(200) });
const Verify = Login.extend({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), displayName: z.string().max(40).optional(), timezone: z.string().max(64).optional() });
const Provider = z.object({ idToken: z.string().min(10), displayName: z.string().max(40).optional(), timezone: z.string().max(64).optional() });
const Refresh = z.object({ refreshToken: z.string().min(10) });
const Logout = Refresh.extend({ pushToken: z.string().min(10).max(4096).optional() });

/** An app install an account was banned on can't sign in or create a new account (any email). */
async function deviceGate(req: FastifyRequest) {
  const deviceId = deviceIdOf(req.headers['x-device-id']);
  if (await deviceBanned(deviceId)) {
    await event({ userId: null, kind: 'device_blocked', actor: 'system', details: { deviceId, path: req.url } }).catch(() => {});
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This device can’t be used with Sproutly because of an earlier ban. If you think this is a mistake, contact support.');
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { if (/\/auth\/(otp\/(start|verify)|apple|google)$/.test(req.url.split('?')[0] ?? '')) await deviceGate(req); });
  app.post('/auth/otp/start', async (req) => startOtp(Login.parse(req.body).phoneOrEmail));
  app.post('/auth/otp/verify', async (req) => {
    const b = Verify.parse(req.body);
    return verifyOtp(b.phoneOrEmail, b.code, b.displayName, b.timezone);
  });
  app.post('/auth/apple', async (req) => {
    const b = Provider.parse(req.body);
    return signInWithProvider('apple', b.idToken, b.displayName, b.timezone);
  });
  app.post('/auth/google', async (req) => {
    const b = Provider.parse(req.body);
    return signInWithProvider('google', b.idToken, b.displayName, b.timezone);
  });
  app.post('/auth/refresh', async (req) => refresh(Refresh.parse(req.body).refreshToken));
  app.post('/auth/logout', async (req) => {
    const b = Logout.parse(req.body);
    await logout(b.refreshToken, b.pushToken);
    return { ok: true };
  });
}
