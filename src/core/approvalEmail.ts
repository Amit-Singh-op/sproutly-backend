import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { one } from '../db/pool.js';
import { log } from '../lib/log.js';
import { needsApproval } from './approval.js';
import { approvalRequestEmail } from './emailTemplate.js';
import { emailConfigured, sendEmail } from './mail.js';

/**
 * While approval is required, each new sign-up emails the moderators who they are, with a button to let them in.
 * The button opens GET /approve?t=…, a page that confirms with one more tap (POST): mail scanners and link
 * previews open links on their own, and must not approve anyone by doing so.
 */

export type SignInMethod = 'email' | 'phone' | 'apple' | 'google';
const METHOD_LABEL: Record<SignInMethod, string> = { email: 'Email code', phone: 'Phone code', apple: 'Apple', google: 'Google' };

const LINK_TTL = '30d';
// Its own key (derived from JWT_SECRET), so an approve link can never pass as a sign-in token or the other way round.
const linkKey = createHash('sha256').update(`${config.JWT_SECRET}:approve-link`).digest();

export const approveLinkToken = (userId: string) =>
  new SignJWT({ purpose: 'approve' }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(LINK_TTL).sign(linkKey);

/** The user id an approve link is for, or null if it's not one of ours or has expired. */
export async function verifyApproveLink(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, linkKey, { algorithms: ['HS256'] });
    return payload.purpose === 'approve' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Moderators to email: APPROVAL_EMAILS, or else ADMIN_EMAILS. */
const recipients = () => {
  const list = (config.APPROVAL_EMAILS || config.ADMIN_EMAILS).split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
  return [...new Set(list)];
};

/** "20 Nov 2026, 2:05 pm (Asia/Kolkata)" */
export function formatTime(d: Date, timeZone: string): string {
  try {
    return `${d.toLocaleString('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} (${timeZone})`;
  } catch {
    return d.toISOString();
  }
}

/** What to show for their login: Apple/Google sometimes hide the email and we only have their account id. */
export function contactOf(login: string): string {
  const m = /^(apple|google):/.exec(login);
  return m ? `email hidden by ${m[1] === 'apple' ? 'Apple' : 'Google'}` : login;
}

/**
 * Call after a new account is created. Emails only when approval is required and this person has to wait (not the
 * store-review account or a moderator). Never throws: a failed email must not break signing up.
 */
export async function notifyApprovalNeeded(userId: string, method: SignInMethod): Promise<void> {
  try {
    const u = await one<{ login: string; display_name: string; handle: string; timezone: string; created_at: Date; approved: boolean }>(
      'SELECT login, display_name, handle, timezone, created_at, approved FROM users WHERE id = $1', [userId]);
    if (!u || u.approved || !(await needsApproval(u.login))) return;
    const to = recipients();
    if (to.length === 0) { log.warn({ userId }, 'approval needed but no APPROVAL_EMAILS / ADMIN_EMAILS to tell'); return; }
    if (!emailConfigured()) { log.warn({ userId }, 'approval needed but no email service is configured'); return; }

    // Times in the moderator's own time zone when they have an account here.
    const mod = await one<{ timezone: string }>('SELECT timezone FROM users WHERE login = ANY($1) ORDER BY created_at LIMIT 1', [to]);
    const reviewLogin = config.REVIEW_EMAIL?.trim().toLowerCase() ?? '';
    const adminLogins = config.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const waiting = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE NOT approved AND suspended_at IS NULL AND login <> ALL($1)`, [[reviewLogin, ...adminLogins]]);

    const email = approvalRequestEmail({
      name: u.display_name,
      handle: u.handle,
      contact: contactOf(u.login),
      method: METHOD_LABEL[method],
      signedUp: formatTime(u.created_at, mod?.timezone ?? 'UTC'),
      timezone: u.timezone,
      userId,
      waiting: Math.max(1, waiting?.n ?? 1),
      approveUrl: config.publicUrl ? `${config.publicUrl}/approve?t=${await approveLinkToken(userId)}` : null,
    });
    await sendEmail({ to, ...email });
    log.info({ userId, to: to.length }, 'approval request emailed');
  } catch (err) {
    log.error({ err, userId }, 'approval request email failed');
  }
}
