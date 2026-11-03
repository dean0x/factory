import { expect } from 'vitest';
import { detectStyle, renderText, type CommandOutput } from '../../src/cli/output.js';

/** The limits of design 3 for the output of a job command. */
export const MAX_OUTPUT_LINES = 20;
export const MAX_FIRST_LINE_CHARS = 120;

/**
 * Fails when the output of a job command is not short. It has three checks: at most 20 lines, a
 * non-empty first line, and a first line of at most 120 characters. It does not read the words of
 * the first line.
 */
export const expectShortOutput = (text: string): void => {
  const lines = text.replace(/\n$/, '').split('\n');
  const first = lines[0] ?? '';
  expect({ firstLineEmpty: first.trim() === '' }).toEqual({ firstLineEmpty: false });
  expect(first.length, `the first line has ${first.length} characters: ${first.slice(0, 40)}...`).toBeLessThanOrEqual(
    MAX_FIRST_LINE_CHARS,
  );
  expect(lines.length, `the output has ${lines.length} lines`).toBeLessThanOrEqual(MAX_OUTPUT_LINES);
};

/** The text that a person sees on a plain terminal for the output of a command, without color. */
export const plainText = (output: CommandOutput): string => renderText(output, detectStyle({}, false, false), false);
