import { pool } from './pool.js';
import { DECOR_ITEMS, MOVE_ITEMS, OUTFIT_ITEMS, THEME_ITEMS } from '../shared/rules.js';
import { CATALOG_ITEMS } from '../shared/catalog.js';

/** Idempotent reference data: catalog, the current event, and the public groups shown in Discover. */
export async function seed() {
  const legacyItems = [
    ...OUTFIT_ITEMS.map((i, n) => ({ id: `outfit:${i.id}`, kind: 'outfit', name: i.name, plus: i.plus, sort: n })),
    ...MOVE_ITEMS.map((i, n) => ({ id: `move:${i.id}`, kind: 'move', name: i.name, plus: i.plus, sort: n })),
    ...DECOR_ITEMS.map((i, n) => ({ id: `decor:${i.id}`, kind: 'decor', name: i.name, plus: i.plus, sort: n })),
    ...THEME_ITEMS.map((i, n) => ({ id: `theme:${i.id}`, kind: 'theme', name: i.name, plus: i.plus, sort: n })),
  ];
  for (const i of legacyItems) {
    await pool.query(
      `INSERT INTO catalog_items (id, kind, name, plus_only, sort) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plus_only = EXCLUDED.plus_only, sort = EXCLUDED.sort`,
      [i.id, i.kind, i.name, i.plus, i.sort],
    );
  }

  for (const i of CATALOG_ITEMS) {
    await pool.query(
      `INSERT INTO catalog_items (id, kind, name, plus_only, sort, slot, rarity, unlock_method, unlock_requirement, price_coins, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         plus_only = EXCLUDED.plus_only,
         slot = EXCLUDED.slot,
         rarity = EXCLUDED.rarity,
         unlock_method = EXCLUDED.unlock_method,
         unlock_requirement = EXCLUDED.unlock_requirement,
         price_coins = EXCLUDED.price_coins,
         description = EXCLUDED.description`,
      [
        i.id,
        ['head', 'body', 'face', 'top', 'bottom', 'shoes', 'neck'].includes(i.slot) ? 'outfit' : i.slot,
        i.name,
        i.plusOnly,
        0,
        i.slot,
        i.rarity,
        i.unlockMethod,
        i.unlockRequirement ? String(i.unlockRequirement) : null,
        i.priceCoins ?? null,
        i.description ?? null,
      ],
    );
  }

  const ev = await pool.query("SELECT 1 FROM events WHERE title = 'Companion Picnic'");
  if (ev.rowCount === 0) {
    await pool.query(
      `INSERT INTO events (title, description, reward_item_id, starts_at, ends_at)
       VALUES ('Companion Picnic', 'Bring your companion to the park this weekend. Join a group chat to earn a picnic blanket.', 'decor:bean_bag', now() - interval '1 day', now() + interval '30 days')`,
    );
  }

  const groups = [
    { title: 'Weekend Hikers', category: 'Outdoors', color: '#2F8A6C', description: 'Trails, snacks and sunrise photos.', plus: false },
    { title: 'Study Squad', category: 'Study', color: '#3D6FD1', description: 'Focus sessions and shared notes.', plus: false },
    { title: 'Cozy Gamers', category: 'Games', color: '#7A5AF8', description: 'Chill co-op nights, no rage allowed.', plus: false },
    { title: 'Plant Parents', category: 'Hobbies', color: '#7CC6A2', description: 'Show off your leaves.', plus: false },
    { title: 'Plus Lounge', category: 'For you', color: '#A8741A', description: 'The members-only hangout for Plus.', plus: true },
  ];
  for (const g of groups) {
    const exists = await pool.query('SELECT 1 FROM conversations WHERE kind = $1 AND title = $2 AND is_public', ['group', g.title]);
    if (exists.rowCount) continue;
    await pool.query(
      `INSERT INTO conversations (kind, title, description, avatar_color, category, is_public, plus_only, max_members)
       VALUES ('group', $1, $2, $3, $4, TRUE, $5, $6)`,
      [g.title, g.description, g.color, g.category, g.plus, g.plus ? 500 : 100],
    );
  }
  console.log(`seeded ${legacyItems.length + CATALOG_ITEMS.length} catalog items, 1 event, ${groups.length} public groups`);
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
