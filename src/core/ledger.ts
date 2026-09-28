import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { XP_DAILY_CAPS } from '../shared/rules.js';
import type { CoinTransaction } from '../shared/types.js';
import { grantEnergy, userDay } from './companion.js';

interface CoinTxRow {
  id: string;
  user_id: string;
  amount: number;
  balance_after: number;
  source: string;
  reference_id: string | null;
  created_at: Date;
}

export async function getWallet(userId: string): Promise<{ coins: number; history: CoinTransaction[] }> {
  const comp = await one<{ coins: number }>('SELECT coins FROM companions WHERE user_id = $1', [userId]);
  const coins = comp?.coins ?? 0;

  const rows = await q<CoinTxRow>(
    'SELECT id, user_id, amount, balance_after, source, reference_id, created_at FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [userId],
  );

  const history: CoinTransaction[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    amount: r.amount,
    balanceAfter: r.balance_after,
    source: r.source,
    referenceId: r.reference_id ?? undefined,
    createdAt: r.created_at.toISOString(),
  }));

  return { coins, history };
}

export async function adjustCoins(
  userId: string,
  amount: number,
  source: string,
  referenceId?: string,
): Promise<{ coins: number; transactionId: string }> {
  const result = await tx(async (c) => {
    // Lock the balance first: concurrent calls with the same referenceId then see each other's row instead of
    // both passing the idempotency check and the loser failing on the unique constraint.
    const comp = await one<{ coins: number }>('SELECT coins FROM companions WHERE user_id = $1 FOR UPDATE', [userId], c);
    if (!comp) throw E.notFound('Companion not found');
    if (referenceId) {
      const existing = await one<{ id: string; balance_after: number }>(
        'SELECT id, balance_after FROM coin_transactions WHERE user_id = $1 AND reference_id = $2',
        [userId, referenceId],
        c,
      );
      if (existing) {
        return { coins: existing.balance_after, transactionId: existing.id };
      }
    }

    const current = comp.coins;
    const next = current + amount;
    if (next < 0) {
      throw E.badRequest('Insufficient coins balance');
    }

    await q('UPDATE companions SET coins = $2, updated_at = now() WHERE user_id = $1', [userId, next], c);

    const inserted = await one<{ id: string }>(
      `INSERT INTO coin_transactions (user_id, amount, balance_after, source, reference_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, amount, next, source, referenceId ?? null],
      c,
    );

    return { coins: next, transactionId: inserted!.id };
  });

  toUser(userId, 'wallet:update', { coins: result.coins });
  return result;
}

export async function grantXp(
  userId: string,
  source: keyof typeof XP_DAILY_CAPS,
  amount?: number,
  referenceId?: string,
): Promise<{ gained: number; capped: boolean; energy?: number; level?: number; leveledUp?: boolean }> {
  const cap = XP_DAILY_CAPS[source];
  if (!cap) {
    throw E.badRequest('Unknown XP source');
  }

  const result = await tx(async (c) => {
    // Serialise grants per user so parallel requests can't both read the same daily total and exceed the cap.
    await one('SELECT 1 FROM companions WHERE user_id = $1 FOR UPDATE', [userId], c);
    const day = await userDay(userId, c);

    if (referenceId) {
      const existing = await one<{ id: string }>(
        'SELECT id FROM xp_ledger WHERE user_id = $1 AND reference_id = $2',
        [userId, referenceId],
        c,
      );
      if (existing) {
        return { gained: 0, capped: false };
      }
    }

    const sumRow = await one<{ total: string }>(
      'SELECT COALESCE(SUM(amount), 0)::text AS total FROM xp_ledger WHERE user_id = $1 AND day = $2 AND source = $3',
      [userId, day, source],
      c,
    );
    const totalToday = parseInt(sumRow?.total ?? '0', 10);
    if (totalToday >= cap.maxPerDay) {
      return { gained: 0, capped: true };
    }

    const desired = amount ?? cap.xpPerEvent;
    const gain = Math.min(desired, cap.maxPerDay - totalToday);
    if (gain <= 0) {
      return { gained: 0, capped: true };
    }

    await q(
      `INSERT INTO xp_ledger (user_id, amount, source, day, reference_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, gain, source, day, referenceId ?? null],
      c,
    );

    const next = await grantEnergy(c, userId, gain);
    return {
      gained: gain,
      capped: totalToday + gain >= cap.maxPerDay,
      energy: next.energy,
      level: next.level,
      leveledUp: next.leveledUp,
    };
  });

  if (result.leveledUp && result.level) {
    await enqueue.push(`level:${userId}:${result.level}`, { kind: 'level', userId, level: result.level });
  }

  return result;
}
