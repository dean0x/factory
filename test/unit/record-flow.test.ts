import { describe, expect, it } from 'vitest';
import { headConflictIn } from '../../src/board/edit.js';
import { parseBoard, parseDecisionLog, parseWaiting } from '../../src/board/files.js';
import { branchesOf, findWorkItem, openRequestsOf, recordWork, type WorkItemQuery } from '../../src/board/record-flow.js';
import type { CliResult } from '../../src/cli/errors.js';
import { localBoardOf } from '../../src/commands/board-open.js';
import { guardReadOf } from '../../src/core/guard-source.js';
import { ok } from '../../src/core/result.js';
import { boardKeys, commands, guardIds } from '../../src/names.js';
import type { CheckedRecord } from '../../src/recipes/entry.js';
import { softwareRecipe } from '../../src/recipes/software/entry.js';
import { softwareGuardIds } from '../../src/recipes/software/guard-parts.js';
import { softwareQueueKey } from '../../src/recipes/software/words.js';
import { branchOf } from '../../src/workers/registry.js';
import { APPROVAL_LINK, approvalAnswer, approvalRelay, approvalRequest } from '../helpers/approval-go.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { HOME } from '../helpers/guard-fixture.js';
import { GUARD_STORE, guardStoreText, withGuardsOff } from '../helpers/guarded-node.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';

type Row = Readonly<Record<string, unknown>>;
const { point, ref, head, item } = APPROVAL_LINK;
const check = softwareRecipe.recordCheck;
if (check === undefined) throw new Error('the recipe has no record check');
const rules = { points: [point], parseRef: check.parseRef, parseHead: check.parseHead };
const query: WorkItemQuery = { point, ref, branch: branchOf('alpha'), closed: 'done', workerField: 'lane', remedy: { command: 'pr merge', rest: ` ${ref}` } };

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const itemsOf = (...rows: readonly Row[]) => valueOf(parseBoard(boardText(rows), softwareQueueKey)).items;
const waitingOf = (...items: readonly Row[]) => valueOf(parseWaiting(JSON.stringify({ intro: '', groups: [], items })));
const logText = (...rows: readonly Row[]) => JSON.stringify({ rows });
const find = (rows: readonly Row[], waiting: readonly Row[] = [], log: readonly Row[] = []) =>
  findWorkItem(itemsOf(...rows), waitingOf(...waiting), valueOf(parseDecisionLog(logText(...log))), rules, query);

const target = itemRecord(item, { lane: 'alpha' });
const decoys = [itemRecord('B-2', { lane: 'beta' }), itemRecord('B-3', { lane: 'beta' })] as const;
const found = (id: string) => ({ ok: true, value: { kind: 'found', item: { id } } });
const refused = (cause: string) => ({ ok: true, value: { kind: 'lookup', cause } });
const linkFault = (id: string) => ({
  ok: false, error: { kind: 'failure', message: `the link of request "${id}" is invalid`, hint: expect.stringContaining('factory doctor') },
});

describe('work item lookup', () => {
  it('finds a branch match between items of another worker', () => {
    expect(find([decoys[0], target, decoys[1]])).toMatchObject(found(item));
  });

  it('reports no item if the only branch match is closed', () => {
    expect(find([decoys[0], { ...target, status: 'done' }, decoys[1]])).toEqual(refused('no item matches the reference or head branch'));
  });

  it('reports several items if two open items match the branch', () => {
    expect(find([decoys[0], target, itemRecord('B-4', { lane: 'alpha' }), decoys[1]])).toEqual(refused('several items match the head branch'));
  });

  it('finds an open item from the branch of a former worker', () => {
    expect(find([decoys[0], itemRecord(item, { unassigned_from: ['beta', 'alpha'] }), decoys[1]])).toMatchObject(found(item));
  });

  it.each([
    { name: 'open request', waiting: [approvalRequest()], log: [] },
    { name: 'settled close', waiting: [], log: [approvalRelay()] },
    { name: 'settled answer', waiting: [], log: [approvalAnswer().row] },
  ])('finds a closed item from a link in a $name', ({ waiting, log }) => {
    expect(find([decoys[0], { ...target, status: 'done' }, decoys[1]], waiting, log)).toMatchObject(found(item));
  });

  it('ignores the display link on an answer when its request has no link', () => {
    const answer = approvalAnswer({ ...approvalRequest(), fields: [] });
    expect(find([target, ...decoys], [], [{ ...approvalRelay(), ...answer.row, board_item: 'B-2' }])).toMatchObject(found(item));
  });

  it('finds the same item when the branch and several requests name it', () => {
    expect(find([decoys[0], target, decoys[1]], [approvalRequest('D-2')], [approvalRelay()])).toMatchObject(found(item));
  });

  it('reports several items when an open request and a settled request link different items', () => {
    const other = approvalRelay('D-2', undefined, { ...APPROVAL_LINK, item: 'B-2' });
    expect(find([decoys[0], target, decoys[1]], [approvalRequest()], [other])).toEqual(refused('several items link to the reference'));
  });

  it('reports a conflict when the branch and link match different items', () => {
    const request = approvalRequest('D-1', { ...APPROVAL_LINK, item: 'B-2' });
    expect(find([decoys[0], target, decoys[1]], [request])).toEqual(refused('the linked item and the head branch match different items'));
  });

  it('refuses an open link if the item id differs only in letter case, even with a branch match', () => {
    const request = approvalRequest('D-1', { ...APPROVAL_LINK, item: item.toLowerCase() });
    expect(find([decoys[0], target, decoys[1]], [request])).toMatchObject(linkFault('D-1'));
  });

  it('refuses a settled link if the item id differs only in letter case, even with a branch match', () => {
    const row = approvalRelay('D-1', undefined, { ...APPROVAL_LINK, item: item.toLowerCase() });
    expect(find([decoys[0], target, decoys[1]], [], [row])).toMatchObject(linkFault('D-1'));
  });

  it('refuses a link to a missing item, even with a branch match', () => {
    const request = approvalRequest('D-1', { ...APPROVAL_LINK, item: 'B-9' });
    expect(find([target, ...decoys], [request])).toMatchObject({
      ok: false, error: { kind: 'failure', message: 'a linked request names an item that is not on the board', hint: expect.stringContaining('factory doctor') },
    });
  });

  it('compares references in the form that the recipe parser returns', () => {
    const normalized = { ...rules, parseRef: (text: string) => rules.parseRef(text.replace(/^ref:/u, '')) };
    const request = approvalRequest('D-1', { ...APPROVAL_LINK, ref: `ref:${ref}` });
    expect(findWorkItem(itemsOf({ ...target, status: 'done' }), waitingOf(request), valueOf(parseDecisionLog(logText())), normalized, query))
      .toMatchObject(found(item));
  });

  it('gives the lookup command in the remedy for an invalid former worker list', () => {
    const [row] = itemsOf(itemRecord(item, { unassigned_from: 'alpha' }));
    if (row === undefined) throw new Error('the fixture has no item');
    expect(branchesOf(row, null, query.remedy)).toMatchObject({
      ok: false, error: { kind: 'failure', message: expect.stringContaining('is not a list of text'), hint: `Check the item in board.json, then run "factory pr merge ${ref}" again.` },
    });
  });
});

