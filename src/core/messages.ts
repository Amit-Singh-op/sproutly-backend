import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { one, q, tx, type Db } from '../db/pool.js';
import { toUser, toUsers } from '../lib/emitter.js';
import { E } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { enqueue } from '../lib/queues.js';
import { limit } from '../lib/ratelimit.js';
import { LIMITS, RATE_LIMITS, cleanText, emotesFor, neutralPreview, previewFor } from '../shared/rules.js';
import { EMOTES, STICKER_KINDS, type Message, type PollPayload, type SystemPayload } from '../shared/types.js';
import { isPlus } from './entitlements.js';
import { memberIds, requireMember, summaryFor } from './conversations.js';
import { requireLiveSeat } from './live.js';

// ---------------- validation (doc 6.2 step 2) ----------------
const Text = z.string().transform(cleanText).pipe(z.string().min(1, 'Message is empty').max(LIMITS.textMax, 'Message is too long'));
export const SendBody = z.discriminatedUnion('type', [
  z.object({ clientId: z.string().uuid(), conversationId: z.string().uuid(), type: z.literal('text'), body: Text }),
  z.object({ clientId: z.string().uuid(), conversationId: z.string().uuid(), type: z.literal('sticker'), payload: z.object({ kind: z.enum(STICKER_KINDS), emote: z.enum(EMOTES).optional() }) }),
  z.object({
    clientId: z.string().uuid(), conversationId: z.string().uuid(), type: z.literal('poll'),
    payload: z.object({
      question: Text.pipe(z.string().max(200)),
      options: z.array(z.string().transform(cleanText).pipe(z.string().min(1).max(80))).min(LIMITS.pollOptionsMin).max(LIMITS.pollOptionsMax),
    }),
  }),
]);
export type SendBody = z.infer<typeof SendBody>;

// ---------------- row -> Message ----------------
export interface MessageRow {
  id: string; conversation_id: string; seq: number; sender_id: string | null; client_id: string; type: Message['type'];
  body: string | null; payload: Message['payload']; created_at: Date; edited_at: Date | null; deleted_at: Date | null;
}

/** Poll counts/total/myVote are computed per viewer; stored payload is just { question, options }. */
async function pollState(messageIds: string[], viewerId: string | null, db?: Db) {
  if (messageIds.length === 0) return new Map<string, { counts: Map<number, number>; total: number; mine: number | null }>();
  const rows = await q<{ message_id: string; option_idx: number; n: number; mine: boolean }>(
    `SELECT message_id, option_idx, count(*)::int AS n, bool_or(user_id = $2) AS mine
       FROM poll_votes WHERE message_id = ANY($1::uuid[]) GROUP BY message_id, option_idx`, [messageIds, viewerId], db,
  );
  const out = new Map<string, { counts: Map<number, number>; total: number; mine: number | null }>();
  for (const r of rows) {
    const s = out.get(r.message_id) ?? { counts: new Map(), total: 0, mine: null };
    s.counts.set(r.option_idx, r.n);
    s.total += r.n;
    if (r.mine) s.mine = r.option_idx;
    out.set(r.message_id, s);
  }
  return out;
}

export async function toMessages(rows: MessageRow[], viewerId: string | null, db?: Db): Promise<Message[]> {
  const polls = await pollState(rows.filter((r) => r.type === 'poll' && !r.deleted_at).map((r) => r.id), viewerId, db);
  return rows.map((r) => {
    let payload = r.deleted_at ? null : r.payload;
    if (r.type === 'poll' && payload) {
      const p = payload as PollPayload;
      const s = polls.get(r.id);
      payload = { question: p.question, options: p.options, counts: p.options.map((_, i) => s?.counts.get(i) ?? 0), total: s?.total ?? 0, myVote: s?.mine ?? null };
    }
    return {
      id: r.id, clientId: r.client_id, conversationId: r.conversation_id, seq: r.seq, senderId: r.sender_id, type: r.type,
      body: r.deleted_at ? null : r.body, payload, createdAt: r.created_at.toISOString(),
      editedAt: r.edited_at?.toISOString() ?? null, deletedAt: r.deleted_at?.toISOString() ?? null,
    };
  });
}

