import { z } from 'zod';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { parseGithubRepo } from '../core/git.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import { flags, flagText, ghTimeoutMs, mergeCheck } from '../names.js';
import { parseJsonText } from '../state/load.js';

/*
 * The merge check is a guard against a mistake, not a proof. The session that runs it controls PATH and the environment, so it
 * can put another `gh` in front of the real one. The check stops a wrong PR number, a PR that is not merged and a PR of another
 * branch. It does not stop a session that wants to deceive the board.
 */

declare const mergedBrand: unique symbol;

/**
 * A PR that passed the merge check. Only `readMergedPr` makes one, so a value of this type proves that the check ran and passed.
 * `prHead` is the head sha of the PR (`headRefOid`), never the merge commit: the merge commit goes to the output and to the commit
 * message only.
 */
export interface MergedPr {
  readonly [mergedBrand]: true;
  readonly number: number;
  readonly mergeCommit: string;
  readonly prHead: string;
}

/** The result of the read: a merged PR that matches. Every other case is a failure. */
export type MergedRead = { readonly kind: 'merged'; readonly pr: MergedPr };

/** What the PR must match. `head` is the head branch; without it the head branch is not tested. */
export interface MergeReadInput {
  /** `owner/name` of the repo, from `githubRepoOf`. */
  readonly repo: string;
  readonly number: number;
  /** The branch that the PR merged into. */
  readonly base: string;
  readonly head?: string;
}

const fields = mergeCheck.fields;

/** The answer of `gh pr view`. A key that the check does not know, or a missing key, fails the parse. */
const prSchema = z.strictObject({
  [fields.number]: z.number(),
  [fields.state]: z.string(),
  [fields.mergedAt]: z.string().nullable(),
  [fields.mergeCommit]: z.object({ [mergeCheck.mergeCommitSha]: z.string() }).nullable(),
  [fields.headBranch]: z.string(),
  [fields.headSha]: z.string(),
  [fields.baseBranch]: z.string(),
  [fields.crossRepository]: z.boolean(),
  [fields.url]: z.string(),
});

const CHECK_AGAIN = 'Check the PR number and the branch, then run the command again.';

/** A PR that does not match. The reason is a fixed phrase and the number that the caller gave: no text of gh is repeated. */
const mismatch = (number: string, reason: string): CliResult<never> => failure(`PR ${number}: ${reason}`, CHECK_AGAIN);

const unreadable = (number: string): CliResult<never> =>
  failure(
    `gh could not read PR ${number}`,
    `Check that ${toolNames.gh} is installed and signed in to ${mergeCheck.host}, then run the command again.`,
  );

/** The PR number of a flag: one to nine digits, no leading zero. Anything else is a usage error. */
export const parsePrNumber = (text: string): CliResult<number> =>
  mergeCheck.prPattern.test(text)
    ? ok(Number(text))
    : usageError(`${flagText(flags.pr)}: must be a whole number of one to nine digits, with no leading zero`);

/**
 * `owner/name` of the repo of a project URL. Only a repo on the GitHub host passes. Any other URL is a failure, and no `gh` runs.
 * The message never repeats the URL, because a URL can hold a secret.
 */
export const githubRepoOf = (url: string): CliResult<string> => {
  const repo = parseGithubRepo(url);
  return repo === null
    ? failure(
        `the merge check reads repos on ${mergeCheck.host} only`,
        `Check that the url of the project is a ${mergeCheck.host} URL.`,
      )
    : ok(repo);
};

const isSha = (text: string): boolean => mergeCheck.shaPattern.test(text);

/**
 * Read the PR with `gh pr view` and check that it is the merged PR that the caller expects. Each of these is a failure (exit 1)
 * and nothing else passes: `gh` missing, not signed in, a non-zero exit, the time limit, output that is too long or not JSON of
 * the known shape, a state other than merged, no merge time, another number, another base, a PR from another repo, another head
 * branch, a url of another repo, and a sha that is not 40 lowercase hex digits. A PR number that breaks the form is a usage error
 * (exit 2) and `gh` does not run.
 */
export const readMergedPr = async (deps: Deps, input: MergeReadInput): Promise<CliResult<MergedRead>> => {
  const number = String(input.number);
  const checked = parsePrNumber(number);
  if (!checked.ok) return checked;
  const words = mergeCheck.words;
  const run = await deps.run(
    toolNames.gh,
    [words.group, words.verb, words.repoFlag, `${mergeCheck.host}/${input.repo}`, words.jsonFlag, mergeCheck.fieldList, words.endOfFlags, number],
    { timeoutMs: ghTimeoutMs },
  );
  if (!run.ok || run.value.exitCode !== 0) return unreadable(number);
  if (run.value.stdout.length > mergeCheck.maxOutputChars) return mismatch(number, 'the answer of gh is too long');
  const json = parseJsonText(run.value.stdout);
  const parsed = json.ok ? prSchema.safeParse(json.value) : null;
  if (parsed === null || !parsed.success) return mismatch(number, 'the answer of gh is not a PR record');
  const pr = parsed.data;
  const mergeCommit = pr[fields.mergeCommit]?.[mergeCheck.mergeCommitSha] ?? '';
  const head = pr[fields.headSha];
  const expectedUrl = `https://${mergeCheck.host}/${input.repo}/pull/${number}`;
  if (pr[fields.state] !== mergeCheck.mergedState) return mismatch(number, 'the PR is not merged');
  if ((pr[fields.mergedAt] ?? '') === '') return mismatch(number, 'the PR has no merge time');
  if (pr[fields.number] !== input.number) return mismatch(number, 'gh gave another PR');
  if (pr[fields.url].toLowerCase() !== expectedUrl.toLowerCase()) return mismatch(number, 'the PR is not in this repo');
  if (pr[fields.crossRepository]) return mismatch(number, 'the PR comes from another repo');
  if (pr[fields.baseBranch] !== input.base) return mismatch(number, 'the PR merged into another base branch');
  if (input.head !== undefined && pr[fields.headBranch] !== input.head) return mismatch(number, 'the PR comes from another head branch');
  if (!isSha(mergeCommit) || !isSha(head)) return mismatch(number, 'a commit of the PR is not a full sha');
  return ok({ kind: 'merged', pr: { number: input.number, mergeCommit, prHead: head } as MergedPr });
};
