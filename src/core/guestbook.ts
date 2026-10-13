import { one, q } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { localDay } from '../lib/time.js';
import { LIMITS, cleanText, initialsOf } from '../shared/rules.js';
import type { GuestbookEntry, GuestbookSticker, PaletteId } from '../shared/types.js';
import { isBlocked } from './users.js';
import { notifyActivity } from './activity.js';
import { recordSocialQuest } from './companion.js';
import { autoFlag, requireNotMuted } from './moderation.js';

interface EntryRow {
  id: string; owner_id: string; author_id: string; sticker: GuestbookSticker; note: string | null; palette: PaletteId; created_at: Date;
  display_name: string; avatar_color: string;
}
const toEntry = (r: EntryRow): GuestbookEntry => ({
  id: r.id, ownerId: r.owner_id, authorId: r.author_id, authorName: r.display_name, authorInitials: initialsOf(r.display_name), authorColor: r.avatar_color,
  palette: r.palette, sticker: r.sticker, note: r.note, createdAt: r.created_at.toISOString(),
});
const SELECT = `SELECT g.*, u.display_name, u.avatar_color FROM guestbook_entries g JOIN users u ON u.id = g.author_id`;

async function dayOf(userId: string) {
  return localDay((await one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [userId]))?.timezone ?? 'UTC');
}

/** Newest first. Entries from people either side has blocked are left out. */
export async function listGuestbook(viewerId: string, ownerId: string) {
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [ownerId]))) throw E.notFound('Room not found');
  if (viewerId !== ownerId && (await isBlocked(viewerId, ownerId))) throw E.notFound('Room not found');
  const rows = await q<EntryRow>(
    `${SELECT} WHERE g.owner_id = $1 AND NOT g.hidden
       AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'blocked'
                        AND ((f.user_id = $2 AND f.friend_id = g.author_id) OR (f.user_id = g.author_id AND f.friend_id = $2)))
     ORDER BY g.created_at DESC LIMIT $3`,
    [ownerId, viewerId, LIMITS.guestbookPreview],
  );
  const signedToday = viewerId !== ownerId
    && !!(await one('SELECT 1 FROM guestbook_entries WHERE owner_id = $1 AND author_id = $2 AND day = $3', [ownerId, viewerId, await dayOf(viewerId)]));
  return { entries: rows.map(toEntry), signedToday };
}

/** One note per visitor per room per (visitor's) local day. The owner gets guestbook:new and a push. */
export async function signGuestbook(authorId: string, ownerId: string, p: { sticker: GuestbookSticker; note?: string }): Promise<GuestbookEntry> {
  if (authorId === ownerId) throw E.badRequest("You can't sign your own guestbook");
  await requireNotMuted(authorId);
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [ownerId]))) throw E.notFound('Room not found');
  if (await isBlocked(authorId, ownerId)) throw E.notFound('Room not found');
  const note = p.note ? cleanText(p.note).slice(0, LIMITS.guestbookNoteMax) || null : null;
  const palette = (await one<{ palette: PaletteId }>('SELECT palette FROM companions WHERE user_id = $1', [authorId]))?.palette ?? 'mo';
  const day = await dayOf(authorId);
  const ins = await one<{ id: string }>(
    `INSERT INTO guestbook_entries (owner_id, author_id, day, sticker, note, palette) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_id, author_id, day) DO NOTHING RETURNING id`,
    [ownerId, authorId, day, p.sticker, note, palette],
  );
  if (!ins) throw new AppError(409, 'ALREADY_SIGNED', 'You already left a note here today');
  const entry = toEntry((await one<EntryRow>(`${SELECT} WHERE g.id = $1`, [ins.id]))!);
  if (note) autoFlag(authorId, 'guestbook', ins.id, note);
  toUser(ownerId, 'guestbook:new', entry);
  await enqueue.push(`guestbook:${ins.id}`, { kind: 'guestbook', entryId: ins.id });
  await notifyActivity([ownerId], authorId, 'guestbook', {}, `guestbook:${ins.id}`);
  await recordSocialQuest(authorId, 'guestbook', ownerId);
  return entry;
}
