import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db/pool.js';
import { getMe, peersOf, userStyleOf, userStyles } from '../../core/users.js';
import { registerDevice, report } from '../../core/misc.js';
import { deleteAccount } from '../../core/account.js';
import { toUsers } from '../../lib/emitter.js';
import { isValidTimezone } from '../../lib/time.js';
import { LIMITS } from '../../shared/rules.js';

const PatchMe = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
  readReceipts: z.boolean().optional(),
});
const Device = z.object({ platform: z.enum(['ios', 'android']), pushToken: z.string().min(10).max(4096), appVersion: z.string().max(40).optional() });
const Report = z.object({ targetType: z.enum(['user', 'message', 'post']), targetId: z.string().uuid(), reason: z.string().min(1).max(500) });

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => getMe(req.userId));

  app.patch('/me', async (req) => {
    const p = PatchMe.parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [req.userId];
    if (p.displayName !== undefined) { vals.push(p.displayName); sets.push(`display_name = $${vals.length}`); }
    if (p.timezone !== undefined) { vals.push(p.timezone); sets.push(`timezone = $${vals.length}`); }
    if (p.readReceipts !== undefined) { vals.push(p.readReceipts); sets.push(`read_receipts = $${vals.length}`); }
    if (sets.length) await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (p.displayName !== undefined) {
      const style = await userStyleOf(req.userId);
      if (style) toUsers([...(await peersOf(req.userId)), req.userId], 'style:update', style);
    }
    return getMe(req.userId);
  });

  /** In-app account deletion (Play requirement). Body must confirm, so a stray request can't wipe an account. */
  app.delete('/me', async (req) => {
    z.object({ confirm: z.literal('DELETE') }).parse(req.body ?? {});
    await deleteAccount(req.userId);
    return { ok: true };
  });

  app.post('/devices', async (req) => {
    const d = Device.parse(req.body);
    await registerDevice(req.userId, d.platform, d.pushToken, d.appVersion);
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

  app.post('/reports', async (req) => {
    const r = Report.parse(req.body);
    await report(req.userId, r.targetType, r.targetId, r.reason);
    return { ok: true };
  });
}
