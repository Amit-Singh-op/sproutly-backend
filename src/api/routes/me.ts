import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signupFinished } from '../../core/approvalEmail.js';
import { q } from '../../db/pool.js';
import { getMe, peersOf, userStyleOf, userStyles } from '../../core/users.js';
import { registerDevice, report } from '../../core/misc.js';
import { deleteAccount } from '../../core/account.js';
import { toUsers } from '../../lib/emitter.js';
import { isValidTimezone } from '../../lib/time.js';
import { LIMITS, RATE_LIMITS, cleanText } from '../../shared/rules.js';
import { BIO_MAX, REPORT_CATEGORIES } from '../../shared/types.js';
import { limit } from '../../lib/ratelimit.js';
import { E } from '../../lib/errors.js';
import { UPLOAD_FOLDERS, isOwnCloudinaryUrl, uploadSignature } from '../../lib/cloudinary.js';
import { AnalyticsBody, recordEvents } from '../../core/analytics.js';
import { addSong, removeSong, songsOfUser } from '../../core/music.js';
import { clearWarning, requireNotMuted } from '../../core/moderation.js';
import { isReservedName } from '../../shared/safety.js';
import { autoFlag, isAdmin } from '../../core/moderation.js';

const PatchMe = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
  readReceipts: z.boolean().optional(),
  dmPolicy: z.enum(['everyone', 'friends']).optional(),
  notificationsEnabled: z.boolean().optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  // Empty clears it; line breaks are kept (up to 3 lines), runs of blank lines are not.
  bio: z.string().transform((v) => cleanText(v.replace(/\r/g, '')).replace(/\n{2,}/g, '\n').split('\n').slice(0, 3).join('\n')).pipe(z.string().max(BIO_MAX, `Keep your bio under ${BIO_MAX} characters`)).nullable().optional(),
});
const Device = z.object({ platform: z.enum(['ios', 'android']), pushToken: z.string().min(10).max(4096), appVersion: z.string().max(40).optional() });
// Older apps send only a free-text reason (counted as 'other'); newer ones pick a category and may add a note.
const Report = z.object({
  targetType: z.enum(['user', 'message', 'post', 'story', 'comment', 'guestbook']), targetId: z.string().uuid(),
  category: z.enum(REPORT_CATEGORIES).default('other'), reason: z.string().max(500).default(''),
});

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => getMe(req.userId));
  // A moderator's warning was read: don't show it again.
  app.post('/me/notice/seen', async (req) => { await clearWarning(req.userId); return { ok: true }; });

  // Your songs: links from music apps, shown as cards on your profile (friends see them). Newest first.
  const SongUrl = z.object({ url: z.string().trim().min(8).max(500) });
  app.get('/me/music', async (req) => ({ songs: await songsOfUser(req.userId) }));
  app.post('/me/music/songs', async (req) => addSong(req.userId, SongUrl.parse(req.body).url));
  app.delete('/me/music/songs', async (req) => removeSong(req.userId, SongUrl.parse(req.query).url));

  app.patch('/me', async (req) => {
    const p = PatchMe.parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [req.userId];
    // Names that could pass for Sproutly staff are for moderators only.
    if (p.displayName !== undefined && isReservedName(p.displayName) && !(await isAdmin(req.userId))) throw E.badRequest('That name is reserved. Please pick another one.');
    if (p.displayName !== undefined) { vals.push(p.displayName); sets.push(`display_name = $${vals.length}`); }
    if (p.timezone !== undefined) { vals.push(p.timezone); sets.push(`timezone = $${vals.length}`); }
    if (p.readReceipts !== undefined) { vals.push(p.readReceipts); sets.push(`read_receipts = $${vals.length}`); }
    if (p.dmPolicy !== undefined) { vals.push(p.dmPolicy); sets.push(`dm_policy = $${vals.length}`); }
    if (p.bio) await requireNotMuted(req.userId);
    if (p.bio !== undefined) { vals.push(p.bio || null); sets.push(`bio = $${vals.length}`); }
    if (p.bio) autoFlag(req.userId, 'user', req.userId, p.bio);
    if (p.notificationsEnabled !== undefined) { vals.push(p.notificationsEnabled); sets.push(`notifications_enabled = $${vals.length}`); }
    if (p.avatarUrl !== undefined) {
      if (p.avatarUrl !== null && !isOwnCloudinaryUrl(p.avatarUrl, req.userId)) throw E.badRequest('Upload the photo first, then save it.');
      vals.push(p.avatarUrl); sets.push(`avatar_url = $${vals.length}`);
    }
    if (sets.length) await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    // A new sign-up chose their name: that's the end of signing up, so the approval email can go now.
    if (p.displayName !== undefined) await signupFinished(req.userId);
    if (p.displayName !== undefined || p.avatarUrl !== undefined) {
      const style = await userStyleOf(req.userId);
      if (style) toUsers([...(await peersOf(req.userId)), req.userId], 'style:update', style);
    }
    return getMe(req.userId);
  });

  /** Signed params for a direct Cloudinary upload (see lib/cloudinary.ts). */
  app.post('/uploads/signature', async (req) => {
    const { folder } = z.object({ folder: z.enum(UPLOAD_FOLDERS).default('avatars') }).parse(req.body ?? {});
    // Uploads cost storage/bandwidth: cap how many a person can start.
    await limit(`upload:${req.userId}`, RATE_LIMITS.uploadsPerUser, "You've uploaded a lot of photos recently. Please try again later.");
    return uploadSignature(req.userId, folder);
  });

  /** In-app account deletion (Play requirement). Body must confirm, so a stray request can't wipe an account. */
  app.delete('/me', async (req) => {
    z.object({ confirm: z.literal('DELETE') }).parse(req.body ?? {});
    await deleteAccount(req.userId);
    return { ok: true };
  });

  app.post('/devices', async (req) => {
    const d = Device.parse(req.body);
    await registerDevice(req.userId, d.platform, d.pushToken, d.appVersion, req.sessionId);
    return { ok: true };
  });

  // Sign-out: this phone stops getting the account's pushes.
  app.post('/devices/remove', async (req) => {
    const { pushToken } = z.object({ pushToken: z.string().min(10).max(4096) }).parse(req.body);
    await q('DELETE FROM devices WHERE user_id = $1 AND push_token = $2', [req.userId, pushToken]);
    return { ok: true };
  });

  app.get('/users/styles', async (req) => {
    const ids = String((req.query as { ids?: string }).ids ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    return userStyles([...new Set(ids)].slice(0, LIMITS.userStylesMax));
  });

  /** First-party usage events, batched by the app. */
  app.post('/analytics', async (req) => {
    await limit(`analytics:${req.userId}`, RATE_LIMITS.analyticsPerUser, 'Too many events.');
    return { accepted: await recordEvents(req.userId, AnalyticsBody.parse(req.body)) };
  });

  app.post('/reports', async (req) => {
    const r = Report.parse(req.body);
    await report(req.userId, r.targetType, r.targetId, r.category, r.reason);
    return { ok: true };
  });
}
