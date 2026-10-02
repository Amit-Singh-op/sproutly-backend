/**
 * Privacy policy + terms, served at /privacy and /terms (the URLs given to Google Play) and mirrored in the app's
 * Legal screen. Written from what Sproutly actually collects. Review before publishing; not legal advice.
 */
export const CONTACT_EMAIL = 'sproutlyy.app@gmail.com';
export const LEGAL_UPDATED = '2 October 2026';

export type LegalDoc = { title: string; intro: string; sections: [heading: string, body: string][] };

export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  intro: `This policy explains what Sproutly ("we", "us") collects when you use the Sproutly app, why, how long we keep it, and the choices you have. Questions: ${CONTACT_EMAIL}.`,
  sections: [
    ['What we collect',
      '• Account: your email address (to sign you in with a one-time code), display name, username, avatar colour, optional profile photo, and your time zone (for daily quests and streaks).\n'
      + '• Your companion: its name, level, energy, coins, outfits, moves, streak and streak shields, eggs, room settings and chat-style choices, and when you last looked after it.\n'
      + '• Things you create: chat messages (including stickers, emojis and polls) and poll votes, 24-hour stories (photos or text), Show off posts (photos, captions and the activity you tag), cheers, groups you create or join, friends, and people you block or report.\n'
      + '• Photos: only the ones you choose to upload as your profile photo, a story or a Show off post. We never access your photo library or camera except when you pick or take a photo.\n'
      + '• Activity: whether you are online, and when you have a chat open, so friends can see you in its room. Also who viewed your stories, and chat streaks (whether you and a friend both messaged each other on a given day).\n'
      + '• Friend updates: when a friend visits your room, signs your guestbook, levels up or reaches a streak milestone, a short note about it is shown to you (and yours to your friends) in the app.\n'
      + '• App usage: which features you use and when you open the app (for example "opened the shop" or "claimed a daily gift"), with your platform and app version. We use this only to understand and improve Sproutly; it is never sold or used for ads, and no third-party analytics service receives it.\n'
      + '• Device: a push-notification token, your platform (Android/iOS) and app version, so we can send the notifications you have turned on.\n'
      + '• Purchases: if you subscribe to Sproutly Plus, your plan and renewal date. Payment is handled by Google Play or the App Store; we never see your card details.\n'
      + '• Technical: server logs (such as IP address and request time) kept briefly for security and to fix problems.'],
    ['How we use it',
      'To run the app: sign you in, deliver your messages, show your companion, stories and posts to the right people, send the notifications you have turned on, apply your subscription, keep the service safe (rate limits, blocking, reports) and fix bugs. We do not sell your data and we do not show ads.'],
    ['Who can see what',
      '• Messages: only the people in that chat.\n'
      + '• Plaza: while you have the Plaza open, people in the same spot see your companion, your name, where you walk, your emotes and the short lines you say there. People you block never see you, and you never see them.\n'
      + '• Stories, Show off posts and your online status: your friends and people you share a chat with. People you block never see them.\n'
      + '• Your name, username, profile photo, companion and level: people you chat with or who find you in search.\n'
      + '• When you have a chat open, the others in it see your companion in its room.'],
    ['Who we share it with',
      'Only with services that run Sproutly for us, under their own privacy terms: Render (servers and live data such as who is online), Neon (database), Cloudinary (storing and delivering the photos you upload), Resend (sign-in code emails), Google Firebase Cloud Messaging (push notifications), RevenueCat and Google Play / Apple App Store (subscriptions). We may disclose information if required by law.'],
    ['How long we keep it',
      '• Chat messages are deleted automatically 3 days after they are sent, in every chat.\n'
      + '• Stories disappear after 24 hours and are then deleted.\n'
      + '• Show off posts appear in feeds for 72 hours; you can delete your own at any time.\n'
      + '• Friend updates are kept for 30 days and app usage records for 180 days, then deleted.\n'
      + '• Plaza chat lines are never saved to our database: the last few in each spot are kept for 10 minutes so people arriving can see them, then deleted.\n'
      + '• Everything else (profile, companion, friends, settings) is kept while your account exists.\n'
      + '• When you delete your account we delete your profile, companion, friends, posts, stories, sessions and devices, and messages you sent are wiped.\n'
      + '• Server logs are kept for up to 30 days. Copies in our providers\' backups expire on their normal schedules.'],
    ['Security',
      'Data is encrypted in transit (HTTPS). Sign-in codes and session tokens are stored only as secure hashes. Photos can only be uploaded through a signed, one-time permission from our server.'],
    ['Your choices and rights',
      `• Change your display name and profile photo in the app at any time.\n• Turn notifications on or off (Profile → Notifications). Notifications are only sent for private chats and when someone @mentions you in a group.\n• Turn reminders on or off (Profile → Reminders). Reminders (daily gift, streak about to end, coming back after a break) are scheduled on your phone, not sent by our servers.\n• Turn off read receipts or mute chats in the app.\n• Delete your own stories and Show off posts at any time.\n• Block and report people, messages, stories and posts in the app.\n• Delete your account in the app (Profile → Delete account) or at https://sproutly-backend.onrender.com/delete-account.\n• Ask for a copy of your data or any other privacy request by emailing ${CONTACT_EMAIL}.`],
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
    ['Your account', 'You need a valid email address to sign in. Keep access to it safe; anyone with access to your email can sign in as you. You are responsible for activity on your account. You must be at least 13 years old to use Sproutly.'],
    ['Be kind', 'Do not use Sproutly to harass, threaten, spam or impersonate anyone, or to share illegal, hateful, sexual or violent content, in chats, stories, posts or photos. We may remove content and suspend or delete accounts that break these rules. You can block and report people, messages, stories and posts in the app; content reported by several people may be hidden or removed automatically.'],
    ['Your content', 'You own what you post, including photos. You give us permission to store it and show it to the people you share it with, only to run the app. Only post photos you have the right to share.'],
    ['Messages and stories are temporary', 'Chat messages are deleted automatically 3 days after they are sent, and stories after 24 hours. Save anything you want to keep.'],
    ['Sproutly Plus', 'Plus is an optional subscription sold through Google Play or the App Store, billed monthly or yearly at the price shown in the app before you buy. If a free trial is offered, you are charged when it ends unless you cancel before then. It renews automatically until you cancel it in your store account settings, at least 24 hours before the renewal date. Refunds follow the store\'s policies. Deleting your Sproutly account does not cancel a store subscription.'],
    ['Availability', 'We work to keep Sproutly running, but it is provided "as is" and may change or be interrupted. To the extent allowed by law, we are not liable for indirect losses from using the app.'],
    ['Ending', 'You can stop using Sproutly and delete your account at any time. We may end or suspend accounts that break these terms.'],
    ['Changes', 'We may update these terms; we will change the date above and tell you in the app about important changes.'],
  ],
};
