import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logout, refresh, signInWithProvider, startOtp, verifyOtp } from '../../core/auth.js';

const Login = z.object({ phoneOrEmail: z.string().min(3).max(200) });
const Verify = Login.extend({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), displayName: z.string().max(40).optional(), timezone: z.string().max(64).optional() });
const Provider = z.object({ idToken: z.string().min(10), displayName: z.string().max(40).optional(), timezone: z.string().max(64).optional() });
const Refresh = z.object({ refreshToken: z.string().min(10) });

export async function authRoutes(app: FastifyInstance) {
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
    await logout(Refresh.parse(req.body).refreshToken);
    return { ok: true };
  });
}
