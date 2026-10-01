import { z } from 'zod';
import { q } from '../db/pool.js';
import { ANALYTICS_EVENT_MAX } from '../shared/types.js';

/** Kept this long, then dropped by the cleanup job. */
export const ANALYTICS_KEEP_DAYS = 180;
const PROPS_MAX_BYTES = 2048;

const Prop = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
export const AnalyticsBody = z.object({
  platform: z.enum(['ios', 'android', 'web']).optional(),
  appVersion: z.string().max(40).optional(),
  events: z.array(z.object({
    name: z.string().regex(/^[a-z0-9_.]{1,64}$/),
    props: z.record(z.string().max(40), Prop).optional(),
    at: z.string().datetime(),
  })).min(1).max(ANALYTICS_EVENT_MAX),
});

/**
 * First-party usage events (no third parties). Timestamps from the phone are trusted only within a sane window
 * (queued offline up to a week; never in the future) and props are size-capped.
 */
export async function recordEvents(userId: string, body: z.infer<typeof AnalyticsBody>) {
  const now = Date.now();
  const rows = body.events
    .map((e) => ({ ...e, t: Date.parse(e.at), props: JSON.stringify(e.props ?? {}) }))
    .filter((e) => Number.isFinite(e.t) && e.t <= now + 5 * 60_000 && e.t >= now - 7 * 86400_000 && e.props.length <= PROPS_MAX_BYTES);
  if (rows.length === 0) return 0;
  await q(
    `INSERT INTO analytics_events (user_id, name, props, platform, app_version, at)
     SELECT $1, n, p::jsonb, $5, $6, a FROM unnest($2::text[], $3::text[], $4::timestamptz[]) AS x(n, p, a)`,
    [userId, rows.map((r) => r.name), rows.map((r) => r.props), rows.map((r) => new Date(r.t).toISOString()), body.platform ?? null, body.appVersion ?? null],
  );
  return rows.length;
}
