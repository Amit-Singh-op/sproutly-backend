/**
 * Plaza end-to-end against a running LOCAL backend (api :4100, realtime :4101 by default).
 *   E2E_API=http://localhost:4100/v1 E2E_RT=http://localhost:4101 npx tsx test/plaza.e2e.ts
 */
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { ballAfter, ballMoving } from '../src/shared/plaza.js';

const API = process.env.E2E_API ?? 'http://localhost:4100/v1';
const RT = process.env.E2E_RT ?? 'http://localhost:4101';
if (!/localhost|127\.0\.0\.1/.test(API + RT)) { console.error('Refusing: local servers only.'); process.exit(2); }

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
async function user(tag: string) {
  const email = `plaza-${tag}-${Date.now()}@test.dev`;
  const s = await call('POST', '/auth/otp/start', undefined, { phoneOrEmail: email });
  const v = await call('POST', '/auth/otp/verify', undefined, { phoneOrEmail: email, code: s.body.devCode, displayName: `Plaza ${tag}`, timezone: 'UTC' });
  const me = await call('GET', '/me', v.body.accessToken);
  const sock: Socket = io(RT, { transports: ['websocket'], auth: { token: v.body.accessToken } });
  await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
  const seen: { event: string; p: any }[] = [];
  for (const e of ['plaza:join', 'plaza:leave', 'plaza:move', 'plaza:emote', 'plaza:say', 'plaza:kick']) sock.on(e, (p: any) => seen.push({ event: e, p }));
  return { token: v.body.accessToken as string, id: me.body.id as string, sock, seen };
}
const enter = (u: { sock: Socket }, spot: string) => new Promise<any>((res) => u.sock.timeout(8000).emit('plaza:enter', { spot }, (err: any, r: any) => res(err ? { ok: false, err: String(err) } : r)));
const say = (u: { sock: Socket }, text: string) => new Promise<any>((res) => u.sock.timeout(8000).emit('plaza:say', { text }, (err: any, r: any) => res(err ? { ok: false } : r)));
const got = (u: { seen: any[] }, event: string, pred: (p: any) => boolean = () => true) => u.seen.some((s) => s.event === event && pred(s.p));

