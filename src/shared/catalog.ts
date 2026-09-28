import type { CatalogItem, CatalogSlot, EquippedSlots, Outfit } from './types.js';
import { OUTFITS } from './types.js';

export const CATALOG_ITEMS: CatalogItem[] = [
  // ---------- Head ----------
  { id: 'party', name: 'Party Hat', slot: 'head', rarity: 'common', unlockMethod: 'starter', plusOnly: false, description: 'Festive and fun for any occasion.' },
  { id: 'flower', name: 'Flower Crown', slot: 'head', rarity: 'rare', unlockMethod: 'reward', plusOnly: false, priceCoins: 150, description: 'Freshly picked blooming blossoms.' },
  { id: 'wizard', name: 'Wizard Hat', slot: 'head', rarity: 'epic', unlockMethod: 'plus', plusOnly: true, description: 'Enchanted star-embroidered wizard hat.' },
  { id: 'crown', name: 'Gold Crown', slot: 'head', rarity: 'epic', unlockMethod: 'plus', plusOnly: true, description: 'Fit for companion royalty.' },
  { id: 'cap', name: 'Street Cap', slot: 'head', rarity: 'rare', unlockMethod: 'level', unlockRequirement: 20, plusOnly: true, description: 'Sporty street-style cap with a golden star.' },
  { id: 'bandana', name: 'Bandana', slot: 'head', rarity: 'rare', unlockMethod: 'level', unlockRequirement: 30, plusOnly: true, description: 'Classic patterned rouge bandana.' },
  { id: 'headphones', name: 'Headphones', slot: 'head', rarity: 'epic', unlockMethod: 'level', unlockRequirement: 10, plusOnly: true, description: 'Studio grade comfy over-ear headphones.' },

  // ---------- Face ----------
  { id: 'shades', name: 'Cool Shades', slot: 'face', rarity: 'rare', unlockMethod: 'plus', plusOnly: true, description: 'Sleek dark shades for sunny vibes.' },

  // ---------- Body ----------
  { id: 'scarf', name: 'Cozy Scarf', slot: 'body', rarity: 'common', unlockMethod: 'reward', plusOnly: false, priceCoins: 100, description: 'Warm knitted winter scarf.' },
  { id: 'hoodie', name: 'Classic Hoodie', slot: 'body', rarity: 'rare', unlockMethod: 'level', unlockRequirement: 10, plusOnly: false, description: 'Super soft everyday hoodie.' },

  // ---------- Back ----------
  { id: 'backpack', name: 'Explorer Pack', slot: 'back', rarity: 'rare', unlockMethod: 'shop', plusOnly: false, priceCoins: 250, description: 'Ready for trails and adventures.' },

  // ---------- Hand ----------
  { id: 'sword', name: 'Wooden Sword', slot: 'hand', rarity: 'rare', unlockMethod: 'shop', plusOnly: false, priceCoins: 300, description: 'A trusty hero training blade.' },

  // ---------- Trail ----------
  { id: 'aura', name: 'Glow Aura', slot: 'trail', rarity: 'epic', unlockMethod: 'plus', plusOnly: true, description: 'Radiates mystical soft warmth.' },

  // ---------- Frame ----------
  { id: 'frame_sprout', name: 'Sprout Frame', slot: 'frame', rarity: 'common', unlockMethod: 'starter', plusOnly: false, description: 'Natural green sprout avatar border.' },
  { id: 'frame_gold', name: 'Golden Aura Frame', slot: 'frame', rarity: 'epic', unlockMethod: 'plus', plusOnly: true, description: 'Gleaming golden prestige border.' },

  // ---------- Colour (Species/Palette) ----------
  { id: 'mo', name: 'Mint Sprout', slot: 'colour', rarity: 'common', unlockMethod: 'starter', plusOnly: false, description: 'The classic gentle green sprout.' },
  { id: 'pip', name: 'Peach Sprout', slot: 'colour', rarity: 'common', unlockMethod: 'starter', plusOnly: false, description: 'Warm, sunny and cheerful peach sprout.' },
  { id: 'blu', name: 'Lilac Sprout', slot: 'colour', rarity: 'common', unlockMethod: 'starter', plusOnly: false, description: 'Dreamy, calm and relaxed lilac sprout.' },
  { id: 'drake', name: 'Ember Drake', slot: 'colour', rarity: 'legendary', unlockMethod: 'plus', plusOnly: true, description: 'Fiery dragon that grows horns and wings.' },
  { id: 'bolt', name: 'Bolt Bot', slot: 'colour', rarity: 'legendary', unlockMethod: 'plus', plusOnly: true, description: 'High-tech robotic companion that upgrades with levels.' },

  // ---------- Emotes ----------
  { id: 'smile', name: 'Smile', slot: 'emote', rarity: 'common', unlockMethod: 'starter', plusOnly: false },
  { id: 'laugh', name: 'Laugh', slot: 'emote', rarity: 'common', unlockMethod: 'starter', plusOnly: false },
  { id: 'angry', name: 'Grumpy', slot: 'emote', rarity: 'common', unlockMethod: 'starter', plusOnly: false },
  { id: 'sad', name: 'Sad', slot: 'emote', rarity: 'common', unlockMethod: 'starter', plusOnly: false },
  { id: 'love', name: 'Love', slot: 'emote', rarity: 'common', unlockMethod: 'starter', plusOnly: false },
  { id: 'shock', name: 'Shock', slot: 'emote', rarity: 'common', unlockMethod: 'starter', plusOnly: false },
  { id: 'bloom', name: 'Bloom', slot: 'emote', rarity: 'rare', unlockMethod: 'starter', plusOnly: false },
  { id: 'shy', name: 'Shy', slot: 'emote', rarity: 'rare', unlockMethod: 'starter', plusOnly: false },
  { id: 'fire', name: 'Fire Breath', slot: 'emote', rarity: 'rare', unlockMethod: 'plus', plusOnly: true },
  { id: 'smug', name: 'Smug', slot: 'emote', rarity: 'rare', unlockMethod: 'plus', plusOnly: true },
  { id: 'glitch', name: 'Glitch', slot: 'emote', rarity: 'rare', unlockMethod: 'plus', plusOnly: true },
  { id: 'scan', name: 'Scan', slot: 'emote', rarity: 'rare', unlockMethod: 'plus', plusOnly: true },
];

