import { describe, expect, it } from 'vitest';
import { CATALOG_ITEMS, itemAccess, primaryOutfitFromSlots, resolveEquippedSlots } from '../src/shared/catalog.js';
import { CATALOG_SLOTS } from '../src/shared/types.js';

describe('wardrobe catalog', () => {
  it('has unique ids and only valid slots', () => {
    const ids = CATALOG_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of CATALOG_ITEMS) expect(CATALOG_SLOTS).toContain(i.slot);
  });

  it('has clothes in every new slot, with a free starter in tops, bottoms and shoes', () => {
    for (const slot of ['top', 'bottom', 'shoes', 'neck'] as const) {
      expect(CATALOG_ITEMS.filter((i) => i.slot === slot).length).toBeGreaterThanOrEqual(4);
    }
    for (const slot of ['top', 'bottom', 'shoes'] as const) {
      expect(CATALOG_ITEMS.some((i) => i.slot === slot && i.unlockMethod === 'starter' && !i.plusOnly)).toBe(true);
    }
  });

  it('every coin-priced item can actually be bought (shop or reward), never a Plus item for coins', () => {
    for (const i of CATALOG_ITEMS.filter((x) => x.priceCoins)) {
      expect(['shop', 'reward']).toContain(i.unlockMethod);
      expect(i.plusOnly).toBe(false);
    }
  });
});

describe('outfits saved before the new slots', () => {
  it('moves a scarf and a hoodie out of the old body slot', () => {
    expect(resolveEquippedSlots({ body: 'scarf' })).toEqual({ neck: 'scarf' });
    expect(resolveEquippedSlots({ body: 'hoodie', head: 'cap' })).toEqual({ top: 'hoodie', head: 'cap' });
  });

  it('never overwrites something already in the new slot', () => {
    expect(resolveEquippedSlots({ body: 'scarf', neck: 'chain' })).toEqual({ neck: 'chain' });
  });

  it('keeps the single legacy outfit working', () => {
    expect(resolveEquippedSlots(null, 'scarf')).toEqual({ neck: 'scarf' });
    expect(primaryOutfitFromSlots({ neck: 'scarf' })).toBe('scarf');
  });
});

describe('who can wear what', () => {
  const item = (id: string) => CATALOG_ITEMS.find((i) => i.id === id)!;
  const ctx = (o: Partial<{ plus: boolean; level: number; owned: string[] }> = {}) =>
    ({ plus: !!o.plus, level: o.level ?? 1, owned: new Set(o.owned ?? []) });

  it('starters are free, shop items need buying, Plus items need Plus', () => {
    expect(itemAccess(item('jeans'), ctx()).owned).toBe(true);
    expect(itemAccess(item('bomber'), ctx())).toMatchObject({ owned: false, reason: 'not_owned', price: 150 });
    expect(itemAccess(item('bomber'), ctx({ owned: ['bomber'] })).owned).toBe(true);
    expect(itemAccess(item('puffer'), ctx())).toMatchObject({ owned: false, reason: 'plus' });
    expect(itemAccess(item('puffer'), ctx({ plus: true })).owned).toBe(true);
  });
});
