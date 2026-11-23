import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { ok } from '../../src/core/result.js';
import { ghTimeoutMs } from '../../src/names.js';
import type { RecipeProject, WorkFacts, WorkHost } from '../../src/recipes/entry.js';
import { softwareGuardIds } from '../../src/recipes/software/guard-parts.js';
import { readinessFor, readinessOf, readinessPrSchema, type ReadinessPr } from '../../src/recipes/software/merge-ready.js';
import { recordedMergedPrs } from '../fixtures/merge-ready.js';
import { createFakeDeps, exited, missingProgram, type RunHandler } from '../helpers/fake-deps.js';
import { fakeWorkHost } from '../helpers/work-host.js';

const HEAD = 'a'.repeat(40);
const PROJECT: RecipeProject = { id: 'project', path: 'project', url: 'https://github.com/example/project.git', default_branch: 'main' };
const ITEM = { id: 'T-1', title: 'Test item', status: 'open', track: null, stage: null, record: {} };
const TARGET = { pr: 12, project: PROJECT };
const PASS = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' } as const;
const GOOD: ReadinessPr = {
  number: 12, url: 'https://github.com/example/project/pull/12', state: 'OPEN', isDraft: false,
  headRefOid: HEAD, headRefName: 'worker/example', baseRefName: 'main', isCrossRepository: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergedAt: null, statusCheckRollup: [PASS],
};
const WORK: WorkFacts = {
  project: PROJECT, cloneDir: '/node/project', mode: 'owner', openRequests: [], headConflict: null, branches: [GOOD.headRefName],
};
const VALID_HOST: Partial<WorkHost> = {
  find: async () => ok({ kind: 'found', item: ITEM }),
  facts: async () => ok(WORK),
};
const HOSTILE = 'UNTRUSTED_TEXT';
const notReady = (...reasons: string[]) => ({ kind: 'not-ready', reasons });

describe('readinessOf', () => {
  it('accepts a matching clean PR with passed checks and no open request', () => {
    expect(readinessOf({ pr: GOOD, behindBy: 0, record: { ...WORK, base: 'main' } })).toEqual({ kind: 'ready' });
  });

  it('accepts an empty review decision and a merge state of HAS_HOOKS', () => {
    const pr: ReadinessPr = { ...GOOD, reviewDecision: '', mergeStateStatus: 'HAS_HOOKS' };
    expect(readinessOf({ pr, behindBy: 0 })).toEqual({ kind: 'ready' });
  });

  it.each<[Partial<ReadinessPr>, string]>([
    [{ isDraft: true }, 'the PR is a draft'],
    [{ statusCheckRollup: null }, 'the PR has no checks'],
    [{ statusCheckRollup: [] }, 'the PR has no checks'],
    [{ statusCheckRollup: [PASS, { __typename: 'StatusContext', state: 'PENDING' }] }, 'the PR has pending checks'],
    [{ statusCheckRollup: [PASS, { ...PASS, conclusion: 'FAILURE' }] }, 'the PR has failed checks'],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, 'the review requires changes'],
    [{ reviewDecision: 'REVIEW_REQUIRED' }, 'the PR needs a review'],
    [{ mergeStateStatus: 'DIRTY' }, 'the merge state is DIRTY'],
    [{ mergeStateStatus: 'BLOCKED' }, 'the merge state is BLOCKED'],
    [{ mergeStateStatus: 'BEHIND' }, 'the merge state is BEHIND'],
    [{ mergeStateStatus: 'UNSTABLE' }, 'the merge state is UNSTABLE'],
    [{ mergeStateStatus: 'DRAFT' }, 'the merge state is DRAFT'],
    [{ mergeable: 'CONFLICTING' }, 'the PR has merge conflicts'],
    [{ state: 'CLOSED' }, 'the PR is closed'],
    [{ state: 'MERGED', mergedAt: '2026-11-23T00:18:48Z' }, 'the PR is already merged'],
  ])('gives the fixed reason for %j', (change, reason) => {
    expect(readinessOf({ pr: { ...GOOD, ...change }, behindBy: 0 })).toEqual(notReady(reason));
  });

  it('lists failed and pending checks when both apply', () => {
    const pr: ReadinessPr = { ...GOOD, statusCheckRollup: [{ ...PASS, conclusion: 'FAILURE' }, { ...PASS, status: 'QUEUED' }] };
    expect(readinessOf({ pr, behindBy: 0 })).toEqual(notReady('the PR has failed checks', 'the PR has pending checks'));
  });
});

