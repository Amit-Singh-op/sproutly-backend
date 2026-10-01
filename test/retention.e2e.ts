/**
 * End-to-end retention check against a running LOCAL backend (never point this at production: it rewrites rows to
 * simulate days passing). Talks to the API like the app; uses SQL only to move time.
 * Run (local docker db + redis, api on 4100):
 *   DATABASE_URL=postgres://sproutly:sproutly@localhost:5433/sproutly E2E_API=http://localhost:4100/v1 npx tsx test/retention.e2e.ts
 */
import pg from 'pg';
import { DROP_ENERGY } from '../src/shared/rules.js';
import { QUEST_CHEST, levelCoins, EGG_DAYS, MAX_SHIELDS, ROOM_GIFT_COINS, SHOP_OFFERS, addDays, offerPrice } from '../src/shared/retention.js';

const API = process.env.E2E_API ?? 'http://localhost:4100/v1';
const DB = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(DB) || !/localhost|127\.0\.0\.1/.test(API)) {
  console.error('Refusing to run: DATABASE_URL and E2E_API must both point at localhost.');
  process.exit(2);
}
const db = new pg.Pool({ connectionString: DB });
pg.types.setTypeParser(1082, (v) => v);

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) { await sleep(250); v = await fn(); }
  return v;
}

async function call<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function signIn(email: string, name: string, timezone = 'Asia/Kolkata') {
  const s = await call('POST', '/auth/otp/start', undefined, { phoneOrEmail: email });
  const v = await call('POST', '/auth/otp/verify', undefined, { phoneOrEmail: email, code: s.body.devCode, displayName: name, timezone });
  const me = await call('GET', '/me', v.body.accessToken);
  return { token: v.body.accessToken as string, id: me.body.id as string };
}
const sql = (text: string, params: unknown[] = []) => db.query(text, params).then((r) => r.rows);
const localToday = async (userId: string) => (await sql(`SELECT to_char(now() AT TIME ZONE u.timezone, 'YYYY-MM-DD') AS d FROM users u WHERE id = $1`, [userId]))[0].d as string;