// ---------------- insert with seq (doc 6.1) ----------------
async function insertMessage(c: pg.PoolClient, m: { conversationId: string; senderId: string | null; clientId: string; type: Message['type']; body: string | null; payload: unknown }) {
  // The UPDATE's row lock on the conversation serialises concurrent senders; ON CONFLICT makes retries a no-op.
  const row = await one<MessageRow>(
    `WITH s AS (UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $2 RETURNING last_seq)
     INSERT INTO messages (id, conversation_id, seq, sender_id, client_id, type, body, payload)
     SELECT $1, $2, s.last_seq, $3, $4, $5, $6, $7 FROM s
     ON CONFLICT (sender_id, client_id) DO NOTHING
     RETURNING *`,
    [uuidv7(), m.conversationId, m.senderId, m.clientId, m.type, m.body, m.payload === null ? null : JSON.stringify(m.payload)], c,
  );
  return row;
}

async function afterInsert(c: pg.PoolClient, row: MessageRow, senderName: string, isGroup: boolean) {
  await q(
    `UPDATE conversations SET last_message_id = $2, last_message_at = $3, last_message_preview = $4, last_sender_id = $5 WHERE id = $1`,
    [row.conversation_id, row.id, row.created_at, neutralPreview({ type: row.type, body: row.body, payload: row.payload, deletedAt: null }, senderName, isGroup), row.sender_id], c,
  );
  if (row.sender_id) {
    // Doc 6.2 step 7: the sender has obviously read/received their own message.
    await q(
      `UPDATE conversation_members SET read_seq = GREATEST(read_seq, $3), delivered_seq = GREATEST(delivered_seq, $3), archived = FALSE
        WHERE conversation_id = $1 AND user_id = $2`, [row.conversation_id, row.sender_id, row.seq], c,
    );
  }
  // A new message un-archives the chat for everyone.
  await q('UPDATE conversation_members SET archived = FALSE WHERE conversation_id = $1 AND archived', [row.conversation_id], c);
}

/** Doc 6.2 step 9: msg:new to every member + conv:update (with that member's unread and preview) to each member. */
async function fanOut(msg: Message, kind: 'dm' | 'group', senderName: string) {
  const unread = await q<{ user_id: string; unread: number }>(
    `SELECT m.user_id, (SELECT count(*)::int FROM messages x WHERE x.conversation_id = m.conversation_id AND x.seq > m.read_seq AND x.created_at > now() - interval '3 days'
                          AND x.sender_id IS DISTINCT FROM m.user_id AND x.deleted_at IS NULL AND x.type <> 'system') AS unread
       FROM conversation_members m WHERE m.conversation_id = $1`, [msg.conversationId],
  );
  toUsers(unread.map((u) => u.user_id), 'msg:new', msg);
  await Promise.all(unread.map(async (u) => {
    // DMs (and a group's first message) carry the full summary so a new chat appears in the list immediately.
    const summary = kind === 'dm' || msg.seq <= 1 ? await summaryFor(u.user_id, msg.conversationId) : null;
    toUser(u.user_id, 'conv:update', {
      id: msg.conversationId, lastSeq: msg.seq, lastMessageAt: msg.createdAt, unread: u.unread,
      lastMessagePreview: previewFor(msg, { isGroup: kind === 'group', senderName, mine: msg.senderId === u.user_id }),
      ...(summary ? { summary } : {}),
    });
  }));
}

