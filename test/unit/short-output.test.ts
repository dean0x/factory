import { describe, expect, it } from 'vitest';
import { expectShortOutput, MAX_FIRST_LINE_CHARS, MAX_OUTPUT_LINES } from '../helpers/short-output.js';

const lines = (count: number): string =>
  `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`;

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
