import { maxDisplayWidth } from '../names.js';
import type { CliError } from './errors.js';

export type LineLevel = 'text' | 'heading' | 'ok' | 'warn' | 'fail';

export interface OutLine {
  readonly level: LineLevel;
  readonly text: string;
}

export interface JsonDoc {
  readonly schema: string;
  readonly [key: string]: unknown;
}

export interface CommandOutput {
  readonly lines: readonly OutLine[];
  readonly json: JsonDoc;
  readonly warnings: readonly string[];
  readonly failed: boolean;
  /** The exit code of a failed command, when it is not the common failure code. */
  readonly exitCode?: number;
}

export interface Style {
  paint(level: LineLevel, text: string): string;
}

interface StyleSettings {
  readonly color: boolean;
  readonly unicode: boolean;
}

const ANSI_RESET = '\u001b[0m';
const ANSI_BY_LEVEL: Readonly<Record<LineLevel, string>> = {
  text: '',
  heading: '\u001b[1m',
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  fail: '\u001b[31m',
};

const SYMBOLS_UNICODE: Readonly<Record<LineLevel, string>> = {
  text: '',
  heading: '',
  ok: '✓',
  warn: '!',
  fail: '✗',
};

const SYMBOLS_ASCII: Readonly<Record<LineLevel, string>> = {
  text: '',
  heading: '',
  ok: '[ok]',
  warn: '[warn]',
  fail: '[FAIL]',
};

export const createStyle = ({ color, unicode }: StyleSettings): Style => ({
  paint: (level, text) => {
    const symbols = unicode ? SYMBOLS_UNICODE : SYMBOLS_ASCII;
    const symbol = symbols[level];
    const line = symbol === '' ? text : `${symbol} ${text}`;
    const ansi = ANSI_BY_LEVEL[level];
    return color && ansi !== '' ? `${ansi}${line}${ANSI_RESET}` : line;
  },
});

const firstNonEmpty = (values: readonly (string | undefined)[]): string =>
  values.find((value) => value !== undefined && value !== '') ?? '';

export const detectStyle = (
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
  noColorFlag: boolean,
): Style => {
  const locale = firstNonEmpty([env['LC_ALL'], env['LC_CTYPE'], env['LANG']]);
  return createStyle({
    color: isTTY && !noColorFlag && firstNonEmpty([env['NO_COLOR']]) === '' && env['TERM'] !== 'dumb',
    unicode: isTTY && /utf-?8/i.test(locale),
  });
};

/** C0 controls (not tab or newline), DEL and C1 controls. The escape character is among them. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Values from config and folder names reach the terminal as text. Control characters never go through as they are. */
export const printable = (text: string): string => text.replace(CONTROL_CHARACTERS, '?');

export const renderError = (error: CliError): string =>
  `error: ${printable(error.message)}\n${error.hint === undefined ? '' : `${printable(error.hint)}\n`}`;

/** The text for an error that no command handled. Its message is filtered like any other error text. */
export const renderInternalError = (cause: unknown): string =>
  `error: internal error: ${printable(cause instanceof Error ? cause.message : 'unknown')}\n`;

export const renderText =(output: CommandOutput, style: Style, quiet: boolean): string => {
  const shown = output.lines.filter((line) => !quiet || line.level === 'warn' || line.level === 'fail');
  return shown.map((line) => `${style.paint(line.level, printable(line.text))}\n`).join('');
};

/**
 * The lines of a table: the title line as a heading, then one text line for each row. A column is as wide as its widest cell, and
 * two spaces part the columns. A line has no space at its end.
 */
export const tableLines = (title: readonly string[], rows: readonly (readonly string[])[]): readonly OutLine[] => {
  const all = [title, ...rows];
  const widths = title.map((_, column) => Math.max(...all.map((row) => (row[column] ?? '').length)));
  const lineOf = (row: readonly string[]): string => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
  return [{ level: 'heading', text: lineOf(title) }, ...rows.map((row): OutLine => ({ level: 'text', text: lineOf(row) }))];
};

