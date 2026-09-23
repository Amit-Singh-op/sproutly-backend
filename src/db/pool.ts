import pg from 'pg';
import { config } from '../config.js';

// BIGINT (seq) as JS number: safe up to 2^53, far beyond any conversation's message count.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE stays a 'YYYY-MM-DD' string (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  // Serverless Postgres (Neon) suspends when idle and drops connections; recycle idle ones before that happens,
  // and give a cold start time to wake up instead of failing the first request.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});
// An idle connection dropped by the server emits 'error' on the pool; unhandled, that crashes the process.
// The pool discards the broken client and opens a fresh one on the next query.
pool.on('error', (err) => { console.warn('[db] idle connection lost:', err.message); });

export type Db = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query<T>(text, params);
  return r.rows;
}
export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const r = await db.query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
