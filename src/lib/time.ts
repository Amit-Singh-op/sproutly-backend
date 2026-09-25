/** The user's local calendar day (YYYY-MM-DD) for quests and streaks, from an IANA timezone. */
export function localDay(timezone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Whole days between two YYYY-MM-DD strings (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export const isValidTimezone = (tz: string) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};

/** The instant the user's next local day starts (ISO). Uses the current UTC offset, so it can be an hour off across a DST change. */
export function nextLocalMidnight(timezone: string, at: Date = new Date()): string {
  const wall = (tz: string) => Date.parse(at.toLocaleString('en-US', { timeZone: tz }));
  let offset = 0;
  try { offset = wall(timezone) - wall('UTC'); } catch { offset = 0; }
  const [y, m, d] = localDay(timezone, at).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1) - offset).toISOString();
}
