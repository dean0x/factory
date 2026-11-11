import { describe, expect, it } from 'vitest';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { requestHash } from '../../src/names.js';

const ENTRY = {
  title: 'T',
  id: 'D-1',
  question: 'Q?',
  options: [
    { text: 'Yes', rec: true, key: 'a' },
    { key: 'b', text: 'No' },
  ],
};

const CANONICAL =
  '{"request":{"id":"D-1","options":[{"key":"a","rec":true,"text":"Yes"},{"key":"b","text":"No"}],"question":"Q?","title":"T"},"tag":"factory.decision-request","version":1}';

const textOf = (entry: Readonly<Record<string, unknown>>): string => {
  const text = canonicalRequestText(entry);
  if (!text.ok) throw new Error(`no canonical text: ${text.error}`);
  return text.value;
};

describe('the request hash', () => {
  it('M5-1b TP-172 gives the tagged canonical JSON: keys sorted at every level, no whitespace, the id included', () => {
    expect(textOf(ENTRY)).toBe(CANONICAL);
  });

  it('M5-1b TP-172 names the tag and the version of the wrapper in the names file', () => {
    expect(requestHash.tag).toBe('factory.decision-request');
    expect(requestHash.version).toBe(1);
  });

  it('M5-1b TP-172 gives the SHA-256 hex of the UTF-8 bytes of the text, with no wrapper step', () => {
    expect(requestHashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(requestHashOf('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(requestHashOf(CANONICAL)).toBe('e9cbd58ff703cbb8e6e4241702e51936f38658fd7b048592d1f45238026b2b34');
    expect(requestHashOf(CANONICAL)).toMatch(requestHash.pattern);
  });

  it('M5-1b TP-172 gives one hash for another key order', () => {
    const shuffled = {
      options: [
        { key: 'a', text: 'Yes', rec: true },
        { text: 'No', key: 'b' },
      ],
      question: 'Q?',
      id: 'D-1',
      title: 'T',
    };
    expect(requestHashOf(textOf(shuffled))).toBe(requestHashOf(textOf(ENTRY)));
  });

  it('M5-1b TP-172 gives another hash when a separator moves between two texts', () => {
    const one = textOf({ ...ENTRY, title: 'a b', question: 'c' });
    const two = textOf({ ...ENTRY, title: 'a', question: 'b c' });
    expect(requestHashOf(one)).not.toBe(requestHashOf(two));
  });

  it('M5-1b TP-172 keeps the order of an array, so a moved option gives another hash', () => {
    const swapped = { ...ENTRY, options: [...ENTRY.options].reverse() };
    expect(requestHashOf(textOf(swapped))).not.toBe(requestHashOf(textOf(ENTRY)));
  });

  it('M5-1b TP-172 uses the stored strings: no trim and no clean-up', () => {
    const padded = textOf({ ...ENTRY, title: 'T ' });
    expect(padded).toContain('"title":"T "');
    expect(requestHashOf(padded)).not.toBe(requestHashOf(textOf(ENTRY)));
  });

  it('M5-1b TP-172 includes the id, so two requests with the same text and another id give another hash', () => {
    expect(requestHashOf(textOf({ ...ENTRY, id: 'D-2' }))).not.toBe(requestHashOf(textOf(ENTRY)));
  });

  it('M5-1b TP-172 escapes a quote, a line break, a lone surrogate and a key that looks like a prototype key', () => {
    const entry = JSON.parse('{"__proto__":"x","title":"a\\"b\\nc\\ud800"}') as Record<string, unknown>;
    expect(textOf(entry)).toBe(
      '{"request":{"__proto__":"x","title":"a\\"b\\nc\\ud800"},"tag":"factory.decision-request","version":1}',
    );
  });

  it('M5-1b TP-172 gives an error, never a throw, for a value that is not JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const bad of [{ a: undefined }, { a: () => 1 }, { a: 1n }, { a: Number.NaN }, { a: Symbol('s') }, cyclic]) {
      expect(canonicalRequestText(bad)).toMatchObject({ ok: false });
    }
  });
});
