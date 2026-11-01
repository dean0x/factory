import { failure, type CliResult } from '../cli/errors.js';
import { ok } from '../core/result.js';

/** One pure step from schema version `from` to `from + 1`. */
export interface Migration {
  readonly from: number;
  readonly to: number;
  apply(raw: unknown): CliResult<unknown>;
}

/** Check that the chain from `current` to `target` has no gap, and return its steps. */
export const planMigrations = (
  current: number,
  target: number,
  list: readonly Migration[],
): CliResult<readonly Migration[]> => {
  if (current > target) {
    return failure(`version ${current} is newer than the version ${target} that this factory reads. Upgrade factory.`);
  }
  const steps: Migration[] = [];
  for (let version = current; version < target; version += 1) {
    const matches = list.filter((migration) => migration.from === version);
    const [step] = matches;
    if (step === undefined) return failure(`no migration from version ${version}`);
    if (matches.length > 1) return failure(`two migrations start at version ${version}`);
    if (step.to !== version + 1) return failure(`the migration from version ${version} must go to ${version + 1}`);
    steps.push(step);
  }
  return ok(steps);
};

/** Apply the steps in order. The first error stops the run. */
export const runMigrations = (raw: unknown, steps: readonly Migration[]): CliResult<unknown> => {
  let current = raw;
  for (const step of steps) {
    const next = step.apply(current);
    if (!next.ok) {
      return failure(`migration from version ${step.from} to ${step.to} failed: ${next.error.message}`);
    }
    current = next.value;
  }
  return ok(current);
};