interface Answer {
  readonly view?: Record<string, unknown>;
  readonly compare?: RunHandler;
  readonly host?: Partial<WorkHost>;
  readonly target?: Parameters<typeof readinessFor>[2];
}

const runWith = ({ view = GOOD, compare = () => exited(0, '{"behind_by":0}'), host, target = TARGET }: Answer = {}) => {
  const order: string[] = [];
  const deps = createFakeDeps({ run: (call) => {
    order.push(call.args[0] ?? 'no argument');
    return call.args[0] === 'pr' ? exited(0, JSON.stringify(view)) : compare(call);
  } });
  const { work, calls } = fakeWorkHost({ ...VALID_HOST, ...host });
  const result = readinessFor(deps, {
    guards: work.guards,
    find: (query) => { order.push('find'); return work.find(query); },
    facts: (link) => { order.push('facts'); return work.facts(link); },
  }, target);
  return { result, order, deps, calls };
};

const withFacts = (change: Partial<WorkFacts>): Partial<WorkHost> => ({ facts: async () => ok({ ...WORK, ...change }) });

const expectUnreadable = async (result: ReturnType<typeof readinessFor>, cause: string) => {
  const value = await result;
  expect(value).toMatchObject({ kind: 'unreadable', cause });
  expect(JSON.stringify(value)).not.toContain(HOSTILE);
};

