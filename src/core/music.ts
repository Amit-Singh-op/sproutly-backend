/**
 * Songs from music apps (Spotify, YouTube / YouTube Music, Apple Music, SoundCloud), shown as cards:
 *   - "your songs" on your profile, up to SONGS_MAX (friends see them on your profile, the newest in their friends list), and
 *   - in chats: a text message with a song link gets the card as its payload (see messages.ts).
 * Title, artist and cover come from the provider's public preview (oEmbed, or Open Graph tags for Apple), so no
 * account or API key is needed. Lookups are cached in Redis, so the same link shared again is instant.
 */
import { one, q } from '../db/pool.js';
import { toUsers } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { limit } from '../lib/ratelimit.js';
import { redis } from '../lib/redis.js';
import { providerOf, songKey } from '../shared/music.js';
import { SONGS_MAX, type SongCard } from '../shared/types.js';

const TIMEOUT_MS = 5000;
const clip = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n) || null;
const httpsOrNull = (u: unknown) => (typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) && u.length <= 500 ? u : null);

// ---------------- lookup ----------------

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** A provider's public song page (only ever the fixed music hosts providerOf allows). */
async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; SproutlyBot/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, 300_000);
}

const metaContent = (html: string, prop: string) =>
  html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1]
  ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, 'i'))?.[1];
const unescapeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Title, artist and cover for a song link (the provider's public preview: oEmbed, or Open Graph tags for Apple). */
export async function songFromLink(link: string): Promise<SongCard> {
  const found = providerOf(link);
  if (!found) throw E.badRequest('Paste a link from Spotify, YouTube, Apple Music or SoundCloud');
  const { url, provider } = found;
  const canonical = url.toString().slice(0, 500);
  let title: string | null = null, artist: string | null = null, art: unknown = null;
  try {
    if (provider === 'spotify') {
      // The track page has the artist (oEmbed only has the title); oEmbed stays as the fallback.
      const html = await getHtml(canonical).catch(() => '');
      const artists = [...html.matchAll(/<meta[^>]+name=["']music:musician_description["'][^>]+content=["']([^"']*)["']/gi)].map((m) => unescapeHtml(m[1]!));
      title = clip(unescapeHtml(metaContent(html, 'og:title') ?? ''), 120);
      artist = clip(artists.join(', '), 80);
      art = metaContent(html, 'og:image');
      if (!title) {
        const j = await getJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(canonical)}`);
        title = clip(j.title as string, 120);
        art = j.thumbnail_url;
      }
    } else if (provider === 'youtube') {
      // YouTube Music links work with YouTube's oEmbed once pointed at www.youtube.com.
      const v = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
      const lookup = v ? `https://www.youtube.com/watch?v=${encodeURIComponent(v)}` : canonical.replace('://music.', '://www.');
      const j = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(lookup)}`);
      title = clip(j.title as string, 120);
      artist = clip((j.author_name as string | undefined)?.replace(/\s+-\s+Topic$/, ''), 80);
      art = j.thumbnail_url;
    } else if (provider === 'soundcloud') {
      const j = await getJson(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(canonical)}`);
      artist = clip(j.author_name as string, 80);
      const raw = (j.title as string | undefined) ?? '';
      title = clip(artist && raw.endsWith(` by ${artist}`) ? raw.slice(0, -` by ${artist}`.length) : raw, 120);
      art = j.thumbnail_url;
    } else {
      const html = await getHtml(canonical);
      // "‎Song Name - Song by Artist - Apple Music" (also "Album by Artist on Apple Music")
      const og = unescapeHtml(metaContent(html, 'og:title') ?? '').replace(/^‎/, '').replace(/\s+(-|on)\s+Apple Music$/i, '');
      const m = og.match(/^(.*?)\s+-\s+(?:Song|Single|EP|Album)\s+by\s+(.*)$/i) ?? og.match(/^(.*?)\s+by\s+(.*)$/i);
      title = clip(m ? m[1] : og, 120);
      artist = clip(m?.[2], 80);
      art = metaContent(html, 'og:image');
    }
  } catch (err) {
    log.info({ provider, err: (err as Error).message }, 'song preview failed');
    throw new AppError(422, 'SONG_NOT_FOUND', "Couldn't find that song. Check the link and try again.");
  }
  if (!title) throw new AppError(422, 'SONG_NOT_FOUND', "Couldn't find that song. Check the link and try again.");
  return { url: canonical, title, artist, artUrl: httpsOrNull(art), provider };
}

/** songFromLink with a Redis cache: hits for a week, misses for an hour (so a broken link isn't fetched on every send). */
export async function songCached(link: string): Promise<SongCard | null> {
  const found = providerOf(link);
  if (!found) return null;
  const key = `song2:${songKey(link)}`; // v2: Spotify cards carry the artist
  try {
    const hit = await redis.get(key);
    if (hit) return hit === '-' ? null : (JSON.parse(hit) as SongCard);
  } catch { /* no cache: look it up */ }
  const song = await songFromLink(link).catch(() => null);
  redis.set(key, song ? JSON.stringify(song) : '-', 'EX', song ? 7 * 86400 : 3600).catch(() => {});
  return song;
}

// ---------------- your songs ----------------

/** The songs on someone's profile, newest first. */
export async function songsOfUser(userId: string): Promise<SongCard[]> {
  const songs = (await one<{ songs: SongCard[] }>('SELECT songs FROM user_music WHERE user_id = $1', [userId]))?.songs ?? [];
  if (songs.some((s) => s.provider === 'spotify' && !s.artist)) void fillArtists(userId, songs).catch(() => {});
  return songs;
}

/** Spotify songs saved before cards carried the artist: look them up again in the background and save once. */
const filling = new Set<string>();
async function fillArtists(userId: string, songs: SongCard[]) {
  if (filling.has(userId)) return;
  filling.add(userId);
  try {
    const next = await Promise.all(songs.map(async (s) => (s.provider === 'spotify' && !s.artist ? (await songCached(s.url)) ?? s : s)));
    if (next.some((s, i) => s.artist !== songs[i]!.artist)) {
      await q('UPDATE user_music SET songs = $2, updated_at = now() WHERE user_id = $1', [userId, JSON.stringify(next)]);
      await tell(userId, next);
    }
  } finally {
    filling.delete(userId);
  }
}

/** The newest song of many people at once (the friends list). People without one are left out. */
export async function topSongsOf(userIds: string[]): Promise<Record<string, SongCard>> {
  const out: Record<string, SongCard> = {};
  if (userIds.length === 0) return out;
  const rows = await q<{ user_id: string; song: SongCard }>(
    `SELECT user_id, songs->0 AS song FROM user_music WHERE user_id = ANY($1::uuid[]) AND jsonb_array_length(songs) > 0`, [userIds]);
  for (const r of rows) out[r.user_id] = r.song;
  return out;
}

/** Tell the person and their friends (blocks remove the friendship, so they're not in it). */
async function tell(userId: string, songs: SongCard[]) {
  const rows = await q<{ id: string }>(`SELECT friend_id AS id FROM friendships WHERE user_id = $1 AND status = 'accepted'`, [userId]);
  toUsers([userId, ...rows.map((r) => r.id)], 'music:update', { userId, songs });
}

async function saveSongs(userId: string, songs: SongCard[]) {
  await q(
    `INSERT INTO user_music (user_id, songs) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET songs = EXCLUDED.songs, updated_at = now()`, [userId, JSON.stringify(songs)]);
  await tell(userId, songs);
  return { songs };
}

/** Add a song to the top of your list (the same link again just moves it up). Keeps the newest SONGS_MAX. */
export async function addSong(userId: string, link: string): Promise<{ songs: SongCard[] }> {
  await limit(`music-song:${userId}`, { points: 15, windowS: 600 }, 'That’s a lot of songs.');
  if (!providerOf(link)) throw E.badRequest('Paste a link from Spotify, YouTube, Apple Music or SoundCloud');
  const song = await songCached(link);
  if (!song) throw new AppError(422, 'SONG_NOT_FOUND', "Couldn't find that song. Check the link and try again.");
  const now = await songsOfUser(userId);
  return saveSongs(userId, [song, ...now.filter((s) => s.url !== song.url)].slice(0, SONGS_MAX));
}

export async function removeSong(userId: string, url: string): Promise<{ songs: SongCard[] }> {
  const now = await songsOfUser(userId);
  return saveSongs(userId, now.filter((s) => s.url !== url));
}
