import { config } from '../config.js';

// Email clients ignore <style> blocks and flexbox unevenly (Outlook desktop renders with Word), so this is
// table-based with inline styles only. Colours match the web pages in api/routes/web.ts.
const C = { cream: '#FFF8EE', card: '#FFFFFF', ink: '#2B2340', muted: '#6B6480', mint: '#2F8A6C', mintSoft: '#E6F3EE', line: '#EDE3D3' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function logo(): string {
  if (config.EMAIL_LOGO_URL) {
    return `<img src="${esc(config.EMAIL_LOGO_URL)}" width="56" height="56" alt="Sproutly" style="display:block;border:0;border-radius:14px;margin:0 auto;">`;
  }
  // Emoji badge: renders everywhere without hosting an image.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
    <td width="56" height="56" align="center" valign="middle" bgcolor="${C.mint}" style="width:56px;height:56px;background:${C.mint};border-radius:14px;font-size:30px;line-height:56px;">&#127793;</td>
  </tr></table>`;
}

export function otpEmail(code: string): { subject: string; text: string; html: string } {
  const subject = `${code} is your Sproutly code`;
  const text = [
    'Your Sproutly sign-in code',
    '',
    code,
    '',
    'Enter this code in the app to sign in. It expires in 10 minutes.',
    'If you didn’t try to sign in, you can safely ignore this email. Never share this code with anyone.',
    '',
    '— The Sproutly team',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<!--[if mso]><style>td,p,a,span{font-family:Arial,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${C.cream};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.cream};">Your sign-in code is ${code}. It expires in 10 minutes.&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.cream}" style="background:${C.cream};">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
      <tr><td align="center" style="padding-bottom:24px;">
        ${logo()}
        <div style="font-family:${FONT};font-size:20px;font-weight:700;color:${C.ink};padding-top:12px;letter-spacing:-0.2px;">Sproutly</div>
      </td></tr>
      <tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:36px 32px;">
        <p style="margin:0 0 8px;font-family:${FONT};font-size:22px;font-weight:700;color:${C.ink};">Your sign-in code</p>
        <p style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:22px;color:${C.muted};">Enter this code in the Sproutly app to sign in.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" bgcolor="${C.mintSoft}" style="background:${C.mintSoft};border-radius:12px;padding:20px 12px;">
            <span style="font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${C.mint};">${code}</span>
          </td></tr>
        </table>
        <p style="margin:24px 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:${C.muted};">This code expires in <strong style="color:${C.ink};">10 minutes</strong>. Never share it with anyone. Sproutly will never ask you for it.</p>
        <p style="margin:16px 0 0;padding-top:16px;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">Didn’t try to sign in? You can safely ignore this email; your account is still secure.</p>
      </td></tr>
      <tr><td align="center" style="padding:24px 16px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">
        You’re receiving this because someone requested a sign-in code for this email address.<br>&copy; ${new Date().getFullYear()} Sproutly
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
  return { subject, text, html };
}
