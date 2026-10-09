import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { one, pool, q, tx } from '../db/pool.js';
import { AppError, E } from '../lib/errors.js';
import { signAccess } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { limit } from '../lib/ratelimit.js';
import { isValidTimezone } from '../lib/time.js';
import { RATE_LIMITS } from '../shared/rules.js';
import { otpEmail } from './emailTemplate.js';
import { createUser } from './users.js';
import { requireNotSuspended } from './suspension.js';
import { bannedLogin, recordBlockedSignIn } from './moderation.js';
import { isReviewLogin, ensureReviewPlus } from './review.js';
import { invalidatePlus } from './entitlements.js';

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; isNew?: boolean }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

export function normalizeLogin(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw E.badRequest('Enter a valid email address');
    return s;
  }
  const digits = s.replace(/[^\d+]/g, '');
  if (!/^\+?\d{7,15}$/.test(digits)) throw E.badRequest('Enter a valid phone number or email');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

// ---------------- OTP delivery ----------------
// Gmail SMTP (smtp.gmail.com:465) authenticated with a Google App Password.
// Fail fast: a blocked or slow SMTP port must not hang the sign-in request.
// (Timeouts must be transport options; nodemailer's second createTransport argument is only message defaults.)
const mailer = config.GMAIL_USER && config.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      // App passwords are shown with spaces ("abcd efgh ..."); Google accepts them without.
      auth: { user: config.GMAIL_USER, pass: config.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
  : null;
// Gmail rewrites any From address that isn't the account or a verified alias, so default to the account itself.
const otpFrom = config.OTP_FROM ?? (config.GMAIL_USER ? `Sproutly <${config.GMAIL_USER}>` : undefined);

/**
 * Resend HTTPS API (port 443). Preferred when RESEND_API_KEY is set: hosts like Render's free tier block
 * outbound SMTP ports, where the SMTP transport just times out. OTP_FROM must be on a domain verified in Resend.
 */
async function sendViaResend(to: string, subject: string, text: string, html: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: otpFrom, to: [to], subject, text, html, ...(config.OTP_REPLY_TO && { reply_to: config.OTP_REPLY_TO }) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function deliverOtp(login: string, code: string) {
  const { subject, text, html } = otpEmail(code);
  if (login.includes('@') && (config.RESEND_API_KEY || mailer)) {
    try {
      if (config.RESEND_API_KEY) await sendViaResend(login, subject, text, html);
      else await mailer!.sendMail({ from: otpFrom, to: login, subject, text, html, replyTo: config.OTP_REPLY_TO });
    } catch (err) {
      log.error({ err }, 'OTP email failed');
      throw E.unavailable('OTP_UNAVAILABLE', 'We couldn’t send the code right now. Please try again in a moment.');
    }
    return;
  }
  if (!config.isProd) {
    log.info({ login, code }, 'OTP (dev: not delivered)');
    return;
  }
  // No SMS provider is configured; refusing is better than silently never delivering.
  throw E.unavailable('OTP_UNAVAILABLE', login.includes('@') ? 'Email sign-in is not configured' : 'Phone sign-in is not available yet. Use your email.');
}

/** POST /auth/otp/start: 6 digits, hashed, 10 min, 5 attempts; 5 codes per hour per login. */
export async function startOtp(raw: string): Promise<{ ok: true; devCode?: string }> {
  const login = normalizeLogin(raw);
  // A suspended account (or one deleted while suspended) can't sign in: say so before sending a code.
  const banned = await bannedLogin(login);
  if (banned) {
    await recordBlockedSignIn(login, (await one<{ id: string }>('SELECT id FROM users WHERE login = $1', [login]))?.id ?? null);
    throw new AppError(403, 'ACCOUNT_SUSPENDED', banned);
  }
  await limit(`otp:${login}`, RATE_LIMITS.otpPerHour, 'Too many codes requested. Try again later.');
  // Store reviewers can't receive our emails: their one account uses the fixed code given to Google/Apple.
  const isReview = !!config.REVIEW_EMAIL && !!config.REVIEW_CODE && login === normalizeLogin(config.REVIEW_EMAIL);
  const code = isReview ? config.REVIEW_CODE! : config.otpDevCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  await q(
    `INSERT INTO otp_codes (login, code_hash, attempts, expires_at) VALUES ($1, $2, 0, $3)
     ON CONFLICT (login) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at`,
    [login, sha256(`${login}:${code}`), new Date(Date.now() + OTP_TTL_MS)],
  );
  if (!isReview) await deliverOtp(login, code);
  return config.otpDevCode ? { ok: true, devCode: code } : { ok: true };
}

export async function verifyOtp(raw: string, code: string, displayName?: string, timezone?: string): Promise<Tokens> {
  const login = normalizeLogin(raw);
  const row = await one<{ code_hash: string; attempts: number; expires_at: Date }>('SELECT code_hash, attempts, expires_at FROM otp_codes WHERE login = $1', [login]);
  if (!row || row.expires_at.getTime() < Date.now()) throw new AppError(400, 'OTP_EXPIRED', 'Code expired. Request a new one.');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw E.rateLimited('Too many attempts. Request a new code.');
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(sha256(`${login}:${code.trim()}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await q('UPDATE otp_codes SET attempts = attempts + 1 WHERE login = $1', [login]);
    throw new AppError(400, 'OTP_INVALID', 'That code isn’t right');
  }
  await q('DELETE FROM otp_codes WHERE login = $1', [login]);
  return signInLogin(login, displayName, timezone);
}

async function signInLogin(login: string, displayName?: string, timezone?: string): Promise<Tokens> {
  const banned = await bannedLogin(login);
  if (banned) { await recordBlockedSignIn(login, null); throw new AppError(403, 'ACCOUNT_SUSPENDED', banned); }
  const tz = timezone && isValidTimezone(timezone) ? timezone : undefined;
  const { userId, isNew } = await tx(async (c) => {
    const existing = await one<{ id: string }>('SELECT id FROM users WHERE login = $1', [login], c);
    if (existing) {
      if (tz) await q('UPDATE users SET timezone = $2 WHERE id = $1', [existing.id, tz], c);
      return { userId: existing.id, isNew: false };
    }
    return { userId: await createUser(c, login, displayName, tz), isNew: true };
  });
  // The store-review account always has Plus (reviewers must be able to see every feature).
  if (isReviewLogin(login)) { await ensureReviewPlus(userId); await invalidatePlus(userId); }
  return { ...(await issueTokens(userId)), isNew };
}

// ---------------- refresh tokens (rotating families) ----------------
async function issueTokens(userId: string, family: string = randomUUID()): Promise<Tokens> {
  // Every way in (code, Apple/Google, token refresh) passes here: a suspended account gets no new tokens.
  await requireNotSuspended(userId);
  const refreshToken = randomBytes(48).toString('base64url');
  await q(
    'INSERT INTO refresh_tokens (user_id, family, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
    [userId, family, sha256(refreshToken), new Date(Date.now() + config.refreshTtlS * 1000)],
  );
  return { accessToken: await signAccess(userId), refreshToken, expiresIn: config.accessTtlS };
}

/** Each refresh marks the old token used and issues a new one in the same family. Reusing a used token revokes the family. */
export async function refresh(refreshToken: string): Promise<Tokens> {
  const hash = sha256(refreshToken);
  const out = await tx(async (c) => {
    const t = await one<{ id: string; user_id: string; family: string; used_at: Date | null; revoked_at: Date | null; expires_at: Date }>(
      'SELECT id, user_id, family, used_at, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [hash], c,
    );
    if (!t || t.revoked_at || t.expires_at.getTime() < Date.now()) return null;
    if (t.used_at) {
      // Theft detection: someone presented a token that was already rotated.
      await q('UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL', [t.family], c);
      log.warn({ userId: t.user_id, family: t.family }, 'refresh token reuse: family revoked');
      return 'reused' as const;
    }
    await q('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [t.id], c);
    return { userId: t.user_id, family: t.family };
  });
  if (!out || out === 'reused') throw E.unauthorized('Please sign in again');
  return issueTokens(out.userId, out.family);
}

export async function logout(refreshToken: string) {
  const t = await one<{ family: string }>('SELECT family FROM refresh_tokens WHERE token_hash = $1', [sha256(refreshToken)]);
  if (t) await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL', [t.family]);
}

// ---------------- Apple / Google ----------------
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export async function signInWithProvider(provider: 'apple' | 'google', idToken: string, displayName?: string, timezone?: string): Promise<Tokens> {
  let payload: { sub?: string; email?: string; email_verified?: boolean | string };
  try {
    if (provider === 'apple') {
      ({ payload } = await jwtVerify(idToken, appleJwks, { issuer: 'https://appleid.apple.com', audience: config.APPLE_AUDIENCE }));
    } else {
      if (config.googleAudiences.length === 0) throw E.unavailable('AUTH_UNAVAILABLE', 'Google sign-in is not configured');
      ({ payload } = await jwtVerify(idToken, googleJwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.googleAudiences }));
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'AUTH_UNAVAILABLE') throw err;
    throw E.unauthorized('Could not verify that sign-in');
  }
  // Prefer the verified email so Apple/Google/OTP land on the same account; fall back to the provider subject.
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  const login = payload.email && verified ? payload.email.toLowerCase() : `${provider}:${payload.sub}`;
  if (!payload.sub) throw E.unauthorized('Could not verify that sign-in');
  return signInLogin(login, displayName, timezone);
}
