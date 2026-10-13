// Mirror of sproutly/src/data/types.ts — the app/server contract. Keep in sync (doc section 1: 'shared').
/** Core domain types shared by the app and every backend service. */

export type UUID = string;

// ---------- companion ----------
export const MOODS = [
  'idle', 'happy', 'eat', 'play', 'sleep', 'wave', // free
  'music', 'walk', 'spin', 'flip', 'cheer', 'zen', // Plus
] as const;
export type Mood = (typeof MOODS)[number];

export const OUTFITS = ['none', 'party', 'flower', 'scarf', 'wizard', 'shades', 'crown', 'aura', 'headphones', 'cap', 'bandana'] as const;
export type Outfit = (typeof OUTFITS)[number];

/** Also picks the character: drake and bolt are Plus-only. */
export const PALETTE_IDS = ['mo', 'pip', 'blu', 'drake', 'bolt'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

/** Facial expressions. The first six every character has (drawn its own way); the rest belong to one species. */
export const EMOTES = ['smile', 'laugh', 'angry', 'sad', 'love', 'shock', 'bloom', 'shy', 'fire', 'smug', 'glitch', 'scan'] as const;
export type Emote = (typeof EMOTES)[number];

/** Home-screen actions. `dance` is Plus-only. */
export const COMPANION_ACTIONS = ['pet', 'feed', 'play', 'nap', 'wake', 'dance'] as const;
export type CompanionAction = (typeof COMPANION_ACTIONS)[number];

export const ACTION_RULES: Record<CompanionAction, { mood: Mood; gain: number; line: string; dailyCap: number; plus: boolean }> = {
  pet: { mood: 'happy', gain: 5, line: 'Hehe, that tickles!', dailyCap: 10, plus: false },
  feed: { mood: 'eat', gain: 10, line: 'Yum, berry crunch!', dailyCap: 5, plus: false },
  play: { mood: 'play', gain: 15, line: 'Wheee! Again!', dailyCap: 5, plus: false },
  nap: { mood: 'sleep', gain: 0, line: 'zzz...', dailyCap: 999, plus: false },
  wake: { mood: 'happy', gain: 0, line: 'Good morning!', dailyCap: 999, plus: false },
  dance: { mood: 'music', gain: 20, line: 'Dance party!', dailyCap: 5, plus: true },
};

export const ENERGY_PER_LEVEL = 1000;

// ---------- catalog & inventory v2 ----------
export const CATALOG_SLOTS = ['body', 'head', 'face', 'top', 'bottom', 'shoes', 'neck', 'back', 'hand', 'colour', 'emote', 'trail', 'frame'] as const;
export type CatalogSlot = (typeof CATALOG_SLOTS)[number];

export const RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type Rarity = (typeof RARITIES)[number];

export const UNLOCK_METHODS = ['starter', 'level', 'streak', 'quest', 'egg', 'plus', 'reward', 'shop'] as const;
export type UnlockMethod = (typeof UNLOCK_METHODS)[number];

export interface CatalogItem {
  id: string;
  name: string;
  slot: CatalogSlot;
  rarity: Rarity;
  unlockMethod: UnlockMethod;
  unlockRequirement?: number | string;
  plusOnly: boolean;
  priceCoins?: number;
  description?: string;
  assetKey?: string;
  /** Set by GET /catalog: false = not on sale right now (an expired drop or hidden item you already own). */
  available?: boolean;
  /** A limited drop: when it leaves. */
  availableUntil?: string;
  /** Highlighted as a new drop. */
  featuredNew?: boolean;
  owned?: boolean;
  locked?: boolean;
  lockReason?: 'plus' | 'level' | 'not_owned';
  isNew?: boolean;
}

export interface EquippedSlots {
  /** Legacy: tops and neckwear saved before they had their own slots (resolveEquippedSlots moves them). */
  body?: string;
  head?: string;
  face?: string;
  top?: string;
  bottom?: string;
  shoes?: string;
  neck?: string;
  back?: string;
  hand?: string;
  colour?: PaletteId;
  emote?: Emote;
  trail?: string;
  frame?: string;
}

export interface UserInventoryItem {
  itemId: string;
  count: number;
  source: UnlockMethod;
  acquiredAt: string;
  seen: boolean;
}

export interface CoinTransaction {
  id: UUID;
  userId: UUID;
  amount: number;
  balanceAfter: number;
  source: string;
  referenceId?: string;
  createdAt: string;
}

export interface XpTransaction {
  id: UUID;
  userId: UUID;
  amount: number;
  source: 'message' | 'room_visit' | 'group_join' | 'daily_login' | 'quest' | 'invite' | 'companion_action';
  day: string;
  createdAt: string;
}

export interface Companion {
  name: string;
  palette: PaletteId;
  level: number;
  energy: number; // 0..999
  coins: number;
  equippedOutfit: Outfit;
  equippedSlots?: EquippedSlots;
  signatureMove: Mood;
  roomTheme: 'basic' | 'cabin';
  streak: number;
  /** Banked streak shields (0..MAX_SHIELDS). Missing on old servers. */
  shields?: number;
  /** Last companion action (ISO). Drives how Mo looks when you come back and the local reminders. */
  lastActionAt?: string | null;
  /** Local day (YYYY-MM-DD) of the last action that counted for the streak. */
  lastActiveDay?: string | null;
}

export interface AppConfig {
  plusEnabled: boolean;
  approvalRequired: boolean;
  phaseFlags?: Record<string, boolean>;
}

// ---------- chat ----------
export const MESSAGE_TYPES = ['text', 'sticker', 'poll', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const STICKER_KINDS = ['happy', 'music', 'eat', 'sleep'] as const;
export type StickerKind = (typeof STICKER_KINDS)[number];
export const STICKER_LABELS: Record<StickerKind, string> = { happy: 'Yay!', music: 'Dance', eat: 'Nom', sleep: 'Sleepy' };

export interface StickerPayload {
  kind: StickerKind;
  /** An emote sticker. `kind` is still set (as a fallback animation) for clients that predate emotes. */
  emote?: Emote;
  snapshot: { palette: PaletteId; outfit: Outfit; equippedSlots?: EquippedSlots };
}
export interface PollPayload {
  question: string;
  options: string[];
  counts: number[];
  total: number;
  myVote: number | null;
}
export interface SystemPayload {
  event: 'member_joined' | 'member_left' | 'renamed' | 'companion_event';
  text: string;
}

export interface Message {
  id: UUID;
  clientId: UUID;
  conversationId: UUID;
  seq: number;
  senderId: UUID | null;
  type: MessageType;
  body: string | null;
  /** Text messages: a SongCard when the message has a song link in it. */
  payload: StickerPayload | PollPayload | SystemPayload | SongCard | null;
  createdAt: string; // ISO
  editedAt: string | null;
  deletedAt: string | null;
}

/** Local-only delivery state of an own message. */
export type MessageState = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface ConversationSummary {
  id: UUID;
  kind: 'dm' | 'group';
  title: string;
  avatarColor: string;
  avatarUrl?: string | null;
  initials: string;
  lastSeq: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: number;
  memberCount: number;
  plusOnly: boolean;
  otherUserId: UUID | null; // for DMs (presence dot)
  /** DM partner online when the list was fetched (live 'presence' events override it). */
  otherOnline?: boolean;
  muted: boolean;
  pinned: boolean;
  /** DMs: the chat streak with the other person (null when there is none). */
  friendStreak?: FriendStreak | null;
  /** Groups: people in the chat right now, out of `capacity` at once (live via 'group:count'). */
  liveCount?: number;
  capacity?: number;
}
/** A public group found by search, with its live numbers. */
export interface GroupHit { id: UUID; title: string; memberCount: number; liveCount?: number; capacity?: number; full?: boolean; plusOnly?: boolean; joined?: boolean }

export interface MemberReceipt {
  userId: UUID;
  deliveredSeq: number;
  readSeq: number;
}

// ---------- Plus chat style ----------
export const BORDER_DESIGNS = ['solid', 'dashed', 'double', 'dotted', 'glow'] as const;
export type BorderDesign = (typeof BORDER_DESIGNS)[number];
export const MESSAGE_ANIMATIONS = ['none', 'pop', 'float', 'shimmer', 'wiggle'] as const;
export type MessageAnimation = (typeof MESSAGE_ANIMATIONS)[number];
export const WALLPAPERS = ['none', 'lavender', 'mint', 'peach', 'sky', 'cream', 'night'] as const;
export type WallpaperId = (typeof WALLPAPERS)[number];

export const AVATAR_ANIMATIONS = ['float', 'bounce', 'spin', 'glide', 'zen'] as const;
export type AvatarAnimation = (typeof AVATAR_ANIMATIONS)[number];

export const AVATAR_EFFECTS = ['fire', 'water', 'sparkle', 'nature', 'lightning', 'hearts'] as const;
export type AvatarEffect = (typeof AVATAR_EFFECTS)[number];

export const AVATAR_CHARMS = ['crown', 'star', 'diamond', 'flame', 'lightning', 'sparkle'] as const;
export type AvatarCharm = (typeof AVATAR_CHARMS)[number];

export interface ChatStyle {
  bubble: string;
  text: string;
  border: string;
  design: BorderDesign;
  avatar: string;
  animation: MessageAnimation;
  wallpaper: WallpaperId;
  /** Plus avatar-stage picks; unset means none chosen. */
  avatarAnimation?: AvatarAnimation;
  avatarEffect?: AvatarEffect;
  avatarCharm?: AvatarCharm;
}

/** Everything a client needs to render another user's messages. */
export interface UserStyle {
  userId: UUID;
  displayName: string;
  handle?: string;
  initials: string;
  avatarColor: string;
  avatarUrl?: string | null;
  isPlus: boolean;
  style: ChatStyle | null; // null => free styling
  companion: { palette: PaletteId; outfit: Outfit; equippedSlots?: EquippedSlots; level?: number; signatureMove: Mood };
  version: number;
}

// ---------- entitlements ----------
export interface Entitlements {
  plusActive: boolean;
  period: 'monthly' | 'yearly' | null;
  currentPeriodEnd: string | null;
  plusSince: string | null;
}

// ---------- quests ----------
export interface Quest {
  key: string;
  title: string;
  reward: number;
  target: number;
  progress: number;
  done: boolean;
}

// ---------- showcase ----------
export interface ShowcasePost {
  id: UUID;
  userId: UUID;
  authorName: string;
  authorInitials: string;
  authorColor: string;
  authorUrl?: string | null;
  authorIsPlus: boolean;
  caption: string;
  /** Photo posted with it (Cloudinary). Without one, the card shows the companion snapshot. */
  imageUrl?: string | null;
  /** What they were doing ("daily activity"). */
  activity?: ShowcaseActivity | null;
  createdAt: string;
  snapshot: { name: string; level: number; palette: PaletteId; outfit: Outfit; equippedSlots?: EquippedSlots; outfitLabel: string; signatureMove: Mood };
  cheerCount: number;
  cheeredByMe: boolean;
  topOfWeek: boolean;
  /** 'day' = a moment from your day (takes comments); 'mo' = a Mo update (no comments). */
  kind: ShowcaseKind;
  commentCount: number;
}

export type ShowcaseKind = 'day' | 'mo';
export interface ShowcaseComment {
  id: UUID;
  postId: UUID;
  userId: UUID;
  authorName: string;
  authorInitials: string;
  authorColor: string;
  authorUrl?: string | null;
  authorIsPlus: boolean;
  body: string;
  createdAt: string;
}
export const COMMENT_MAX = 300;

// ---------- groups ----------
export interface GroupCard {
  id: UUID;
  title: string;
  description: string;
  category: string;
  memberCount: number;
  avatarColor: string;
  initials: string;
  plusOnly: boolean;
  joined: boolean;
  /** People in the chat right now, out of `capacity` at once; `full` = no room right now (live via 'group:count'). */
  liveCount?: number;
  capacity?: number;
  full?: boolean;
}
/** A group's live numbers: members (no limit) and how many are in the chat right now (sent to viewers and members). */
export interface GroupCount { id: UUID; memberCount: number; liveCount: number; capacity: number; full: boolean }

export interface EventCard {
  id: UUID;
  title: string;
  description: string;
  rewardItemId: string;
  /** Seasonal events: when it ends and how much daily-drop energy is multiplied while it runs. */
  endsAt?: string;
  dropMultiplier?: number;
  emoji?: string | null;
}

export interface Me {
  id: UUID;
  handle: string;
  displayName: string;
  initials: string;
  avatarColor: string;
  avatarUrl?: string | null;
  timezone: string;
  readReceipts: boolean;
  /** Who can message you privately. */
  dmPolicy: 'everyone' | 'friends';
  /** Settings → Notifications (push). Only private chats and @mentions in groups ever notify. */
  notificationsEnabled?: boolean;
  /** Short bio on your profile (up to BIO_MAX characters), or null. */
  bio?: string | null;
  /** Can open the moderation tools (set on the server, never by the app). */
  isAdmin?: boolean;
  /** A warning to show once, or that you're muted. */
  modNotice?: ModNotice | null;
  /** Invite-only: false until an admin approves the account (the app shows the waitlist screen). */
  approved: boolean;
  companion: Companion;
  entitlements: Entitlements;
  chatStyle: ChatStyle;
  quests: Quest[];
}

// ---------- extra client-facing shapes (mirror docs/BACKEND.md) ----------
export interface ConversationMemberInfo {
  userId: UUID;
  displayName: string;
  avatarColor: string;
  avatarUrl?: string | null;
  online: boolean;
  lastSeenAt: string | null;
}

export interface ConversationDetail {
  id: UUID;
  kind: 'dm' | 'group';
  title: string;
  initials: string;
  avatarColor: string;
  memberCount: number;
  onlineCount: number;
  otherUserId: UUID | null;
  otherOnline: boolean;
  otherLastSeenAt: string | null;
  plusOnly: boolean;
  readOnly: boolean;
  /** Private chat you can't send in (they only take messages from friends, or a block): why, to show instead of the composer. */
  sendBlocked?: string | null;
  myReadSeq: number;
  avatarUrl?: string | null;
  members?: ConversationMemberInfo[];
}

/** How you and someone else are connected: friends, a request either way, blocked, or nothing yet. */
export type FriendRelation = 'self' | 'friends' | 'outgoing' | 'incoming' | 'blocked' | 'none';
export interface Person { id: UUID; displayName: string; handle: string; avatarColor: string; avatarUrl?: string | null; initials: string; online?: boolean; relation?: FriendRelation; /** Friends list only: the newest song on their profile. */ song?: SongCard | null }

// ---------------- moderation ----------------
/** Why something was reported (the reporter picks one). Severity: 4 critical, 3 high, 2 medium, 1 low. */
export const REPORT_CATEGORIES = ['child_safety', 'violence', 'harassment', 'hate', 'sexual', 'self_harm', 'spam', 'scam', 'impersonation', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_CATEGORY_INFO: Record<ReportCategory, { label: string; severity: 1 | 2 | 3 | 4 }> = {
  child_safety: { label: 'Child safety', severity: 4 },
  violence: { label: 'Threats or violence', severity: 4 },
  self_harm: { label: 'Self-harm or suicide', severity: 4 },
  harassment: { label: 'Bullying or harassment', severity: 3 },
  hate: { label: 'Hate speech', severity: 3 },
  sexual: { label: 'Sexual content', severity: 3 },
  scam: { label: 'Scam or fraud', severity: 2 },
  impersonation: { label: 'Pretending to be someone', severity: 2 },
  spam: { label: 'Spam', severity: 1 },
  other: { label: 'Something else', severity: 1 },
};
export type ReportTarget = 'user' | 'message' | 'post' | 'story' | 'comment' | 'guestbook';
export type ModAction = 'dismiss' | 'warn' | 'remove_content' | 'mute' | 'unmute' | 'suspend' | 'ban' | 'unban';
/** Where an account stands. suspendedUntil null with suspended = a permanent ban. */
export interface ModStatus { suspended: boolean; suspendedUntil: string | null; mutedUntil: string | null; isAdmin: boolean }
export interface ModQueueItem {
  subject: Person; status: ModStatus;
  openReports: number; reporters: number; severity: 1 | 2 | 3 | 4; topCategory: ReportCategory; lastReportedAt: string;
}
export interface ModReport {
  id: UUID; category: ReportCategory; note: string; reporter: { id: UUID; displayName: string; handle: string } | null;
  /** How often this reporter's past reports were dismissed (0..1): low trust when high. */
  reporterDismissRate: number;
  targetType: ReportTarget; targetId: UUID; content: Record<string, unknown>; contentHidden: boolean;
  status: 'open' | 'actioned' | 'dismissed'; createdAt: string;
}
export interface ModEvent { kind: string; actor: string; actorName: string | null; reason: string | null; details: Record<string, unknown>; createdAt: string }
export interface ModUserDetail {
  person: Person; joinedAt: string; status: ModStatus; warning: string | null;
  reports: ModReport[]; history: ModEvent[];
  reportsFiled: number; reportsFiledDismissed: number;
  /** Messages they deleted in the last 14 days (private copies, moderators only). */
  deletedMessages: { id: UUID; conversationId: UUID; type: string; body: string | null; sentAt: string; deletedAt: string }[];
}
export interface ModLogItem extends ModEvent { subject: { id: UUID; displayName: string; handle: string } | null }
export interface ModActionInput { action: ModAction; reason: string; hours?: number; days?: number; reportIds?: UUID[] }
/** A message from the moderators, shown once when the app opens (warning), or while muted. */
export interface ModNotice { kind: 'warning' | 'muted'; message: string; until: string | null }

// ---------------- music ----------------
export type MusicProvider = 'spotify' | 'youtube' | 'apple' | 'soundcloud';
/**
 * A song from a music app, shown as a card that opens it there. On profiles ("your song") and on chat messages: a text
 * message with a song link gets the card as its payload (older apps just show the link).
 */
export interface SongCard { url: string; title: string; artist: string | null; artUrl: string | null; provider: MusicProvider }
/** Someone's profile as you see it. Songs only for friends (and yourself); blocked or suspended people aren't found. */
export const BIO_MAX = 160;
/** Songs on a profile. */
export const SONGS_MAX = 5;
export interface UserProfile extends Person {
  relation: FriendRelation;
  bio: string | null;
  companion: { name: string; palette: PaletteId; level: number; equippedOutfit: Outfit; equippedSlots?: EquippedSlots; streak: number };
  /** Has Sproutly Plus (shows the Plus badge). */
  plus: boolean;
  /** Newest first; empty unless you're friends. */
  songs: SongCard[];
}
export interface FriendRequests { incoming: (Person & { requestedAt: string })[]; outgoing: (Person & { requestedAt: string })[] }

// ---------------- 1v1 matches ----------------
export type MatchStatus = 'invited' | 'active' | 'done' | 'declined' | 'cancelled' | 'expired';
export interface MatchPlayer { id: UUID; displayName: string; initials: string; avatarColor: string; avatarUrl: string | null; palette: PaletteId; level: number; outfit: Outfit; equippedSlots: EquippedSlots }
export interface Match {
  id: UUID;
  game: string;
  kind: 'race' | 'turn';
  status: MatchStatus;
  /** a = who challenged, b = who was challenged. */
  a: MatchPlayer;
  b: MatchPlayer;
  /** 1 if you're a, 2 if you're b. */
  you: 1 | 2;
  aScore: number | null;
  bScore: number | null;
  /** On a finished match: the winner's id, or null for a draw. */
  winnerId: UUID | null;
  /** Turn games: whose move it is. */
  turnId: UUID | null;
  endReason: 'forfeit' | 'timeout' | null;
  /** Races: when both start playing (server time). */
  startsAt: string | null;
  /** Invites: when an unanswered invite lapses. */
  expiresAt: string | null;
  state: unknown;
  createdAt: string;
  updatedAt: string;
}
/** A friend in the Arcade: online or not, and your head-to-head record. */
export interface ArcadeFriend extends Person { wins: number; losses: number; draws: number }

export type SendInput =
  | { clientId: UUID; conversationId: UUID; type: 'text'; body: string }
  | { clientId: UUID; conversationId: UUID; type: 'sticker'; payload: { kind: StickerKind; emote?: Emote } }
  | { clientId: UUID; conversationId: UUID; type: 'poll'; payload: { question: string; options: string[] } };

export type SendAck =
  | { ok: true; id: UUID; seq: number; createdAt: string; message?: Message }
  | { ok: false; code: string; message: string };

export interface RoomInfo { ownerId: UUID; ownerName: string; companion: Companion; theme: 'basic' | 'cabin'; decor: string[] }
/** Someone invited you to visit their room (pending, from the last week). */
export interface RoomInvite { id: UUID; hostId: UUID; hostName: string; hostInitials: string; hostColor: string; hostUrl?: string | null; createdAt: string }

export interface RoomState { ownerId: UUID; night: boolean; music: boolean; visitors: { userId: UUID; palette: PaletteId; outfit: Outfit; equippedSlots?: EquippedSlots; name: string }[] }

export interface ActionResult {
  mood: Mood; line: string; gain: number; energy: number; level: number; leveledUp: boolean; streak: number; quests: Quest[];
  /** First action after COMEBACK_AFTER_H away. */
  comeback?: { energy: number; coins: number } | null;
  /** Streak milestone reached by this action (granted once per account). */
  milestone?: StreakMilestoneReward | null;
  shields?: number;
  /** A shield saved the streak on this action. */
  shieldUsed?: boolean;
  /** The incubating egg after this action (it warms once per local day). */
  egg?: Egg | null;
  coins?: number;
  lastActionAt?: string;
  lastActiveDay?: string;
}

// ---------- guestbook ----------
export const GUESTBOOK_STICKERS = ['wave', 'heart', 'flower', 'star'] as const;
export type GuestbookSticker = (typeof GUESTBOOK_STICKERS)[number];
export const GUESTBOOK_EMOJI: Record<GuestbookSticker, string> = { wave: '👋', heart: '💖', flower: '🌸', star: '⭐' };

/** A visitor's note in someone's room. One per visitor per room per local day. */
export interface GuestbookEntry {
  id: UUID;
  ownerId: UUID;
  authorId: UUID;
  authorName: string;
  authorInitials: string;
  authorColor: string;
  palette: PaletteId;
  sticker: GuestbookSticker;
  note: string | null;
  createdAt: string;
}

// ---------- daily drop ----------
export type DropRarity = 'common' | 'rare' | 'epic';
export interface DropReward { energy: number; rarity: DropRarity }

/** One free gift per local day. Claiming on consecutive days walks a 7-day track; day 7 is always rare or better. */
export interface DailyDrop {
  available: boolean;
  /** Next local midnight: when the next drop opens. */
  nextAt: string;
  /** Position on the 7-day track of the next claim (1..7). */
  trackDay: number;
  /** Today's reward once claimed. */
  today: DropReward | null;
}
export interface DropClaim {
  drop: DailyDrop; reward: DropReward; energy: number; level: number; leveledUp: boolean;
  /** Finishing the 7-day track banks a shield and starts an egg (if none is incubating); events multiply energy. */
  bonus?: { shield: boolean; egg: boolean; eventMultiplier: number };
  shields?: number;
}

export interface AvatarStageAction {
  conversationId: UUID;
  userId: UUID;
  action: 'walk' | 'chair' | 'jukebox' | 'plant' | 'coffee' | 'nap' | 'cheer' | 'wave' | 'dance' | 'jump' | 'love' | 'portal';
  targetX?: number;
  targetY?: number;
  isPlus?: boolean;
  avatarEffect?: AvatarEffect;
  avatarAnimation?: AvatarAnimation;
}

/** Someone currently inside a chat's avatar room and the last thing they did (targetX/Y are 0..1 of the floor). */
export interface StageOccupant {
  userId: UUID;
  action?: AvatarStageAction['action'];
  targetX?: number;
  targetY?: number;
  isPlus?: boolean;
  avatarEffect?: AvatarEffect;
  avatarAnimation?: AvatarAnimation;
}
/** Everyone in the room; sent whenever someone enters, leaves, or takes/leaves a seat. */
export interface StagePresence { conversationId: UUID; occupants: StageOccupant[] }
/** Most companions one chat's room holds at once. */
export const STAGE_CAPACITY = 25;
/** Most people in a group chat at the same moment (members are unlimited). Same as the avatar room's seats. */
export const ROOM_LIVE_CAPACITY = STAGE_CAPACITY;
/** Sent to you when the room is full: you can still chat, your companion waits outside until a spot opens. */
export interface StageFull { conversationId: UUID; capacity: number; count: number }


// ---------- show off: daily activity ----------
export const SHOWCASE_ACTIVITIES = ['workout', 'study', 'food', 'outdoors', 'gaming', 'art', 'music', 'chill'] as const;
export type ShowcaseActivity = (typeof SHOWCASE_ACTIVITIES)[number];
/** Most Show off posts one person can share in any 24 hours. */
export const SHOWCASE_DAILY_MAX = 5;

// ---------- stories (24 h) ----------
/** Backgrounds a text story can use (also the picker order). */
export const STORY_BGS = ['#3B2A6B', '#2F8A6C', '#D9543A', '#3D6FD1', '#E7B94A', '#1C1B29', '#F6A5C0', '#7A5AF8'] as const;
export type StoryBg = (typeof STORY_BGS)[number];
export interface Story {
  id: UUID;
  kind: 'image' | 'text';
  imageUrl: string | null;
  /** Caption on a photo, or the whole text story. */
  text: string | null;
  bg: string | null;
  createdAt: string;
  expiresAt: string;
  viewedByMe: boolean;
  /** Only filled for your own stories. */
  viewCount?: number;
}
/** One person's active stories, oldest first (the viewer plays them in order). */
export interface StoryGroup {
  userId: UUID;
  displayName: string;
  initials: string;
  avatarColor: string;
  avatarUrl: string | null;
  isMe: boolean;
  /** Any story in the group the viewer hasn't seen yet (coloured ring). */
  hasUnseen: boolean;
  stories: Story[];
}
export type NewStory = { kind: 'image'; imageUrl: string; text?: string } | { kind: 'text'; text: string; bg: StoryBg };

export interface ServiceEvents {
  'guestbook:new': GuestbookEntry;
  'msg:new': Message;
  'msg:update': { id: UUID; conversationId: UUID; body?: string | null; editedAt?: string | null; deletedAt?: string | null; /** An edit removed the song link: drop its card. */ payload?: null };
  'receipt:update': { conversationId: UUID; userId: UUID; deliveredSeq: number; readSeq: number; minDeliveredSeq: number; minReadSeq: number };
  'conv:update': { id: UUID; lastSeq: number; lastMessagePreview: string | null; lastMessageAt: string | null; unread: number; summary?: ConversationSummary };
  typing: { conversationId: UUID; userIds: UUID[] };
  presence: { userId: UUID; online: boolean; lastSeenAt: string | null };
  'poll:update': { messageId: UUID; counts: number[]; total: number };
  'style:update': UserStyle;
  'me:entitlements': Entitlements;
  'quest:update': { quests: Quest[]; energy: number; level: number };
  'activity:new': ActivityItem;
  'plaza:join': { spot: PlazaSpotId; occupant: PlazaOccupant };
  'plaza:leave': { spot: PlazaSpotId; userId: UUID };
  'plaza:move': { spot: PlazaSpotId; userId: UUID; x: number; y: number };
  'plaza:emote': { spot: PlazaSpotId; userId: UUID; emote: PlazaEmote };
  'plaza:say': { spot: PlazaSpotId; line: PlazaLine };
  'plaza:kick': { spot: PlazaSpotId; userId: UUID; ball: PlazaBall };
  'plaza:counts': PlazaSpotInfo[];
  'group:count': GroupCount;
  /** A new Show off post you can see (fetch it with getPost: visibility is checked there). */
  'showcase:new': { postId: UUID; userId: UUID };
  /** Live counts on a post you can see. */
  'showcase:update': { postId: UUID; cheerCount?: number; commentCount?: number };
  'showcase:delete': { postId: UUID };
  /** Someone you can see added or removed a story: reload the story row. */
  'stories:update': { userId: UUID };
  /** Your friends or blocks changed (you or the other person): reload stories and the Show off feed. */
  'social:update': { userId: UUID };
  /** A friend request was sent, accepted, declined or cancelled, or someone was unfriended. */
  'friends:update': { userId: UUID };
  /** A moderator warned you, or you were muted / put on hold (shown as a notice). */
  'me:notice': ModNotice;
  /** Someone changed the songs on their profile (sent to them and their friends), newest first. */
  'music:update': { userId: UUID; songs: SongCard[] };
  /** A 1v1 match changed (invite, accept, move, result): the full match as this person may see it. */
  'match:update': Match;
  /** Live race: the other player's score so far. */
  'match:score': { matchId: UUID; userId: UUID; score: number };
  /** Your room invites changed (a new one for you, or one you sent was answered): reload them. */
  'invites:update': Record<string, never>;
  /** You opened a group chat that's at its at-once limit: you can read it and you're let in when a seat frees up. */
  'conv:full': { conversationId: UUID; capacity: number; count: number };
  'wallet:update': { coins: number };
  'room:state': RoomState;
  'stage:action': AvatarStageAction;
  'stage:presence': StagePresence;
  'stage:full': StageFull;
  connection: { connected: boolean };
  /** App-only (never sent by the server): the saved sign-in was rejected, so the app signs out. */
  /** This account was just suspended: sign out now and show the reason. */
  'account:suspended': { message: string };
  'session:expired': { reason: 'expired' };
}
export type EventName = keyof ServiceEvents;

// ---------- retention (rules in retention.ts) ----------
export interface StreakMilestoneReward { day: number; coins: number; itemId?: string; shields?: number }

/** How Mo feels about the time since your last visit. Only changes looks and words, never takes anything away. */
export type CompanionNeed = 'content' | 'peckish' | 'lonely' | 'missing';

export interface FriendStreak {
  count: number;
  /** Nobody has kept it going today yet (UTC day); it ends at UTC midnight. */
  atRisk: boolean;
  sentToday: boolean;
  theyToday: boolean;
}

export const ACTIVITY_KINDS = ['guestbook', 'room_visit', 'level_up', 'streak_milestone', 'friend_streak', 'egg_hatched', 'friend_request', 'friend_accept', 'match_invite', 'match_result'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export interface ActivityItem {
  id: UUID;
  kind: ActivityKind;
  actor: { id: UUID; displayName: string; initials: string; avatarColor: string; palette: PaletteId } | null;
  data: Record<string, number | string>;
  text: string;
  createdAt: string;
  seen: boolean;
}

export interface Egg {
  id: UUID;
  /** Distinct local days it has been warmed (a companion action that day). */
  progress: number;
  target: number;
  warmedToday: boolean;
  ready: boolean;
  source: 'starter' | 'drop' | 'shop';
}
export interface EggHatch { reward: { coins: number; energy: number; itemId: string | null }; energy: number; level: number; leveledUp: boolean; coins: number }

export type ShopOfferId = 'scarf' | 'flower' | 'shield' | 'egg';
export interface ShopOffer {
  id: ShopOfferId;
  kind: 'item' | 'shield' | 'egg';
  name: string;
  description: string;
  price: number;
  basePrice: number;
  /** This week's deal (discounted). */
  featured: boolean;
  /** False when owned / shields full / an egg is already incubating. */
  available: boolean;
  reason?: string;
}
export interface Shop { offers: ShopOffer[]; coins: number; shields: number; endsAt: string }
export interface ShopPurchase { shop: Shop; coins: number; shields: number; itemId: string | null; egg: Egg | null }

export const ANALYTICS_EVENT_MAX = 50;
export interface AnalyticsEvent { name: string; props?: Record<string, string | number | boolean | null>; at: string }

export interface QuestChest { day: string; ready: boolean; claimed: boolean; done: number; total: number; reward: { coins: number; energy: number } }
export interface QuestChestClaim { chest: QuestChest; coins: number; energy: number; level: number; leveledUp: boolean }
/** The last 7 local days (today included). */
export interface WeeklyRecap {
  from: string;
  to: string;
  daysWithCompanion: number;
  energyEarned: number;
  coinsEarned: number;
  friendVisits: number;
  guestbookNotes: number;
  chatStreakBest: number;
  streak: number;
}

// ---------- plaza (public hangout spots; rules in plaza.ts) ----------
export type PlazaSpotId = 'cafe' | 'park' | 'beach' | 'rooftop' | 'library' | 'garden';
export type PlazaEmote = 'wave' | 'heart' | 'laugh' | 'dance' | 'cheer';
export interface PlazaOccupant {
  userId: UUID;
  name: string;
  palette: PaletteId;
  outfit: Outfit;
  /** Everything it's wearing, slot by slot. */
  equippedSlots?: EquippedSlots;
  level: number;
  isPlus: boolean;
  /** 0..1 of the stage. */
  x: number;
  y: number;
}
export interface PlazaLine { id: string; userId: UUID; name: string; text: string; at: string }
export interface PlazaSpotInfo { id: PlazaSpotId; count: number; full: boolean }
/** The shared ball: x, y on the floor (0..1), z height (fraction of stage height), velocities per second. */
export interface PlazaBall { x: number; y: number; z: number; vx: number; vy: number; vz: number }
export interface PlazaState { spot: PlazaSpotId; occupants: PlazaOccupant[]; lines: PlazaLine[]; /** Spots with a ball: its last kick and how long ago that was. */ ball?: { state: PlazaBall; ageMs: number } | null }
/** Your own line comes back in the reply, so it shows right away (others get it as 'plaza:say'). */
export interface PlazaSayResult { ok: boolean; message?: string; line?: PlazaLine }
export type PlazaEnterResult = { ok: true; state: PlazaState } | { ok: false; code: 'FULL' | 'ERROR'; message: string };
