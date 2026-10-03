/**
 * Live social updates, against a LOCAL backend (api :4100, realtime :4101) started with IP_LIMITS=off:
 *   DATABASE_URL=postgres://...localhost... E2E_API=http://localhost:4100/v1 E2E_RT=http://localhost:4101 npx tsx test/social-live.e2e.ts
 * Two people who share a chat: stories, Show off posts, cheers, comments and blocking all reach the other one live,
 * and someone with no connection to the author hears nothing.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';

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
  const email = `live-${tag}-${Date.now()}-${randomUUID().slice(0, 6)}@test.dev`;
  const s = await call('POST', '/auth/otp/start', undefined, { phoneOrEmail: email });
  const v = await call('POST', '/auth/otp/verify', undefined, { phoneOrEmail: email, code: s.body.devCode, displayName: `Live ${tag}`, timezone: 'UTC' });
  const me = await call('GET', '/me', v.body.accessToken);
  const sock = io(RT, { transports: ['websocket'], auth: { token: v.body.accessToken } });
  await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
  const seen: { e: string; p: any }[] = [];
  for (const e of ['stories:update', 'showcase:new', 'showcase:update', 'showcase:delete', 'social:update', 'invites:update']) sock.on(e, (p: any) => seen.push({ e, p }));
  return { token: v.body.accessToken, id: me.body.id, sock, seen };
}
const got = (u: U, e: string, f: (p: any) => boolean = () => true) => u.seen.some((s) => s.e === e && f(s.p));

async function main() {
  const a = await user('a'), b = await user('b'), stranger = await user('x');
  // a and b share a chat (that's what makes them each other's audience).
  const dm = await call('POST', '/conversations', a.token, { kind: 'dm', userId: b.id });
  await call('POST', `/conversations/${dm.body.id}/messages`, a.token, { clientId: randomUUID(), type: 'text', body: 'hi' });
  await sleep(300);

  console.log('\nStories');
  await call('POST', '/stories', a.token, { kind: 'text', text: 'Hello world', bg: '#2F8A6C' });
  await sleep(700);
  check('a new story reaches the friend live', got(b, 'stories:update', (p) => p.userId === a.id));
  check('nobody outside the audience hears it', !got(stranger, 'stories:update'));

  console.log('\nShow off');
  const post = await call('POST', '/showcase/posts', a.token, { caption: 'Live test', kind: 'mo' });
  await sleep(700);
  check('a new post reaches the friend live', got(b, 'showcase:new', (p) => p.postId === post.body.id), post.body);
  check('…but not a stranger', !got(stranger, 'showcase:new'));
  await call('POST', `/showcase/posts/${post.body.id}/cheer`, b.token);
  await sleep(700);
  check('a cheer updates the count live for the author', got(a, 'showcase:update', (p) => p.postId === post.body.id && p.cheerCount === 1));
  await call('DELETE', `/showcase/posts/${post.body.id}`, a.token);
  await sleep(700);
  check('a deleted post disappears live', got(b, 'showcase:delete', (p) => p.postId === post.body.id));

  console.log('\nRoom invites');
  await db.query(`INSERT INTO entitlements (user_id, plus_active) VALUES ($1, TRUE) ON CONFLICT (user_id) DO UPDATE SET plus_active = TRUE`, [a.id]);
  // The server caches Plus status briefly; a real purchase clears it through the webhook, so the test does too.
  { const r = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380'); await r.del(`ent:${a.id}`); r.disconnect(); }
  await call('POST', '/rooms/invites', a.token, { guestId: b.id });
  await call('POST', '/rooms/invites', a.token, { guestId: b.id });
  await sleep(700);
  check('the guest hears about a new invite live', got(b, 'invites:update'));
  const list = await call('GET', '/rooms/invites', b.token);
  check('the guest sees one invite (inviting twice does not spam)', list.status === 200 && list.body.length === 1 && list.body[0].hostId === a.id && !!list.body[0].hostName, list.body);
  a.seen.length = 0;
  const ans = await call('POST', `/rooms/invites/${list.body[0].id}/respond`, b.token, { accept: true });
  await sleep(700);
  check('answering tells the host live', ans.status === 200 && got(a, 'invites:update'));
  check('…and the invite is gone', (await call('GET', '/rooms/invites', b.token)).body.length === 0);
  const theirs = await call('POST', `/rooms/invites/${list.body[0].id}/respond`, stranger.token, { accept: true });
  check("nobody else can answer someone's invite", theirs.status === 404, theirs.status);

  console.log('\nBlocking');
  await call('POST', `/users/${b.id}/block`, a.token);
  await sleep(700);
  check('blocking refreshes both sides live', got(a, 'social:update') && got(b, 'social:update'));

  console.log('\nSocket flood guard');
  let dropped = 0;
  for (let i = 0; i < 200; i++) a.sock.emit('typing:start', { conversationId: dm.body.id });
  a.sock.on('connect_error', () => dropped++);
  await sleep(1500);
  check('a flood of events gets the connection cut', a.sock.disconnected || dropped > 0, { disconnected: a.sock.disconnected });

  console.log(`\n${pass} passed, ${fail} failed`);
  [a, b, stranger].forEach((u) => u.sock.disconnect());
  await db.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
