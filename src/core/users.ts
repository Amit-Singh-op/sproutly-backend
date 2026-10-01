import type pg from 'pg';
import { one, q, type Db } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { onlineMap } from '../lib/presence.js';
import { DEFAULT_CHAT_STYLE, initialsOf } from '../shared/rules.js';
import { WALLPAPERS, type ChatStyle, type Companion, type Me, type Mood, type Outfit, type PaletteId, type Person, type UserStyle, type EquippedSlots } from '../shared/types.js';
import { resolveEquippedSlots } from '../shared/catalog.js';
import { getEntitlements } from './entitlements.js';
import { ensureQuests } from './companion.js';
import { isApproved } from './approval.js';

const AVATAR_COLORS = ['#2B2340', '#D9543A', '#7A5AF8', '#2F8A6C', '#3D6FD1', '#A8741A'];

/** First sign-in: users + companions ("Mo", palette mo, level 1) + entitlements in one transaction (doc section 3). */
export async function createUser(c: pg.PoolClient, login: string, displayName: string | undefined, timezone: string | undefined): Promise<string> {
  const name = (displayName?.trim() || login.split('@')[0] || 'Sprout').slice(0, 40);
  const base = name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'sprout';
  let handle = base;
  for (let i = 0; i < 20 && (await one('SELECT 1 FROM users WHERE handle = $1', [handle], c)); i++) {
    handle = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
  }
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
  const u = await one<{ id: string }>(
    `INSERT INTO users (handle, login, display_name, avatar_color, timezone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [handle, login, name, color, timezone || 'UTC'], c,
  );
  await q(`INSERT INTO companions (user_id) VALUES ($1)`, [u!.id], c);

  // Check if this login has an active preserved subscription
  const now = new Date();
  const preserved = await one<{
    product_id: string | null; status: string | null; period: 'monthly' | 'yearly' | null; trial: boolean;
    current_period_end: Date | null; plus_since: Date | null; store: string | null;
    will_renew: boolean; billing_issue_at: Date | null; last_event_ms: number; original_user_id: string;
  }>(
    `SELECT * FROM preserved_subscriptions
      WHERE login = $1 AND (current_period_end IS NULL OR current_period_end > $2)`,
    [login, now], c
  );

  if (preserved) {
    await q(
      `INSERT INTO subscriptions (
         user_id, product_id, status, period, trial, current_period_end, plus_since,
         store, will_renew, billing_issue_at, last_event_ms, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
      [
        u!.id, preserved.product_id, preserved.status ?? 'active', preserved.period, preserved.trial,
        preserved.current_period_end, preserved.plus_since ?? now, preserved.store,
        preserved.will_renew, preserved.billing_issue_at, preserved.last_event_ms
      ], c
    );
    await q(`INSERT INTO entitlements (user_id, plus_active) VALUES ($1, TRUE)`, [u!.id], c);
    await q(`DELETE FROM preserved_subscriptions WHERE login = $1`, [login], c);
  } else {
    await q(`INSERT INTO entitlements (user_id, plus_active) VALUES ($1, FALSE)`, [u!.id], c);
  }

  return u!.id;
}

interface CompanionRow {
  name: string;
  palette: PaletteId;
  level: number;
  energy: number;
  coins?: number | null;
  equipped_outfit: Outfit;
  equipped_slots?: EquippedSlots | string | null;
  signature_move: Mood;
  room_theme: 'basic' | 'cabin';
  streak: number;
  shields?: number | null;
  last_action_at?: Date | null;
  last_active_day?: string | null;
}
export const companionFromRow = (r: CompanionRow): Companion => {
  let equippedSlots: EquippedSlots | undefined = undefined;
  if (r.equipped_slots) {
    if (typeof r.equipped_slots === 'string') {
      try {
        equippedSlots = JSON.parse(r.equipped_slots);
      } catch {}
    } else if (typeof r.equipped_slots === 'object') {
      equippedSlots = r.equipped_slots as EquippedSlots;
    }
  }
  return {
    name: r.name,
    palette: r.palette,
    level: r.level,
    energy: r.energy,
    coins: r.coins ?? 0,
    equippedOutfit: r.equipped_outfit,
    equippedSlots: equippedSlots ?? resolveEquippedSlots(null, r.equipped_outfit),
    signatureMove: r.signature_move,
    roomTheme: r.room_theme,
    streak: r.streak,
    shields: r.shields ?? 0,
    lastActionAt: r.last_action_at ? r.last_action_at.toISOString() : null,
    lastActiveDay: r.last_active_day ?? null,
  };
};

export async function getCompanion(userId: string, db?: Db): Promise<Companion> {
  const r = await one<CompanionRow>('SELECT * FROM companions WHERE user_id = $1', [userId], db);
  if (!r) throw E.notFound('Companion not found');
  return companionFromRow(r);
}

