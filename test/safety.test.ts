import { describe, expect, it } from 'vitest';
import { flagText, isDisposableEmail, isReservedName } from '../src/shared/safety.js';

describe('reserved names', () => {
  it('blocks names that could pass for staff, look-alikes included', () => {
    for (const n of ['Sproutly', 'sproutly team', 'Admin', 'adm1n', 'Moderator', 'Sproutly Support', 'OFFICIAL', 'st4ff', 'Help Desk'])
      expect(isReservedName(n)).toBe(true);
  });
  it('leaves ordinary names alone', () => {
    for (const n of ['AJ', 'Amitt', 'Ashutosh', 'Ramo', 'Tushar', 'Sprout', 'Maddie', 'Modi', 'Supriya', 'Stefan'])
      expect(isReservedName(n)).toBe(false);
  });
});

describe('throwaway emails', () => {
  it('refuses known temporary inboxes', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@YOPMAIL.com')).toBe(true);
    expect(isDisposableEmail('x@eu.guerrillamail.com')).toBe(true);
  });
  it('allows normal providers and phone numbers', () => {
    expect(isDisposableEmail('someone@gmail.com')).toBe(false);
    expect(isDisposableEmail('a@verismart.ai')).toBe(false);
    expect(isDisposableEmail('+919999999999')).toBe(false);
  });
});

describe('automatic flags (flag only)', () => {
  it('flags threats, sexual requests and slurs', () => {
    expect(flagText('i will kill you tomorrow')).toBe('violence');
    expect(flagText('I know where you live')).toBe('violence');
    expect(flagText('just kys')).toBe('harassment');
    expect(flagText('send me nudes')).toBe('sexual');
  });
  it('does not flag everyday talk', () => {
    for (const t of ['this game is killing me lol', 'I could kill for a pizza', 'you killed it today!', 'send me the notes', 'nice shot', 'what a day', null, ''])
      expect(flagText(t)).toBeNull();
  });
});