async function main() {
  const A = await user('a');
  const B = await user('b');
  const C = await user('c');

  console.log('\nJoining');
  const ea = await enter(A, 'park');
  check('A enters the park', ea.ok && ea.state.occupants.some((o: any) => o.userId === A.id), ea);
  const me = ea.state.occupants.find((o: any) => o.userId === A.id);
  check('A stands on the floor', me.x >= 0.06 && me.x <= 0.94 && me.y >= 0.42 && me.y <= 0.92, me);
  const eb = await enter(B, 'park');
  check('B sees A already there', eb.ok && eb.state.occupants.some((o: any) => o.userId === A.id));
  await sleep(300);
  check('A is told B joined', got(A, 'plaza:join', (p) => p.occupant.userId === B.id));
  const spots = (await call('GET', '/plaza/spots', A.token)).body;
  check('spot list counts 2 in the park', spots.find((s: any) => s.id === 'park')?.count === 2 && spots.length === 6, spots);
  check('bad spot is refused', (await enter(A, 'moon')).ok === false);

  console.log('\nMoving, emotes, chat');
  B.sock.emit('plaza:move', { x: 5, y: -3 });
  await sleep(300);
  check('moves reach others, clamped to the floor', got(A, 'plaza:move', (p) => p.userId === B.id && p.x === 0.94 && p.y === 0.42), A.seen.filter((s) => s.event === 'plaza:move'));
  // Make today's rotating social quest the Plaza one for B, whatever day it is.
  if (process.env.DATABASE_URL && /localhost/.test(process.env.DATABASE_URL)) {
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await call('GET', '/quests/today', B.token);
    await db.query(`UPDATE quests_daily SET quest_key = 'plaza', title = 'Wave at someone in the Plaza', target = 1, progress = 0, completed_at = NULL
                     WHERE user_id = $1 AND quest_key IN ('visit2','guestbook','sticker')`, [B.id]);
    await db.end();
  }
  B.sock.emit('plaza:emote', { emote: 'wave' });
  await sleep(500);
  check('emotes reach others', got(A, 'plaza:emote', (p) => p.userId === B.id && p.emote === 'wave'));
  const qb = (await call('GET', '/quests/today', B.token)).body.find((q: any) => q.key === 'plaza');
  if (qb) check('waving with someone around completes the Plaza quest', qb.done === true, qb);
  else console.log('  (skipped Plaza quest check: set DATABASE_URL to the local db)');
  const s1 = await say(B, '  hello\u0007 park  ');
  await sleep(300);
  check('chat line reaches others, cleaned', s1.ok && got(A, 'plaza:say', (p) => p.line.userId === B.id && p.line.text === 'hello park'), A.seen.filter((s) => s.event === 'plaza:say'));
  check('sender gets their line in the reply, not as an echo', s1.line?.text === 'hello park' && !got(B, 'plaza:say', (p) => p.line.text === 'hello park'));
  const long = await say(B, 'x'.repeat(150));
  await sleep(200);
  check('long lines are cut to 80', long.ok && got(A, 'plaza:say', (p) => p.line.text.length === 80));
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push(await say(B, `spam ${i}`));
  check('chat is rate limited', burst.some((r) => !r.ok), burst);
  const ec = await enter(C, 'park');
  check('arrivals see recent lines', ec.ok && ec.state.lines.some((l: any) => l.text === 'hello park'), ec.state?.lines);

  console.log('\nBall');
  check('the park has a ball, resting once caught up', !!ea.state.ball && !ballMoving(ballAfter(ea.state.ball.state, 'soccer', ea.state.ball.ageMs + 20_000)), ea.state.ball);
  check('the library has none', (await enter(C, 'library')).state.ball === null);
  await enter(C, 'park');
  A.sock.emit('plaza:kick', { x: 0.5, y: 0.64, z: 0, vx: 50, vy: 0, vz: 0.5 });
  await sleep(400);
  const kick = B.seen.find((s) => s.event === 'plaza:kick');
  check('kicks reach others, speed capped', !!kick && kick.p.userId === A.id && kick.p.ball.vx <= 1.6 + 1e-9, kick?.p);
  check('the kicker gets no echo', !A.seen.some((s) => s.event === 'plaza:kick'));
  const late = await enter(C, 'park');
  check('arrivals get the last kick and its age', late.state.ball.state.vx > 0 && late.state.ball.ageMs >= 300, late.state.ball);

  console.log('\nBlocking');
  await call('POST', `/users/${A.id}/block`, B.token);
  await enter(B, 'park'); // re-enter refreshes who B can see
  const eaa = await enter(A, 'park');
  check('A no longer sees B in the park', eaa.ok && !eaa.state.occupants.some((o: any) => o.userId === B.id));
  check("A doesn't see B's old lines", !eaa.state.lines.some((l: any) => l.userId === B.id));
  A.seen.length = 0;
  await sleep(10_500); // B used up its chat allowance in the rate-limit check above
  await say(B, 'can you see me');
  B.sock.emit('plaza:emote', { emote: 'heart' });
  await sleep(400);
  check("A gets none of B's lines or emotes", !got(A, 'plaza:say', (p) => p.line.userId === B.id) && !got(A, 'plaza:emote', (p) => p.userId === B.id));
  check('C still sees B', got(C, 'plaza:say', (p) => p.line.text === 'can you see me'));

  console.log('\nLeaving');
  C.seen.length = 0;
  A.sock.emit('plaza:enter', { spot: 'cafe' }, () => {});
  await sleep(500);
  check('switching spots leaves the old one', got(C, 'plaza:leave', (p) => p.userId === A.id && p.spot === 'park'));
  const sp = (await call('GET', '/plaza/spots', C.token)).body;
  check('counts follow', sp.find((s: any) => s.id === 'cafe')?.count === 1 && sp.find((s: any) => s.id === 'park')?.count === 2, sp);
  C.seen.length = 0;
  B.sock.disconnect();
  await sleep(600);
  check('closing the app leaves the plaza', got(C, 'plaza:leave', (p) => p.userId === B.id));

  console.log(`\n${pass} passed, ${fail} failed`);
  [A, C].forEach((u) => u.sock.disconnect());
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
