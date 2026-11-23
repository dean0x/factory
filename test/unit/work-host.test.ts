import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitCodeFor, type CliResult } from '../../src/cli/errors.js';
import { recipeHostFor } from '../../src/cli/recipe-host.js';
import { renderConfig } from '../../src/config/render.js';
import { indexPathOf, recordHome } from '../../src/core/home-index.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { decisionPlaceOf, putDecision, recordDelegation } from '../../src/core/owner-record.js';
import { boardKeys, commands, env, files, guardIds, guardValues, program } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { softwareGuardIds } from '../../src/recipes/software/guard-parts.js';
import { layoutOf } from '../../src/state/layout.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { branchOf, workCopyOf, writeWorkerRecord } from '../../src/workers/registry.js';
import { APPROVAL_ID, APPROVAL_LINK, approvalAnswer, approvalRelay, approvalRequest } from '../helpers/approval-go.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { guardStoreText, withGuardsOff } from '../helpers/guarded-node.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { fakeWorkHost } from '../helpers/work-host.js';

const { item, point, ref, head } = APPROVAL_LINK;
const worker = 'alpha';
const query = { point, ref, branch: branchOf(worker) };
const target = { item, point, ref, head };
const approval = { ...target, need: 'go' } as const;
const host = recipeHostFor(recipes);
const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const expectRefusal = (result: CliResult<unknown>, code: number, message: string, hint: string): void => {
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(message), hint: expect.stringContaining(hint) } });
  if (!result.ok) expect(exitCodeFor(result.error)).toBe(code);
};

interface Setup {
  readonly off?: readonly string[];
  readonly delegated?: boolean;
  readonly outputTTY?: boolean;
}

let folder: string;
beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'factory-work-host-')));
});
afterEach(async () => {
  if (folder !== undefined) await rm(folder, { recursive: true });
});

const setup = async ({ off = [], delegated = false, outputTTY = true }: Setup = {}) => {
  const home = join(folder, 'node');
  const state = join(folder, 'user-state');
  const layout = layoutOf(home);
  const calls = createFakeDeps();
  const deps = {
    ...createNodeDeps(), cwd: home, env: { [env.stateHome]: state },
    stdinIsTTY: true, stdoutIsTTY: outputTTY, run: calls.run,
  };
  const sample = sampleConfigWithBoard();
  const node = sample.core.node.id;
  const config = withGuardsOff(delegated ? { ...sample, core: { ...sample.core, approval: { ...sample.core.approval, [point]: 'delegated' } } } : sample, off);
  const texts = renderConfig(config);
  const writeState = (file: string, text: string) => writeFile(join(layout.stateDir, file), text);
  const writeWaiting = (...items: readonly unknown[]) => writeState(files.waiting, JSON.stringify({ intro: '', groups: [], items }));
  const writeLog = (...rows: readonly unknown[]) => writeState(files.decisionLog, JSON.stringify({ rows }));
  const board = boardText([itemRecord(item, { lane: worker })]);
  await mkdir(layout.stateDir, { recursive: true });
  await writeFile(layout.configFile, texts.shared);
  await writeFile(join(home, files.localConfig), texts.local, { mode: 0o600 });
  await writeState(files.nodeState, JSON.stringify({ schema_version: STATE_SCHEMA_VERSION, created_with: 'test', blocks: {} }));
  await writeState(files.board, board);
  await writeWaiting();
  await writeLog();
  const index = valueOf(await indexPathOf(deps));
  if (index === null) throw new Error('expected a factory list path');
  expect(await recordHome(deps, index, { home, id: node, projects: [] })).toMatchObject({ ok: true });
  if (off.length > 0) await writeFile(join(state, program, files.guardRecords), guardStoreText(node, home, off, deps.now()), { mode: 0o600 });
  if (delegated) valueOf(await recordDelegation(deps, { root: home, node, point, mode: 'delegated' }));
  const saveAnswer = async (mismatch = false) => {
    const { row, record } = approvalAnswer();
    await writeLog(row);
    const place = valueOf(await decisionPlaceOf(deps, home, node));
    const { id, option, hash, at } = record;
    valueOf(await putDecision({ ...deps, stdoutIsTTY: true }, place, { id, option, hash: mismatch ? '0'.repeat(64) : hash, at }));
  };
  const open = async () => {
    expect(host.openWork).toBeTypeOf('function');
    return valueOf(await host.openWork(deps, home, commands.item));
  };
  return { deps, home, open, saveAnswer, writeWaiting, writeLog, writeState, board, calls: calls.calls };
};

