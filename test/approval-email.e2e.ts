/**
 * End-to-end check of the "someone is waiting for approval" email and its approve button, against a running local
 * backend (npm run dev) whose ADMIN_EMAILS includes mod@example.com and PUBLIC_API_URL=http://localhost:4000.
 * The email itself is captured here (Resend's API is faked), so nothing is really sent.
 * Run: set -a && . ./.env && set +a && npx tsx test/approval-email.e2e.ts
 */
import { randomUUID } from 'node:crypto';
process.env.RESEND_API_KEY = 're_test_fake';
process.env.OTP_FROM = 'Sproutly <no-reply@example.com>';

const { one, pool, q } = await import('../src/db/pool.js');
const { notifyApprovalNeeded } = await import('../src/core/approvalEmail.js');
const { signAccess } = await import('../src/lib/jwt.js');
const { queue } = await import('../src/lib/queues.js');
const { clearAppConfigCache } = await import('../src/core/appConfig.js');

const BASE = process.env.E2E_BASE ?? 'http://localhost:4000';
const API = `${BASE}/v1`;
const realFetch = globalThis.fetch;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

// Fake Resend: record what would have been sent.
type Sent = { from: string; to: string[]; subject: string; text: string; html: string };
let sent: Sent[] = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(input).startsWith('https://api.resend.com/')) {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: 'fake' }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await realFetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function signUp(email: string, name: string) {
  const s = await call('POST', '/auth/otp/start', undefined, { phoneOrEmail: email });
  const v = await call('POST', '/auth/otp/verify', undefined, { phoneOrEmail: email, code: s.body.devCode, displayName: name, timezone: 'Asia/Kolkata' });
  const me = await call('GET', '/me', v.body.accessToken);
  return { access: v.body.accessToken as string, id: me.body.id as string, isNew: v.body.isNew as boolean };
}
const page = async (url: string, init?: RequestInit) => { const r = await realFetch(url, init); return { status: r.status, html: await r.text() }; };
const approvedInDb = async (id: string) => (await one<{ approved: boolean }>('SELECT approved FROM users WHERE id = $1', [id]))?.approved;
const postApprove = (t: string) => page(`${BASE}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t }).toString() });

async function main() {
  await q(`INSERT INTO app_config (key, value) VALUES ('approval_required', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
  clearAppConfigCache();

  console.log('a new person signs up while approval is required');
  const email = `wait-${randomUUID().slice(0, 8)}@example.com`;
  const p = await signUp(email, 'Riya <Test>');
  check('they are new and not approved', p.isNew && (await approvedInDb(p.id)) === false);
  check('they are kept out (403 APPROVAL_PENDING)', (await call('GET', '/friends', p.access)).body?.code === 'APPROVAL_PENDING');

  sent = [];
  await notifyApprovalNeeded(p.id, 'email');
  check('one email is sent', sent.length === 1, sent.length);
  const m = sent[0]!;
  check('to the moderator', JSON.stringify(m.to) === JSON.stringify(['mod@example.com']), m.to);
  check('subject names them', m.subject === 'Riya <Test> is waiting to join Sproutly', m.subject);
  check('says who they are (email, method, time zone, id)', m.text.includes(`Email code: ${email}`) && m.text.includes('Asia/Kolkata') && m.text.includes(p.id), m.text);
  check('their name is escaped in the HTML', m.html.includes('Riya &#60;Test&#62;') && !m.html.includes('Riya <Test>'));
  const link = /href="([^"]+\/approve\?t=[^"]+)"/.exec(m.html)?.[1]?.replace(/&#38;/g, '&');
  check('has an Approve button linking to this server', !!link && link.startsWith(`${BASE}/approve?t=`), link);

  console.log('opening the link (what a mail scanner would do)');
  const g = await page(link!);
  check('shows who it is and a confirm button', g.status === 200 && g.html.includes('Let Riya &lt;Test&gt; in?') && g.html.includes('method="post"'), g.status);
  check('opening it does NOT approve them', (await approvedInDb(p.id)) === false);

  console.log('tapping Approve');
  const t = new URL(link!).searchParams.get('t')!;
  const a = await postApprove(t);
  check('says approved', a.status === 200 && a.html.includes('can use Sproutly now'), a.status);
  check('approved in the database', (await approvedInDb(p.id)) === true);
  check('they can use the app straight away', (await call('GET', '/friends', p.access)).status === 200);
  const job = await queue('push').getJob(`approved_${p.id}`);
  check('a "You’re in" push is queued for them', !!job && job.data.userId === p.id && job.data.data?.type === 'approved', job?.data);
  const again = await postApprove(t);
  check('tapping again says already approved', again.status === 200 && again.html.includes('could already use Sproutly'));
  check('opening the link again says already approved', (await page(link!)).html.includes('Already approved'));

  console.log('bad links');
  check('a made-up token is refused', (await page(`${BASE}/approve?t=nope`)).status === 400);
  check('no token is refused', (await postApprove('')).status === 400);
  const access = await signAccess(p.id);
  check('a sign-in token can’t be used as an approve link', (await postApprove(access)).status === 400);
  const tampered = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
  check('a tampered token is refused', (await postApprove(tampered)).status === 400);

  console.log('no email when it isn’t needed');
  sent = [];
  const mod = await signUp('mod@example.com', 'Moderator');
  await notifyApprovalNeeded(mod.id, 'email');
  check('a moderator signing up: no email', sent.length === 0, sent.length);
  await notifyApprovalNeeded(p.id, 'email');
  check('someone already approved: no email', sent.length === 0, sent.length);
  await q(`UPDATE app_config SET value = 'false' WHERE key = 'approval_required'`);
  clearAppConfigCache();
  const open = await signUp(`open-${randomUUID().slice(0, 8)}@example.com`, 'Open Door');
  await notifyApprovalNeeded(open.id, 'email');
  check('approval switched off: no email', sent.length === 0, sent.length);
  await q(`UPDATE app_config SET value = 'true' WHERE key = 'approval_required'`);
  clearAppConfigCache();

  console.log('Apple/Google with a hidden email');
  const hidden = await one<{ id: string }>(`INSERT INTO users (handle, login, display_name) VALUES ($1, $2, 'Hidden Mail') RETURNING id`, [`h${randomUUID().slice(0, 8)}`, `apple:${randomUUID()}`]);
  await new Promise((r) => setTimeout(r, 200));
  await notifyApprovalNeeded(hidden!.id, 'apple');
  check('says Apple hid the email', sent.length === 1 && sent[0]!.text.includes('Apple: email hidden by Apple'), sent[0]?.text);
  await q('DELETE FROM users WHERE id = $1', [hidden!.id]);
  const gone = /approve\?t=([^"\s]+)/.exec(sent[0]!.text)?.[1];
  check('approving a deleted account says it’s gone', !!gone && (await postApprove(gone)).status === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
