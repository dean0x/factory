import { describe, expect, it } from 'vitest';
import { displayLine, removedByDisplay, renderJson, visibleText, wrapText } from '../../src/cli/output.js';
import { maxDisplayWidth } from '../../src/names.js';

/** Characters that the source of this file does not hold as they are. */
const at = (code: number): string => String.fromCodePoint(code);
const ESC = at(0x1b);
const NUL = at(0);
const DEL = at(0x7f);
const NEXT_LINE = at(0x85);
const RIGHT_TO_LEFT_OVERRIDE = at(0x202e);
const LEFT_TO_RIGHT_ISOLATE = at(0x2066);
const ZERO_WIDTH_SPACE = at(0x200b);
const BYTE_ORDER_MARK = at(0xfeff);
const LINE_SEPARATOR = at(0x2028);
const VARIATION_SELECTOR = at(0xfe0f);
const HANGUL_FILLER = at(0x3164);
const E_ACUTE = at(0xe9);
const EMOJI = at(0x1f600);

describe('the display helper for a line of text (AC-36)', () => {
  it('M5-1b TP-90 removes control characters, among them the escape character of a terminal sequence', () => {
    expect(displayLine(`a${ESC}[2Jb${NUL}c${DEL}d${NEXT_LINE}e`)).toBe('a[2Jbcde');
  });

  it('M5-1b TP-90 removes bidi, invisible and format characters', () => {
    const text = `a${RIGHT_TO_LEFT_OVERRIDE}b${LEFT_TO_RIGHT_ISOLATE}c${ZERO_WIDTH_SPACE}d${BYTE_ORDER_MARK}e${LINE_SEPARATOR}f`;
    expect(displayLine(text)).toBe('abcdef');
  });

  it('M5-1b TP-90 removes the variation selectors and the fillers, because they show as nothing', () => {
    expect(displayLine(`a${VARIATION_SELECTOR}b${HANGUL_FILLER}c`)).toBe('abc');
  });

  it('M5-1b TP-90 turns a newline, a carriage return and a tab into one space each', () => {
    expect(displayLine('one\ntwo\rthree\tfour')).toBe('one two three four');
  });

  it('M5-1b TP-90 leaves other text as it is, non-ASCII text and an emoji among it', () => {
    const text = `${E_ACUTE}crire des tests. ${EMOJI}`;
    expect(displayLine(text)).toBe(text);
  });

  it('M5-1b TP-90 cuts a line to the width cap', () => {
    const cut = displayLine('x'.repeat(maxDisplayWidth + 50));
    expect(cut).toBe('x'.repeat(maxDisplayWidth));
  });

  it('M5-1b TP-90 cuts a line to a width that the caller gives, and keeps a line that fits', () => {
    expect(displayLine('abcdef', 4)).toBe('abcd');
    expect(displayLine('abcd', 4)).toBe('abcd');
  });

  it('M5-1b TP-90 measures the width after it removed hidden characters and turned line breaks into spaces', () => {
    expect(displayLine(`a${ZERO_WIDTH_SPACE}b\nc`, 4)).toBe('ab c');
  });

  it('M5-1b TP-90 does not cut a character of two code units in half', () => {
    const cut = displayLine(`ab${EMOJI}cd`, 3);
    expect(cut).toBe('ab');
  });
});

describe('the display helper for the JSON output (AC-36)', () => {
  it('M5-1b TP-105 removes hidden characters from string values at any depth', () => {
    const doc = {
      schema: 'x/v1',
      title: `a${ESC}[2Jb${RIGHT_TO_LEFT_OVERRIDE}c${ZERO_WIDTH_SPACE}d${VARIATION_SELECTOR}e`,
      rows: [{ note: `n${NUL}o` }, `p${BYTE_ORDER_MARK}q`],
    };
    expect(JSON.parse(renderJson(doc))).toEqual({
      schema: 'x/v1',
      title: 'a[2Jbcde',
      rows: [{ note: 'no' }, 'pq'],
    });
  });

  it('M5-1b TP-105 keeps a line break and a tab in a string value as an escape', () => {
    const text = renderJson({ schema: 'x/v1', title: 'one\ntwo\tthree' });
    expect(text).toContain('"one\\ntwo\\tthree"');
    expect(JSON.parse(text)).toEqual({ schema: 'x/v1', title: 'one\ntwo\tthree' });
  });

  it('M5-1b TP-105 keeps a carriage return in a string value as an escape, so that the line breaks do not change', () => {
    const text = renderJson({ schema: 'x/v1', title: 'a\r\nb' });
    expect(text).toContain('"a\\r\\nb"');
    expect(JSON.parse(text)).toEqual({ schema: 'x/v1', title: 'a\r\nb' });
  });

  it('M5-1b TP-105 still removes a line separator from a string value that holds a carriage return', () => {
    const text = renderJson({ schema: 'x/v1', title: `a\r${LINE_SEPARATOR}b` });
    expect(JSON.parse(text)).toEqual({ schema: 'x/v1', title: 'a\rb' });
  });

  it('M5-1b TP-105 cuts no string to the width', () => {
    const long = 'y'.repeat(maxDisplayWidth * 3);
    expect(JSON.parse(renderJson({ schema: 'x/v1', title: long }))).toEqual({ schema: 'x/v1', title: long });
  });

  it('M5-1b TP-105 leaves numbers, booleans, null and the keys as they are', () => {
    const doc = { schema: 'x/v1', count: 3, idle: false, owner: null, [`key${ZERO_WIDTH_SPACE}`]: 'v' };
    expect(JSON.parse(renderJson(doc))).toEqual(doc);
  });

  it('M5-1b TP-105 ends the text with one newline and indents with two spaces', () => {
    expect(renderJson({ schema: 'x/v1', a: 1 })).toBe('{\n  "schema": "x/v1",\n  "a": 1\n}\n');
  });
});

