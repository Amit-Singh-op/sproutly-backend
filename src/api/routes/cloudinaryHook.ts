import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { one, q } from '../../db/pool.js';
import { cloudinarySecret } from '../../lib/cloudinary.js';
import { log } from '../../lib/log.js';
import { event } from '../../core/moderation.js';

/**
 * Photo scanning results (only when CLOUDINARY_MODERATION is set, see lib/cloudinary.ts). Cloudinary signs each call:
 * X-Cld-Signature = sha1(body + X-Cld-Timestamp + api_secret). A rejected photo is taken down wherever it's used
 * (profile photo cleared, post hidden, story removed) and its owner lands in the moderation queue.
 */
export async function cloudinaryHookRoutes(app: FastifyInstance) {
  app.post('/webhooks/cloudinary', async (req, reply) => {
    const secret = cloudinarySecret();
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const ts = String(req.headers['x-cld-timestamp'] ?? '');
    const sig = String(req.headers['x-cld-signature'] ?? '');
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 7200;
    const expected = secret ? createHash('sha1').update(raw + ts + secret).digest('hex') : '';
    if (!secret || !fresh || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return reply.code(401).send({ ok: false });
    }
    const body = req.body as { notification_type?: string; moderation_status?: string; public_id?: string; moderation_kind?: string } | undefined;
    if (body?.notification_type !== 'moderation' || body.moderation_status !== 'rejected' || !body.public_id) return { ok: true };

    // sproutly/<folder>/<userId>/<file>
    const [, folder, ownerId] = body.public_id.split('/');
    if (!ownerId || !/^[0-9a-f-]{36}$/i.test(ownerId)) return { ok: true };
    const like = `%${body.public_id}%`;
    if (folder === 'avatars') await q('UPDATE users SET avatar_url = NULL WHERE id = $1 AND avatar_url LIKE $2', [ownerId, like]);
    if (folder === 'showcase') await q('UPDATE showcase_posts SET hidden = TRUE WHERE user_id = $1 AND image_url LIKE $2', [ownerId, like]);
    if (folder === 'stories') await q('DELETE FROM stories WHERE user_id = $1 AND image_url LIKE $2', [ownerId, like]);
    if (!(await one('SELECT 1 FROM users WHERE id = $1', [ownerId]))) return { ok: true };
    const r = await one<{ id: string }>(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, category, subject_id) VALUES (NULL, 'user', $1, $2, 'sexual', $1) RETURNING id`,
      [ownerId, `Photo rejected by the automatic scan (${body.moderation_kind ?? 'scan'})`]);
    await event({ userId: ownerId, kind: 'auto_flag', actor: 'system', reason: 'Photo rejected by the automatic scan', details: { reportId: r?.id, category: 'sexual', publicId: body.public_id, folder } });
    log.info({ ownerId, folder }, 'photo rejected by scan and taken down');
    return { ok: true };
  });
}
