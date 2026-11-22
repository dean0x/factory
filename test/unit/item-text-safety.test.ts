import { describe, expect, it } from 'vitest';
import { allOn } from '../../src/guards/effective.js';
import { guardIds, guardValues, itemWords } from '../../src/names.js';
import { checkFileTokens } from '../../src/safety/secrets.js';

describe('checkFileTokens', () => {
  const shortHead = 'abcdef0';
  const fullHead = shortHead + '1'.repeat(33);
  const hint = 'Remove the token from the text.';

  it('uses the item text reason and does not repeat any input text', () => {
    expect(checkFileTokens(`Private text: ${fullHead}`, allOn, hint, itemWords.noteToken)).toEqual({
      ok: false,
      error: { kind: 'safety', message: 'the note or close reason looks like a token', hint },
    });
  });

  it('keeps the task text reason when the caller gives no reason', () => {
    expect(checkFileTokens(fullHead, allOn, hint)).toEqual({
      ok: false,
      error: { kind: 'safety', message: 'the task text looks like a token', hint },
    });
  });

  it('accepts a short commit id with the secrets guard on', () => {
    expect(checkFileTokens(shortHead, allOn, hint, itemWords.noteToken)).toEqual({ ok: true, value: undefined });
  });

  it('accepts a full commit id with the secrets guard off', () => {
    const guards = { [guardIds.secrets]: guardValues.off };
    expect(checkFileTokens(fullHead, guards, hint, itemWords.noteToken)).toEqual({ ok: true, value: undefined });
  });
});
