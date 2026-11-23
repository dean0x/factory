import { z } from 'zod';
import type { BoardItem } from '../../board/contract.js';
import type { CliError } from '../../cli/errors.js';
import type { Deps } from '../../core/deps.js';
import { parseGithubRepo, remoteDefaultBranchOf } from '../../core/git.js';
import { isGuardOn } from '../../guards/effective.js';
import { readinessKinds, requestWords } from '../../names.js';
import type { RecipeProject, WorkFacts, WorkHost } from '../entry.js';
import { softwareApprovalPoints } from './approval.js';
import { checkSchema, countsOf } from './check-runs.js';
import { compareBaseSchema, headBranchReason, mergeCheck, otherPrReason, runCompare, runPrView } from './github-pr.js';
import { softwareGuardIds } from './guard-parts.js';

const MAX_VIEW_CHARS = 262_144;
const CHECK_LIMIT = 100;
const TOO_MANY_CHECKS = `the PR has ${CHECK_LIMIT} or more check contexts`;
const MERGE_POINT = softwareApprovalPoints[0].id;
const prState = z.enum(['OPEN', 'CLOSED', 'MERGED']);

/** Read only the fields the merge work uses. Check details not used by the classifier are stripped. */
export const readinessPrSchema = z.strictObject({
  number: z.int().min(1).max(999_999_999),
  url: z.string().min(1).max(512),
  state: prState,
  isDraft: z.boolean(),
  headRefOid: z.string().regex(mergeCheck.shaPattern),
  headRefName: z.string().min(1).max(255),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.enum(['CLEAN', 'HAS_HOOKS', 'DIRTY', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'DRAFT', 'UNKNOWN']),
  reviewDecision: z.enum(['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
  mergedAt: z.iso.datetime().nullable(),
  statusCheckRollup: z.array(checkSchema).max(CHECK_LIMIT).nullable(),
});

export type ReadinessPr = z.infer<typeof readinessPrSchema>;
export const readinessView = { fields: Object.keys(readinessPrSchema.shape).join(','), maxOutputChars: MAX_VIEW_CHARS } as const;

type NotReady = { readonly kind: typeof readinessKinds.notReady; readonly reasons: readonly string[] };
type Verdict = { readonly kind: typeof readinessKinds.ready } | NotReady;
type Unreadable = { readonly kind: typeof readinessKinds.unreadable; readonly cause: string; readonly remedy?: string };
type WorkLookup = { readonly kind: typeof readinessKinds.lookup; readonly cause: string };
type PrRead = { readonly kind: 'read'; readonly pr: ReadinessPr } | NotReady | Unreadable;

interface BoundWork {
  readonly pr: ReadinessPr;
  readonly repo: string;
  readonly item: BoardItem;
  readonly facts: WorkFacts;
}

export type Readiness =
  | ({ readonly kind: typeof readinessKinds.ready } & BoundWork)
  | NotReady
  | { readonly kind: typeof readinessKinds.headMoved; readonly head: string }
  | ({ readonly kind: typeof readinessKinds.mergedAtPin } & BoundWork)
  | Unreadable
  | WorkLookup;

interface RecordFacts extends Pick<WorkFacts, 'branches' | 'headConflict' | 'openRequests'> {
  /** Omit the base rule when the PR rule is off. */
  readonly base: string | undefined;
}

export interface ReadinessFacts {
  readonly pr: ReadinessPr;
  readonly behindBy: number;
  readonly record?: RecordFacts;
}

export interface ReadinessTarget {
  readonly pr: number;
  readonly head?: string | undefined;
  readonly project: RecipeProject;
}

type ReadinessHost = Pick<WorkHost, 'guards' | 'find' | 'facts'>;

const notReady = (...reasons: readonly string[]): NotReady => ({ kind: readinessKinds.notReady, reasons });
const unreadable = (cause: string, remedy?: string): Unreadable =>
  ({ kind: readinessKinds.unreadable, cause, ...(remedy === undefined ? {} : { remedy }) });
const readFault = ({ message, hint }: CliError): Unreadable => unreadable(message, hint);

const stateReasonOf = (state: z.infer<typeof prState>): string | null => {
  switch (state) {
    case 'OPEN': return null;
    case 'CLOSED': return 'the PR is closed';
    case 'MERGED': return 'the PR is already merged';
    default: return state satisfies never;
  }
};

const reviewReasonOf = (review: ReadinessPr['reviewDecision']): string | null => {
  switch (review) {
    case '':
    case 'APPROVED': return null;
    case 'CHANGES_REQUESTED': return 'the review requires changes';
    case 'REVIEW_REQUIRED': return 'the PR needs a review';
    default: return review satisfies never;
  }
};

const conflictReasonOf = (mergeable: ReadinessPr['mergeable']): string | null => {
  switch (mergeable) {
    case 'MERGEABLE': return null;
    case 'CONFLICTING': return 'the PR has merge conflicts';
    case 'UNKNOWN': return 'GitHub has not determined if the PR can merge. Run check again.';
    default: return mergeable satisfies never;
  }
};

const mergeReasonOf = (state: ReadinessPr['mergeStateStatus']): string | null => {
  switch (state) {
    case 'CLEAN':
    case 'HAS_HOOKS': return null;
    case 'DIRTY':
    case 'BLOCKED':
    case 'BEHIND':
    case 'UNSTABLE':
    case 'DRAFT': return `the merge state is ${state}`;
    case 'UNKNOWN': return 'GitHub has not determined the merge state. Run check again.';
    default: return state satisfies never;
  }
};

const checkReasonsOf = (checks: ReadinessPr['statusCheckRollup']): readonly string[] => {
  if (checks === null || checks.length === 0) return ['the PR has no checks'];
  if (checks.length >= CHECK_LIMIT) return [TOO_MANY_CHECKS];
  const { failed, pending } = countsOf(checks);
  return [
    ...(failed > 0 ? ['the PR has failed checks'] : []),
    ...(pending > 0 ? ['the PR has pending checks'] : []),
  ];
};

const recordReasonsOf = (pr: ReadinessPr, record: RecordFacts): readonly (string | null)[] => [
  record.base !== undefined && record.base !== pr.baseRefName ? 'the PR targets another base branch' : null,
  headBranchReason(pr.headRefName, record.branches ?? []),
  record.openRequests.length > 0 ? `the item or PR has an open ${requestWords.request}` : null,
  record.headConflict,
];

const verdictOf = (reasons: readonly (string | null)[]): Verdict => {
  const present = reasons.filter((reason) => reason !== null);
  return present.length === 0 ? { kind: readinessKinds.ready } : notReady(...present);
};

/** Judge the PR with the compare result and, when supplied, the facts of its item. */
export const readinessOf = ({ pr, behindBy, record }: ReadinessFacts): Verdict => verdictOf([
  stateReasonOf(pr.state),
  pr.isDraft ? 'the PR is a draft' : null,
  ...checkReasonsOf(pr.statusCheckRollup),
  reviewReasonOf(pr.reviewDecision),
  conflictReasonOf(pr.mergeable),
  mergeReasonOf(pr.mergeStateStatus),
  behindBy > 0 ? 'the PR is behind its base branch' : null,
  ...(record === undefined ? [] : recordReasonsOf(pr, record)),
]);

/** Distinguish a full rollup from a malformed reply. A partial list of checks never passes. */
const prOf = (value: unknown): PrRead => {
  const parsed = readinessPrSchema.safeParse(value);
  if (parsed.success) {
    return (parsed.data.statusCheckRollup?.length ?? 0) >= CHECK_LIMIT
      ? notReady(TOO_MANY_CHECKS) : { kind: 'read', pr: parsed.data };
  }
  const tooMany = parsed.error.issues.some(({ code, path }) => code === 'too_big' && path.length === 1 && path[0] === 'statusCheckRollup');
  return tooMany ? notReady(TOO_MANY_CHECKS) : unreadable('could not read the PR facts');
};

type BoundRead = { readonly kind: 'bound'; readonly value: BoundWork } | Unreadable | WorkLookup;

const bindWork = async (work: ReadinessHost, target: ReadinessTarget, repo: string, pr: ReadinessPr): Promise<BoundRead> => {
  const ref = String(pr.number);
  const found = await work.find({ point: MERGE_POINT, ref, branch: pr.headRefName });
  if (!found.ok) return readFault(found.error);
  const lookup = found.value;
  switch (lookup.kind) {
    case readinessKinds.lookup: return lookup;
    case 'found': {
      const { item } = lookup;
      const facts = await work.facts({ item: item.id, point: MERGE_POINT, ref, head: pr.headRefOid, project: target.project.id });
      if (!facts.ok) return readFault(facts.error);
      const itemRepo = parseGithubRepo(facts.value.project.url ?? '');
      if (facts.value.project.id !== target.project.id || itemRepo?.toLowerCase() !== repo.toLowerCase()) {
        return unreadable('the project of the item does not match the PR project');
      }
      return { kind: 'bound', value: { pr, repo, item, facts: facts.value } };
    }
    default: return lookup satisfies never;
  }
};

const recordVerdict = async (deps: Deps, work: ReadinessHost, bound: BoundWork, merged: boolean): Promise<Verdict | Unreadable> => {
  const { pr, facts } = bound;
  let base: string | undefined;
  if (isGuardOn(work.guards, softwareGuardIds.prRules)) {
    const branch = facts.project.default_branch ?? await remoteDefaultBranchOf(deps, facts.cloneDir);
    if (branch === null) return unreadable('the project has no default branch');
    base = branch;
  }
  // The locked record flow checks approval on the rerun. An open request is a readiness rule for new merges only.
  return verdictOf(recordReasonsOf(pr, { ...facts, base, openRequests: merged ? [] : facts.openRequests }));
};

/** Read one view, check its identity and base name, then compare, find and read the facts. Never retry. */
export const readinessFor = async (deps: Deps, work: ReadinessHost, target: ReadinessTarget): Promise<Readiness> => {
  const repo = parseGithubRepo(target.project.url ?? '');
  if (repo === null) return unreadable(`the project does not name a repo on ${mergeCheck.host}`);
  const number = String(target.pr);
  if (!mergeCheck.prPattern.test(number)) return unreadable('the PR number is invalid');
  if (target.head !== undefined && !mergeCheck.shaPattern.test(target.head)) return unreadable('the head is not a full SHA');

  const view = await runPrView(deps, { repo, number, ...readinessView });
  if (view.kind !== 'parsed') return unreadable('could not read the PR facts');
  const read = prOf(view.value);
  if (read.kind !== 'read') return read;
  const { pr } = read;
  const other = otherPrReason(pr, { repo, number: target.pr });
  if (other !== null) return notReady(other);
  if (target.head !== undefined && target.head !== pr.headRefOid) return { kind: readinessKinds.headMoved, head: pr.headRefOid };
  const base = compareBaseSchema.safeParse(pr.baseRefName);
  if (!base.success) return notReady('the PR base branch name is invalid');

  const merged = pr.state === 'MERGED' && target.head !== undefined;
  if (merged) {
    if (pr.mergedAt === null) return unreadable('the merged PR has no merge time');
  } else {
    const compare = await runCompare(deps, { repo, base: base.data, head: pr.headRefOid });
    if (!compare.ok) return readFault(compare.error);
    const verdict = readinessOf({ pr, behindBy: compare.value });
    if (verdict.kind === readinessKinds.notReady) return verdict;
  }

  const bound = await bindWork(work, target, repo, pr);
  if (bound.kind !== 'bound') return bound;
  const verdict = await recordVerdict(deps, work, bound.value, merged);
  if (verdict.kind !== readinessKinds.ready) return verdict;
  return { kind: merged ? readinessKinds.mergedAtPin : readinessKinds.ready, ...bound.value };
};
