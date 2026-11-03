import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectShortOutput, MAX_FIRST_LINE_CHARS, MAX_OUTPUT_LINES } from '../helpers/short-output.js';

const lines = (count: number): string =>
  `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`;

/** The roadmap line of the helper test starts with this text, as an open or a checked box. */
const ROADMAP_LINE_START = /^- \[[ xX]\] Helper test: the short-output helper /;

/** The three checks of the helper, in the words that the roadmap line uses. */
const roadmapChecks = (): readonly string[] => [
  `at most ${MAX_OUTPUT_LINES} lines`,
  'a non-empty first line',
  `a first line of at most ${MAX_FIRST_LINE_CHARS} characters`,
];

/** The checks that a roadmap line does not name. */
const missingChecks = (line: string): string[] => roadmapChecks().filter((check) => !line.includes(check));

const roadmapLines = (): string[] =>
  readFileSync(join(__dirname, '..', '..', 'docs', 'roadmap-v2.md'), 'utf8')
    .split('\n')
    .filter((line) => ROADMAP_LINE_START.test(line));

describe('expectShortOutput', () => {
  it('has the limits of the design', () => {
    expect(MAX_OUTPUT_LINES).toBe(20);
    expect(MAX_FIRST_LINE_CHARS).toBe(120);
  });

  it('accepts 20 lines', () => {
    expect(() => expectShortOutput(lines(20))).not.toThrow();
  });

  it('accepts one line, with or without the final newline', () => {
    expect(() => expectShortOutput('Started the session.\n')).not.toThrow();
    expect(() => expectShortOutput('Started the session.')).not.toThrow();
  });

  it('rejects 21 lines', () => {
    expect(() => expectShortOutput(lines(21))).toThrow();
  });

  it('rejects an empty first line', () => {
    expect(() => expectShortOutput('\nStarted the session.\n')).toThrow();
  });

  it('rejects a first line that holds only spaces', () => {
    expect(() => expectShortOutput('   \nStarted the session.\n')).toThrow();
  });

  it('does not read the words of the first line', () => {
    expect(() => expectShortOutput('x y z\n')).not.toThrow();
  });

  it('rejects an empty text', () => {
    expect(() => expectShortOutput('')).toThrow();
  });

  it('accepts a first line of 120 characters', () => {
    expect(() => expectShortOutput(`${'x'.repeat(120)}\nsecond\n`)).not.toThrow();
  });

  it('rejects a first line of 121 characters', () => {
    expect(() => expectShortOutput(`${'x'.repeat(121)}\nsecond\n`)).toThrow();
  });

  it('does not limit the length of a line after the first', () => {
    expect(() => expectShortOutput(`first\n${'x'.repeat(300)}\n`)).not.toThrow();
  });
});

describe('the roadmap line of the short-output helper', () => {
  it('names the three checks of the helper', () => {
    const found = roadmapLines();
    expect(found, 'the roadmap has no line, or more than one line, for the helper test').toHaveLength(1);
    expect(missingChecks(found[0] ?? '')).toEqual([]);
  });

  it('finds each check that a line does not name', () => {
    const line = `- [ ] Helper test: the short-output helper has three checks: at most ${MAX_OUTPUT_LINES} lines, a non-empty first line, and a first line of at most ${MAX_FIRST_LINE_CHARS} characters.`;
    expect(missingChecks(line)).toEqual([]);
    expect(missingChecks(line.replace('at most 20 lines', 'few lines'))).toEqual(['at most 20 lines']);
    expect(missingChecks(line.replace('a non-empty first line', 'a first line'))).toEqual(['a non-empty first line']);
    expect(missingChecks(line.replace('at most 120 characters', 'a short length'))).toEqual([
      'a first line of at most 120 characters',
    ]);
    expect(missingChecks('- [ ] Helper test: the short-output helper has no checks.')).toHaveLength(3);
  });
});
