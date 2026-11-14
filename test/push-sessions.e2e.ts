/**
 * End-to-end check that a signed-out phone gets no more pushes, against a running local backend (npm run dev).
 * Signs in like the app, registers push tokens, signs out in the different ways, and checks which phones the push
 * worker would still send to.
 * Run: set -a && . ./.env && set +a && npx tsx test/push-sessions.e2e.ts
 */
import { randomUUID } from 'node:crypto';
import { one, pool, q } from '../src/db/pool.js';
import { liveDevices } from '../src/worker/push.js';

const API = process.env.E2E_API ?? 'http://localhost:4000/v1';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

async function call<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** One sign-in = one session (one phone). */
async function signIn(email: string) {
  const s = await call('POST', '/auth/otp/start', undefined, { phoneOrEmail: email });
  const v = await call('POST', '/auth/otp/verify', undefined, { phoneOrEmail: email, code: s.body.devCode, displayName: 'Push Test', timezone: 'Asia/Kolkata' });
  const me = await call('GET', '/me', v.body.accessToken);
  return { access: v.body.accessToken as string, refresh: v.body.refreshToken as string, id: me.body.id as string };
}
const register = (access: string, pushToken: string) => call('POST', '/devices', access, { platform: 'android', pushToken, appVersion: '0.1.5' });
const live = async (userId: string) => (await liveDevices(userId)).map((d) => d.push_token).sort();
const tok = (name: string) => `${name}-${randomUUID()}`;

async function main() {
  const email = `push-${randomUUID().slice(0, 8)}@example.com`;

  console.log('signing out with the push token');
  const phoneA = await signIn(email);
  const phoneB = await signIn(email);
  const ta = tok('phoneA'), tb = tok('phoneB');
  check('phone A registers its push token', (await register(phoneA.access, ta)).status === 200);
  check('phone B registers its push token', (await register(phoneB.access, tb)).status === 200);
  const rowA = await one<{ session_family: string | null }>('SELECT session_family FROM devices WHERE push_token = $1', [ta]);
  check('the token is tied to the sign-in session', !!rowA?.session_family, rowA);
  check('both phones get pushes while signed in', JSON.stringify(await live(phoneA.id)) === JSON.stringify([ta, tb].sort()));
  check('phone A signs out', (await call('POST', '/auth/logout', undefined, { refreshToken: phoneA.refresh, pushToken: ta })).status === 200);
  check('phone A gets no more pushes, phone B still does', JSON.stringify(await live(phoneA.id)) === JSON.stringify([tb]), await live(phoneA.id));

  console.log('signing out without the push token (older app, or the token lookup failed)');
  check('phone B signs out', (await call('POST', '/auth/logout', undefined, { refreshToken: phoneB.refresh })).status === 200);
  check('phone B gets no more pushes', (await live(phoneB.id)).length === 0, await live(phoneB.id));
  check('and its token row is gone', !(await one('SELECT 1 FROM devices WHERE push_token = $1', [tb])));

  console.log('session ends on the server without the app saying anything (expired / revoked)');
  const phoneC = await signIn(email);
  const tc = tok('phoneC');
  await register(phoneC.access, tc);
  check('phone C gets pushes while signed in', JSON.stringify(await live(phoneC.id)) === JSON.stringify([tc]));
  await q(`UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [phoneC.id]);
  check('expired session: phone C gets no pushes, though its token row is still there',
    (await live(phoneC.id)).length === 0 && !!(await one('SELECT 1 FROM devices WHERE push_token = $1', [tc])));

  console.log('token rows from before sessions were tracked (no session)');
  const phoneD = await signIn(email);
  const td = tok('legacy');
  await q(`INSERT INTO devices (user_id, platform, push_token) VALUES ($1, 'android', $2)`, [phoneD.id, td]);
  check('old row still works while the account is signed in somewhere', (await live(phoneD.id)).includes(td));
  await call('POST', '/auth/logout', undefined, { refreshToken: phoneD.refresh });
  check('old row gets nothing once the account is signed out everywhere', (await live(phoneD.id)).length === 0, await live(phoneD.id));

  console.log('re-registering keeps the session');
  const phoneE = await signIn(email);
  const te = tok('phoneE');
  await register(phoneE.access, te);
  await register(phoneE.access, te);
  check('registering the same token twice keeps one row tied to the session',
    (await q('SELECT 1 FROM devices WHERE push_token = $1 AND session_family IS NOT NULL', [te])).length === 1);
  const refreshed = await call('POST', '/auth/refresh', undefined, { refreshToken: phoneE.refresh });
  await register(refreshed.body.accessToken, te);
  check('after a token refresh the phone still gets pushes', (await live(phoneE.id)).includes(te));
  await call('POST', '/auth/logout', undefined, { refreshToken: refreshed.body.refreshToken });
  check('signing out with the refreshed token stops them', (await live(phoneE.id)).length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
