import { failure, type CliResult } from '../../cli/errors.js';
import type { Deps } from '../../core/deps.js';
import { remoteDefaultBranchOf } from '../../core/git.js';
import { ok } from '../../core/result.js';
import { toolNames } from '../../core/tools.js';
import { files, flags, flagText, keys, program, roles } from '../../names.js';
import type { CheckedRecord, RecordCheck, RecordCheckInput } from '../entry.js';
import { mergedStage } from './board.js';
import { githubRepoOf, parsePrNumber, readMergedPr, RECORD_COMMAND, RECORD_READER } from './github-pr.js';

/**
 * Check a merged PR on GitHub and give the record that the core writes. The repo comes from the URL of the project, the base is the
 * default branch (of the project, else the one that the remote of the clone names, never the current branch of the clone), and the
 * head branch is one of the branches that the core gives from the item (the worker, else the former workers).
 * The PR number is checked first, so a bad number is a usage error (exit 2) before any call of `gh`. Every other fault is a
 * failure (exit 1). This is the only place that makes a `CheckedRecord` for the software recipe.
 */
const checkMergedPr = async (deps: Deps, input: RecordCheckInput): Promise<CliResult<CheckedRecord>> => {
  const number = parsePrNumber(input.ref, flagText(flags.ref));
  if (!number.ok) return number;
  const repo = githubRepoOf(input.project.url ?? '', RECORD_READER);
  if (!repo.ok) return repo;
  const base = input.project.default_branch ?? (await remoteDefaultBranchOf(deps, input.cloneDir));
  if (base === null) {
    return failure(
      `the project ${input.project.id} names no default branch`,
      `Set ${keys.project.defaultBranch} for the project in ${files.config}, then run "${RECORD_COMMAND}" again.`,
    );
  }
  const read = await readMergedPr(deps, {
    repo: repo.value,
    number: number.value,
    base,
    ...(input.branches === undefined ? {} : { heads: input.branches }),
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

/** The record check of the software recipe: a PR that is merged into the default branch, from the branch of the worker or of a former worker. */
export const softwareRecordCheck: RecordCheck = {
  stage: mergedStage,
  summary: 'record a merged PR',
  refHelp:
    `the number of the PR. ${program} reads the PR with ${toolNames.gh} and records the merge only when the PR is merged ` +
    `into the default branch of the project, from the branch of the ${roles.worker} (of a former ${roles.worker} when the item has none). ` +
    'It never merges a PR.',
  parseRef: (text) => {
    const number = parsePrNumber(text, flagText(flags.ref));
    return number.ok ? ok(String(number.value)) : number;
  },
  check: checkMergedPr,
};
