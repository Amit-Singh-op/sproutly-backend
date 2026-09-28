/**
 * Privacy policy + terms, served at /privacy and /terms (the URLs given to Google Play) and mirrored in the app's
 * Legal screen. Written from what Sproutly actually collects. Review before publishing; not legal advice.
 */
export const CONTACT_EMAIL = 'sproutlyy.app@gmail.com';
export const LEGAL_UPDATED = '24 September 2026';

export type LegalDoc = { title: string; intro: string; sections: [heading: string, body: string][] };

export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  intro: `This policy explains what Sproutly ("we", "us") collects when you use the Sproutly app, why, and the choices you have. Questions: ${CONTACT_EMAIL}.`,
  sections: [
    ['What we collect',
      '• Account: your email address (to sign you in with a one-time code), display name, username and avatar colour, and your time zone (for daily quests and streaks).\n'
      + '• Your companion: its name, level, energy, outfits, moves, streak and room settings.\n'
      + '• Things you create: chat messages, stickers, polls and poll votes, Showcase posts and cheers, groups you create or join, friends, and people you block or report.\n'
      + '• Device: a push-notification token, your platform (Android/iOS) and app version, so we can send you notifications.\n'
      + '• Purchases: if you subscribe to Sproutly Plus, your plan and renewal date. Payment is handled by Google Play or the App Store; we never see your card details.\n'
      + '• Technical: server logs (such as IP address and request time) kept briefly for security and to fix problems.'],
    ['How we use it',
      'To run the app: sign you in, deliver your messages, show your companion and progress, send notifications you have not muted, apply your subscription, keep the service safe (rate limits, blocking, reports) and fix bugs. We do not sell your data and we do not show ads.'],
    ['Who we share it with',
      'Only with services that run Sproutly for us, under their own privacy terms: Render (servers), Neon (database), Google (sign-in code emails), Google Firebase Cloud Messaging (push notifications), RevenueCat and Google Play / Apple App Store (subscriptions). Other Sproutly users see what you choose to share with them: your name, companion, messages in chats you are in, and your Showcase posts. We may disclose information if required by law.'],
    ['How long we keep it',
      'We keep your data while your account exists. When you delete your account we delete your profile, companion, friends, posts, sessions and devices. Messages you sent are wiped and shown to others as "Message deleted". Server logs are kept for up to 30 days. Copies in our providers\' backups expire on their normal schedules.'],
    ['Security',
      'Data is encrypted in transit (HTTPS). Sign-in codes and session tokens are stored only as secure hashes.'],
    ['Your choices and rights',
      `• Change your display name in the app at any time.\n• Turn off read receipts or mute chats in the app.\n• Delete your account in the app (Profile → Delete account) or at https://sproutly-backend.onrender.com/delete-account.\n• Ask for a copy of your data or any other privacy request by emailing ${CONTACT_EMAIL}.`],
    ['Children',
      `Sproutly is not directed to children under 13 and we do not knowingly collect their data. If you believe a child under 13 has an account, contact ${CONTACT_EMAIL} and we will delete it.`],
    ['Changes',
      'If we change this policy we will update the date above and, for important changes, tell you in the app.'],
  ],
};

export const TERMS: LegalDoc = {
  title: 'Terms of Use',
  intro: `By using Sproutly you agree to these terms. Questions: ${CONTACT_EMAIL}.`,
  sections: [
    ['Your account', 'You need a valid email address to sign in. Keep access to it safe; anyone with access to your email can sign in as you. You are responsible for activity on your account.'],
    ['Be kind', 'Do not use Sproutly to harass, threaten, spam or impersonate anyone, or to share illegal, hateful, sexual or violent content. We may remove content and suspend or delete accounts that break these rules. You can block and report people in the app.'],
    ['Your content', 'You own what you post. You give us permission to store and show it to the people you share it with, only to run the app.'],
    ['Sproutly Plus', 'Plus is an optional subscription sold through Google Play or the App Store. It renews automatically until you cancel it in your store account settings, at least 24 hours before the renewal date. Refunds follow the store\'s policies. Deleting your Sproutly account does not cancel a store subscription.'],
    ['Availability', 'We work to keep Sproutly running, but it is provided "as is" and may change or be interrupted. To the extent allowed by law, we are not liable for indirect losses from using the app.'],
    ['Ending', 'You can stop using Sproutly and delete your account at any time. We may end or suspend accounts that break these terms.'],
    ['Changes', 'We may update these terms; we will change the date above and tell you in the app about important changes.'],
  ],
};