/** Doc 6.2: the whole send path. Idempotent on (sender, clientId): a retry returns the original message. */
export async function sendMessage(userId: string, input: SendBody): Promise<Message> {
  const member = await requireMember(userId, input.conversationId);
  if (member.read_only) throw E.readOnly();
  // Groups allow ROOM_LIVE_CAPACITY people in at once: sending needs one of those seats.
  await requireLiveSeat(userId, input.conversationId);

  // Step 3: idempotency fast-path. The conversation kind and sender name are needed later; fetching them in the same
  // round trip matters when the database is far away (each sequential query delays msg:new for every member).
  const [dupe, conv, sender] = await Promise.all([
    one<MessageRow>('SELECT * FROM messages WHERE sender_id = $1 AND client_id = $2', [userId, input.clientId]),
    one<{ kind: 'dm' | 'group' }>('SELECT kind FROM conversations WHERE id = $1', [input.conversationId]),
    one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId]),
  ]);
  if (dupe) return (await toMessages([dupe], userId))[0]!;

  // Step 4: rate limits.
  await limit(`msg:u:${userId}`, RATE_LIMITS.msgPerUser, 'You’re sending messages too fast');
  await limit(`msg:c:${input.conversationId}`, RATE_LIMITS.msgPerConversation, 'This chat is very busy, try again in a moment');

  // Step 5: stickers are Plus-only; the server fills the companion snapshot.
  let payload: unknown = null;
  let body: string | null = null;
  if (input.type === 'sticker') {
    if (!(await isPlus(userId))) throw E.plusRequired('sticker');
    await limit(`sticker:u:${userId}`, RATE_LIMITS.stickerPerUser, 'Too many stickers, give it a second');
    const comp = await one<{ palette: string; equipped_outfit: string }>('SELECT palette, equipped_outfit FROM companions WHERE user_id = $1', [userId]);
    const palette = comp?.palette ?? 'mo';
    // Emotes are per species: a drake can't send a bot's "glitch".
    if (input.payload.emote && !emotesFor(palette).includes(input.payload.emote)) throw E.badRequest("Your companion doesn't have that emote");
    payload = { kind: input.payload.kind, ...(input.payload.emote ? { emote: input.payload.emote } : {}), snapshot: { palette, outfit: comp?.equipped_outfit ?? 'none' } };
  } else if (input.type === 'poll') {
    payload = { question: input.payload.question, options: input.payload.options };
  } else {
    body = input.body;
  }

  const row = await tx(async (c) => {
    const inserted = await insertMessage(c, { conversationId: input.conversationId, senderId: userId, clientId: input.clientId, type: input.type, body, payload });
    if (!inserted) return null; // lost a race with a concurrent retry
    await afterInsert(c, inserted, sender?.display_name ?? '', conv?.kind === 'group');
    return inserted;
  });
  if (!row) {
    const existing = await one<MessageRow>('SELECT * FROM messages WHERE sender_id = $1 AND client_id = $2', [userId, input.clientId]);
    return (await toMessages([existing!], userId))[0]!;
  }

  const msg = (await toMessages([row], null))[0]!;
  await fanOut(msg, conv?.kind ?? 'group', sender?.display_name ?? '');
  // Replying means the sender has read everything before it (afterInsert already moved their read_seq):
  // push the new watermark so the other side's ticks turn blue instead of waiting for a reload.
  void markWatermark(userId, msg.conversationId, msg.seq, 'read').catch((err) => log.warn({ err, conversationId: msg.conversationId }, 'receipt broadcast after send failed'));
  // Step 10: jobs (ids derived from the message id => enqueueing twice is a no-op).
  await Promise.all([
    enqueue.push(`push:${msg.id}`, { kind: 'message', messageId: msg.id }),
    enqueue.quests(`quest:${msg.id}`, { kind: 'message.sent', messageId: msg.id }),
  ]);
  return msg;
}

