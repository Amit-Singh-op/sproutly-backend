import { q } from '../db/pool.js';

/** What the app is told at launch. Add new switches here and as rows in app_config. */
export interface AppConfig {
  plusEnabled: boolean;
  /** Invite-only: new accounts need users.approved = true before they can use the app. */
  approvalRequired: boolean;
}

const DEFAULTS: AppConfig = { plusEnabled: false, approvalRequired: true };
const CACHE_MS = 30_000;
let cached: { at: number; value: AppConfig } | null = null;

/** Reads app_config (cached 30 s, so flipping a value in the DB takes effect within half a minute). */
export async function getAppConfig(): Promise<AppConfig> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const rows = await q<{ key: string; value: unknown }>('SELECT key, value FROM app_config');
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const value: AppConfig = {
    plusEnabled: byKey.has('plus_enabled') ? byKey.get('plus_enabled') === true : DEFAULTS.plusEnabled,
    approvalRequired: byKey.has('approval_required') ? byKey.get('approval_required') === true : DEFAULTS.approvalRequired,
  };
  cached = { at: Date.now(), value };
  return value;
}