describe('the work host on a local board', () => {
  it('refuses absent proof when the owner go guard is off', async () => {
    const world = await setup({ off: [guardIds.ownerGo] });
    const work = await world.open();
    expect(work.guards[guardIds.ownerGo]).toBe(guardValues.off);
    expectRefusal(await work.approval(approval), 1, 'no linked approval request', 'factory request add');
  });

  it('reads an owner store answer in delegated mode', async () => {
    const world = await setup({ delegated: true });
    await world.saveAnswer();
    const work = await world.open();
    expect(valueOf(await work.facts({ ...target, project: 'web' })).mode).toBe('delegated');
    expect(valueOf(await work.approval({ ...approval, need: 'owner-record' }))).toEqual({ kind: 'record', id: APPROVAL_ID, decider: 'owner' });
  });

  it('accepts a relay only when an owner record is not required', async () => {
    const world = await setup({ delegated: true });
    await world.writeLog(approvalRelay());
    const work = await world.open();
    expect(valueOf(await work.approval(approval))).toEqual({ kind: 'relayed', id: APPROVAL_ID, decider: 'coordinator' });
    expectRefusal(await work.approval({ ...approval, need: 'owner-record' }), 1, 'owner store decision', 'factory decide');
  });

  it('stops on an owner store hash mismatch', async () => {
    const world = await setup({ delegated: true });
    await world.saveAnswer(true);
    const work = await world.open();
    expectRefusal(await work.approval({ ...approval, need: 'owner-record' }), 4, 'has no settled approval', 'Add a linked request');
  });

  it('does not fall back to a branch when the linked id differs only by case', async () => {
    const world = await setup();
    await world.writeWaiting(approvalRequest());
    const work = await world.open();
    expect(valueOf(await work.find(query))).toMatchObject({ kind: 'found', item: { id: item } });
    await world.writeWaiting(approvalRequest(APPROVAL_ID, { ...APPROVAL_LINK, item: item.toLowerCase() }));
    expectRefusal(await work.find(query), 1, `the link of request "${APPROVAL_ID}" is invalid`, 'factory doctor');
  });

  it('gives the mode, worker project, open requests and head conflict from the board', async () => {
    const world = await setup({ off: [softwareGuardIds.approvalMerge] });
    await world.writeWaiting(approvalRequest());
    await world.writeState(files.board, boardText([itemRecord(item, { lane: worker }), itemRecord('B-2', { [boardKeys.mergedPrHead]: head })]));
    const project = 'web';
    valueOf(await writeWorkerRecord(world.deps, world.home, { id: worker, project, branch: query.branch, workCopy: workCopyOf(world.home, project, worker) }));
    const work = await world.open();
    expect(work.guards[softwareGuardIds.approvalMerge]).toBe(guardValues.off);
    expect(valueOf(await work.facts(target))).toMatchObject({
      mode: 'owner', project: { id: project }, branches: [query.branch], cloneDir: join(world.home, project),
      openRequests: [APPROVAL_ID], headConflict: 'the item B-2 records the head of this check already',
    });
  });

  it('refuses a record with no proof before any external call or board change', async () => {
    const world = await setup();
    const work = await world.open();
    expectRefusal(await work.record({ item, ref, project: 'web' }), 1, 'no linked approval request', 'factory request add');
    expect(world.calls).toEqual([]);
    expect(await readFile(join(layoutOf(world.home).stateDir, files.board), 'utf8')).toBe(world.board);
  });

  it('needs a terminal window for output from an owner terminal', async () => {
    const world = await setup({ outputTTY: false, off: [guardIds.sessionChecks] });
    const work = await world.open();
    expect(work.guards[guardIds.sessionChecks]).toBe(guardValues.off);
    expectRefusal(await work.caller(), 4, 'terminal window for output', 'factory item');
    expect(world.calls).toEqual([]);
  });

  it('accepts an owner terminal and makes no external call', async () => {
    const world = await setup();
    const work = await world.open();
    expect(await work.caller()).toEqual({ ok: true, value: undefined });
    expect(world.calls).toEqual([]);
  });
});

describe('the fake work host', () => {
  it('lists calls in order and returns the result that the test gives it', async () => {
    const proof = { kind: 'record', id: APPROVAL_ID, decider: 'owner' } as const;
    const { work, calls } = fakeWorkHost({ approval: async () => ({ ok: true, value: proof }) });
    await work.caller();
    await work.find(query);
    expect(valueOf(await work.approval(approval))).toEqual(proof);
    expect(calls).toEqual([['caller'], ['find', query], ['approval', approval]]);
  });
});
