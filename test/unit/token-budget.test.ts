import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetRow, parseBudgetRows, tokensOf } from '../helpers/token-budget.js';

const BUDGET_FILE = join(__dirname, '..', '..', 'docs', 'token-budget.md');

const TABLE = [
  '# Token budget',
  '',
  '| # | Job | Command | Built in | After | Budget | Measured |',
  '|---|---|---|---|---|---|---|',
  '| 1 | Merge check | `factory check <pr>`, `factory pr merge <pr>` | FAC-M5 | 2 calls, 3–6k | 6000 | - |',
  '| 2 | Worker creation | `factory worker new` | FAC-M4 | 1 call, 1–2k | 2000 | 33 |',
  '',
].join('\n');

describe('tokensOf', () => {
  it('divides the characters by 4 and rounds up', () => {
    expect(tokensOf('')).toBe(0);
    expect(tokensOf('abcd')).toBe(1);
    expect(tokensOf('abcde')).toBe(2);
    expect(tokensOf('a'.repeat(203))).toBe(51);
  });
});

describe('parseBudgetRows', () => {
  it('reads the job, the command, the budget and the measured size of each row', () => {
    expect(parseBudgetRows(TABLE)).toEqual([
      { job: 1, command: '`factory check <pr>`, `factory pr merge <pr>`', budget: 6000, measured: null },
      { job: 2, command: '`factory worker new`', budget: 2000, measured: 33 },
    ]);
  });

  it('skips the header, the divider and the text around the table', () => {
    expect(parseBudgetRows('# Title\n\n| # | Job |\n|---|---|\n')).toEqual([]);
  });

  it('refuses a measured size that is neither - nor a number', () => {
    const bad = '| 3 | Job | `factory x` | FAC-M4 | 1 call | 1000 | about 20 |';
    expect(() => parseBudgetRows(bad)).toThrow('the measured size "about 20" is not a number');
  });
});

describe('the token budget of FAC-M4 (TP-64, TP-39)', () => {
  /**
   * The jobs that FAC-M4 builds: the status round, the restart of all workers, the worker creation, the session reset, the
   * watch, the resource check and the self reset. The typed owner input moves to FAC-M5 and the move of an outside session
   * to FAC-M7.
   */
  const FAC_M4_JOBS = [
    [2, 'factory status'],
    [3, 'factory reboot'],
    [4, 'factory worker new'],
    [7, 'factory worker reset'],
    [14, 'factory worker watch'],
    [16, 'factory machine'],
    [17, 'factory self reset'],
  ] as const;

  it.each([
    [12, 'factory worker relay', 'FAC-M5'],
    [15, 'factory worker adopt', 'FAC-M7'],
  ])('TP-39: the job %i (%s) is built in %s and has no measured size yet', (job, command, milestone) => {
    const line = readFileSync(BUDGET_FILE, 'utf8')
      .split('\n')
      .find((candidate) => new RegExp(`^\\|\\s*${job}\\s*\\|`).test(candidate));
    expect(line).toContain(`| ${milestone} |`);
    expect(budgetRow(job).command).toContain(command);
    expect(budgetRow(job).measured).toBeNull();
  });

  it.each(FAC_M4_JOBS)('has a measured size within the budget for the job %i (%s)', (job, command) => {
    const row = budgetRow(job);
    expect(row.command).toContain(command);
    expect(row.measured, `the row ${job} has no measured size`).not.toBeNull();
    expect(row.measured ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(row.budget);
  });
});
