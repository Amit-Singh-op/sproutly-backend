import nodemailer from 'nodemailer';
import { config } from '../config.js';

/**
 * Outgoing email: Resend's HTTPS API when RESEND_API_KEY is set (Render's free tier blocks SMTP ports), otherwise
 * Gmail SMTP with an App Password. Used for sign-in codes and for the "someone is waiting for approval" email.
 */

// Fail fast: a blocked or slow SMTP port must not hang a request.
// (Timeouts must be transport options; nodemailer's second createTransport argument is only message defaults.)
const mailer = config.GMAIL_USER && config.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      // App passwords are shown with spaces ("abcd efgh ..."); Google accepts them without.
      auth: { user: config.GMAIL_USER, pass: config.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
  : null;
// Gmail rewrites any From address that isn't the account or a verified alias, so default to the account itself.
const from = config.OTP_FROM ?? (config.GMAIL_USER ? `Sproutly <${config.GMAIL_USER}>` : undefined);

export const emailConfigured = () => !!config.RESEND_API_KEY || !!mailer;

export interface Email { to: string[]; subject: string; text: string; html: string; replyTo?: string }

/** OTP_FROM must be on a domain verified in Resend. */
async function sendViaResend(m: Email) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, ...(m.replyTo && { reply_to: m.replyTo }) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Throws if no email service is configured or the send fails. */
export async function sendEmail(m: Email) {
  if (config.RESEND_API_KEY) return sendViaResend(m);
  if (!mailer) throw new Error('No email service configured (RESEND_API_KEY or GMAIL_USER + GMAIL_APP_PASSWORD)');
  await mailer.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo });
}
