import { z } from 'zod';
import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { PRODUCTS, periodForProduct } from '../shared/rules.js';
import { applySubscription, getEntitlements, type SubscriptionState } from './entitlements.js';

/**
 * RevenueCat integration (doc section 5).
 * - Webhooks are the source of truth for the subscription lifecycle.
 * - syncFromRevenueCat() reads the subscriber over RevenueCat's REST API; the app calls it right after a purchase or
 *   restore so Plus unlocks without waiting for the webhook to arrive.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Event = z.object({
  id: z.string(),
  type: z.string(),
  app_user_id: z.string().optional(),
  original_app_user_id: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  transferred_from: z.array(z.string()).optional(),
  transferred_to: z.array(z.string()).optional(),
  product_id: z.string().optional().nullable(),
  new_product_id: z.string().optional().nullable(),
  entitlement_ids: z.array(z.string()).optional().nullable(),
  period_type: z.string().optional().nullable(),
  purchased_at_ms: z.number().optional().nullable(),
  expiration_at_ms: z.number().optional().nullable(),
  grace_period_expiration_at_ms: z.number().optional().nullable(),
  event_timestamp_ms: z.number().optional(),
  store: z.string().optional().nullable(),
}).passthrough();
export const WebhookBody = z.object({ event: Event, api_version: z.string().optional() });
type RcEvent = z.infer<typeof Event>;

/** RevenueCat ids may be anonymous ("$RCAnonymousID:…") or aliased; find the one that is one of our users. */
async function resolveUser(ev: Pick<RcEvent, 'app_user_id' | 'original_app_user_id' | 'aliases'>): Promise<string | null> {
  const candidates = [ev.app_user_id, ev.original_app_user_id, ...(ev.aliases ?? [])].filter((x): x is string => !!x && UUID_RE.test(x));
  for (const id of candidates) {
    if (await one('SELECT 1 FROM users WHERE id = $1', [id])) return id;
  }
  // Check if candidate was original_user_id of a preserved subscription where user rejoined
  for (const id of candidates) {
    const row = await one<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN preserved_subscriptions p ON p.login = u.login
        WHERE p.original_user_id = $1`,
      [id]
    );
    if (row) return row.id;
  }
  return null;
}

const touchesPlus = (ev: RcEvent) => !ev.entitlement_ids || ev.entitlement_ids.length === 0 || ev.entitlement_ids.some(id => /plus|pro/i.test(id));

function stateFromEvent(ev: RcEvent): SubscriptionState {
  const now = Date.now();
  const expires = ev.expiration_at_ms ?? null;
  const grace = ev.grace_period_expiration_at_ms ?? null;
  const notExpired = expires === null || expires > now || (grace !== null && grace > now);
  // PRODUCT_CHANGE is sent when a plan change is *scheduled*; the new product only applies from the next RENEWAL,
  // which carries it. Until then the user keeps the plan they paid for.
  const productId = ev.product_id ?? null;
  const base = {
    productId,
    period: periodForProduct(productId),
    trial: ev.period_type === 'TRIAL',
    currentPeriodEnd: expires ? new Date(expires) : null,
    store: ev.store ?? null,
    purchasedAt: ev.purchased_at_ms ? new Date(ev.purchased_at_ms) : null,
  };
  switch (ev.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'NON_RENEWING_PURCHASE':
    case 'SUBSCRIPTION_EXTENDED':
    case 'TEMPORARY_ENTITLEMENT_GRANT':
      return { ...base, active: notExpired, status: notExpired ? 'active' : 'expired', willRenew: true, billingIssueAt: null };
    case 'CANCELLATION':
      // Still active until the end of the paid period.
      return { ...base, active: notExpired, status: notExpired ? 'cancelled' : 'expired', willRenew: false, billingIssueAt: null };
    case 'BILLING_ISSUE':
      // Grace period: keep Plus while the store retries the charge.
      return { ...base, active: true, status: 'billing_issue', willRenew: true, billingIssueAt: new Date(ev.event_timestamp_ms ?? now) };
    case 'EXPIRATION':
      return { ...base, active: false, status: 'expired', willRenew: false, billingIssueAt: null };
    default:
      throw new Error(`unhandled type ${ev.type}`);
  }
}

const HANDLED = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED',
  'TEMPORARY_ENTITLEMENT_GRANT', 'CANCELLATION', 'BILLING_ISSUE', 'EXPIRATION', 'TRANSFER']);

/** Returns what happened, for logs and tests. Idempotent on event.id. */
export async function handleWebhook(body: unknown): Promise<'duplicate' | 'ignored' | 'applied' | 'unknown_user'> {
  const parsed = WebhookBody.safeParse(body);
  if (!parsed.success) throw E.badRequest('Invalid RevenueCat payload');
  const ev = parsed.data.event;

  const fresh = await pool.query('INSERT INTO webhook_events (id, source) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [ev.id, 'revenuecat']);
  if (fresh.rowCount === 0) return 'duplicate';
  try {
    return await processEvent(ev);
  } catch (err) {
    // Un-claim the id so RevenueCat's retry (we answer 5xx) is processed instead of being dropped as a duplicate.
    await pool.query('DELETE FROM webhook_events WHERE id = $1', [ev.id]).catch(() => {});
    throw err;
  }
}

async function processEvent(ev: RcEvent): Promise<'ignored' | 'applied' | 'unknown_user'> {
  if (!HANDLED.has(ev.type) || !touchesPlus(ev)) {
    log.info({ type: ev.type, id: ev.id }, 'revenuecat event ignored');
    return 'ignored';
  }
  const eventMs = ev.event_timestamp_ms ?? Date.now();

  if (ev.type === 'TRANSFER') {
    // Doc: move the entitlement between users. Losers are deactivated; winners get the current store state.
    for (const from of ev.transferred_from ?? []) {
      const uid = await resolveUser({ app_user_id: from });
      if (uid) await applySubscription(uid, { active: false, productId: null, period: null, status: 'transferred', trial: false, currentPeriodEnd: null, willRenew: false, billingIssueAt: null, store: null, purchasedAt: null }, eventMs);
    }
    for (const to of ev.transferred_to ?? []) {
      const uid = await resolveUser({ app_user_id: to });
      if (uid) await syncFromRevenueCat(uid).catch((err) => log.warn({ err, uid }, 'transfer sync failed'));
    }
    return 'applied';
  }

  const userId = await resolveUser(ev);
  if (!userId) {
    log.warn({ id: ev.id, appUserId: ev.app_user_id }, 'revenuecat event for unknown user');
    return 'unknown_user';
  }
  await applySubscription(userId, stateFromEvent(ev), eventMs);
  return 'applied';
}

// ---------------- REST: GET /v1/subscribers/{app_user_id} ----------------
const Subscriber = z.object({
  subscriber: z.object({
    entitlements: z.record(z.object({
      expires_date: z.string().nullable(),
      grace_period_expires_date: z.string().nullable().optional(),
      product_identifier: z.string(),
      purchase_date: z.string().nullable().optional(),
    })).default({}),
    subscriptions: z.record(z.object({
      period_type: z.string().nullable().optional(),
      unsubscribe_detected_at: z.string().nullable().optional(),
      billing_issues_detected_at: z.string().nullable().optional(),
      store: z.string().nullable().optional(),
      expires_date: z.string().nullable().optional(),
    })).default({}),
  }),
});

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Test hook. */
export const setRevenueCatFetch = (f: Fetch) => { fetchImpl = f; };

export async function syncFromRevenueCat(userId: string) {
  if (!config.REVENUECAT_SECRET_KEY) {
    // Without the secret key we can only rely on webhooks; report current state.
    return getEntitlements(userId);
  }
  const res = await fetchImpl(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${config.REVENUECAT_SECRET_KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) throw E.unavailable('PURCHASES_UNAVAILABLE', `RevenueCat returned ${res.status}`);
  const data = Subscriber.parse(await res.json());
  const ent = data.subscriber.entitlements[PRODUCTS.entitlement] ?? data.subscriber.entitlements['sproutly_pro'] ?? Object.values(data.subscriber.entitlements)[0];
  const now = Date.now();
  let state: SubscriptionState;
  if (!ent) {
    state = { active: false, productId: null, period: null, status: 'none', trial: false, currentPeriodEnd: null, willRenew: false, billingIssueAt: null, store: null, purchasedAt: null };
  } else {
    const exp = ent.expires_date ? Date.parse(ent.expires_date) : null;
    const grace = ent.grace_period_expires_date ? Date.parse(ent.grace_period_expires_date) : null;
    const active = exp === null || exp > now || (grace !== null && grace > now);
    const sub = data.subscriber.subscriptions[ent.product_identifier];
    state = {
      active,
      productId: ent.product_identifier,
      period: periodForProduct(ent.product_identifier),
      status: !active ? 'expired' : sub?.billing_issues_detected_at ? 'billing_issue' : sub?.unsubscribe_detected_at ? 'cancelled' : 'active',
      trial: sub?.period_type === 'trial',
      currentPeriodEnd: exp ? new Date(exp) : null,
      willRenew: !sub?.unsubscribe_detected_at,
      billingIssueAt: sub?.billing_issues_detected_at ? new Date(sub.billing_issues_detected_at) : null,
      store: sub?.store ?? null,
      purchasedAt: ent.purchase_date ? new Date(ent.purchase_date) : null,
    };
  }
  // A REST read reflects "now", so it outranks any webhook generated before this moment.
  await applySubscription(userId, state, now);
  return getEntitlements(userId);
}