/** System messages ("X joined"). They have no sender and never count as unread. */
export async function sendSystem(conversationId: string, event: SystemPayload['event'], text: string) {
  const conv = await one<{ kind: 'dm' | 'group' }>('SELECT kind FROM conversations WHERE id = $1', [conversationId]);
  const row = await tx(async (c) => {
    const r = await insertMessage(c, { conversationId, senderId: null, clientId: randomUUID(), type: 'system', body: null, payload: { event, text } });
    if (r) await afterInsert(c, r, '', conv?.kind === 'group');
    return r;
  });
  if (row) await fanOut((await toMessages([row], null))[0]!, conv?.kind ?? 'group', '');
}

// ---------------- history (doc 6.6) ----------------
export async function history(userId: string, conversationId: string, opts: { beforeSeq?: number; afterSeq?: number; limit?: number }) {
  await requireMember(userId, conversationId);
  const lim = Math.min(Math.max(opts.limit ?? LIMITS.historyPageDefault, 1), LIMITS.historyPageMax);
  let rows: MessageRow[];
  if (opts.afterSeq !== undefined) {
    rows = await q<MessageRow>(`SELECT * FROM messages WHERE conversation_id = $1 AND seq > $2 AND created_at > now() - interval '3 days' ORDER BY seq ASC LIMIT $3`, [conversationId, opts.afterSeq, lim + 1]);
    const hasMore = rows.length > lim;
    return { messages: await toMessages(rows.slice(0, lim), userId), hasMore };
  }
  rows = opts.beforeSeq !== undefined
    ? await q<MessageRow>(`SELECT * FROM messages WHERE conversation_id = $1 AND seq < $2 AND created_at > now() - interval '3 days' ORDER BY seq DESC LIMIT $3`, [conversationId, opts.beforeSeq, lim + 1])
    : await q<MessageRow>(`SELECT * FROM messages WHERE conversation_id = $1 AND created_at > now() - interval '3 days' ORDER BY seq DESC LIMIT $2`, [conversationId, lim + 1]);
  const hasMore = rows.length > lim;
  return { messages: await toMessages(rows.slice(0, lim).reverse(), userId), hasMore };
}

// ---------------- watermarks (doc 6.4) ----------------
/** Cumulative, never backwards, clamped to last_seq. `read` also implies delivered. */
export async function markWatermark(userId: string, conversationId: string, upToSeq: number, kind: 'delivered' | 'read') {
  if (!Number.isFinite(upToSeq) || upToSeq < 0) return;
  await requireMember(userId, conversationId);
  const updated = await one<{ delivered_seq: number; read_seq: number; changed: boolean }>(
    kind === 'read'
      ? `UPDATE conversation_members m
            SET read_seq = GREATEST(m.read_seq, LEAST($3, c.last_seq)), delivered_seq = GREATEST(m.delivered_seq, LEAST($3, c.last_seq))
           FROM conversations c WHERE m.conversation_id = $1 AND m.user_id = $2 AND c.id = m.conversation_id
         RETURNING m.delivered_seq, m.read_seq, TRUE AS changed`
      : `UPDATE conversation_members m
            SET delivered_seq = GREATEST(m.delivered_seq, LEAST($3, c.last_seq))
           FROM conversations c WHERE m.conversation_id = $1 AND m.user_id = $2 AND c.id = m.conversation_id
         RETURNING m.delivered_seq, m.read_seq, TRUE AS changed`,
    [conversationId, userId, upToSeq],
  );
  if (!updated) return;

  // Minimums over members with read receipts on.
  const mins = await one<{ min_delivered: number | null; min_read: number | null }>(
    `SELECT min(m.delivered_seq) AS min_delivered, min(m.read_seq) AS min_read
       FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 AND u.read_receipts`, [conversationId],
  );
  const minDelivered = mins?.min_delivered ?? 0;
  const minRead = mins?.min_read ?? 0;
  await q('UPDATE conversations SET min_delivered_seq = $2, min_read_seq = $3 WHERE id = $1', [conversationId, minDelivered, minRead]);

  // Per-member emit: someone with receipts off sees 0 for everyone; someone with receipts off broadcasts readSeq 0.
  const members = await q<{ user_id: string; read_receipts: boolean }>(
    `SELECT m.user_id, u.read_receipts FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = $1`, [conversationId],
  );
  const actorReceipts = members.find((m) => m.user_id === userId)?.read_receipts ?? true;
  for (const m of members) {
    const visible = m.read_receipts && actorReceipts;
    toUser(m.user_id, 'receipt:update', {
      conversationId, userId, deliveredSeq: updated.delivered_seq, readSeq: visible ? updated.read_seq : 0,
      minDeliveredSeq: minDelivered, minReadSeq: m.read_receipts ? minRead : 0,
    });
  }
  if (kind === 'read') {
    // My unread badge on my other devices.
    const s = await summaryFor(userId, conversationId);
    if (s) toUser(userId, 'conv:update', { id: conversationId, lastSeq: s.lastSeq, lastMessagePreview: s.lastMessagePreview, lastMessageAt: s.lastMessageAt, unread: s.unread });
  }
}

