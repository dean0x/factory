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

export const renderText = (output: CommandOutput, style: Style, quiet: boolean): string => {
  const shown = output.lines.filter((line) => !quiet || line.level === 'warn' || line.level === 'fail');
  return shown.map((line) => `${style.paint(line.level, line.text)}\n`).join('');
};

export const renderWarnings = (warnings: readonly string[]): string =>
  warnings.map((warning) => `warning: ${warning}\n`).join('');

export const renderJson = (doc: JsonDoc): string => `${JSON.stringify(doc, null, 2)}\n`;
