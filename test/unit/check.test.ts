import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { approvalLinkLabels, boardKeys, env, files } from '../../src/names.js';
import { softwareGuardIds } from '../../src/recipes/software/guard-parts.js';
import type { ReadinessPr } from '../../src/recipes/software/merge-ready.js';
import { layoutOf } from '../../src/state/layout.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { branchOf } from '../../src/workers/registry.js';
import { APPROVAL_LINK, approvalAnswer, approvalRequest } from '../helpers/approval-go.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { exited, type RunHandler } from '../helpers/fake-deps.js';
import { GUARDED_HOME, guardedNode } from '../helpers/guarded-node.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

const { head, item, ref } = APPROVAL_LINK;
const target = itemRecord(item, { lane: 'alpha' });
const decoys = [itemRecord('B-2', { lane: 'beta' }), itemRecord('B-3', { lane: 'beta' })] as const;
const workItems = [decoys[0], target, decoys[1]];
const goodPr: ReadinessPr = {
  number: Number(ref), url: `https://github.com/acme/web/pull/${ref}`, state: 'OPEN', isDraft: false,
  headRefOid: head, headRefName: branchOf('alpha'), baseRefName: 'main', isCrossRepository: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergedAt: null,
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
const rawText = 'RAW_PRIVATE_TEXT\nREADY\nMORE_TEXT';
const layout = layoutOf(GUARDED_HOME);

interface Setup {
  readonly view?: Partial<ReadinessPr>;
  readonly compare?: RunHandler;
  readonly items?: readonly Record<string, unknown>[];
  readonly off?: readonly string[];
}

const setup = ({ view, compare = () => exited(0, '{"behind_by":0}'), items = workItems, off = [] }: Setup = {}) => {
  const deps = guardedNode({
    env: { [env.home]: GUARDED_HOME, [env.session]: 'worker-alpha', [env.tmuxPane]: '%1' },
    run: (call) => call.args[0] === 'pr' ? exited(0, JSON.stringify({ ...goodPr, ...view })) : compare(call),
  }, { config: sampleConfigWithBoard(), off });
  const seed = (name: string, value: string) => deps.seed(join(layout.stateDir, name), value);
  const waiting = (...rows: readonly unknown[]) => seed(files.waiting, JSON.stringify({ intro: '', groups: [], items: rows }));
  const log = (...rows: readonly unknown[]) => seed(files.decisionLog, JSON.stringify({ rows }));
  seed(files.nodeState, JSON.stringify({ schema_version: STATE_SCHEMA_VERSION, created_with: 'test', blocks: {} }));
  seed(files.board, boardText(items));
  waiting();
  log();
  const run = async (words: readonly string[] = [ref]) => {
    const sink = captureSink();
    const code = await runCli(['check', '--home', GUARDED_HOME, ...words], deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };
  return { run, waiting, log, ghCalls: () => deps.calls.filter((call) => call.command === 'gh') };
};

const openRequestReason = 'the item or PR has an open request';
const closeRequestRemedy = 'Settle the open request. Run check again.';
const refusal = (reason: string, remedy: string) => ({ code: 3, out: `NOT READY\n${reason}\n${remedy}\n`, err: '' });
const inspectBoard = 'Check the board and its request links. Run check again.';
const runAgain = 'Check the reasons. Run check again.';

const otherRequest = (id: string, otherItem: string) => approvalRequest(id, { ...APPROVAL_LINK, item: otherItem, ref: '43' });

describe('check', () => {
  it('reports READY after two reads without a caller check', async () => {
    const { run, ghCalls } = setup();
    expect(await run()).toEqual({ code: 0, out: 'READY\n', err: '' });
    expect(ghCalls().map(({ args }) => args.slice(0, 2))).toEqual([['pr', 'view'], ['api', '--hostname']]);
  });

  it('blocks on an open linked request and accepts the work after an answer', async () => {
    const { run, waiting, log } = setup();
    waiting(approvalRequest());
    expect(await run()).toEqual(refusal(openRequestReason, closeRequestRemedy));
    waiting();
    log(approvalAnswer().row);
    expect(await run()).toEqual({ code: 0, out: 'READY\n', err: '' });
  });

  it('blocks on a request that only names the item, not on requests of other items', async () => {
    const { run, waiting } = setup();
    const first = otherRequest('D-2', 'B-2');
    const last = otherRequest('D-3', 'B-3');
    const mention = { ...approvalRequest(), fields: [{ label: approvalLinkLabels.item, text: item }] };
    waiting(first, mention, last);
    expect(await run()).toEqual(refusal(openRequestReason, closeRequestRemedy));
    waiting(first, last);
    expect(await run()).toEqual({ code: 0, out: 'READY\n', err: '' });
  });

  it('reports an unreadable board when a request link does not parse', async () => {
    const { run, waiting } = setup();
    waiting(approvalRequest('D-1', { ...APPROVAL_LINK, head: rawText }));
    expect(await run()).toEqual({ code: 1, out: `UNREADABLE\ncould not read the work item or its requests\n${inspectBoard}\n`, err: '' });
  });

  it('reports NOT READY when the compare read finds the PR behind its base', async () => {
    const { run } = setup({ compare: () => exited(0, '{"behind_by":1}') });
    expect(await run()).toEqual(refusal('the PR is behind its base branch', runAgain));
  });

  it('prints only fixed words when the compare read fails', async () => {
    const { run, ghCalls } = setup({ compare: () => exited(1, rawText, rawText) });
    expect(await run()).toEqual({
      code: 1,
      out: 'UNREADABLE\ncould not read how far the PR is behind its base branch\nCheck the GitHub connection. Run check again.\n',
      err: '',
    });
    expect(ghCalls()).toHaveLength(2);
  });

  it('prints no raw PR state or GitHub error text in JSON', async () => {
    const { run } = setup({ view: { url: rawText } });
    const { code, out, err } = await run([ref, '--json']);
    expect(code).toBe(3);
    expect(JSON.parse(out)).toEqual({
      schema: 'factory.check/v1', result: 'not-ready', pr: Number(ref), head: null,
      reasons: ['the PR is not in this repo'], offGuards: [], remedy: runAgain,
    });
    expect(err).toBe('');
  });

  it.each<[Partial<ReadinessPr>, string]>([
    [{ baseRefName: 'other' }, 'the PR targets another base branch'],
    [{ url: `https://github.com/acme/other/pull/${ref}` }, 'the PR is not in this repo'],
    [{ isCrossRepository: true }, 'the PR comes from another repo'],
  ])('refuses another target for %j', async (view, reason) => {
    const { run } = setup({ view });
    expect(await run()).toEqual(refusal(reason, runAgain));
  });

  it('names the skipped base rule when pr-rules is off', async () => {
    const { run } = setup({ view: { baseRefName: 'other' }, off: [softwareGuardIds.prRules] });
    expect(await run()).toEqual({ code: 0, out: 'READY\nThe guard pr-rules is off. The check did not test the base branch.\n', err: '' });
    const { code, out } = await run([ref, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      schema: 'factory.check/v1', result: 'ready', pr: Number(ref), head, reasons: [], remedy: null, offGuards: ['pr-rules'],
    });
  });

  it('still refuses a fork when pr-rules is off', async () => {
    const { run } = setup({ view: { isCrossRepository: true }, off: [softwareGuardIds.prRules] });
    const { code, out } = await run();
    expect(code).toBe(3);
    expect(out).toBe('NOT READY\nthe PR comes from another repo\nCheck the reasons. Run check again.\nThe guard pr-rules is off. The check did not test the base branch.\n');
  });

  it('refuses a linked item with no worker on the PR head branch', async () => {
    const { run, log } = setup({ items: [decoys[0], { ...target, lane: 'beta' }, decoys[1]] });
    log(approvalAnswer().row);
    expect(await run()).toEqual(refusal('the PR comes from another head branch', runAgain));
  });

  it.each([
    [[{ ...decoys[0], [boardKeys.mergedPrHead]: head }, target, decoys[1]]],
    [[decoys[0], { ...target, [boardKeys.mergedPrHead]: 'b'.repeat(40) }, decoys[1]]],
  ])('refuses a conflicting head on the board', async (items) => {
    const { run } = setup({ items });
    expect(await run()).toEqual(refusal('the PR head conflicts with a board record', inspectBoard));
  });

  it.each([
    [[decoys[0], { ...target, status: 'done' }, decoys[1]], 'no item matches the reference or head branch'],
    [[...workItems.slice(0, 2), itemRecord('B-4', { lane: 'alpha' }), decoys[1]], 'several items match the head branch'],
  ] as const)('refuses an item lookup that does not give one item', async (items, reason) => {
    const { run } = setup({ items });
    expect(await run()).toEqual(refusal(reason, inspectBoard));
  });

  it('keeps the verdict first and the text within 20 lines when several rules fail', async () => {
    const { run } = setup({ view: { state: 'CLOSED', isDraft: true, statusCheckRollup: null, reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, compare: () => exited(0, '{"behind_by":1}') });
    const { code, out } = await run();
    expect(code).toBe(3);
    const lines = out.trimEnd().split('\n');
    expect(lines).toEqual(['NOT READY', 'the PR is closed', 'the PR is a draft', 'the PR has no checks', 'the PR needs a review',
      'the PR has merge conflicts', 'the merge state is DIRTY', 'the PR is behind its base branch', runAgain]);
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it('reports HEAD MOVED when the read head differs from the pin', async () => {
    const { run, ghCalls } = setup({ view: { headRefOid: 'b'.repeat(40) } });
    expect(await run([ref, '--head', head])).toEqual({
      code: 3, out: 'HEAD MOVED\nthe PR head does not match the pin\nCheck the new head. Run check again.\n', err: '',
    });
    expect(ghCalls()).toHaveLength(1);
  });

  it('does not give READY for a merged PR at its pinned head', async () => {
    const { run } = setup({ view: { state: 'MERGED', mergedAt: '2026-11-23T00:18:48Z' } });
    expect(await run([ref, '--head', head])).toEqual(refusal('the PR is already merged', runAgain));
  });

  it.each([
    [[], 'needs exactly one PR number'],
    [[ref, 'extra'], 'needs exactly one PR number'],
    [['01'], 'must be a whole number'],
    [[ref, '--head', head.slice(0, 7)], 'must be a full commit id'],
    [[ref, '--head', head.toUpperCase()], 'must be a full commit id'],
    [[ref, '--admin'], 'Unknown option'],
  ] as const)('refuses invalid arguments before a gh call: %j', async (args, reason) => {
    const { run, ghCalls } = setup();
    const { code, out, err } = await run(args);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain(reason);
    expect(ghCalls()).toEqual([]);
  });

  it('shows command help without a gh call', async () => {
    const { run, ghCalls } = setup();
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('factory check PR [--head SHA] [--project ID] [--home DIR] [--json]');
    expect(ghCalls()).toEqual([]);
  });
});
