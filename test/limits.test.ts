import { describe, expect, it } from 'vitest';
import { waitText } from '../src/lib/ratelimit.js';

describe('rate limit wait times read naturally', () => {
  it('rounds to friendly units', () => {
    expect(waitText(3)).toBe('a few seconds');
    expect(waitText(37)).toBe('40 seconds');
    expect(waitText(120)).toBe('2 minutes');
    expect(waitText(3599)).toBe('60 minutes');
    expect(waitText(4 * 3600)).toBe('4 hours');
  });
});
