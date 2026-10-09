import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deleteAccountWithCode } from '../../core/account.js';
import { CONTACT_EMAIL, LEGAL_UPDATED, PRIVACY, TERMS, type LegalDoc } from '../../shared/legal.js';

/** Public web pages for the store listing: privacy policy, terms, and the account-deletion page Play requires. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Sproutly</title>
<style>
  :root{--cream:#FFF8EE;--ink:#2B2340;--muted:#6B6480;--mint:#2F8A6C;--coral:#D9543A;--line:#EDE3D3}
  *{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:720px;margin:0 auto;padding:32px 20px 64px}h1{font-size:30px;margin:0 0 4px}h2{font-size:19px;margin:28px 0 6px}
  .muted{color:var(--muted)}p{white-space:pre-line;margin:0}
  .card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px;margin-top:20px}
  input,button{font:inherit;width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line);margin-top:10px}
  button{background:var(--coral);color:#fff;border:0;font-weight:700;cursor:pointer}button[disabled]{opacity:.5}
  .ok{color:var(--mint);font-weight:700}.err{color:var(--coral);font-weight:700}
</style></head><body><main>${body}</main></body></html>`;
}

function legal(doc: LegalDoc) {
  return page(doc.title, `<h1>${esc(doc.title)}</h1><p class="muted">Sproutly · Last updated ${esc(LEGAL_UPDATED)}</p>
<p style="margin-top:16px">${esc(doc.intro)}</p>
${doc.sections.map(([h, b]) => `<h2>${esc(h)}</h2><p>${esc(b)}</p>`).join('\n')}`);
}

const DELETE_PAGE = page('Delete your account', `
<h1>Delete your Sproutly account</h1>
<p class="muted">This permanently deletes your profile, companion, friends, posts and sessions. Messages you sent are wiped and show as "Message deleted" to others. This can't be undone.</p>
<p style="margin-top:12px"><b>In the app:</b> Profile → Delete account.<br><b>Here:</b> confirm your email below.</p>
<p class="muted" style="margin-top:12px">If you subscribed to Sproutly Plus, cancel it in Google Play (Payments &amp; subscriptions) as well; deleting your account doesn't cancel it.</p>
<p class="muted" style="margin-top:12px">A suspended account can be deleted too. Records of reports and suspensions are kept for up to 2 years for safety (see the <a href="/privacy">Privacy Policy</a>), and a suspended email can't be used to sign up again while the suspension lasts.</p>
<div class="card">
  <label for="email"><b>Your account email</b></label>
  <input id="email" type="email" autocomplete="email" placeholder="you@mail.com">
  <button id="send">Email me a code</button>
  <div id="step2" style="display:none">
    <label for="code" style="display:block;margin-top:16px"><b>6-digit code</b></label>
    <input id="code" inputmode="numeric" maxlength="6" placeholder="------">
    <button id="del">Permanently delete my account</button>
  </div>
  <p id="msg" style="margin-top:12px"></p>
</div>
<p class="muted" style="margin-top:20px">Trouble? Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> from your account email.</p>
<script>
const $=id=>document.getElementById(id),msg=(t,ok)=>{$('msg').textContent=t;$('msg').className=ok?'ok':'err'};
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||'Something went wrong');return j}
$('send').onclick=async()=>{const e=$('email').value.trim();if(!e)return msg('Enter your email');$('send').disabled=true;
  try{await post('/v1/auth/otp/start',{phoneOrEmail:e});$('step2').style.display='block';msg('Code sent. Check your email (and spam).',true)}catch(x){msg(x.message)}finally{$('send').disabled=false}};
$('del').onclick=async()=>{const e=$('email').value.trim(),c=$('code').value.trim();if(c.length!==6)return msg('Enter the 6-digit code');
  if(!confirm('Delete your Sproutly account permanently?'))return;$('del').disabled=true;
  try{await post('/v1/account/delete-by-code',{phoneOrEmail:e,code:c});$('step2').style.display='none';$('send').style.display='none';msg('Done. If an account existed for this email, it has been deleted.',true)}catch(x){msg(x.message);$('del').disabled=false}};
</script>`);

/** Deleting some of your data while keeping your account (Play's Data safety form links here). */
const DELETE_DATA_PAGE = page('Delete your data', `
<h1>Delete some of your Sproutly data</h1>
<p class="muted">You can remove things you've shared without deleting your account. Everything below is deleted right away.</p>
<div class="card">
<h2 style="margin-top:0">In the app</h2>
<p>• <b>A chat message:</b> long-press it → Delete.
• <b>A story:</b> open it → Delete. Stories also disappear on their own after 24 hours.
• <b>A Show off post:</b> tap the bin on your post.
• <b>A comment:</b> long-press it → Delete. You can also remove any comment on your own post.
• <b>Your profile photo:</b> Profile → your photo → Remove or change it.
• <b>Friends and blocks:</b> Profile → Friends → remove someone.
• <b>A saved look:</b> Closet → My looks → save over it with a different outfit.</p>
</div>
<h2>Deleted automatically</h2>
<p>Chat messages are deleted from our servers after 3 days. Stories are deleted after 24 hours. Show off posts leave the feed after 72 hours.</p>
<h2>Anything else</h2>
<p>To ask us to delete any other data about you, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> from your account email and say what you'd like removed. We'll reply within 30 days.</p>
<p class="muted" style="margin-top:20px">Want to delete everything? <a href="/delete-account">Delete your whole account</a>.</p>`);