const BY_ID = new Map<string, CatalogItem>(CATALOG_ITEMS.map((item) => [item.id, item]));

export function getCatalogItem(id: string): CatalogItem | undefined {
  return BY_ID.get(id);
}

/** Why an item can't be worn yet. */
export type LockReason = 'plus' | 'level' | 'not_owned';
export type ItemAccess = { owned: true } | { owned: false; reason: LockReason; level?: number; price?: number };

/** Level an item needs (0 = none). */
export function requiredLevel(item: CatalogItem): number {
  const r = item.unlockRequirement;
  const n = typeof r === 'number' ? r : r ? parseInt(r, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * The single ownership rule, used by the catalog listing, the equip endpoint and the Closet.
 * Starter, Plus and level items are owned as soon as their gate is met (nothing needs granting);
 * shop / reward / egg / quest / streak items are owned only once they're in the inventory.
 */
export function itemAccess(item: CatalogItem, ctx: { plus: boolean; level: number; owned: ReadonlySet<string> }): ItemAccess {
  if (item.plusOnly && !ctx.plus) return { owned: false, reason: 'plus' };
  const lvl = requiredLevel(item);
  if (lvl > 0 && ctx.level < lvl) return { owned: false, reason: 'level', level: lvl };
  if (item.unlockMethod === 'starter' || item.unlockMethod === 'plus' || item.unlockMethod === 'level') return { owned: true };
  if (ctx.owned.has(item.id)) return { owned: true };
  return { owned: false, reason: 'not_owned', ...(item.priceCoins ? { price: item.priceCoins } : {}) };
}

export function getCatalogBySlot(slot: CatalogSlot): CatalogItem[] {
  return CATALOG_ITEMS.filter((item) => item.slot === slot);
}

export function slotOfOutfit(outfitId: Outfit | string): CatalogSlot {
  const item = BY_ID.get(outfitId);
  if (item) return item.slot;
  if (['party', 'flower', 'wizard', 'crown', 'cap', 'bandana', 'headphones'].includes(outfitId)) return 'head';
  if (['shades'].includes(outfitId)) return 'face';
  if (['scarf', 'hoodie'].includes(outfitId)) return 'body';
  if (outfitId === 'aura') return 'trail';
  return 'head';
}

/** Merges legacy single outfit and multi-slot equipped mapping into a unified EquippedSlots map. */
export function resolveEquippedSlots(slots?: Partial<EquippedSlots> | null, singleOutfit?: Outfit): EquippedSlots {
  const result: EquippedSlots = { ...(slots ?? {}) };
  if (singleOutfit && singleOutfit !== 'none') {
    const slot = slotOfOutfit(singleOutfit);
    if (!result[slot]) {
      (result as Record<string, string | undefined>)[slot] = singleOutfit;
    }
  }
  return result;
}

/** Extracts a single legacy outfit identifier for backward-compatible payload and screen consumers. */
export function primaryOutfitFromSlots(slots?: Partial<EquippedSlots> | null): Outfit {
  if (!slots) return 'none';
  if (slots.head && OUTFITS.includes(slots.head as Outfit)) return slots.head as Outfit;
  if (slots.face && OUTFITS.includes(slots.face as Outfit)) return slots.face as Outfit;
  if (slots.body && OUTFITS.includes(slots.body as Outfit)) return slots.body as Outfit;
  if (slots.trail === 'aura') return 'aura';
  return 'none';
}
