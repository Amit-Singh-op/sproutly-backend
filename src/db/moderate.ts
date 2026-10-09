/**
 * Admin moderation command. Run it in the server's shell (Render → Shell):
 *
 *   node dist/db/moderate.js suspend   someone@mail.com "Harassing people in group chats"
 *   node dist/db/moderate.js unsuspend someone@mail.com "Appeal accepted"
 *   node dist/db/moderate.js history   someone@mail.com
 *
 * suspend takes effect immediately: the person's app shows the reason and signs out, and they can't sign in or sign
 * up again with that email. history shows everything on record (reports with the reported content, suspensions,
 * blocked sign-ins), newest first.
 */
import { pool, one } from './pool.js';
import { history, suspendUser, unsuspendLogin } from '../core/moderation.js';

async function main() {
  const [cmd, rawLogin, ...rest] = process.argv.slice(2);
  const login = rawLogin?.trim().toLowerCase();
  const note = rest.join(' ').trim();
  if (!cmd || !login) {
    console.log('Usage: node dist/db/moderate.js <suspend|unsuspend|history> <email> ["reason"]');
    return;
  }
  if (cmd === 'suspend') {
    const u = await one<{ id: string }>('SELECT id FROM users WHERE login = $1', [login]);
    if (!u) {
      // No account (yet, or deleted): still block the email.
      await pool.query(`INSERT INTO banned_logins (login, reason) VALUES ($1, $2) ON CONFLICT (login) DO UPDATE SET reason = EXCLUDED.reason`, [login, note || null]);
      console.log(`No account for ${login}; the email is now blocked from signing up.`);
      return;
    }
    await suspendUser(u.id, note || 'Your account has been suspended for breaking Sproutly’s community rules. If you think this is a mistake, contact support.', 'admin');
    console.log(`Suspended ${login}. Their app signs out now.`);
  } else if (cmd === 'unsuspend') {
    await unsuspendLogin(login, note);
    console.log(`Lifted the suspension on ${login}.`);
  } else if (cmd === 'history') {
    const rows = await history(login);
    if (!rows.length) console.log(`Nothing on record for ${login}.`);
    for (const r of rows) {
      console.log(`${r.created_at.toISOString()}  ${r.kind.padEnd(16)} by ${r.actor}${r.reason ? `  "${r.reason}"` : ''}`);
      if (r.details && Object.keys(r.details as object).length) console.log(`    ${JSON.stringify(r.details)}`);
    }
  } else {
    console.log(`Unknown command "${cmd}". Use suspend, unsuspend or history.`);
  }
}

main()
  // Give the "you're suspended" event and the disconnect a moment to go out before exiting.
  .then(() => new Promise((r) => setTimeout(r, 1500)))
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
