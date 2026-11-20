import { q } from '../db/pool.js';
import type { AppConfig } from '../shared/types.js';

export { type AppConfig };

const DEFAULTS: AppConfig = { plusEnabled: false, approvalRequired: true, phaseFlags: {} };
const CACHE_MS = 30_000;
let cached: { at: number; value: AppConfig } | null = null;

/** Reads app_config (cached 30 s, so flipping a value in the DB takes effect within half a minute). */
export async function getAppConfig(): Promise<AppConfig> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const rows = await q<{ key: string; value: unknown }>('SELECT key, value FROM app_config');
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const phaseFlags: Record<string, boolean> = {};
  for (const [k, v] of byKey.entries()) {
    if (k.startsWith('phase_')) {
      phaseFlags[k] = v === true || v === 'true';
    }
  }
  const value: AppConfig = {
    plusEnabled: byKey.has('plus_enabled') ? byKey.get('plus_enabled') === true || byKey.get('plus_enabled') === 'true' : DEFAULTS.plusEnabled,
    approvalRequired: byKey.has('approval_required') ? byKey.get('approval_required') === true || byKey.get('approval_required') === 'true' : DEFAULTS.approvalRequired,
    phaseFlags,
  };
  cached = { at: Date.now(), value };
  return value;
}

/** Test hook: read app_config again on the next call. */
export const clearAppConfigCache = () => { cached = null; };
