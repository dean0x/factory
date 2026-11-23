import { failure, usageError, type CliResult } from '../../cli/errors.js';
import type { Deps } from '../../core/deps.js';
import { parseGithubRepo } from '../../core/git.js';
import { ok } from '../../core/result.js';
import { toolNames } from '../../core/tools.js';
import { commands, commandText, flags, flagText } from '../../names.js';
import { mergeCheck, parsePrNumber, runPrView } from './github-pr.js';
import { readinessPrSchema, readinessView } from './merge-ready.js';
import { mergeMethod, prMergeCommand, prMergeLimits, type mergeMethods } from './words.js';

const GH_MERGE = 'pr merge'.split(' ');

export interface MergeTarget {
  /** The owner and repo name from the readiness read. */
  readonly repo: string;
  readonly number: number;
  readonly head: string;
}

export interface MergeRequest extends MergeTarget {
  readonly method: (typeof mergeMethods)[number];
  readonly admin: boolean;
}

export type MergeConfirmation =
  | { readonly kind: 'merged'; readonly mergeCommit: string | null }
  | { readonly kind: 'not-merged' }
  | { readonly kind: 'head-moved'; readonly head: string }
  | { readonly kind: 'unknown' };

const targetNumber = ({ repo, number, head }: MergeTarget): CliResult<string> => {
  // Add the Git suffix so that a repo name that ends in .git also makes the round trip.
  if (parseGithubRepo(`https://${mergeCheck.host}/${repo}.git`) !== repo) {
    return usageError(
      'The repo name is not valid for GitHub.',
      `Check the project URL. Run "${commandText(commands.doctor)}" to check the config.`,
    );
  }
  const text = String(number);
  const parsed = parsePrNumber(text, 'PR number');
  if (!parsed.ok) return parsed;
  if (!mergeCheck.shaPattern.test(head)) {
    return usageError(
      'The head must be a full commit id of 40 lowercase hex digits.',
      `Give the full PR head. Run "${prMergeCommand} ${flagText(flags.help)}" to see the options.`,
    );
  }
  return ok(text);
};

const invalidMethod = (_method: never): CliResult<never> => usageError(
  'The merge method is invalid.',
  `Check the project merge method. Run "${commandText(commands.doctor)}" to check the config.`,
);

const methodFlagOf = (method: MergeRequest['method']): CliResult<string> => {
  switch (method) {
    case mergeMethod.squash: return ok('--squash');
    case mergeMethod.merge: return ok('--merge');
    case mergeMethod.rebase: return ok('--rebase');
    default: return invalidMethod(method satisfies never);
  }
};

/** Check the target again at the write boundary. Always pin the merge to the full head. */
export const mergeArgv = (request: MergeRequest): CliResult<readonly string[]> => {
  const number = targetNumber(request);
  if (!number.ok) return number;
  const method = methodFlagOf(request.method);
  if (!method.ok) return method;
  const { repoFlag, endOfFlags } = mergeCheck.words;
  return ok([
    ...GH_MERGE, repoFlag, `${mergeCheck.host}/${request.repo}`, '--match-head-commit', request.head, method.value,
    ...(request.admin === true ? ['--admin'] : []), endOfFlags, number.value,
  ]);
};

/** Start at most one write. The exit code describes the call, not the PR state. */
export const runMerge = async (deps: Pick<Deps, 'run'>, request: MergeRequest): Promise<CliResult<void>> => {
  const argv = mergeArgv(request);
  if (!argv.ok) return argv;
  const run = await deps.run(toolNames.gh, argv.value, { timeoutMs: prMergeLimits.mergeTimeoutMs });
  return run.ok && run.value.exitCode === 0 ? ok(undefined)
    : failure(
      'gh could not complete the merge call.',
      `Run "${commandText(commands.check)} ${request.number}" to check the PR state before a new merge call.`,
    );
};

const confirmationSchema = readinessPrSchema.pick({ state: true, mergedAt: true, headRefOid: true, mergeCommit: true });
const confirmationView = { ...readinessView, fields: Object.keys(confirmationSchema.shape).join(',') };

/** The last read decides unless a merge or a head change ends the reads early. */
export const confirmMerged = async (deps: Deps, target: MergeTarget): Promise<MergeConfirmation> => {
  const number = targetNumber(target);
  if (!number.ok) return { kind: 'unknown' };
  let last: MergeConfirmation = { kind: 'unknown' };
  for (let read = 0; read < prMergeLimits.mergeRereads; read += 1) {
    if (read > 0) await deps.sleep(prMergeLimits.mergeRereadMs);
    const view = await runPrView(deps, { repo: target.repo, number: number.value, ...confirmationView });
    const parsed = view.kind === 'parsed' ? confirmationSchema.safeParse(view.value) : null;
    last = { kind: 'unknown' };
    if (parsed?.success !== true) continue;
    const { state, headRefOid, mergedAt, mergeCommit } = parsed.data;
    if (headRefOid !== target.head) return { kind: 'head-moved', head: headRefOid };
    if (state === mergeCheck.mergedState && mergedAt !== null) return { kind: 'merged', mergeCommit: mergeCommit?.oid ?? null };
    if (state === 'OPEN') last = { kind: 'not-merged' };
  }
  return last;
};
