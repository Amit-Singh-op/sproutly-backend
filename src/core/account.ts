import { createHash, timingSafeEqual } from 'node:crypto';
import { one, q, tx } from '../db/pool.js';
import { AppError, E } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { redis } from '../lib/redis.js';
import { normalizeLogin } from './auth.js';

/**
 * Deletes an account and its personal data (Google Play account-deletion requirement).
 * - Removed via ON DELETE CASCADE: profile, companion, entitlements/subscription record, sessions, devices,
 *   friendships/blocks, memberships, quests, chat style, showcase posts + cheers, rooms, invites, poll votes.
 * - The user's messages stay in other people's chats as "Message deleted" (text and attachments wiped,
 *   sender cleared), so conversations don't lose their ordering.
 * - Groups they created keep existing without an owner.
 * An active store subscription is NOT cancelled by this; the user must cancel it in Google Play / App Store.
 */
export async function deleteAccount(userId: string) {
  await tx(async (c) => {
    const exists = await one('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId], c);
    if (!exists) throw E.notFound('Account not found');
    await q(
      `UPDATE messages SET sender_id = NULL, body = NULL, payload = NULL, deleted_at = COALESCE(deleted_at, now())
        WHERE sender_id = $1`, [userId], c,
    );
    await q('UPDATE conversations SET owner_id = NULL WHERE owner_id = $1', [userId], c);
    await q(
      `UPDATE conversations c SET member_count = GREATEST(c.member_count - 1, 0)
         FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1`, [userId], c,
    );
    await q(`DELETE FROM reports WHERE target_type = 'user' AND target_id = $1`, [userId], c);
    await q('DELETE FROM users WHERE id = $1', [userId], c);
  });
  await redis.del(`ent:${userId}`, `presence-sockets:${userId}`).catch(() => {});
  log.info({ userId }, 'account deleted');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Web deletion flow (the URL given to Google Play): the person proves they own the email with the same
 * 6-digit code used for sign-in, then the account is deleted. Never creates an account.
 */
export async function deleteAccountWithCode(rawLogin: string, code: string) {
  const login = normalizeLogin(rawLogin);
  const row = await one<{ code_hash: string; attempts: number; expires_at: Date }>(
    'SELECT code_hash, attempts, expires_at FROM otp_codes WHERE login = $1', [login],
  );
  if (!row || row.expires_at.getTime() < Date.now()) throw new AppError(400, 'OTP_EXPIRED', 'Code expired. Request a new one.');
  if (row.attempts >= 5) throw E.rateLimited('Too many attempts. Request a new code.');
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(sha256(`${login}:${code.trim()}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await q('UPDATE otp_codes SET attempts = attempts + 1 WHERE login = $1', [login]);
    throw new AppError(400, 'OTP_INVALID', 'That code isn’t right');
  }
  await q('DELETE FROM otp_codes WHERE login = $1', [login]);
  const user = await one<{ id: string }>('SELECT id FROM users WHERE login = $1', [login]);
  // Same answer whether or not an account existed, so the page can't be used to probe emails.
  if (user) await deleteAccount(user.id);
  return { ok: true as const };
}
