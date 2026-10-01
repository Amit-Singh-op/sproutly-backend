/** Rules the app and server must agree on (doc section 1: `shared` + `catalog`). Mirrors sproutly/src/data/rules.ts. */
import type { ChatStyle, Emote, Message, Mood, Outfit, PaletteId } from './types.js';

export const LIMITS = {
  textMax: 4000,
  pollOptionsMin: 2,
  pollOptionsMax: 6,
  historyPageMax: 200,
  historyPageDefault: 50,
  freeGroupMax: 100,
  plusGroupMax: 500,
  showcaseCooldownMs: 24 * 60 * 60 * 1000,
  editWindowMs: 15 * 60 * 1000,
  deleteWindowMs: 60 * 60 * 1000,
  typingTtlS: 6,
  presenceTtlS: 60,
  reportsToHide: 5,
  feedFanoutCap: 5000,
  userStylesMax: 200,
  guestbookNoteMax: 80,
  guestbookPreview: 20,
  guestbookPushesPerDay: 3,
} as const;

export const RATE_LIMITS = {
  msgPerUser: { points: 10, windowS: 10 },
  msgPerConversation: { points: 60, windowS: 60 },
  stickerPerUser: { points: 5, windowS: 10 },
  cheersPerUser: { points: 60, windowS: 60 },
  commentsPerUser: { points: 20, windowS: 60 },
  otpPerHour: { points: 5, windowS: 3600 },
  uploadsPerUser: { points: 30, windowS: 3600 },
  analyticsPerUser: { points: 60, windowS: 60 },
} as const;

/** App Store / Play products and RevenueCat identifiers (doc section 5). */
export const PRODUCTS = {
  monthly: 'plus_monthly',
  yearly: 'plus_yearly',
  entitlement: 'plus',
} as const;
export const periodForProduct = (productId: string | null | undefined): 'monthly' | 'yearly' | null => {
  if (!productId) return null;
  if (productId.startsWith(PRODUCTS.yearly) || /year|annual/i.test(productId)) return 'yearly';
  if (productId.startsWith(PRODUCTS.monthly) || /month/i.test(productId)) return 'monthly';
  return null;
};

// ---------- catalog (plusOnly flags) ----------
export const OUTFIT_ITEMS: { id: Outfit; name: string; plus: boolean; level?: number }[] = [
  { id: 'none', name: 'None', plus: false },
  { id: 'party', name: 'Party hat', plus: false },
  { id: 'flower', name: 'Flower crown', plus: false },
  { id: 'scarf', name: 'Cozy scarf', plus: false },
  { id: 'wizard', name: 'Wizard hat', plus: true },
  { id: 'shades', name: 'Cool shades', plus: true },
  { id: 'crown', name: 'Gold crown', plus: true },
  { id: 'aura', name: 'Glow aura', plus: true },
  { id: 'headphones', name: 'Headphones', plus: true, level: 10 },
  { id: 'cap', name: 'Street cap', plus: true, level: 20 },
  { id: 'bandana', name: 'Bandana', plus: true, level: 30 },
];
export const MOVE_ITEMS: { id: Mood; name: string; plus: boolean }[] = [
  { id: 'wave', name: 'Wave', plus: false },
  { id: 'sleep', name: 'Nap', plus: false },
  { id: 'eat', name: 'Snack', plus: false },
  { id: 'walk', name: 'Walk', plus: true },
  { id: 'music', name: 'Dance', plus: true },
  { id: 'spin', name: 'Spin', plus: true },
  { id: 'flip', name: 'Backflip', plus: true },
  { id: 'cheer', name: 'Cheer', plus: true },
  { id: 'zen', name: 'Zen float', plus: true },
];
export const DECOR_ITEMS = [
  { id: 'string_lights', name: 'String lights', plus: true },
  { id: 'gold_trophy', name: 'Gold trophy', plus: true },
  { id: 'bean_bag', name: 'Bean bag', plus: true },
] as const;
export const THEME_ITEMS = [
  { id: 'basic', name: 'Basic room', plus: false },
  { id: 'cabin', name: 'Cozy Cabin', plus: true },
] as const;

export const isPlusOutfit = (o: string) => OUTFIT_ITEMS.some((i) => i.id === o && i.plus);
export const isPlusMove = (m: string) => MOVE_ITEMS.some((i) => i.id === m && i.plus);
export const outfitName = (o: string) => OUTFIT_ITEMS.find((i) => i.id === o)?.name ?? 'None';
/** Plus outfits that also need the companion to reach a level (0 = no level gate). */
export const outfitLevel = (o: string) => OUTFIT_ITEMS.find((i) => i.id === o)?.level ?? 0;

