import { describe, expect, it } from 'vitest';
import { displayLine, renderJson, visibleText } from '../../src/cli/output.js';
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
