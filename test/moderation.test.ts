import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORT_CATEGORIES, REPORT_CATEGORY_INFO } from '../src/shared/types.js';

describe('report reasons', () => {
  it('every reason has a label and a severity from 1 to 4', () => {
    for (const c of REPORT_CATEGORIES) {
      expect(REPORT_CATEGORY_INFO[c].label.length).toBeGreaterThan(2);
      expect([1, 2, 3, 4]).toContain(REPORT_CATEGORY_INFO[c].severity);
    }
  });

  it('the database allows exactly the reasons the app can send', () => {
    const sql = readFileSync('db/migrations/028_moderation_v2.sql', 'utf8');
    const allowed = sql.match(/category IN \(([^)]*)\)/)![1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect([...allowed].sort()).toEqual([...REPORT_CATEGORIES].sort());
  });

  it('the most serious reasons are critical', () => {
    expect(REPORT_CATEGORY_INFO.child_safety.severity).toBe(4);
    expect(REPORT_CATEGORY_INFO.violence.severity).toBe(4);
    expect(REPORT_CATEGORY_INFO.spam.severity).toBe(1);
  });
});
