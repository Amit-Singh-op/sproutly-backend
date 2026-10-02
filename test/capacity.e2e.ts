/**
 * Capacity under simultaneous joins, against a LOCAL backend (api :4100, realtime :4101):
 *   DATABASE_URL=postgres://...localhost... E2E_API=http://localhost:4100/v1 E2E_RT=http://localhost:4101 npx tsx test/capacity.e2e.ts
 * Everyone fires at the same moment; exactly the capacity gets in (groups: members unlimited, 25 in the chat at once), the rest are told it's full, and watchers get live counts.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { PLAZA_CAPACITY } from '../src/shared/plaza.js';
import { ROOM_LIVE_CAPACITY, STAGE_CAPACITY } from '../src/shared/types.js';

const API = process.env.E2E_API ?? 'http://localhost:4100/v1';
const RT = process.env.E2E_RT ?? 'http://localhost:4101';
const DB = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(API + RT + DB)) { console.error('Refusing: local only.'); process.exit(2); }
const db = new pg.Pool({ connectionString: DB });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
type U = { token: string; id: string; sock: Socket; seen: { e: string; p: any }[] };
async function user(tag: string): Promise<U> {
  const email = `cap-${tag}-${Date.now()}-${randomUUID().slice(0, 6)}@test.dev`;
  const s = await call('POST', '/auth/otp/start', undefined, { phoneOrEmail: email });
  const v = await call('POST', '/auth/otp/verify', undefined, { phoneOrEmail: email, code: s.body.devCode, displayName: `Cap ${tag}`, timezone: 'UTC' });
  const me = await call('GET', '/me', v.body.accessToken);
  const sock = io(RT, { transports: ['websocket'], auth: { token: v.body.accessToken } });
  await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
  const seen: { e: string; p: any }[] = [];
  for (const e of ['group:count', 'plaza:counts', 'stage:full', 'stage:presence', 'conv:full']) sock.on(e, (p: any) => seen.push({ e, p }));
  return { token: v.body.accessToken, id: me.body.id, sock, seen };
}
const ack = (s: Socket, ev: string, p: unknown) => new Promise<any>((res) => s.timeout(10000).emit(ev, p, (e: any, r: any) => res(e ? { ok: false, err: String(e) } : r)));

async function main() {
  const N = ROOM_LIVE_CAPACITY + 2;
  console.log(`\nGroup: no member limit, ${ROOM_LIVE_CAPACITY} in the chat at once; ${N} members open it at the same moment`);
  const owner = await user('owner');
  const watcher = await user('watcher');
  const g = (await call('POST', '/conversations', owner.token, { kind: 'group', title: `Cap ${Date.now()}`, category: 'Gaming', isPublic: true, avatarColor: '#2F8A6C', memberIds: [] })).body;
  watcher.sock.emit('discover:watch', { on: true });
  await sleep(300);
  const crowdG = await Promise.all(Array.from({ length: N }, (_, i) => user(`g${i}`)));
  const joins = await Promise.all(crowdG.map((u) => call('POST', `/groups/${g.id}/join`, u.token)));
  check(`all ${N} could join (membership has no limit)`, joins.every((r) => r.status === 200), joins.map((r) => r.status));
  const row = (await db.query('SELECT member_count FROM conversations WHERE id = $1', [g.id])).rows[0];
  check('member count is exact', row.member_count === N + 1, row);
  crowdG.forEach((u) => u.sock.emit('conv:join', { conversationId: g.id }));
  await sleep(1500);
  const outside = crowdG.filter((u) => u.seen.some((s) => s.e === 'conv:full' && s.p.conversationId === g.id));
  check(`exactly 2 were told it's full right now (got ${outside.length})`, outside.length === 2);
  check('the full message carries the limit', outside[0]?.seen.find((s) => s.e === 'conv:full')?.p.capacity === ROOM_LIVE_CAPACITY);
  const live = watcher.seen.filter((s) => s.e === 'group:count' && s.p.id === g.id).pop()?.p;
  check(`group list watchers see ${ROOM_LIVE_CAPACITY}/${ROOM_LIVE_CAPACITY} in, full`, live?.liveCount === ROOM_LIVE_CAPACITY && live?.full === true && live?.memberCount === N + 1, live);
  const listed = (await call('GET', '/groups/discover?category=Gaming', watcher.token)).body;
  const card = (listed.items ?? listed).find((x: any) => x.id === g.id);
  check('the group list says full right now', card?.liveCount === ROOM_LIVE_CAPACITY && card?.capacity === ROOM_LIVE_CAPACITY && card?.full === true, card);
  const waiting = outside[0]!;
  const send = await call('POST', `/conversations/${g.id}/messages`, waiting.token, { clientId: randomUUID(), type: 'text', body: 'hi' });
  check('sending without a seat is refused with ROOM_FULL', send.status === 403 && send.body.code === 'ROOM_FULL', send);
  const seated = crowdG.find((u) => !outside.includes(u))!;
  waiting.seen.length = 0;
  seated.sock.emit('conv:leave', { conversationId: g.id });
  await sleep(800);
  const freed = waiting.seen.filter((s) => s.e === 'group:count' && s.p.id === g.id).pop()?.p;
  check('someone closing the chat frees a seat, live (people waiting hear it)', freed?.liveCount === ROOM_LIVE_CAPACITY - 1 && freed?.full === false, freed);
  waiting.sock.emit('conv:join', { conversationId: g.id });
  await sleep(600);
  const send2 = await call('POST', `/conversations/${g.id}/messages`, waiting.token, { clientId: randomUUID(), type: 'text', body: 'in!' });
  check('the waiting person gets in and can send', send2.status === 200 || send2.status === 201, send2);
  watcher.seen.length = 0;
  crowdG.filter((u) => !outside.includes(u) && u !== seated)[0]!.sock.disconnect();
  await sleep(800);
  const dropped = watcher.seen.filter((s) => s.e === 'group:count' && s.p.id === g.id).pop()?.p;
  check('a dropped connection frees its seat too', dropped?.liveCount === ROOM_LIVE_CAPACITY - 1, dropped);

  console.log('\nChats: search and member chat lists');
  const finder = await user('finder');
  const found = (await call('GET', `/search?q=${encodeURIComponent(g.title.slice(0, 8))}`, finder.token)).body;
  const hit = found.groups.find((x: any) => x.id === g.id);
  check('search shows the group with who is in now', hit?.liveCount === ROOM_LIVE_CAPACITY - 1 && hit?.capacity === ROOM_LIVE_CAPACITY && hit?.joined === false, hit);
  const late = await call('POST', `/groups/${g.id}/join`, finder.token);
  check('joining from search always works', late.status === 200, late.body);
  const ownerList = (await call('GET', '/conversations', owner.token)).body;
  const mine = ownerList.find((x: any) => x.id === g.id);
  check("a member's chat list carries live count and capacity", mine?.capacity === ROOM_LIVE_CAPACITY && mine?.liveCount === ROOM_LIVE_CAPACITY - 1, mine);
  crowdG.forEach((u) => u.sock.disconnect());

  console.log(`\nPlaza: ${PLAZA_CAPACITY} spots, ${PLAZA_CAPACITY + 4} people enter at the same moment`);
  const lobby = await user('lobby');
  lobby.sock.emit('plaza:lobby', { on: true });
  const crowd = await Promise.all(Array.from({ length: PLAZA_CAPACITY + 4 }, (_, i) => user(`p${i}`)));
  const enters = await Promise.all(crowd.map((u) => ack(u.sock, 'plaza:enter', { spot: 'beach' })));
  const inside = enters.filter((r) => r.ok).length;
  const turnedAway = enters.filter((r) => !r.ok && r.code === 'FULL');
  check(`exactly ${PLAZA_CAPACITY} got in (got ${inside})`, inside === PLAZA_CAPACITY, enters.filter((r) => !r.ok).map((r) => r.code ?? r.err));
  check('the rest were told it is full', turnedAway.length === 4, turnedAway.map((r) => r.message));
  await sleep(900);
  const counts = lobby.seen.filter((s) => s.e === 'plaza:counts').pop()?.p;
  const beach = counts?.find((c: any) => c.id === 'beach');
  check('the spot picker got live counts: beach full', beach?.count === PLAZA_CAPACITY && beach?.full === true, beach);
  crowd[0]!.sock.emit('plaza:leave', {});
  await sleep(900);
  const beach2 = lobby.seen.filter((s) => s.e === 'plaza:counts').pop()?.p.find((c: any) => c.id === 'beach');
  check('one leaving shows live: a spot is free', beach2?.count === PLAZA_CAPACITY - 1 && beach2?.full === false, beach2);
  crowd.forEach((u) => u.sock.disconnect());

  console.log(`\nChat avatar room: ${STAGE_CAPACITY} seats, ${STAGE_CAPACITY + 3} open the chat at the same moment`);
  const host = await user('host');
  const members = await Promise.all(Array.from({ length: STAGE_CAPACITY + 3 }, (_, i) => user(`s${i}`)));
  const room = (await call('POST', '/conversations', host.token, { kind: 'group', title: `Stage ${Date.now()}`, category: 'Gaming', isPublic: true, avatarColor: '#2F8A6C', memberIds: [] })).body;
  await Promise.all(members.map((u) => call('POST', `/groups/${room.id}/join`, u.token)));
  members.forEach((u) => u.sock.emit('conv:join', { conversationId: room.id }));
  await sleep(1500);
  const full = members.filter((u) => u.seen.some((s) => (s.e === 'stage:full' || s.e === 'conv:full') && s.p.conversationId === room.id)).length;
  check(`exactly 3 waited outside a full room (got ${full})`, full === 3);
  members.forEach((u) => u.sock.disconnect());

  console.log(`\n${pass} passed, ${fail} failed`);
  [owner, watcher, lobby, host, finder].forEach((u) => u.sock.disconnect());
  await db.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
