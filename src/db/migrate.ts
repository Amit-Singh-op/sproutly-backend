import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from './pool.js';

/** Applies db/migrations/*.sql in order, once each, each in its own transaction. */
export async function migrate(dir = join(process.cwd(), 'db', 'migrations')) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log(`applied ${f}`);
    } catch (err) {
      await c.query('ROLLBACK');
      throw new Error(`migration ${f} failed: ${(err as Error).message}`);
    } finally {
      c.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.ts')) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
