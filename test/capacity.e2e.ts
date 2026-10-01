/**
 * Capacity under simultaneous joins, against a LOCAL backend (api :4100, realtime :4101):
 *   DATABASE_URL=postgres://...localhost... E2E_API=http://localhost:4100/v1 E2E_RT=http://localhost:4101 npx tsx test/capacity.e2e.ts
 * Everyone fires at the same moment; exactly the capacity gets in, the rest are told it's full, and watchers get live counts.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { PLAZA_CAPACITY } from '../src/shared/plaza.js';
import { STAGE_CAPACITY } from '../src/shared/types.js';

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
  for (const e of ['group:count', 'plaza:counts', 'stage:full', 'stage:presence']) sock.on(e, (p: any) => seen.push({ e, p }));
  return { token: v.body.accessToken, id: me.body.id, sock, seen };
}
const ack = (s: Socket, ev: string, p: unknown) => new Promise<any>((res) => s.timeout(10000).emit(ev, p, (e: any, r: any) => res(e ? { ok: false, err: String(e) } : r)));

async function main() {
  console.log('\nGroup: 3 seats, 8 people join at the same moment');
  const owner = await user('owner');
  const watcher = await user('watcher');
  const g = (await call('POST', '/conversations', owner.token, { kind: 'group', title: `Cap ${Date.now()}`, category: 'Gaming', isPublic: true, avatarColor: '#2F8A6C', memberIds: [] })).body;
  await db.query('UPDATE conversations SET max_members = 3 WHERE id = $1', [g.id]); // owner holds seat 1
  watcher.sock.emit('discover:watch', { on: true });
  await sleep(300);
  const joiners = await Promise.all(Array.from({ length: 8 }, (_, i) => user(`g${i}`)));
  const results = await Promise.all(joiners.map((u) => call('POST', `/groups/${g.id}/join`, u.token)));
  const ok = results.filter((r) => r.status === 200).length;
  const fullMsgs = results.filter((r) => r.status === 409 && r.body.code === 'GROUP_FULL');
  check(`exactly 2 got the 2 free seats (got ${ok})`, ok === 2, results.map((r) => r.status));
  check('everyone else was told it just filled up', fullMsgs.length === 6 && /filled up/.test(fullMsgs[0]?.body.message ?? ''), fullMsgs[0]?.body);
  const row = (await db.query('SELECT member_count, max_members FROM conversations WHERE id = $1', [g.id])).rows[0];
  const real = (await db.query('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [g.id])).rows[0].n;
  check('stored count never goes over the limit and matches real members', row.member_count === 3 && real === 3, { row, real });
  await sleep(500);
  const live = watcher.seen.filter((s) => s.e === 'group:count' && s.p.id === g.id);
  check('a watcher of the group list got live counts, ending full', live.length >= 1 && live[live.length - 1].p.memberCount === 3 && live[live.length - 1].p.full === true, live.map((l) => l.p));
  const listed = (await call('GET', '/groups/discover?category=Gaming', watcher.token)).body;
  const card = (listed.items ?? listed).find((x: any) => x.id === g.id);
  check('the group list says 3 / 3 and full', card?.memberCount === 3 && card?.maxMembers === 3 && card?.full === true, card);
  const winner = joiners[results.findIndex((r) => r.status === 200)]!;
  await call('POST', `/groups/${g.id}/leave`, winner.token);
  await sleep(400);
  const after = watcher.seen.filter((s) => s.e === 'group:count' && s.p.id === g.id).pop();
  check('someone leaving frees a seat, live', after?.p.memberCount === 2 && after?.p.full === false, after?.p);

  console.log('\nChats: search and member chat lists');
  const finder = await user('finder');
  const found = (await call('GET', `/search?q=${encodeURIComponent(g.title.slice(0, 8))}`, finder.token)).body;
  const hit = found.groups.find((x: any) => x.id === g.id);
  check('search shows the group with live count and room left', hit?.memberCount === 2 && hit?.maxMembers === 3 && hit?.full === false && hit?.joined === false, hit);
  const ownerList = (await call('GET', '/conversations', owner.token)).body;
  const mine = ownerList.find((x: any) => x.id === g.id);
  check("the group in a member's chat list carries its capacity", mine?.maxMembers === 3 && mine?.memberCount === 2, mine);
  owner.seen.length = 0;
  const filler = await user('filler');
  await call('POST', `/groups/${g.id}/join`, filler.token);
  await sleep(500);
  check("a member's chat list gets the live count (no chat open)", owner.seen.some((s) => s.e === 'group:count' && s.p.id === g.id && s.p.memberCount === 3 && s.p.full === true), owner.seen.map((s) => s.p));
  const late = await call('POST', `/groups/${g.id}/join`, finder.token);
  check('joining a full group from search gets the "filled up" message', late.status === 409 && late.body.code === 'GROUP_FULL', late.body);

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
  const full = members.filter((u) => u.seen.some((s) => s.e === 'stage:full' && s.p.conversationId === room.id)).length;
  check(`exactly 3 waited outside a full room (got ${full})`, full === 3);
  members.forEach((u) => u.sock.disconnect());

  console.log(`\n${pass} passed, ${fail} failed`);
  [owner, watcher, lobby, host, ...joiners].forEach((u) => u.sock.disconnect());
  await db.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