async function main() {
  const stamp = Date.now();
  const A = await signIn(`ret-a-${stamp}@test.dev`, 'Asha Retain');
  const B = await signIn(`ret-b-${stamp}@test.dev`, 'Bo Retain', 'America/Los_Angeles');
  await call('POST', `/friends/${B.id}`, A.token);

  console.log('\nNew account');
  const me = (await call('GET', '/me', A.token)).body;
  check('starts with one banked shield', me.companion.shields === 1, me.companion);
  check('no last action yet', me.companion.lastActionAt === null);
  check('four quests today, one of them social', me.quests.length === 4 && me.quests.some((q: any) => ['visit2', 'sticker', 'guestbook'].includes(q.key)), me.quests.map((q: any) => q.key));
  const egg0 = (await call('GET', '/egg', A.token)).body.egg;
  check('starter egg waiting, not warmed', egg0 && egg0.progress === 0 && egg0.target === EGG_DAYS && !egg0.ready && egg0.source === 'starter', egg0);
  const eggAgain = (await call('GET', '/egg', A.token)).body.egg;
  check('looking twice does not make a second egg', eggAgain.id === egg0.id);

  console.log('\nCompanion action');
  const r1 = (await call('POST', '/companion/actions', A.token, { action: 'pet' })).body;
  check('streak 1, lastActionAt and lastActiveDay set', r1.streak === 1 && !!r1.lastActionAt && r1.lastActiveDay === await localToday(A.id), r1);
  check('egg warmed once today', r1.egg?.progress === 1 && r1.egg.warmedToday, r1.egg);
  check('no comeback / milestone on a first action', !r1.comeback && !r1.milestone);
  const r2 = (await call('POST', '/companion/actions', A.token, { action: 'feed' })).body;
  check('a second action the same day does not warm again', r2.egg?.progress === 1, r2.egg);
  const early = await call('POST', '/egg/hatch', A.token);
  check('hatching too early is refused', early.status === 409 && early.body.code === 'EGG_NOT_READY', early.body);

  console.log('\nEgg hatch');
  await sql('UPDATE eggs SET progress = target WHERE user_id = $1 AND hatched_at IS NULL', [A.id]);
  const coinsBefore = (await sql('SELECT coins FROM companions WHERE user_id = $1', [A.id]))[0].coins;
  const h = await call('POST', '/egg/hatch', A.token);
  check('ready egg hatches', h.status === 200 && (h.body.reward.coins > 0 || !!h.body.reward.itemId), h.body);
  check('coins match the reward', h.body.coins === coinsBefore + h.body.reward.coins, { coinsBefore, h: h.body });
  if (h.body.reward.itemId) {
    const inv = await sql('SELECT source FROM user_inventory WHERE user_id = $1 AND item_id = $2', [A.id, h.body.reward.itemId]);
    check('hatched item is in the inventory', inv[0]?.source === 'egg', inv);
  }
  const twice = await call('POST', '/egg/hatch', A.token);
  check('cannot hatch the same egg twice', twice.status === 404 && twice.body.code === 'NO_EGG', twice.body);
  check('no new starter egg after hatching', (await call('GET', '/egg', A.token)).body.egg === null);

  console.log('\nStreak shields and milestones');
  const today = await localToday(A.id);
  await sql('UPDATE companions SET streak = 6, last_active_day = $2, shields = 1, shield_used_at = NULL WHERE user_id = $1', [A.id, addDays(today, -2)]);
  await sql(`DELETE FROM user_inventory WHERE user_id = $1 AND item_id = 'scarf'`, [A.id]);
  const s1 = (await call('POST', '/companion/actions', A.token, { action: 'pet' })).body;
  check('one missed day: banked shield saves the streak', s1.streak === 7 && s1.shieldUsed === true && s1.shields === 0, s1);
  check('day-7 milestone grants the scarf and coins', s1.milestone?.day === 7 && s1.milestone.itemId === 'scarf' && s1.milestone.coins === 50, s1.milestone);
  check('scarf really in inventory (source streak)', (await sql(`SELECT source FROM user_inventory WHERE user_id = $1 AND item_id = 'scarf'`, [A.id]))[0]?.source === 'streak');
  const feedB = await until(() => call('GET', '/activity', B.token), (r) => r.body.items.some((i: any) => i.kind === 'streak_milestone'));
  check('friend sees the streak milestone in their feed', feedB.body.items.some((i: any) => i.kind === 'streak_milestone' && i.actor?.id === A.id && i.data.day === 7), feedB.body);

  await sql('UPDATE companions SET streak = 6, last_active_day = $2 WHERE user_id = $1', [A.id, addDays(today, -1)]);
  const s2 = (await call('POST', '/companion/actions', A.token, { action: 'pet' })).body;
  check('reaching 7 again pays nothing (once per account)', s2.streak === 7 && !s2.milestone, s2);

  await sql('UPDATE companions SET streak = 13, last_active_day = $2, shields = 0 WHERE user_id = $1', [A.id, addDays(today, -2)]);
  const s3 = (await call('POST', '/companion/actions', A.token, { action: 'pet' })).body;
  check('missed day with no shield restarts at 1', s3.streak === 1 && !s3.shieldUsed, s3);

  await sql(`UPDATE companions SET streak = 13, last_active_day = $2, shields = 0 WHERE user_id = $1`, [A.id, addDays(today, -1)]);
  await sql(`INSERT INTO user_inventory (user_id, item_id, source) VALUES ($1, 'flower', 'shop') ON CONFLICT DO NOTHING`, [A.id]);
  const s4 = (await call('POST', '/companion/actions', A.token, { action: 'pet' })).body;
  check('milestone item already owned becomes coins (100 + 150)', s4.milestone?.day === 14 && !s4.milestone.itemId && s4.milestone.coins === 250, s4.milestone);

  console.log('\nComeback');
  await sql(`UPDATE companions SET last_action_at = now() - interval '4 days' WHERE user_id = $1`, [A.id]);
  const c0 = (await sql('SELECT coins FROM companions WHERE user_id = $1', [A.id]))[0].coins;
  const cb = (await call('POST', '/companion/actions', A.token, { action: 'feed' })).body;
  check('first action back gives the welcome gift', cb.comeback?.coins === 25 && cb.comeback.energy === 50 && cb.coins === c0 + 25, { cb, c0 });
  const cb2 = (await call('POST', '/companion/actions', A.token, { action: 'feed' })).body;
  check('only once', !cb2.comeback);

  console.log('\nNightly streak reset');
  const { streakResets } = await import('../src/worker/jobs.js');
  const tB = await localToday(B.id);
  await sql('UPDATE companions SET streak = 5, last_active_day = $2, shields = 1 WHERE user_id = $1', [B.id, addDays(tB, -2)]);
  await streakResets();
  check('kept overnight while a shield can still save it', (await sql('SELECT streak FROM companions WHERE user_id = $1', [B.id]))[0].streak === 5);
  await sql('UPDATE companions SET shields = 0 WHERE user_id = $1', [B.id]);
  await streakResets();
  check('dropped to 0 without a shield', (await sql('SELECT streak FROM companions WHERE user_id = $1', [B.id]))[0].streak === 0);

  console.log('\nDaily drop');
  const d1 = (await call('POST', '/drops/today/claim', B.token)).body;
  check('very first gift is at least rare', d1.reward && d1.reward.rarity !== 'common', d1.reward);
  check('no event running → multiplier 1', d1.bonus?.eventMultiplier === 1, d1.bonus);
  const again = await call('POST', '/drops/today/claim', B.token);
  check('cannot claim twice', again.status === 409);
  // Make B's next claim the 7th day of the track and run a 2x event.
  await sql('DELETE FROM daily_drops WHERE user_id = $1', [B.id]);
  for (let i = 6; i >= 1; i--) {
    await sql(`INSERT INTO daily_drops (user_id, day, track_day, rarity, energy) VALUES ($1, $2, $3, 'common', 25)`, [B.id, addDays(tB, -(7 - i)), i]);
  }
  await sql('UPDATE companions SET shields = 1 WHERE user_id = $1', [B.id]);
  await sql(`UPDATE eggs SET hatched_at = now() WHERE user_id = $1 AND hatched_at IS NULL`, [B.id]);
  await sql(`UPDATE events SET starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' WHERE title = 'Spooky Sprout Week'`);
  const ev = (await call('GET', '/events/current', B.token)).body;
  check('current event has emoji, multiplier and end', ev?.emoji === '🎃' && ev.dropMultiplier === 2 && !!ev.endsAt, ev);
  const d7 = (await call('POST', '/drops/today/claim', B.token)).body;
  check('day 7 is rare or better', d7.reward.rarity !== 'common', d7.reward);
  check('event doubles the energy', d7.bonus.eventMultiplier === 2 && d7.reward.energy === DROP_ENERGY[d7.reward.rarity as 'rare'] * 2, d7);
  check('day 7 banks a shield and starts an egg', d7.bonus.shield === true && d7.bonus.egg === true && d7.shields === 2, d7);
  check('the new egg came from the drop', (await call('GET', '/egg', B.token)).body.egg?.source === 'drop');
  await sql(`UPDATE events SET starts_at = '2026-10-24T00:00:00Z', ends_at = '2026-11-02T00:00:00Z' WHERE title = 'Spooky Sprout Week'`);

  console.log('\nShop');
  await sql(`DELETE FROM user_inventory WHERE user_id = $1 AND item_id IN ('scarf','flower')`, [B.id]);
  await sql('UPDATE companions SET coins = 0, shields = 0 WHERE user_id = $1', [B.id]);
  const shop = (await call('GET', '/shop', B.token)).body;
  check('four offers, one featured and discounted', shop.offers.length === 4 && shop.offers.filter((o: any) => o.featured).length === 1
    && shop.offers.every((o: any) => o.price === offerPrice(o.id)), shop.offers);
  check('egg not available while one incubates', shop.offers.find((o: any) => o.id === 'egg').available === false, shop.offers);
  const poor = await call('POST', '/shop/buy', B.token, { offerId: 'flower' });
  check('not enough coins is refused', poor.status === 400 && poor.body.code === 'INSUFFICIENT_COINS', poor.body);
  await sql('UPDATE companions SET coins = 5000 WHERE user_id = $1', [B.id]);
  const fl = await call('POST', '/shop/buy', B.token, { offerId: 'flower' });
  check('buying the flower crown works', fl.status === 200 && fl.body.itemId === 'flower' && fl.body.coins === 5000 - offerPrice('flower'), fl.body);
  const fl2 = await call('POST', '/shop/buy', B.token, { offerId: 'flower' });
  check('cannot buy it twice', fl2.status === 409 && fl2.body.code === 'ALREADY_OWNED', fl2.body);
  const eggBuy = await call('POST', '/shop/buy', B.token, { offerId: 'egg' });
  check('cannot buy an egg while one incubates', eggBuy.status === 409 && eggBuy.body.code === 'EGG_INCUBATING', eggBuy.body);
  const bad = await call('POST', '/shop/buy', B.token, { offerId: 'crown' });
  check('unknown offer is a 400', bad.status === 400);
  // Ten parallel shield taps: exactly MAX_SHIELDS succeed and exactly that many are paid for.
  const coins0 = (await sql('SELECT coins FROM companions WHERE user_id = $1', [B.id]))[0].coins;
  const taps = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/shop/buy', B.token, { offerId: 'shield' })));
  const ok = taps.filter((t) => t.status === 200).length;
  const row = (await sql('SELECT coins, shields FROM companions WHERE user_id = $1', [B.id]))[0];
  check(`parallel buys: ${ok} succeeded, shields capped at ${MAX_SHIELDS}`, ok === MAX_SHIELDS && row.shields === MAX_SHIELDS, { ok, row });
  check('coins charged exactly once per success', row.coins === coins0 - ok * offerPrice('shield'), { coins0, row });
  check('every refusal says shields are full', taps.filter((t) => t.status !== 200).every((t) => t.body.code === 'SHIELDS_FULL'));
  const ledger = await sql(`SELECT sum(amount)::int AS s FROM coin_transactions WHERE user_id = $1 AND source = 'shop'`, [B.id]);
  check('ledger matches the balance change', ledger[0].s === -(offerPrice('flower') + ok * offerPrice('shield')), ledger);
  check('all four offer ids are buyable kinds', SHOP_OFFERS.every((o) => ['item', 'shield', 'egg'].includes(o.kind)));

  console.log('\nRoom visit and guestbook');
  const bCoins = (await sql('SELECT coins FROM companions WHERE user_id = $1', [B.id]))[0].coins;
  const cheer = await call('POST', `/rooms/${B.id}/cheer`, A.token);
  check('A cheers B\'s room', cheer.status === 200, cheer.body);
  const feed = await until(() => call('GET', '/activity', B.token), (r) => r.body.items.some((i: any) => i.kind === 'room_visit'));
  const visit = feed.body.items.find((i: any) => i.kind === 'room_visit');
  check('B sees the visit with the coin gift', visit?.data.coins === ROOM_GIFT_COINS && visit.actor.id === A.id && /left 5 coins/.test(visit.text), visit);
  check('B got the coins', (await sql('SELECT coins FROM companions WHERE user_id = $1', [B.id]))[0].coins === bCoins + ROOM_GIFT_COINS);
  check('cheering twice in a day is refused', (await call('POST', `/rooms/${B.id}/cheer`, A.token)).status === 409);
  const gb = await call('POST', `/rooms/${B.id}/guestbook`, A.token, { sticker: 'heart', note: 'hi!' });
  check('A signs B\'s guestbook', gb.status === 200, gb.body);
  const feed2 = await until(() => call('GET', '/activity', B.token), (r) => r.body.items.some((i: any) => i.kind === 'guestbook'));
  check('B sees the guestbook note in the feed', feed2.body.items.some((i: any) => i.kind === 'guestbook' && i.actor.id === A.id));
  // The social quest: whichever one rotates in today should have moved for A if it was cheer or guestbook.
  const qA = (await call('GET', '/quests/today', A.token)).body;
  const social = qA.find((q: any) => ['visit2', 'sticker', 'guestbook'].includes(q.key));
  if (social.key === 'visit2') check('visit2 counts the cheer (1/2)', social.progress === 1, social);
  if (social.key === 'guestbook') check('guestbook quest done', social.done === true, social);
  if (social.key === 'sticker') check('sticker quest untouched so far', social.progress === 0, social);

  console.log('\nFriend (chat) streak');
  const dm = (await call('POST', '/conversations', A.token, { kind: 'dm', userId: B.id })).body;
  const send = (tok: string, body: string) => call('POST', `/conversations/${dm.id}/messages`, tok, { clientId: crypto.randomUUID(), type: 'text', body });
  await send(A.token, 'hey');
  const half = await until(async () => (await call('GET', '/conversations', A.token)).body.find((c: any) => c.id === dm.id), () => true, 500);
  check('one side alone does not start a streak', !half?.friendStreak, half?.friendStreak);
  await send(B.token, 'hi back');
  const both = await until(async () => (await call('GET', '/conversations', A.token)).body.find((c: any) => c.id === dm.id), (c: any) => !!c?.friendStreak);
  check('both sides today → streak 1, not at risk', both.friendStreak?.count === 1 && !both.friendStreak.atRisk && both.friendStreak.sentToday && both.friendStreak.theyToday, both.friendStreak);
  // Yesterday at 2; today both message → 3 = milestone in both feeds.
  const [ua, ub] = A.id < B.id ? [A.id, B.id] : [B.id, A.id];
  const utcToday = new Date().toISOString().slice(0, 10);
  await sql('UPDATE friend_streaks SET count = 2, last_day = $3, a_day = $3, b_day = $3 WHERE user_a = $1 AND user_b = $2', [ua, ub, addDays(utcToday, -1)]);
  const risk = (await call('GET', '/conversations', B.token)).body.find((c: any) => c.id === dm.id);
  check('nobody yet today → at risk', risk.friendStreak?.atRisk === true && risk.friendStreak.count === 2, risk.friendStreak);
  await send(A.token, 'day 3');
  await send(B.token, 'day 3!');
  const three = await until(() => call('GET', '/activity', A.token), (r) => r.body.items.some((i: any) => i.kind === 'friend_streak'));
  check('3-day chat streak lands in both feeds', three.body.items.some((i: any) => i.kind === 'friend_streak' && i.data.count === 3 && i.actor.id === B.id), three.body.items);
  const bFeed = await until(() => call('GET', '/activity', B.token), (r) => r.body.items.some((i: any) => i.kind === 'friend_streak'));
  check('…and B\'s', bFeed.body.items.some((i: any) => i.kind === 'friend_streak' && i.actor.id === A.id));
  // Sticker quest
  await call('POST', `/conversations/${dm.id}/messages`, A.token, { clientId: crypto.randomUUID(), type: 'sticker', payload: { kind: 'happy' } });
  if (social.key === 'sticker') {
    const q2 = await until(() => call('GET', '/quests/today', A.token), (r) => r.body.find((q: any) => q.key === 'sticker')?.done);
    check('sticker quest completes from a sticker message', q2.body.find((q: any) => q.key === 'sticker')?.done === true);
  }

  console.log('\nLevel-up reaches friends');
  await sql('UPDATE companions SET energy = 995 WHERE user_id = $1', [A.id]);
  const lv = (await call('POST', '/companion/actions', A.token, { action: 'play' })).body;
  check('A levels up', lv.leveledUp === true, lv);
  const lvFeed = await until(() => call('GET', '/activity', B.token), (r) => r.body.items.some((i: any) => i.kind === 'level_up'));
  check('B sees it', lvFeed.body.items.some((i: any) => i.kind === 'level_up' && i.data.level === lv.level));

  console.log('\nActivity housekeeping');
  const before = (await call('GET', '/activity', B.token)).body;
  check('unseen count matches', before.unseen === before.items.filter((i: any) => !i.seen).length && before.unseen > 0, before.unseen);
  await call('POST', '/activity/seen', B.token, { ids: [before.items[0].id] });
  check('mark one seen', (await call('GET', '/activity', B.token)).body.unseen === before.unseen - 1);
  await call('POST', '/activity/seen', B.token, {});
  check('mark all seen', (await call('GET', '/activity', B.token)).body.unseen === 0);
  const badSeen = await call('POST', '/activity/seen', B.token, { ids: ['nope'] });
  check('bad ids are a 400', badSeen.status === 400);
  await call('POST', `/users/${A.id}/block`, B.token);
  check('blocking hides their rows', (await call('GET', '/activity', B.token)).body.items.every((i: any) => i.actor?.id !== A.id));

  console.log('\nAnalytics');
  const now = new Date().toISOString();
  const an = await call('POST', '/analytics', A.token, { platform: 'android', appVersion: '1.0.0', events: [
    { name: 'app_open', at: now }, { name: 'screen.home', props: { plus: false }, at: now },
    { name: 'from_future', at: new Date(Date.now() + 3600_000).toISOString() },
  ] });
  check('valid events accepted, future one dropped', an.status === 200 && an.body.accepted === 2, an.body);
  check('bad event name rejected', (await call('POST', '/analytics', A.token, { events: [{ name: 'Bad Name!', at: now }] })).status === 400);
  check('empty batch rejected', (await call('POST', '/analytics', A.token, { events: [] })).status === 400);
  check('needs auth', (await call('POST', '/analytics', undefined, { events: [{ name: 'app_open', at: now }] })).status === 401);
  const cohort = await sql('SELECT * FROM retention_cohorts LIMIT 1');
  check('retention view answers', cohort.length === 1 && 'd1_pct' in cohort[0], cohort);

  console.log('\nQuest chest');
  const ch0 = (await call('GET', '/quests/chest', A.token)).body;
  if (!ch0.ready && !ch0.claimed) {
    const locked = await call('POST', '/quests/chest/claim', A.token);
    check('locked chest refused', locked.status === 409 && locked.body.code === 'CHEST_LOCKED', locked.body);
  }
  await sql(`UPDATE quests_daily SET completed_at = now(), progress = target WHERE user_id = $1 AND day = $2`, [A.id, await localToday(A.id)]);
  const ch1 = (await call('GET', '/quests/chest', A.token)).body;
  check('all quests done -> chest ready', ch1.ready === true && ch1.done === ch1.total, ch1);
  const c0c = (await sql('SELECT coins FROM companions WHERE user_id = $1', [A.id]))[0].coins;
  const opened = await call('POST', '/quests/chest/claim', A.token);
  check('chest pays coins', opened.status === 200 && opened.body.coins === c0c + QUEST_CHEST.coins, opened.body);
  const twiceC = await call('POST', '/quests/chest/claim', A.token);
  check('chest only once a day', twiceC.status === 409 && twiceC.body.code === 'CHEST_CLAIMED', twiceC.body);

  console.log('\nLevel-up coins');
  const lvlTx = await until(() => sql(`SELECT amount FROM coin_transactions WHERE user_id = $1 AND source = 'level_up'`, [A.id]), (r) => r.length > 0);
  check('the level-up paid coins once', lvlTx.length === 1 && lvlTx[0].amount === levelCoins(lv.level), lvlTx);

  console.log('\nWeekly recap');
  const rc = (await call('GET', '/recap/week', A.token)).body;
  check('recap counts this week', rc.daysWithCompanion >= 1 && rc.energyEarned > 0 && rc.coinsEarned > 0 && rc.chatStreakBest >= 3, rc);

  console.log('\nMe after all that');
  const meA = (await call('GET', '/me', A.token)).body.companion;
  check('me.companion exposes shields / lastActionAt / lastActiveDay', typeof meA.shields === 'number' && !!meA.lastActionAt && !!meA.lastActiveDay, meA);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
