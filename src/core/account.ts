import { createHash, timingSafeEqual } from 'node:crypto';
import { one, q, tx } from '../db/pool.js';
import { AppError, E } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { toUser, toUsers } from '../lib/emitter.js';
import { redis } from '../lib/redis.js';
import { normalizeLogin } from './auth.js';
import { memberIds, summaryFor } from './conversations.js';

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
  const wiped = await tx(async (c) => {
    const exists = await one('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId], c);
    if (!exists) throw E.notFound('Account not found');

    // Preserve active subscription so it can be reactivated if the user rejoins before it ends
    const user = await one<{ login: string }>('SELECT login FROM users WHERE id = $1', [userId], c);
    if (user) {
      const sub = await one<{
        product_id: string | null; status: string | null; period: 'monthly' | 'yearly' | null;
        trial: boolean; current_period_end: Date | null; plus_since: Date | null;
        store: string | null; will_renew: boolean; billing_issue_at: Date | null;
        last_event_ms: number; plus_active: boolean;
      }>(
        `SELECT s.product_id, s.status, s.period, s.trial, s.current_period_end, s.plus_since,
                s.store, s.will_renew, s.billing_issue_at, s.last_event_ms, COALESCE(e.plus_active, FALSE) AS plus_active
           FROM subscriptions s
           LEFT JOIN entitlements e ON e.user_id = s.user_id
          WHERE s.user_id = $1`,
        [userId], c
      );
      if (sub && (sub.plus_active || (sub.current_period_end && sub.current_period_end.getTime() > Date.now()))) {
        await q(
          `INSERT INTO preserved_subscriptions (
             login, original_user_id, product_id, status, period, trial,
             current_period_end, plus_since, store, will_renew, billing_issue_at, last_event_ms, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           ON CONFLICT (login) DO UPDATE SET
             original_user_id = EXCLUDED.original_user_id,
             product_id = EXCLUDED.product_id,
             status = EXCLUDED.status,
             period = EXCLUDED.period,
             trial = EXCLUDED.trial,
             current_period_end = EXCLUDED.current_period_end,
             plus_since = EXCLUDED.plus_since,
             store = EXCLUDED.store,
             will_renew = EXCLUDED.will_renew,
             billing_issue_at = EXCLUDED.billing_issue_at,
             last_event_ms = EXCLUDED.last_event_ms,
             updated_at = now()`,
          [
            user.login, userId, sub.product_id, sub.status, sub.period, sub.trial,
            sub.current_period_end, sub.plus_since, sub.store, sub.will_renew,
            sub.billing_issue_at, sub.last_event_ms
          ],
          c
        );
        log.info({ userId, login: user.login }, 'preserved active subscription before account deletion');
      }
    }
    // Private copies for moderators (kept 14 days), so deleting an account can't erase abuse before it's reported.
    await q(
      `INSERT INTO deleted_messages (message_id, conversation_id, sender_id, type, body, payload, sent_at)
       SELECT id, conversation_id, sender_id, type, body, payload, created_at FROM messages
        WHERE sender_id = $1 AND deleted_at IS NULL AND type <> 'system'
       ON CONFLICT (message_id) DO NOTHING`, [userId], c);
    const wipedRows = await q<{ id: string; conversation_id: string; deleted_at: Date }>(
      `UPDATE messages SET sender_id = NULL, body = NULL, payload = NULL, deleted_at = COALESCE(deleted_at, now())
        WHERE sender_id = $1 RETURNING id, conversation_id, deleted_at`, [userId], c,
    );
    await q('UPDATE conversations SET owner_id = NULL WHERE owner_id = $1', [userId], c);
    await q(
      `UPDATE conversations c SET member_count = GREATEST(c.member_count - 1, 0)
         FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1`, [userId], c,
    );
    // Reports about this account stay (moderation records outlive the account; see the privacy policy).
    await q('DELETE FROM users WHERE id = $1', [userId], c);
    return wipedRows;
  });
  await redis.del(`ent:${userId}`, `presence-sockets:${userId}`).catch(() => {});
  log.info({ userId, wipedMessages: wiped.length }, 'account deleted');
  await notifyWiped(wiped).catch((err) => log.warn({ err, userId }, 'failed to broadcast wiped messages'));
}

/**
 * Tell everyone still in the affected chats that the deleted user's messages are gone, so open chats flip
 * to "Message deleted" live and chat-list previews refresh. Offline clients reconcile when they reopen the chat.
 */
async function notifyWiped(rows: { id: string; conversation_id: string; deleted_at: Date }[]) {
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) byConv.set(r.conversation_id, [...(byConv.get(r.conversation_id) ?? []), r]);
  for (const [conversationId, msgs] of byConv) {
    const members = await memberIds(conversationId);
    if (members.length === 0) continue;
    for (const m of msgs) {
      toUsers(members, 'msg:update', { id: m.id, conversationId, body: null, deletedAt: m.deleted_at.toISOString() });
    }
    for (const uid of members) {
      const s = await summaryFor(uid, conversationId);
      if (s) toUser(uid, 'conv:update', { id: conversationId, lastSeq: s.lastSeq, lastMessagePreview: s.lastMessagePreview, lastMessageAt: s.lastMessageAt, unread: s.unread });
    }
  }
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
