import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One row of the table in `docs/token-budget.md`. A row that no milestone has built has a null `measured`. */
export interface BudgetRow {
  readonly job: number;
  readonly command: string;
  readonly budget: number;
  readonly measured: number | null;
}

const BUDGET_FILE = join(__dirname, '..', '..', 'docs', 'token-budget.md');

/** The size of a text in tokens by the rule of `docs/token-budget.md`: its characters divided by 4, rounded up. */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

const numberOf = (cell: string, what: string, line: string): number => {
  if (!/^\d+$/.test(cell)) throw new Error(`the ${what} "${cell}" is not a number in the row: ${line}`);
  return Number(cell);
};

/** The rows of the job table, in the order of the file. The cell "Measured" is `-` or a number of tokens. */
export const parseBudgetRows = (markdown: string): readonly BudgetRow[] =>
  markdown
    .split('\n')
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      const [, job = '', , command = '', , , budget = '', measured = ''] = cells;
      return {
        job: numberOf(job, 'job number', line),
        command,
        budget: numberOf(budget, 'budget', line),
        measured: measured === '-' ? null : numberOf(measured, 'measured size', line),
      };
    });

/** The row of one job in the token budget of this repository. */
export const budgetRow = (job: number): BudgetRow => {
  const found = parseBudgetRows(readFileSync(BUDGET_FILE, 'utf8')).find((row) => row.job === job);
  if (found === undefined) throw new Error(`docs/token-budget.md has no row for the job ${job}`);
  return found;
};
