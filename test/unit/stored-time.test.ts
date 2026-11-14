import { describe, expect, it } from 'vitest';
import { storedTimeOf } from '../../src/board/stored-time.js';

const AT = '2030-01-02T10:11:12.345Z';

describe('storedTimeOf', () => {
  it('gives back an exact time in UTC, as toISOString writes it', () => {
    expect(storedTimeOf(AT)).toBe(AT);
    expect(storedTimeOf(new Date(AT).toISOString())).toBe(AT);
    expect(storedTimeOf('0000-01-01T00:00:00.000Z')).toBe('0000-01-01T00:00:00.000Z');
    expect(storedTimeOf('9999-12-31T23:59:59.999Z')).toBe('9999-12-31T23:59:59.999Z');
  });

  it('gives null for a value that is not a string', () => {
    const wrong: readonly unknown[] = [undefined, null, 0, 1_893_492_672_345, true, {}, [], [AT], new Date(AT), { toString: () => AT }];
    for (const value of wrong) expect(storedTimeOf(value), typeof value).toBeNull();
  });

  it('gives null for a time in any other form', () => {
    const otherForms: readonly string[] = [
      '2030-01-02',
      '2030-01-02T10:11:12Z',
      '2030-01-02T10:11:12.34Z',
      '2030-01-02T10:11:12.345',
      '2030-01-02T10:11:12.345+00:00',
      '2030-01-02T10:11:12.345+0000',
      '2030-01-02 10:11:12.345Z',
      '2030-01-02t10:11:12.345z',
      ' 2030-01-02T10:11:12.345Z',
      '2030-01-02T10:11:12.345Z ',
      '2030-01-02T10:11:12.345Z\n',
      '+002030-01-02T10:11:12.345Z',
      'Wed, 02 Jan 2030 10:11:12 GMT',
      '',
    ];
    for (const value of otherForms) expect(storedTimeOf(value), JSON.stringify(value)).toBeNull();
  });

  it('gives null for a time that is not a real time, and does not throw', () => {
    const notTimes: readonly string[] = [
      '2030-13-02T10:11:12.345Z',
      '2030-01-32T10:11:12.345Z',
      '2030-02-30T10:11:12.345Z',
      '2030-01-02T24:11:12.345Z',
      '2030-01-02T10:60:12.345Z',
      '2030-01-02T10:11:60.345Z',
      'xxxx-xx-xxTxx:xx:xx.xxxZ',
      'Invalid Date and more...',
    ];
    for (const value of notTimes) expect(() => storedTimeOf(value), value).not.toThrow();
    for (const value of notTimes) expect(storedTimeOf(value), value).toBeNull();
  });

  it('gives null for a text of 24 characters that holds a time and more, or less than a time', () => {
    expect(storedTimeOf(`${AT}${AT}`)).toBeNull();
    expect(storedTimeOf(AT.slice(0, -1))).toBeNull();
    expect(storedTimeOf(`${AT}x`)).toBeNull();
  });
});