describe('readinessFor', () => {
  it('reads the view, compare, item and facts in that order, with a single read at each step', async () => {
    const { result, order, calls, deps } = runWith();
    expect(await result).toEqual({ kind: 'ready', pr: GOOD, repo: 'example/project', item: ITEM, facts: WORK });
    expect(order).toEqual(['pr', 'api', 'find', 'facts']);
    expect(deps.calls[0]).toMatchObject({ command: 'gh', args: [
      'pr', 'view', '--repo', 'github.com/example/project', '--json',
      'number,url,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,mergedAt,statusCheckRollup',
      '--', '12',
    ], timeoutMs: ghTimeoutMs });
    expect(calls).toEqual([
      ['find', { point: 'merge', ref: '12', branch: GOOD.headRefName }],
      ['facts', { item: ITEM.id, point: 'merge', ref: '12', head: HEAD, project: PROJECT.id }],
    ]);
  });

  it.each(recordedMergedPrs)('gives the manual verdict at the recorded head of PR $view.number', async ({ view, compare }) => {
    const sanitizedView = { ...view, url: `https://github.com/example/project/pull/${view.number}`, headRefName: GOOD.headRefName };
    expect(readinessPrSchema.safeParse(sanitizedView).success).toBe(true);
    const { result, order } = runWith({ view: sanitizedView, compare: () => exited(0, JSON.stringify(compare)), target: { ...TARGET, pr: view.number } });
    expect(await result).toEqual(notReady(
      'the PR is already merged', 'GitHub has not determined if the PR can merge. Run check again.',
      'GitHub has not determined the merge state. Run check again.', 'the PR is behind its base branch',
    ));
    expect(order).toEqual(['pr', 'api']);
  });

  it('refuses a PR that is behind the base per the compare read', async () => {
    const { result } = runWith({ compare: () => exited(0, '{"behind_by":1}') });
    expect(await result).toEqual(notReady('the PR is behind its base branch'));
  });

  const failedCompares: readonly RunHandler[] = [
    () => missingProgram(HOSTILE), () => exited(1, HOSTILE, HOSTILE), () => exited(0, HOSTILE),
    () => exited(0, '{"behind_by":-1}'), () => exited(0, '{"behind_by":0.5}'),
    () => exited(0, '{"behind_by":"0"}'), () => exited(0, '{"behind_by":0,"extra":true}'),
    () => exited(0, `${' '.repeat(1024)}{"behind_by":0}`),
  ];
  it.each(failedCompares)('reports an invalid compare answer as unreadable and does not read the board', async (compare) => {
    const { result, order } = runWith({ compare });
    await expectUnreadable(result, 'could not read how far the PR is behind its base branch');
    expect(order).toEqual(['pr', 'api']);
  });

  it.each<[Partial<ReadinessPr>, string]>([
    [{ mergeable: 'UNKNOWN' }, 'GitHub has not determined if the PR can merge. Run check again.'],
    [{ mergeStateStatus: 'UNKNOWN' }, 'GitHub has not determined the merge state. Run check again.'],
  ])('refuses %j with a run-again remedy and does not repeat the view', async (change, reason) => {
    const { result, order } = runWith({ view: { ...GOOD, ...change } });
    expect(await result).toEqual(notReady(reason));
    expect(order).toEqual(['pr', 'api']);
  });

  it('accepts 99 passed checks', async () => {
    const { result } = runWith({ view: { ...GOOD, statusCheckRollup: Array.from({ length: 99 }, () => PASS) } });
    expect(await result).toMatchObject({ kind: 'ready' });
  });

  it.each([100, 101])('refuses an incomplete rollup of %i check contexts', async (length) => {
    const { result } = runWith({ view: { ...GOOD, statusCheckRollup: Array.from({ length }, () => PASS) } });
    expect(await result).toEqual(notReady('the PR has 100 or more check contexts'));
  });

  it.each([
    { futureField: HOSTILE }, { state: HOSTILE }, { mergeable: HOSTILE }, { mergeStateStatus: HOSTILE }, { reviewDecision: HOSTILE },
    { mergedAt: HOSTILE }, { headRefOid: 'a'.repeat(39) }, { headRefName: HOSTILE.repeat(30) },
    { statusCheckRollup: [{ ...PASS, status: HOSTILE }] }, { statusCheckRollup: [], url: HOSTILE.repeat(21_000) },
  ])('refuses an invalid view without repeating the answer', async (change) => {
    const { result, order } = runWith({ view: { ...GOOD, ...change } });
    await expectUnreadable(result, 'could not read the PR facts');
    expect(order).toEqual(['pr']);
  });

  it.each<[Partial<ReadinessPr>, string]>([
    [{ number: 13 }, 'gh gave another PR'],
    [{ url: 'https://github.com/example/other/pull/12' }, 'the PR is not in this repo'],
    [{ isCrossRepository: true }, 'the PR comes from another repo'],
  ])('refuses another PR identity for %j with pr-rules off', async (change, reason) => {
    const { result, order } = runWith({ view: { ...GOOD, ...change }, host: { guards: { [softwareGuardIds.prRules]: 'off' } } });
    expect(await result).toEqual(notReady(reason));
    expect(order).toEqual(['pr']);
  });

  it.each(['a..b', 'a//b', 'a/./b', 'a\u001fb', 'a?b', 'a'.repeat(256)])('does not pass an invalid base ref to gh', async (baseRefName) => {
    const { result, order } = runWith({ view: { ...GOOD, baseRefName } });
    expect(await result).toEqual(notReady('the PR base branch name is invalid'));
    expect(order).toEqual(['pr']);
  });

  it('uses a fixed GET and encodes a slash in the compare base ref', async () => {
    const { result, deps } = runWith({ view: { ...GOOD, baseRefName: 'release/next' } });
    expect(await result).toEqual(notReady('the PR targets another base branch'));
    expect(deps.calls[1]).toMatchObject({ command: 'gh', args: [
      'api', '--hostname', 'github.com', '--method', 'GET', `repos/example/project/compare/release%2Fnext...${HEAD}?per_page=1`, '--jq', '{behind_by}',
    ], timeoutMs: ghTimeoutMs });
  });

  it('accepts another base branch only with pr-rules off', async () => {
    const { result } = runWith({ view: { ...GOOD, baseRefName: 'other' }, host: { guards: { [softwareGuardIds.prRules]: 'off' } } });
    expect(await result).toMatchObject({ kind: 'ready' });
  });

  it.each<[Partial<WorkFacts>, string]>([
    [{ branches: ['worker/other'] }, 'the PR comes from another head branch'],
    [{ branches: undefined }, 'the PR comes from another head branch'],
    [{ openRequests: ['A-1'] }, 'the item or PR has an open request'],
    [{ headConflict: 'the item T-2 records the head of this check already' }, 'the item T-2 records the head of this check already'],
    [{ headConflict: 'T-1 records another head already' }, 'T-1 records another head already'],
  ])('refuses the board facts for %j', async (change, reason) => {
    const { result } = runWith({ host: withFacts(change) });
    expect(await result).toEqual(notReady(reason));
  });

  it('reports a lookup refusal without a facts read', async () => {
    const cause = 'several items link to the reference';
    const { result, order } = runWith({ host: { find: async () => ok({ kind: 'lookup', cause }) } });
    expect(await result).toEqual({ kind: 'lookup', cause });
    expect(order).toEqual(['pr', 'api', 'find']);
  });

  it.each(['find', 'facts'] as const)('gives a fixed reason for an ordinary fault from %s', async (step) => {
    const { result, order } = runWith({ host: { [step]: async () => failure('the link is invalid', 'Check the link.') } });
    expect(await result).toEqual({ kind: 'unreadable', cause: 'could not read the work item or its requests', safety: false });
    expect(order.at(-1)).toBe(step);
  });

  it('does not run gh with a short pin', async () => {
    const { result, order } = runWith({ target: { ...TARGET, head: HEAD.slice(0, 7) } });
    await expectUnreadable(result, 'the head is not a full SHA');
    expect(order).toEqual([]);
  });

  it('does not run gh for a project URL on another host', async () => {
    const project = { ...PROJECT, url: `https://example.net/${HOSTILE}/project` };
    const { result, order } = runWith({ target: { ...TARGET, project } });
    await expectUnreadable(result, 'the project does not name a repo on github.com');
    expect(order).toEqual([]);
  });

  it('does not bind a PR to an item in another repo', async () => {
    const project = { ...PROJECT, url: 'https://github.com/example/other' };
    const { result } = runWith({ host: withFacts({ project }) });
    await expectUnreadable(result, 'the project of the item does not match the PR project');
  });

  it('refuses a mismatch with the pinned head before other reads', async () => {
    const { result, order } = runWith({ target: { ...TARGET, head: 'b'.repeat(40) } });
    expect(await result).toEqual({ kind: 'head-moved', head: HEAD });
    expect(order).toEqual(['pr']);
  });

  it('pins a merged PR to its item and skips checks that only apply before merge', async () => {
    const view = { ...GOOD, state: 'MERGED', mergedAt: '2026-11-23T00:18:48Z', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
    const { result, order } = runWith({ view, target: { ...TARGET, head: HEAD } });
    expect(await result).toMatchObject({ kind: 'merged-at-pin', pr: view, item: ITEM });
    expect(order).toEqual(['pr', 'find', 'facts']);
  });

  it('does not accept a merged PR without the merge time at its pinned head', async () => {
    const { result, order } = runWith({ view: { ...GOOD, state: 'MERGED' }, target: { ...TARGET, head: HEAD } });
    await expectUnreadable(result, 'the merged PR has no merge time');
    expect(order).toEqual(['pr']);
  });
});