interface StyleRow {
  bubble: string; text_color: string; border: string; design: ChatStyle['design']; avatar_color: string; animation: ChatStyle['animation']; wallpaper?: string | null; version: number;
  avatar_animation?: ChatStyle['avatarAnimation'] | null; avatar_effect?: ChatStyle['avatarEffect'] | null; avatar_charm?: ChatStyle['avatarCharm'] | null;
}
const styleFromRow = (r: StyleRow): ChatStyle => ({
  bubble: r.bubble, text: r.text_color, border: r.border, design: r.design, avatar: r.avatar_color, animation: r.animation,
  wallpaper: (WALLPAPERS as readonly string[]).includes(r.wallpaper ?? '') ? (r.wallpaper as ChatStyle['wallpaper']) : 'lavender',
  ...(r.avatar_animation ? { avatarAnimation: r.avatar_animation } : {}),
  ...(r.avatar_effect ? { avatarEffect: r.avatar_effect } : {}),
  ...(r.avatar_charm ? { avatarCharm: r.avatar_charm } : {}),
});

export async function getChatStyle(userId: string): Promise<{ style: ChatStyle; version: number }> {
  const r = await one<StyleRow>('SELECT * FROM chat_styles WHERE user_id = $1', [userId]);
  return r ? { style: styleFromRow(r), version: r.version } : { style: DEFAULT_CHAT_STYLE, version: 0 };
}

export async function getMe(userId: string): Promise<Me> {
  const u = await one<{ id: string; handle: string; display_name: string; avatar_color: string; avatar_url: string | null; timezone: string; read_receipts: boolean; notifications_enabled: boolean }>(
    'SELECT id, handle, display_name, avatar_color, avatar_url, timezone, read_receipts, notifications_enabled FROM users WHERE id = $1', [userId],
  );
  if (!u) throw E.unauthorized();
  const [companion, entitlements, style, quests, approved] = await Promise.all([
    getCompanion(userId), getEntitlements(userId), getChatStyle(userId), ensureQuests(userId), isApproved(userId),
  ]);
  return {
    id: u.id, handle: u.handle, displayName: u.display_name, initials: initialsOf(u.display_name), avatarColor: u.avatar_color, avatarUrl: u.avatar_url,
    timezone: u.timezone, readReceipts: u.read_receipts, notificationsEnabled: u.notifications_enabled, approved, companion, entitlements, chatStyle: style.style, quests,
  };
}

/** Everything a client needs to render someone's messages (doc 6.10). style = null for free users (and after downgrade). */
export async function userStyles(ids: string[]): Promise<UserStyle[]> {
  if (ids.length === 0) return [];
  const rows = await q<{
    id: string; display_name: string; handle: string; avatar_color: string; avatar_url: string | null; plus_active: boolean | null; palette: PaletteId; equipped_outfit: Outfit; level: number; signature_move: Mood;
    bubble: string | null; text_color: string; border: string; design: ChatStyle['design']; s_avatar: string; animation: ChatStyle['animation']; wallpaper: string | null; version: number | null;
    avatar_animation: ChatStyle['avatarAnimation'] | null; avatar_effect: ChatStyle['avatarEffect'] | null; avatar_charm: ChatStyle['avatarCharm'] | null;
  }>(
    `SELECT u.id, u.display_name, u.handle, u.avatar_color, u.avatar_url, e.plus_active, c.palette, c.equipped_outfit, c.level, c.signature_move,
            s.bubble, s.text_color, s.border, s.design, s.avatar_color AS s_avatar, s.animation, s.wallpaper, s.version,
            s.avatar_animation, s.avatar_effect, s.avatar_charm
       FROM users u
       LEFT JOIN entitlements e ON e.user_id = u.id
       LEFT JOIN companions c ON c.user_id = u.id
       LEFT JOIN chat_styles s ON s.user_id = u.id
      WHERE u.id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map((r) => {
    const plus = !!r.plus_active;
    const style = plus ? (r.bubble ? styleFromRow({ bubble: r.bubble, text_color: r.text_color, border: r.border, design: r.design, avatar_color: r.s_avatar, animation: r.animation, wallpaper: r.wallpaper, version: r.version ?? 1, avatar_animation: r.avatar_animation, avatar_effect: r.avatar_effect, avatar_charm: r.avatar_charm }) : DEFAULT_CHAT_STYLE) : null;
    return {
      userId: r.id, displayName: r.display_name, initials: initialsOf(r.display_name),
      handle: r.handle, avatarUrl: r.avatar_url,
      avatarColor: plus && style ? style.avatar : r.avatar_color, isPlus: plus, style,
      companion: { palette: r.palette ?? 'mo', outfit: r.equipped_outfit ?? 'none', level: r.level ?? 1, signatureMove: r.signature_move ?? 'wave' },
      // Version changes whenever anything visible changes (style saved, plan changed) so client caches refresh.
      version: (r.version ?? 0) * 2 + (plus ? 1 : 0),
    };
  });
}
export async function userStyleOf(userId: string) {
  return (await userStyles([userId]))[0] ?? null;
}

/** Everyone who shares at least one conversation with the user (targets for style/presence broadcasts). */
export async function peersOf(userId: string): Promise<string[]> {
  const rows = await q<{ user_id: string }>(
    `SELECT DISTINCT m2.user_id FROM conversation_members m1
       JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
      WHERE m1.user_id = $1 AND m2.user_id <> $1`, [userId],
  );
  return rows.map((r) => r.user_id);
}

/** Presence audience: friends + people in shared conversations, minus anyone who blocked this user. */
export async function presenceAudience(userId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT friend_id AS id FROM friendships WHERE user_id = $1 AND status = 'accepted'
     UNION SELECT user_id FROM friendships WHERE friend_id = $1 AND status = 'accepted'
     UNION SELECT DISTINCT m2.user_id FROM conversation_members m1 JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
            WHERE m1.user_id = $1 AND m2.user_id <> $1`, [userId],
  );
  const blocked = new Set((await q<{ user_id: string }>(`SELECT user_id FROM friendships WHERE friend_id = $1 AND status = 'blocked'`, [userId])).map((r) => r.user_id));
  return rows.map((r) => r.id).filter((id) => !blocked.has(id));
}

