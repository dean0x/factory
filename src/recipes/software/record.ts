import { failure, type CliResult } from '../../cli/errors.js';
import type { Deps } from '../../core/deps.js';
import { defaultBranchOf } from '../../core/git.js';
import { ok } from '../../core/result.js';
import { toolNames } from '../../core/tools.js';
import { files, keys, program, roles } from '../../names.js';
import type { CheckedRecord, RecordCheck, RecordCheckInput } from '../entry.js';
import { mergedStage } from './board.js';
import { githubRepoOf, parsePrNumber, readMergedPr } from './github-pr.js';

/**
 * Check a merged PR on GitHub and give the record that the core writes. The repo comes from the URL of the project, the base is the
 * default branch (of the project, else of the clone), and the head branch is the branch of the worker when the item names one.
 * The PR number is checked first, so a bad number is a usage error (exit 2) before any call of `gh`. Every other fault is a
 * failure (exit 1). This is the only place that makes a `CheckedRecord` for the software recipe.
 */
const checkMergedPr = async (deps: Deps, input: RecordCheckInput): Promise<CliResult<CheckedRecord>> => {
  const number = parsePrNumber(input.ref);
  if (!number.ok) return number;
  const repo = githubRepoOf(input.project.url ?? '');
  if (!repo.ok) return repo;
  const base = input.project.default_branch ?? (await defaultBranchOf(deps, input.cloneDir));
  if (base === null) {
    return failure(
      `the project ${input.project.id} names no default branch`,
      `Set ${keys.project.defaultBranch} for the project in ${files.config}.`,
    );
  }
  const read = await readMergedPr(deps, {
    repo: repo.value,
    number: number.value,
    base,
    ...(input.branch === undefined ? {} : { head: input.branch }),
  });
  if (!read.ok) return read;
  const { pr } = read.value;
  return ok({
    stage: mergedStage,
    ref: String(pr.number),
    head: pr.prHead,
    summary: `PR ${pr.number}, merge commit ${pr.mergeCommit}`,
  } as CheckedRecord);
};

/** The record check of the software recipe: a PR that is merged into the default branch, from the branch of the worker. */
export const softwareRecordCheck: RecordCheck = {
  stage: mergedStage,
  summary: 'record a merged PR',
  refHelp:
    `the number of the PR. ${program} reads the PR with ${toolNames.gh} and records the merge only when the PR is merged ` +
    `into the default branch of the project, from the branch of the ${roles.worker}. It never merges a PR.`,
  parseRef: (text) => {
    const number = parsePrNumber(text);
    return number.ok ? ok(String(number.value)) : number;
  },
  check: checkMergedPr,
};