// ---------------- edit / delete / polls (doc 6.11) ----------------
async function ownMessage(userId: string, messageId: string) {
  const m = await one<MessageRow>('SELECT * FROM messages WHERE id = $1', [messageId]);
  if (!m) throw E.notFound('Message not found');
  await requireMember(userId, m.conversation_id);
  if (m.sender_id !== userId) throw E.forbidden('You can only change your own messages');
  if (m.deleted_at) throw E.conflict('Message was deleted');
  return m;
}

export async function editMessage(userId: string, messageId: string, rawBody: string) {
  const m = await ownMessage(userId, messageId);
  if (m.type !== 'text') throw E.badRequest('Only text messages can be edited');
  if (Date.now() - m.created_at.getTime() > LIMITS.editWindowMs) throw E.conflict('Messages can only be edited for 15 minutes');
  const body = Text.parse(rawBody);
  const r = await one<{ edited_at: Date }>('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1 RETURNING edited_at', [messageId, body]);
  toUsers(await memberIds(m.conversation_id), 'msg:update', { id: m.id, conversationId: m.conversation_id, body, editedAt: r!.edited_at.toISOString() });
}

export async function deleteMessage(userId: string, messageId: string) {
  const m = await ownMessage(userId, messageId);
  if (Date.now() - m.created_at.getTime() > LIMITS.deleteWindowMs) throw E.conflict('Messages can only be deleted for everyone within 1 hour');
  const r = await one<{ deleted_at: Date }>('UPDATE messages SET deleted_at = now(), body = NULL, payload = NULL WHERE id = $1 RETURNING deleted_at', [messageId]);
  toUsers(await memberIds(m.conversation_id), 'msg:update', { id: m.id, conversationId: m.conversation_id, body: null, deletedAt: r!.deleted_at.toISOString() });
}

export async function vote(userId: string, messageId: string, optionIdx: number | null) {
  const m = await one<MessageRow>('SELECT * FROM messages WHERE id = $1', [messageId]);
  if (!m || m.type !== 'poll' || m.deleted_at) throw E.notFound('Poll not found');
  const member = await requireMember(userId, m.conversation_id);
  if (member.read_only) throw E.readOnly();
  const options = (m.payload as PollPayload).options;
  if (optionIdx === null) {
    await q('DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
  } else {
    if (!Number.isInteger(optionIdx) || optionIdx < 0 || optionIdx >= options.length) throw E.badRequest('Invalid option');
    await q(
      `INSERT INTO poll_votes (message_id, user_id, option_idx) VALUES ($1,$2,$3)
       ON CONFLICT (message_id, user_id) DO UPDATE SET option_idx = EXCLUDED.option_idx, voted_at = now()`, [messageId, userId, optionIdx],
    );
  }
  const [msg] = await toMessages([m], userId);
  const p = msg!.payload as PollPayload;
  toUsers(await memberIds(m.conversation_id), 'poll:update', { messageId, counts: p.counts, total: p.total });
  return { counts: p.counts, total: p.total, myVote: p.myVote };
}
