/**
 * Privacy policy + terms, served at /privacy and /terms (the URLs given to Google Play) and mirrored in the app's
 * Legal screen. Written from what Sproutly actually collects. Review before publishing; not legal advice.
 */
export const CONTACT_EMAIL = 'sproutlyy.app@gmail.com';
export const LEGAL_UPDATED = '14 November 2026';

export type LegalDoc = { title: string; intro: string; sections: [heading: string, body: string][] };

export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  intro: `This policy explains what Sproutly ("we", "us") collects when you use the Sproutly app, why, how long we keep it, and the choices you have. Questions: ${CONTACT_EMAIL}.`,
  sections: [
    ['What we collect',
      '• Account: your email address (to sign you in with a one-time code), display name, username, avatar colour, optional profile photo and bio, and your time zone (for daily quests and streaks).\n'
      + '• Your companion: its name, level, energy, coins, the clothes and items you own and what it is wearing, up to three saved looks, moves, streak and streak shields, eggs, room settings and chat-style choices, and when you last looked after it.\n'
      + '• Wardrobe purchases: which items you bought with coins and when. Coins are earned in the app and cannot be bought with money.\n'
      + '• Things you create: chat messages (including stickers, emojis and polls) and poll votes, 24-hour stories (photos or text), Show off posts (photos, captions and the activity you tag), cheers, groups you create or join, friends, and people you block or report.\n'
      + '• Photos: only the ones you choose to upload as your profile photo, a story or a Show off post. We never access your photo library or camera except when you pick or take a photo. Photos are made smaller on your phone before they are uploaded, and photos you view are kept in a temporary cache on your phone so they load faster.\n'
      + '• Activity: whether you are online, and when you have a chat open, so friends can see you in its room. Also who viewed your stories, and chat streaks (whether you and a friend both messaged each other on a given day).\n'
      + '• Friends and friend requests: who you are friends with, requests you send and receive (and when), and your setting for who can message you (everyone, or friends only).\n'
      + '• Arcade games: each game you play (which game, when, your score and the coins it earned), your best scores for the week and of all time, and 1 vs 1 matches with friends (who played, the moves in board games, scores and who won). Scores that are impossible for the time played are kept and marked, and are not counted.\n'
      + '• Songs: if you add songs to your profile (up to 5), their links from a music app (Spotify, YouTube, Apple Music or SoundCloud) with their title, artist and cover. When you send a song link in a chat, we look up the same details and show them as a card in that chat.\n'
      + '• Friend updates: when a friend visits your room, signs your guestbook, levels up, reaches a streak milestone, sends or accepts a friend request, or challenges you to a game, a short note about it is shown to you (and yours to your friends) in the app.\n'
      + '• App usage: which features you use and when you open the app (for example "opened the shop" or "claimed a daily gift"), with your platform and app version. We use this only to understand and improve Sproutly; it is never sold or used for ads, and no third-party analytics service receives it.\n'
      + '• Device: a push-notification token, your platform (Android/iOS) and app version, so we can send the notifications you have turned on; and an identifier for this install of the app (the Android ID for Sproutly, or the iPhone vendor ID), used only for safety: so an account banned for serious or repeated abuse cannot simply come back on the same phone.\n'
      + '• Purchases: Sproutly Plus is coming soon and is not on sale yet. Once it is, if you subscribe we keep your plan and renewal date. Payment is handled by Google Play or the App Store; we never see your card details.\n'
      + '• Safety and moderation: when you report something, or someone reports you, we keep a record of the report (the reason picked and any note), a copy of what was reported (for example the message, post, story, comment or profile, as it was at the time, and for a chat message the messages just before and after it in that chat), and any action we took (a warning, removed content, a mute or a suspension), with which moderator took it. With each moderation record we also keep the network (IP) address and app install the reported account last used. To catch the most serious harm quickly, a short automatic check looks for unmistakable threats, slurs and sexual requests in what is written; a match only asks a moderator to look and never changes or blocks anything by itself. If photo scanning is turned on, uploaded photos are checked automatically and photos that break the rules are taken down for review. Only Sproutly moderators can see reports, and the person reported is never told who reported them. When a moderator acts on your report, we let you know (but not what was done). If an account is suspended we also record its email address, the reason, and any attempts to sign in while suspended.\n'
      + '• Technical: server logs (such as IP address and request time) kept briefly for security and to fix problems.'],
    ['How we use it',
      'To run the app: sign you in, deliver your messages, show your companion, stories and posts to the right people, send the notifications you have turned on, apply your subscription, keep the service safe (rate limits, blocking, reports, reviewing reports and suspending accounts that break the rules) and fix bugs. We do not sell your data and we do not show ads.'],
    ['Who can see what',
      '• Messages: only the people in that chat. If you turn on "Only friends can message me", people who are not your friends cannot message you, including in chats you already had with them.\n'
      + '• Friend requests: only the person you sent one to sees it. A declined request is simply removed; the sender is not told.\n'
      + '• Arcade leaderboards: other players see your name, companion and best score for each game, on the weekly and all-time boards, among friends and in groups you are in. People you block, and people who block you, do not see each other there.\n'
      + '• 1 vs 1 matches: only you and the friend you play see the match, its moves and its result, and your record against each other.\n'
      + '• Plaza: while you have the Plaza open, people in the same spot see your companion, your name, where you walk, your emotes and the short lines you say there. People you block never see you, and you never see them.\n'
      + '• The songs on your profile: only your friends (on your profile, and the newest in their friends list). A song card in a chat is seen by the people in that chat, like any message.\n'
      + '• Stories, Show off posts and your online status: your friends and people you share a chat with. People you block never see them.\n'
      + '• Your profile (name, username, profile photo, bio, companion, level, growth stage, current streak, and whether you have Plus): people you chat with or who find you in search. Your coins, shields and settings are never shown to others.\n'
      + '• When you have a chat open, the others in it see your companion in its room.\n'
      + '• Groups: anyone browsing groups sees each group\'s member count and how many people are in its chat right now (a number, not who). Groups have no member limit; up to 25 people can be in a group chat at the same time.\n'
      + '• Updates are live: new stories, Show off posts, cheers, comments and who is online reach the people allowed to see them as they happen.'],
    ['Who we share it with',
      'Only with services that run Sproutly for us, under their own privacy terms: Render (servers and live data such as who is online), Neon (database), Cloudinary (storing and delivering the photos you upload), Resend (sign-in code emails), Google Firebase Cloud Messaging (push notifications), RevenueCat and Google Play / Apple App Store (subscriptions). When you add or send a song link, the music service it is from (to look up its title and cover). We may disclose information if required by law.'],
    ['How long we keep it',
      '• Chat messages are deleted automatically 3 days after they are sent, in every chat.\n'
      + '• Stories disappear after 24 hours and are then deleted.\n'
      + '• Show off posts appear in feeds for 72 hours; you can delete your own at any time.\n'
      + '• Friend updates are kept for 30 days and app usage records for 180 days, then deleted.\n'
      + '• Plaza chat lines are not saved to our database: the last few in each spot are kept for 10 minutes so people arriving can see them, and each person’s last few lines for 48 hours so a report made from the Plaza can be checked, then deleted.\n'
      + '• When you delete a message (or your account), it disappears for everyone straight away; a private copy is kept for 14 days, which only moderators can see and only when looking into a report, then deleted.\n'
      + '• Arcade scores, best scores and 1 vs 1 matches are kept while your account exists, so your records and leaderboards stay right.\n'
      + '• The songs on your profile are kept until you remove them or delete your account. Song cards in chats are deleted with their message.\n'
      + '• Everything else (profile, companion, friends, friend requests, settings) is kept while your account exists.\n'
      + '• When you delete your account we delete your profile, companion, music, friends, friend requests, game scores and matches, posts, stories, sessions and devices, and messages you sent are wiped.\n'
      + '• Moderation records (reports, the copies of reported content, and suspensions) are kept for up to 2 years, including after the account is deleted, so we can keep the community safe and stop banned people from returning. We may keep them longer where the law requires it (for example, to report child exploitation).\n'
      + '• The email address of a suspended account is kept for as long as the suspension lasts, so it cannot be used to sign up again.\n'
      + '• Server logs are kept for up to 30 days. Copies in our providers\' backups expire on their normal schedules.'],
    ['Permissions on your phone',
      '• Camera and photos: only when you choose to take or pick a photo for your profile picture, a story or a Show off post. Nothing is uploaded unless you post it.\n'
      + '• Notifications: to tell you about private messages, @mentions and the reminders you turn on. You can turn them off in Profile or in your phone settings.\n'
      + '• Sproutly does not ask for your location, contacts or microphone.'],
    ['Security',
      '• Data is encrypted in transit (HTTPS), and our servers send strict security headers.\n'
      + '• Sign-in codes and session tokens are stored only as secure hashes. Codes expire after 10 minutes and allow a few tries; sessions renew with one-time tokens, and a reused token signs that session out everywhere.\n'
      + '• On your phone, your session is kept in the system\'s secure storage (Android Keystore / iOS Keychain).\n'
      + '• We limit how often requests and actions can be made (per account, per action and per network address) to stop spam, code guessing, scripts and abuse; when a limit is reached the app tells you how long to wait. To do this we briefly process your IP address; see Technical data above.\n'
      + '• If an account is suspended, it is signed out everywhere immediately and its sessions are ended.\n'
      + '• Every action is checked on our servers: you can only read chats you are in, edit or delete your own content, and see what people have chosen to share with you.\n'
      + '• Photos can only be uploaded through a signed, one-time permission from our server.'],
    ['Your choices and rights',
      `• Change your display name and profile photo in the app at any time.\n• Turn notifications on or off (Profile → Notifications). Notifications are only sent for private chats and when someone @mentions you in a group.\n• Turn reminders on or off (Profile → Reminders). Reminders (daily gift, streak about to end, coming back after a break) are scheduled on your phone, not sent by our servers.\n• Turn off read receipts or mute chats in the app.\n• Delete your own stories and Show off posts at any time.\n• Block and report people, messages, stories and posts in the app.\n• Delete your account in the app (Profile → Delete account) or at https://sproutly-backend.onrender.com/delete-account.\n• Ask for a copy of your data or any other privacy request by emailing ${CONTACT_EMAIL}.\n• If your account was suspended and you think it was a mistake, email ${CONTACT_EMAIL} from your account email to ask us to review it.`],
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
    ['Be kind', 'Do not use Sproutly to harass, threaten, spam or impersonate anyone, or to share illegal, hateful, sexual or violent content, in chats, the Plaza, stories, posts, photos, your bio or the songs you share. Do not use a name that pretends to be Sproutly or its team (for example “Sproutly Support” or “Admin”), and do not sign up with a temporary email address. We may remove content and suspend or delete accounts that break these rules. You can block and report people, messages, stories and posts in the app; content reported by several people may be hidden or removed automatically.'],
    ['Moderation', `Reports are reviewed by Sproutly moderators, who may dismiss them, warn you, remove what you posted, mute you (you can still read everything, but cannot send messages or post) for a set time, suspend your account for a set time, or ban it. Reports alone never ban anyone: if several established accounts report you within a short time, your account is put on hold (muted) for up to 24 hours until a moderator reviews it. A suspended account is signed out straight away, cannot sign in, and its email address cannot be used to create a new account while the suspension lasts (for good, if it is a ban). Repeated false reports count for less. You can still delete a suspended account. If you think a suspension is a mistake, email ${CONTACT_EMAIL} from your account email and we will review it.`],
    ['Friends and games', 'Adding someone sends them a friend request; you become friends when they accept. You can only challenge friends to 1 vs 1 games, and a challenge expires if it is not answered within 10 minutes. Leaving a game in the middle counts as a loss, and in board games a player who does not move for a day loses. Arcade coins are capped per game and per day, and we may remove scores or coins that were not earned fairly.'],
    ['Fair use', 'Do not use bots, scripts or modified versions of the app, and do not try to get around limits, blocks or suspensions. We limit how often actions can be done; if you reach a limit, wait for the time the app shows.'],
    ['Your content', 'You own what you post, including photos and your bio. You give us permission to store it and show it to the people you share it with, only to run the app. Only post photos you have the right to share. Songs you share are links to the music app they come from; Sproutly shows their title and cover but does not host or play the music.'],
    ['Messages and stories are temporary', 'Chat messages are deleted automatically 3 days after they are sent, and stories after 24 hours. Save anything you want to keep.'],
    ['Coins and items', 'Coins, eggs, shields, clothes, outfits and other in-app items are earned by using Sproutly. Some clothes are available only for a limited time or at events; items you already own stay yours. They have no real-world value, cannot be bought, sold or exchanged for money or anything outside the app, and are not refundable. We may change how they are earned or what they do, and they end when your account is deleted.'],
    ['Sproutly Plus', 'Plus is coming soon and cannot be bought yet; the app shows it as "Coming soon". When it launches, Plus will be an optional subscription sold through Google Play or the App Store, billed monthly or yearly at the price shown in the app before you buy. If a free trial is offered, you are charged when it ends unless you cancel before then. It will renew automatically until you cancel it in your store account settings, at least 24 hours before the renewal date. Refunds follow the store\'s policies. Deleting your Sproutly account does not cancel a store subscription.'],
    ['Availability', 'We work to keep Sproutly running, but it is provided "as is" and may change or be interrupted. To the extent allowed by law, we are not liable for indirect losses from using the app.'],
    ['Ending', 'You can stop using Sproutly and delete your account at any time. We may end or suspend accounts that break these terms.'],
    ['Changes', 'We may update these terms; we will change the date above and tell you in the app about important changes.'],
  ],
};