/** Published child-safety (CSAE) standards, required by Google Play for social apps. */
const CHILD_SAFETY_PAGE = page('Child safety standards', `
<h1>Child Safety Standards</h1>
<p class="muted">Sproutly · Last updated ${esc(LEGAL_UPDATED)}</p>
<p style="margin-top:16px">Sproutly has zero tolerance for child sexual abuse and exploitation (CSAE), including child sexual abuse material (CSAM). These standards apply to everything on Sproutly: profiles, chats, groups, stories, Show off posts, comments and photos.</p>
<h2>Who can use Sproutly</h2>
<p>You must be at least 13 years old to use Sproutly. Accounts we believe belong to someone under 13 are removed.</p>
<h2>What is not allowed</h2>
<p>• Any sexual content involving minors, real or fictional, including images, videos, drawings, text and links.
• Grooming: befriending or messaging a minor with the intent of sexual contact or exploitation.
• Sextortion, or asking a minor for sexual images or personal information.
• Sexualising minors in any way, or sharing, requesting or trading CSAM.
• Using Sproutly to arrange meeting a minor for sexual purposes, or trafficking.</p>
<h2>How we prevent it</h2>
<p>• Anyone can report a user, message, story, post or comment from inside the app. Content reported by several people is hidden automatically while we review it.
• Anyone can block another user, which stops all contact and hides their content.
• An account reported by several different people within a few days is suspended automatically while we review it: it is signed out at once, cannot sign in, and its email cannot be used to sign up again.
• When something is reported we keep a copy of it, even if it is later deleted, so reviews and reports to the authorities have the evidence they need.
• Messages are limited in rate to prevent spam, and chat messages are deleted from our servers after 3 days.
• We review reports and act on them promptly.</p>
<h2>What we do when we find it</h2>
<p>• We remove the content and permanently ban the accounts involved (they are signed out immediately and cannot return with the same email).
• We preserve the relevant information as required by law.
• We report apparent CSAM to the National Center for Missing &amp; Exploited Children (NCMEC) and to the relevant regional and national authorities, and we cooperate with law enforcement.</p>
<h2>How to report</h2>
<p>• In the app: tap the report (shield) button on a post or story, or long-press a message or comment and choose Report. You can also report a user from their profile.
• By email: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Please include the username and what happened. Do not attach or forward abusive images.
• If a child is in immediate danger, contact your local police or emergency services first.</p>
<h2>Contact</h2>
<p>Our child safety point of contact can be reached at <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>`);

export async function webRoutes(app: FastifyInstance) {
  const html = (body: string) => (_req: unknown, reply: { type: (t: string) => { send: (b: string) => unknown } }) => reply.type('text/html; charset=utf-8').send(body);
  const privacy = legal(PRIVACY);
  const terms = legal(TERMS);
  app.get('/privacy', html(privacy));
  app.get('/terms', html(terms));
  app.get('/delete-account', html(DELETE_PAGE));
  app.get('/delete-data', html(DELETE_DATA_PAGE));
  app.get('/child-safety', html(CHILD_SAFETY_PAGE));

  app.post('/v1/account/delete-by-code', async (req) => {
    const b = z.object({ phoneOrEmail: z.string().min(3).max(200), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
    return deleteAccountWithCode(b.phoneOrEmail, b.code);
  });
}
