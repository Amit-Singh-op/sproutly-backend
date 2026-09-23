/**
 * End-to-end payment check against a running local backend (npm run dev).
 * Talks to it exactly like the app (REST + Socket.IO) and like RevenueCat (webhooks).
 * Run: set -a && . ./.env && set +a && npx tsx test/payments.e2e.ts
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';

const API = process.env.E2E_API ?? 'http://localhost:4000/v1';
const RT = process.env.E2E_RT ?? 'http://localhost:4001';
const HOOK = process.env.REVENUECAT_WEBHOOK_AUTH!;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = any>(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signIn(email: string, name: string) {
  const s = await call('POST', '/auth/otp/start', undefined, { phoneOrEmail: email });
  const v = await call('POST', '/auth/otp/verify', undefined, { phoneOrEmail: email, code: s.body.devCode, displayName: name, timezone: 'Asia/Kolkata' });
  const me = await call('GET', '/me', v.body.accessToken);
  return { token: v.body.accessToken as string, id: me.body.id as string };
}

let t = Date.now() - 60 * 60 * 1000;
const nextTs = () => (t += 1000);
const DAY = 86400000;
function event(type: string, userId: string, extra: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      id: randomUUID(), type, app_user_id: userId, original_app_user_id: userId, aliases: [userId],
      product_id: 'plus_yearly', entitlement_ids: ['plus'], period_type: 'NORMAL', store: 'PLAY_STORE', environment: 'SANDBOX',
      purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 365 * DAY, event_timestamp_ms: nextTs(), ...extra,
    },
  };
}
const hook = (payload: unknown, auth = HOOK) => call('POST', '/webhooks/revenuecat', undefined, payload, { Authorization: auth });
const plusOf = async (token: string) => (await call('GET', '/me', token)).body.entitlements;

async function main() {
  const stamp = Date.now();
  const a = await signIn(`buyer${stamp}@test.dev`, 'Asha Buyer');
  const b = await signIn(`friend${stamp}@test.dev`, 'Bo Friend');
  console.log('\nSign-in');
  check('two users created, both free', !(await plusOf(a.token)).plusActive && !(await plusOf(b.token)).plusActive);

  // Live entitlement pushes over the socket, like the app receives them.
  const pushes: any[] = [];
  const sock: Socket = io(RT, { transports: ['websocket'], auth: { token: a.token } });
  await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
  sock.on('me:entitlements', (p) => pushes.push(p));

  console.log('\nFree user is gated (403 PLUS_REQUIRED)');
  const gOutfit = await call('PATCH', '/companion', a.token, { equippedOutfit: 'wizard' });
  check('Plus outfit refused', gOutfit.status === 403 && gOutfit.body.code === 'PLUS_REQUIRED', gOutfit.body);
  const style = { bubble: '#3B2A6B', text: '#FFFFFF', border: '#E7B94A', design: 'glow', avatar: '#2B2340', animation: 'pop', wallpaper: 'night' };
  const gStyle = await call('PUT', '/chat-style', a.token, style);
  check('chat style refused', gStyle.status === 403 && gStyle.body.code === 'PLUS_REQUIRED', gStyle.body);
  const gDance = await call('POST', '/companion/actions', a.token, { action: 'dance' });
  check('dance refused', gDance.status === 403, gDance.body);

  console.log('\nWebhook security');
  check('wrong secret -> 401', (await hook(event('INITIAL_PURCHASE', a.id), 'nope')).status === 401);
  check('missing secret -> 401', (await call('POST', '/webhooks/revenuecat', undefined, event('INITIAL_PURCHASE', a.id))).status === 401);
  check('still free after rejected webhooks', !(await plusOf(a.token)).plusActive);

  console.log('\nPurchase (7-day trial, yearly)');
  const buy = event('INITIAL_PURCHASE', a.id, { period_type: 'TRIAL', expiration_at_ms: Date.now() + 7 * DAY });
  const r1 = await hook(buy);
  check('webhook accepted', r1.status === 200 && r1.body.result === 'applied', r1.body);
  let ent = await plusOf(a.token);
  check('Plus active, yearly, has period end', ent.plusActive && ent.period === 'yearly' && !!ent.currentPeriodEnd, ent);
  await sleep(300);
  check('app got live me:entitlements push', pushes.some((p) => p.plusActive), pushes);
  const dup = await hook(buy);
  check('same event again = duplicate, no-op', dup.status === 200 && dup.body.result === 'duplicate', dup.body);

  console.log('\nPlus features unlocked');
  check('Plus outfit equips', (await call('PATCH', '/companion', a.token, { equippedOutfit: 'wizard' })).status === 200);
  check('chat style saves (night wallpaper)', (await call('PUT', '/chat-style', a.token, style)).status === 200);
  check('saved wallpaper comes back', (await call('GET', '/chat-style', a.token)).body.wallpaper === 'night');
  const bad = await call('PUT', '/chat-style', a.token, { ...style, bubble: '#FFFFFF', text: '#FFFFFF' });
  check('unreadable style (white on white) rejected', bad.status === 400, bad.body);
  check('dance works', (await call('POST', '/companion/actions', a.token, { action: 'dance' })).status === 200);

  console.log('\nOrdering & lifecycle');
  const stale = event('EXPIRATION', a.id, { event_timestamp_ms: t - 30 * 60 * 1000 });
  await hook(stale);
  check('older EXPIRATION arriving late is ignored', (await plusOf(a.token)).plusActive);
  await hook(event('RENEWAL', a.id, { expiration_at_ms: Date.now() + 365 * DAY }));
  check('RENEWAL keeps Plus', (await plusOf(a.token)).plusActive);
  await hook(event('PRODUCT_CHANGE', a.id, { product_id: 'plus_yearly', new_product_id: 'plus_monthly' }));
  check('scheduled PRODUCT_CHANGE keeps current plan until renewal', (await plusOf(a.token)).period === 'yearly');
  await hook(event('CANCELLATION', a.id, { expiration_at_ms: Date.now() + 20 * DAY }));
  check('CANCELLATION keeps Plus until period end', (await plusOf(a.token)).plusActive);
  await hook(event('BILLING_ISSUE', a.id, { expiration_at_ms: Date.now() - DAY, grace_period_expiration_at_ms: Date.now() + 3 * DAY }));
  check('BILLING_ISSUE keeps Plus (grace period)', (await plusOf(a.token)).plusActive);
  await hook(event('UNCANCELLATION', a.id, { expiration_at_ms: Date.now() + 20 * DAY }));
  check('UNCANCELLATION keeps Plus', (await plusOf(a.token)).plusActive);

  console.log('\nExpiry + downgrade rules (worker)');
  await hook(event('EXPIRATION', a.id, { expiration_at_ms: Date.now() - 1000 }));
  ent = await plusOf(a.token);
  check('EXPIRATION ends Plus', !ent.plusActive && ent.period === null, ent);
  let comp: any = null;
  for (let i = 0; i < 20; i++) { comp = (await call('GET', '/companion', a.token)).body; if (comp.equippedOutfit === 'none') break; await sleep(250); }
  check('Plus outfit reset to none by worker', comp.equippedOutfit === 'none', comp);
  const styles = (await call('GET', `/users/styles?ids=${a.id}`, b.token)).body;
  check('others now see free styling (style = null)', styles[0]?.isPlus === false && styles[0]?.style === null, styles);
  check('chat style locked again', (await call('PUT', '/chat-style', a.token, style)).status === 403);

  console.log('\nRe-subscribe, then refund');
  await hook(event('INITIAL_PURCHASE', a.id, { product_id: 'plus_monthly', expiration_at_ms: Date.now() + 30 * DAY }));
  ent = await plusOf(a.token);
  check('re-purchase restores Plus, monthly', ent.plusActive && ent.period === 'monthly', ent);
  await hook(event('CANCELLATION', a.id, { product_id: 'plus_monthly', expiration_at_ms: Date.now() - 1000, cancel_reason: 'CUSTOMER_SUPPORT' }));
  check('refund (cancel with past expiry) ends Plus now', !(await plusOf(a.token)).plusActive);

  console.log('\nTransfer & edge cases');
  await hook(event('INITIAL_PURCHASE', a.id, { expiration_at_ms: Date.now() + 365 * DAY }));
  await hook(event('TRANSFER', a.id, { transferred_from: [a.id], transferred_to: [b.id] }));
  check('TRANSFER removes Plus from the old account', !(await plusOf(a.token)).plusActive);
  const unk = await hook(event('INITIAL_PURCHASE', randomUUID()));
  check('event for unknown user is acknowledged, changes nothing', unk.status === 200 && unk.body.result === 'unknown_user', unk.body);
  const other = await hook({ event: { ...event('INITIAL_PURCHASE', b.id).event, entitlement_ids: ['something_else'] } });
  check('event for another entitlement is ignored', other.body.result === 'ignored' && !(await plusOf(b.token)).plusActive, other.body);
  const junk = await hook({ nope: true });
  check('malformed payload -> 400', junk.status === 400, junk.body);
  const sync = await call('POST', '/purchases/sync', a.token, {}); // the app always sends a JSON body
  check('/purchases/sync answers with current entitlements', sync.status === 200 && typeof sync.body.plusActive === 'boolean', sync.body);
  check('/purchases/sync needs sign-in', (await call('POST', '/purchases/sync')).status === 401);

  sock.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