describe('the visible text keeps its escapes (AC-36)', () => {
  it('M5-1b TP-92 keeps a newline and a tab, and shows each hidden character as an escape', () => {
    expect(visibleText(`a${ESC}b\n\tc${RIGHT_TO_LEFT_OVERRIDE}d`)).toBe('a\\x1bb\n\tc\\u{202e}d');
  });
});

/** One character of each class that the display removes, with a name for the failure message. */
const REMOVED_CHARACTERS: readonly (readonly [string, string])[] = [
  ['escape', ESC],
  ['null', NUL],
  ['delete', DEL],
  ['next line (C1 control)', NEXT_LINE],
  ['carriage return', at(0x0d)],
  ['right-to-left override', RIGHT_TO_LEFT_OVERRIDE],
  ['left-to-right isolate', LEFT_TO_RIGHT_ISOLATE],
  ['zero width space', ZERO_WIDTH_SPACE],
  ['byte order mark', BYTE_ORDER_MARK],
  ['line separator', LINE_SEPARATOR],
  ['paragraph separator', at(0x2029)],
  ['tag character', at(0xe0041)],
  ['variation selector', VARIATION_SELECTOR],
  ['variation selector supplement', at(0xe0100)],
  ['Hangul filler', HANGUL_FILLER],
  ['Mongolian free variation selector', at(0x180b)],
];

describe('the display predicate (AC-42)', () => {
  it.each(REMOVED_CHARACTERS)('M5-1b TP-183 is true for a text with the %s', (_name, character) => {
    expect(removedByDisplay(`a${character}b`)).toBe(true);
  });

  it.each(REMOVED_CHARACTERS.filter(([name]) => name !== 'carriage return'))(
    'M5-1b TP-183 agrees with displayLine: the %s is a character that displayLine removes',
    (_name, character) => {
      expect(displayLine(`a${character}b`)).toBe('ab');
      expect(removedByDisplay(`a${character}b`)).toBe(true);
    },
  );

  it('M5-1b TP-183 is false for clean text, a newline, a tab, non-ASCII text and an emoji', () => {
    expect(removedByDisplay('Pick the plan for the release.')).toBe(false);
    expect(removedByDisplay('one\ntwo\tthree')).toBe(false);
    expect(removedByDisplay(`${E_ACUTE}crire ${EMOJI}`)).toBe(false);
    expect(removedByDisplay('')).toBe(false);
  });

  it('M5-1b TP-183 gives the same answer over repeated calls, for a hidden and for a clean text', () => {
    const hidden = `a${ZERO_WIDTH_SPACE}b`;
    const answers = [1, 2, 3, 4].map(() => [removedByDisplay(hidden), removedByDisplay(hidden), removedByDisplay('clean')]);
    expect(answers).toEqual(Array.from({ length: 4 }, () => [true, true, false]));
  });
});

describe('the wrap helper (AC-42)', () => {
  it('M5-1b TP-181 shows a text of 500 characters in full, in lines of at most the width cap', () => {
    const text = `${'word '.repeat(100)}`;
    const lines = wrapText(text);
    expect(lines.join('')).toBe(text);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(maxDisplayWidth);
    expect(lines).toHaveLength(Math.ceil(text.length / maxDisplayWidth));
  });

  it('M5-1b TP-181 gives one line for a text that fits, also an empty text', () => {
    expect(wrapText('abcd', 4)).toEqual(['abcd']);
    expect(wrapText('')).toEqual(['']);
  });

  it('M5-1b TP-181 splits at the width the caller gives and drops no character', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('M5-1b TP-181 does not cut a character of two code units in half', () => {
    const lines = wrapText(`ab${EMOJI}cd`, 3);
    expect(lines).toEqual(['ab', `${EMOJI}c`, 'd']);
    expect(lines.join('')).toBe(`ab${EMOJI}cd`);
  });

  it('M5-1b TP-181 gives a whole character its own line when the width is smaller than the character, and ends', () => {
    expect(wrapText(`${EMOJI}${EMOJI}`, 1)).toEqual([EMOJI, EMOJI]);
  });

  it('M5-1b TP-181 treats a width below one as one', () => {
    expect(wrapText('abc', 0)).toEqual(['a', 'b', 'c']);
  });
});