// ---------- characters & emotes ----------
/** The palette also picks the character. drake and bolt are Plus-only. */
export type Species = 'sprout' | 'drake' | 'bolt';
const SPECIES: Record<PaletteId, Species> = { mo: 'sprout', pip: 'sprout', blu: 'sprout', drake: 'drake', bolt: 'bolt' };
export const speciesOf = (p: string): Species => SPECIES[p as PaletteId] ?? 'sprout';
export const isPlusPalette = (p: string) => p === 'drake' || p === 'bolt';

const SHARED_EMOTES: Emote[] = ['smile', 'laugh', 'angry', 'sad', 'love', 'shock'];
const OWN_EMOTES: Record<Species, Emote[]> = { sprout: ['bloom', 'shy'], drake: ['fire', 'smug'], bolt: ['glitch', 'scan'] };
/** A companion can only use its own species' emotes. */
export const emotesFor = (p: string): Emote[] => [...SHARED_EMOTES, ...OWN_EMOTES[speciesOf(p)]];

// ---------- daily drop ----------
export const DROP_ENERGY = { common: 25, rare: 60, epic: 150 } as const;
export const DROP_ODDS = { common: 0.7, rare: 0.25, epic: 0.05 } as const;
export const DROP_TRACK_DAYS = 7;

// ---------- chat style: the exact 6 x 5 options ----------
export const STYLE_OPTIONS = {
  bubble: ['#3B2A6B', '#FFFFFF', '#2F8A6C', '#D9543A', '#1C1B29'],
  text: ['#FFFFFF', '#2B2340', '#F2C14E', '#BFE6CF', '#FDE7DF'],
  border: ['#E7B94A', '#F6A5C0', '#5FB8E8', '#7CC6A2', '#FFFFFF'],
  design: ['solid', 'dashed', 'double', 'dotted', 'glow'],
  avatar: ['#2B2340', '#D9543A', '#7A5AF8', '#2F8A6C', '#3D6FD1'],
  animation: ['none', 'pop', 'float', 'shimmer', 'wiggle'],
  wallpaper: ['none', 'lavender', 'mint', 'peach', 'sky', 'cream', 'night'],
} as const;

export const DEFAULT_CHAT_STYLE: ChatStyle = {
  bubble: '#3B2A6B', text: '#FFFFFF', border: '#E7B94A', design: 'glow', avatar: '#2B2340', animation: 'pop', wallpaper: 'lavender',
};

/** WCAG contrast ratio between two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

// ---------- helpers shared with the app ----------
export function previewFor(m: Pick<Message, 'type' | 'body' | 'payload' | 'deletedAt'>, opts: { isGroup: boolean; senderName: string; mine: boolean }): string {
  if (m.deletedAt) return 'Message deleted';
  const who = opts.mine ? 'You' : opts.senderName;
  let text: string;
  switch (m.type) {
    case 'sticker':
      return `${who} sent a sticker`;
    case 'poll':
      text = `Poll: ${(m.payload as { question?: string } | null)?.question ?? ''}`;
      break;
    case 'system':
      return (m.payload as { text?: string } | null)?.text ?? '';
    default:
      text = m.body ?? '';
  }
  if (opts.mine) return `You: ${text}`;
  return opts.isGroup ? `${who}: ${text}` : text;
}

/** Server-stored preview is sender-neutral; the "You:" form is applied per viewer when listing. */
export function neutralPreview(m: Pick<Message, 'type' | 'body' | 'payload' | 'deletedAt'>, senderName: string, isGroup: boolean): string {
  return previewFor(m, { isGroup, senderName, mine: false });
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function applyEnergy(level: number, energy: number, gain: number): { level: number; energy: number; leveledUp: boolean } {
  let e = energy + gain;
  let l = level;
  while (e >= 1000) { e -= 1000; l += 1; }
  return { level: l, energy: e, leveledUp: l > level };
}

/** Strip control characters (keep newline + tab) and trim. */
/** Every message (DMs and groups) is kept for this long, then permanently deleted (hourly purge). */
export const MESSAGE_RETENTION_DAYS = 3;

export const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

// ---------- XP ledger daily caps (Phase 0) ----------
export const XP_DAILY_CAPS: Record<string, { xpPerEvent: number; maxPerDay: number }> = {
  message: { xpPerEvent: 2, maxPerDay: 100 },
  room_visit: { xpPerEvent: 10, maxPerDay: 30 },
  group_join: { xpPerEvent: 15, maxPerDay: 45 },
  daily_login: { xpPerEvent: 25, maxPerDay: 25 },
  companion_action: { xpPerEvent: 10, maxPerDay: 150 },
};
