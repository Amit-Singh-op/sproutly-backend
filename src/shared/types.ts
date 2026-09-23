// Mirror of sproutly/src/data/types.ts — the app/server contract. Keep in sync (doc section 1: 'shared').
/** Core domain types shared by the app and every backend service. */

export type UUID = string;

// ---------- companion ----------
export const MOODS = [
  'idle', 'happy', 'eat', 'play', 'sleep', 'wave', // free
  'music', 'walk', 'spin', 'flip', 'cheer', 'zen', // Plus
] as const;
export type Mood = (typeof MOODS)[number];

export const OUTFITS = ['none', 'party', 'flower', 'scarf', 'wizard', 'shades', 'crown', 'aura'] as const;
export type Outfit = (typeof OUTFITS)[number];

export const PALETTE_IDS = ['mo', 'pip', 'blu'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

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

export interface Companion {
  name: string;
  palette: PaletteId;
  level: number;
  energy: number; // 0..999
  equippedOutfit: Outfit;
  signatureMove: Mood;
  roomTheme: 'basic' | 'cabin';
  streak: number;
}

// ---------- chat ----------
export const MESSAGE_TYPES = ['text', 'sticker', 'poll', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const STICKER_KINDS = ['happy', 'music', 'eat', 'sleep'] as const;
export type StickerKind = (typeof STICKER_KINDS)[number];
export const STICKER_LABELS: Record<StickerKind, string> = { happy: 'Yay!', music: 'Dance', eat: 'Nom', sleep: 'Sleepy' };

export interface StickerPayload {
  kind: StickerKind;
  snapshot: { palette: PaletteId; outfit: Outfit };
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
  payload: StickerPayload | PollPayload | SystemPayload | null;
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
  initials: string;
  lastSeq: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: number;
  memberCount: number;
  plusOnly: boolean;
  otherUserId: UUID | null; // for DMs (presence dot)
  muted: boolean;
  pinned: boolean;
}

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

export interface ChatStyle {
  bubble: string;
  text: string;
  border: string;
  design: BorderDesign;
  avatar: string;
  animation: MessageAnimation;
  wallpaper: WallpaperId;
}

/** Everything a client needs to render another user's messages. */
export interface UserStyle {
  userId: UUID;
  displayName: string;
  initials: string;
  avatarColor: string;
  isPlus: boolean;
  style: ChatStyle | null; // null => free styling
  companion: { palette: PaletteId; outfit: Outfit; signatureMove: Mood };
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
  authorIsPlus: boolean;
  caption: string;
  createdAt: string;
  snapshot: { name: string; level: number; palette: PaletteId; outfit: Outfit; outfitLabel: string; signatureMove: Mood };
  cheerCount: number;
  cheeredByMe: boolean;
  topOfWeek: boolean;
}

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
}

export interface EventCard {
  id: UUID;
  title: string;
  description: string;
  rewardItemId: string;
}

export interface Me {
  id: UUID;
  handle: string;
  displayName: string;
  initials: string;
  avatarColor: string;
  timezone: string;
  readReceipts: boolean;
  companion: Companion;
  entitlements: Entitlements;
  chatStyle: ChatStyle;
  quests: Quest[];
}

// ---------- extra client-facing shapes (mirror docs/BACKEND.md) ----------
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
  myReadSeq: number;
}

export interface Person { id: UUID; displayName: string; handle: string; avatarColor: string; initials: string; online?: boolean }

export type SendInput =
  | { clientId: UUID; conversationId: UUID; type: 'text'; body: string }
  | { clientId: UUID; conversationId: UUID; type: 'sticker'; payload: { kind: StickerKind } }
  | { clientId: UUID; conversationId: UUID; type: 'poll'; payload: { question: string; options: string[] } };

export type SendAck =
  | { ok: true; id: UUID; seq: number; createdAt: string; message?: Message }
  | { ok: false; code: string; message: string };

export interface RoomInfo { ownerId: UUID; ownerName: string; companion: Companion; theme: 'basic' | 'cabin'; decor: string[] }

export interface RoomState { ownerId: UUID; night: boolean; music: boolean; visitors: { userId: UUID; palette: PaletteId; outfit: Outfit; name: string }[] }

export interface ActionResult {
  mood: Mood; line: string; gain: number; energy: number; level: number; leveledUp: boolean; streak: number; quests: Quest[];
}

export interface ServiceEvents {
  'msg:new': Message;
  'msg:update': { id: UUID; conversationId: UUID; body?: string | null; editedAt?: string | null; deletedAt?: string | null };
  'receipt:update': { conversationId: UUID; userId: UUID; deliveredSeq: number; readSeq: number; minDeliveredSeq: number; minReadSeq: number };
  'conv:update': { id: UUID; lastSeq: number; lastMessagePreview: string | null; lastMessageAt: string | null; unread: number; summary?: ConversationSummary };
  typing: { conversationId: UUID; userIds: UUID[] };
  presence: { userId: UUID; online: boolean; lastSeenAt: string | null };
  'poll:update': { messageId: UUID; counts: number[]; total: number };
  'style:update': UserStyle;
  'me:entitlements': Entitlements;
  'quest:update': { quests: Quest[]; energy: number; level: number };
  'room:state': RoomState;
  connection: { connected: boolean };
}
export type EventName = keyof ServiceEvents;
