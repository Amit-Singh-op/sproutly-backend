/**
 * Pure safety rules (no I/O, so they're easy to test):
 *   - names nobody may take (so no one can pose as Sproutly staff),
 *   - throwaway email domains (sign-in is refused, so banned people can't spin up burner accounts),
 *   - a short list of unambiguous slurs, threats and sexual requests that flag a message for moderators.
 *     Flagging never blocks, hides or changes anything: a moderator decides.
 */
import type { ReportCategory } from './types.js';

/** Lowercase, common look-alike characters folded (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s), then letters only. */
export function foldName(s: string): string {
  return s.toLowerCase()
    .replace(/[0]/g, 'o').replace(/[1!|]/g, 'i').replace(/[3]/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[7]/g, 't')
    .normalize('NFKD').replace(/[^a-z]/g, '');
}

const RESERVED = ['sproutly', 'admin', 'administrator', 'moderator', 'support', 'official', 'staff', 'helpdesk', 'customerservice', 'trustandsafety', 'sproutlyteam'];

/** Names (display names and handles) that could pass for Sproutly staff. */
export function isReservedName(name: string): boolean {
  const f = foldName(name);
  return f.length > 0 && RESERVED.some((r) => f.includes(r));
}

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net',
  'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'temp-mail.io', 'tempail.com', 'throwawaymail.com', 'yopmail.com', 'yopmail.net',
  'getnada.com', 'nada.email', 'trashmail.com', 'trashmail.de', 'dispostable.com', 'maildrop.cc', 'mintemail.com', 'mohmal.com', 'emailondeck.com',
  'fakeinbox.com', 'mailnesia.com', 'mytemp.email', 'tempinbox.com', 'spamgourmet.com', 'mailcatch.com', 'moakt.com', 'burnermail.io', 'inboxkitten.com',
  'tempr.email', 'discard.email', 'mailpoof.com', 'emailfake.com', 'fakemail.net', 'mail.tm', 'linshiyouxiang.net', 'tmail.ws', 'mailsac.com',
  'luxusmail.org', 'mvrht.com', 'spam4.me', 'jetable.org', 'getairmail.com', 'anonaddy.me', 'minuteinbox.com', 'tmpmail.org', 'tmpmail.net',
]);

/** Is this a throwaway email address? */
export function isDisposableEmail(login: string): boolean {
  const domain = login.split('@')[1]?.toLowerCase().trim();
  if (!domain) return false;
  return DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith(`.${d}`));
}

/**
 * The few things worth a moderator's look whatever the context. Kept deliberately short: a false flag costs a
 * moderator a second; it never touches the person who wrote it.
 */
const FLAGS: { category: ReportCategory; re: RegExp }[] = [
  { category: 'violence', re: /\b(i('?m| am)?|im) ?(going to|gonna|will|wanna|want to) (kill|stab|shoot|murder|rape|hurt) (you|u|ya|her|him|them)\b/i },
  { category: 'violence', re: /\b(i know where you live|you('?re| are) (dead|gonna die))\b/i },
  { category: 'harassment', re: /\b(kill (your ?self|urself|yo ?self)|kys)\b/i },
  { category: 'sexual', re: /\b(send|show) (me )?(your |ur )?(nudes?|noods|naked (pics?|photos?)|boobs|dick pics?)\b/i },
  { category: 'child_safety', re: /\b(how old are (you|u)\b.{0,40}\b(nudes?|naked|sexy|alone)|are (you|u) (home )?alone\b.{0,40}\b(parents?|mom|dad))/i },
  { category: 'hate', re: /\b(n[i1]gg(er|a)s?|f[a@]gg?[o0]ts?|k[i1]kes?|ch[i1]nks?|sp[i1]cs?|tr[a@]nn(y|ies)|r[e3]t[a@]rds?)\b/i },
];

/** What a piece of text should be flagged for, or null (most text). */
export function flagText(text: string | null | undefined): ReportCategory | null {
  if (!text || text.length < 3) return null;
  for (const f of FLAGS) if (f.re.test(text)) return f.category;
  return null;
}
