import { z } from 'zod';
import { failure, usageError, type CliResult } from '../../cli/errors.js';
import type { Deps } from '../../core/deps.js';
import { parseGithubRepo } from '../../core/git.js';
import { ok } from '../../core/result.js';
import { toolNames } from '../../core/tools.js';
import { flags, flagText, ghTimeoutMs } from '../../names.js';
import { parseJsonText } from '../../state/load.js';

/*
 * The merge check is a guard against a mistake, not a proof. The session that runs it controls PATH and the environment, so it
 * can put another `gh` in front of the real one. The check stops a wrong PR number, a PR that is not merged and a PR of another
 * branch. It does not stop a session that wants to deceive the board.
 */

/**
 * The answer of `gh pr view --json`: the nine fields that the merge check reads, under the names that `gh` gives them. A key that
 * the check does not know, or a missing key, fails the parse. The keys are the list that `gh` is asked for (`mergeCheck.fieldList`).
 */
const prSchema = z.strictObject({
  number: z.number(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  url: z.string(),
});

/**
 * The merge check, which reads one PR with `gh pr view`. The PR number has one to nine digits and no leading zero. A sha has 40
 * lowercase hex digits. `fieldList` is the list that the `--json` option takes. `words` are the arguments of `gh`: its JSON flag
 * is spelled as the JSON flag of this program. Only a PR in the state `mergedState` on `host` passes. `maxOutputChars` bounds the
 * output that is read.
 */
export const mergeCheck = {
  host: 'github.com',
  mergedState: 'MERGED',
  prPattern: /^[1-9][0-9]{0,8}$/,
  shaPattern: /^[0-9a-f]{40}$/,
  maxOutputChars: 16_384,
  fieldList: Object.keys(prSchema.shape).join(','),
  words: { command: 'pr view', repoFlag: '--repo', jsonFlag: flagText(flags.json), endOfFlags: '--' },
} as const;

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
    : usageError(`${flagText(flags.ref)}: must be a whole number of one to nine digits, with no leading zero`);

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
    [...words.command.split(' '), words.repoFlag, `${mergeCheck.host}/${input.repo}`, words.jsonFlag, mergeCheck.fieldList, words.endOfFlags, number],
    { timeoutMs: ghTimeoutMs },
  );
  if (!run.ok || run.value.exitCode !== 0) return unreadable(number);
  if (run.value.stdout.length > mergeCheck.maxOutputChars) return mismatch(number, 'the answer of gh is too long');
  const json = parseJsonText(run.value.stdout);
  const parsed = json.ok ? prSchema.safeParse(json.value) : null;
  if (parsed === null || !parsed.success) return mismatch(number, 'the answer of gh is not a PR record');
  const pr = parsed.data;
  const mergeCommit = pr.mergeCommit?.oid ?? '';
  const head = pr.headRefOid;
  const expectedUrl = `https://${mergeCheck.host}/${input.repo}/pull/${number}`;
  if (pr.state !== mergeCheck.mergedState) return mismatch(number, 'the PR is not merged');
  if ((pr.mergedAt ?? '') === '') return mismatch(number, 'the PR has no merge time');
  if (pr.number !== input.number) return mismatch(number, 'gh gave another PR');
  if (pr.url.toLowerCase() !== expectedUrl.toLowerCase()) return mismatch(number, 'the PR is not in this repo');
  if (pr.isCrossRepository) return mismatch(number, 'the PR comes from another repo');
  if (pr.baseRefName !== input.base) return mismatch(number, 'the PR merged into another base branch');
  if (input.head !== undefined && pr.headRefName !== input.head) return mismatch(number, 'the PR comes from another head branch');
  if (!isSha(mergeCommit) || !isSha(head)) return mismatch(number, 'a commit of the PR is not a full sha');
  return ok({ kind: 'merged', pr: { number: input.number, mergeCommit, prHead: head } as MergedPr });
};