describe('open requests for work', () => {
  it('lists open requests that name the item or link the reference', () => {
    const unrelated = (id: string) => approvalRequest(id, { ...APPROVAL_LINK, item: 'B-2', ref: '43' });
    const sameItem = approvalRequest('D-2', { ...APPROVAL_LINK, ref: '43' });
    const sameRef = approvalRequest('D-3', { ...APPROVAL_LINK, item: 'B-2' });
    expect(openRequestsOf(waitingOf(unrelated('D-1'), sameItem, sameRef, unrelated('D-4')), rules, { item, ref }))
      .toEqual(ok(['D-2', 'D-3']));
  });

  it('refuses an invalid link even after a valid request matches', () => {
    const broken = approvalRequest('D-2', { ...APPROVAL_LINK, head: 'not-a-head' });
    expect(openRequestsOf(waitingOf(approvalRequest(), broken), rules, { item, ref })).toMatchObject(linkFault('D-2'));
  });
});

describe('head conflicts', () => {
  const rows = itemsOf(decoys[0], target, { ...decoys[1], [boardKeys.mergedPrHead]: head });

  it('names another item that records the head', () => {
    expect(headConflictIn(rows, item, head)).toBe('the item B-3 records the head of this check already');
  });

  it('refuses a different head on the same item', () => {
    expect(headConflictIn(itemsOf({ ...target, [boardKeys.mergedPrHead]: 'b'.repeat(40) }), item, head)).toBe(`${item} records another head already`);
  });

  it('permits a rerun for the same head even when another item holds it', () => {
    expect(headConflictIn(itemsOf({ ...target, [boardKeys.mergedPrHead]: head }, { ...decoys[1], [boardKeys.mergedPrHead]: head }), item, head)).toBeNull();
  });
});

it.each([{ off: [] }, { off: [softwareGuardIds.prRules, guardIds.ownerGo] }])('returns record data and off guard ids: $off', async ({ off }) => {
  const checked = { head, ref, stage: check.stage, summary: 'work complete' } as CheckedRecord;
  const sample = withGuardsOff(sampleConfigWithBoard(), off);
  const config = { ...sample, entry: { ...softwareRecipe, recordCheck: { ...check, check: async () => ok(checked) } } };
  const repo = await boardNode({ config, board: boardText([target]), decisionLog: logText(approvalRelay()) });
  repo.deps.seed(GUARD_STORE, guardStoreText(config.core.node.id, HOME, off, repo.deps.now()));
  const { deps } = await guardReadOf(repo.deps, HOME, config, 'always');
  const board = { home: HOME, config, connector: localBoardOf(deps, HOME, config, commands.item) };
  const record = () => recordWork(deps, board, { id: item, ref, project: 'web' });

  expect(await record()).toMatchObject({ ok: true, value: { checked, recorded: { changed: true, item: { id: item } }, offGuards: off } });
  expect(await record()).toMatchObject({ ok: true, value: { checked, recorded: { changed: false }, offGuards: off } });
  expect(repo.commits).toHaveLength(1);
});