export const renderWarnings = (warnings: readonly string[]): string =>
  warnings.map((warning) => `warning: ${printable(warning)}\n`).join('');

/**
 * The characters that show as nothing and that no control or format class holds: the variation selectors, the Hangul
 * fillers and the Mongolian free variation selectors.
 */
export const INVISIBLE_FILLER = /[\u{115f}\u{1160}\u{180b}-\u{180d}\u{180f}\u{3164}\u{fe00}-\u{fe0f}\u{ffa0}\u{e0100}-\u{e01ef}]/u;

/** Every control character, apart from the characters in `kept` (a regex class body), every character that only formats text, and every filler. */
const hiddenCharactersExcept = (kept: string): RegExp =>
  new RegExp(`(?![${kept}])(?:[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]|${INVISIBLE_FILLER.source})`, 'gu');

/** For terminal text: the newline and the tab stay. A raw carriage return never reaches the screen. */
const HIDDEN_CHARACTERS = hiddenCharactersExcept('\\n\\t');

/** For JSON text: a carriage return stays too, because JSON writes it as an escape and a string value keeps its line breaks. */
const HIDDEN_CHARACTERS_IN_JSON = hiddenCharactersExcept('\\n\\t\\r');

const escapeOf = (character: string): string => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`;
};

/** The text with each control character shown as an escape, so that the screen shows the text of the bytes. */
export const visibleText = (value: string): string => value.replace(HIDDEN_CHARACTERS, escapeOf);

const LINE_BREAKS_AND_TABS = /[\n\r\t]/g;

/**
 * Stored text as one clean line of text output: a line break, a carriage return and a tab each become one space, the hidden
 * characters (control, bidi, format and invisible) are removed, and the line is cut to `width` characters. A pair of code
 * units that make one character is never cut in half.
 */
export const displayLine = (text: string, width: number = maxDisplayWidth): string => {
  const clean = text.replace(LINE_BREAKS_AND_TABS, ' ').replace(HIDDEN_CHARACTERS, '');
  const cut = clean.slice(0, Math.max(0, width));
  return cut.length < clean.length && /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/**
 * The same rule as HIDDEN_CHARACTERS, as a copy with no global flag. A global regex keeps `lastIndex` between two calls of `.test`,
 * so a repeated call can give another answer. The copy has the same source, so the display rule has one owner.
 */
const HIDDEN_CHARACTER = new RegExp(HIDDEN_CHARACTERS.source, 'u');

/**
 * True when the text holds a character that the display removes: a control character other than the newline and the tab, a
 * format, line or paragraph separator character, or an invisible filler. A caller that must show exactly the text that it hashes
 * refuses such a text.
 */
export const removedByDisplay = (text: string): boolean => HIDDEN_CHARACTER.test(text);

/**
 * The text as lines of at most `width` code units (at least one), with no character dropped: the lines joined give the text. A
 * character of two code units is never cut in half, so it takes a line of its own when `width` is smaller than it. An empty text
 * gives one empty line. The text is one line of text: a line break in it counts as a character.
 */
export const wrapText = (text: string, width: number = maxDisplayWidth): readonly string[] => {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  let line = '';
  for (const character of text) {
    if (line !== '' && line.length + character.length > limit) {
      lines.push(line);
      line = '';
    }
    line += character;
  }
  return [...lines, line];
};

/** In JSON, the hidden characters leave the string values. A line break and a carriage return stay as escapes and no string is cut. */
const withoutHidden = (_key: string, value: unknown): unknown =>
  typeof value === 'string' ? value.replace(HIDDEN_CHARACTERS_IN_JSON, '') : value;

export const renderJson = (doc: JsonDoc): string => `${JSON.stringify(doc, withoutHidden, 2)}\n`;