export async function isBlocked(a: string, b: string): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM friendships WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)) AND status = 'blocked'`, [a, b]));
}

async function toPeople(rows: { id: string; display_name: string; handle: string; avatar_color: string; avatar_url: string | null }[]): Promise<Person[]> {
  const online = await onlineMap(rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, handle: r.handle, avatarColor: r.avatar_color, avatarUrl: r.avatar_url, initials: initialsOf(r.display_name), online: online[r.id] ?? false }));
}

export async function friends(userId: string): Promise<Person[]> {
  const rows = await q<{ id: string; display_name: string; handle: string; avatar_color: string; avatar_url: string | null }>(
    `SELECT u.id, u.display_name, u.handle, u.avatar_color, u.avatar_url FROM friendships f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = $1 AND f.status = 'accepted' ORDER BY u.display_name`, [userId],
  );
  return toPeople(rows);
}

/** Adding a friend is mutual (the app has no request inbox): both rows become accepted. */
export async function addFriend(userId: string, friendId: string) {
  if (userId === friendId) throw E.badRequest("You can't add yourself");
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [friendId]))) throw E.notFound('User not found');
  if (await isBlocked(userId, friendId)) throw E.forbidden();
  await q(
    `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'accepted'), ($2,$1,'accepted')
     ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted' WHERE friendships.status <> 'blocked'`,
    [userId, friendId],
  );
}
export async function removeFriend(userId: string, friendId: string) {
  await q(`DELETE FROM friendships WHERE status = 'accepted' AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))`, [userId, friendId]);
}
export async function blockUser(userId: string, targetId: string) {
  if (userId === targetId) throw E.badRequest("You can't block yourself");
  await q(`DELETE FROM friendships WHERE user_id = $2 AND friend_id = $1 AND status = 'accepted'`, [userId, targetId]);
  await q(
    `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'blocked')
     ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'blocked'`, [userId, targetId],
  );
}

export async function search(userId: string, term: string) {
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const people = await q<{ id: string; display_name: string; handle: string; avatar_color: string; avatar_url: string | null }>(
    `SELECT u.id, u.display_name, u.handle, u.avatar_color, u.avatar_url FROM users u
      WHERE u.id <> $1 AND (u.display_name ILIKE $2 OR u.handle ILIKE $2)
        AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'blocked' AND ((f.user_id = u.id AND f.friend_id = $1) OR (f.user_id = $1 AND f.friend_id = u.id)))
      ORDER BY (u.handle ILIKE $3) DESC, u.display_name LIMIT 20`, [userId, like, `${term}%`],
  );
  const groups = await q<{ id: string; title: string; member_count: number; max_members: number; plus_only: boolean; joined: boolean }>(
    `SELECT c.id, c.title, c.member_count, c.max_members, c.plus_only,
            EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $2) AS joined
       FROM conversations c WHERE c.kind = 'group' AND c.is_public AND c.title ILIKE $1 ORDER BY c.member_count DESC LIMIT 20`, [like, userId],
  );
  return {
    people: await toPeople(people),
    groups: groups.map((g) => ({
      id: g.id, title: g.title, memberCount: g.member_count, maxMembers: g.max_members, full: g.member_count >= g.max_members,
      plusOnly: g.plus_only, joined: g.joined,
    })),
  };
}
