import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitCodeFor, type CliResult } from '../../src/cli/errors.js';
import { recipeHostFor } from '../../src/cli/recipe-host.js';
import { runCli } from '../../src/cli/run.js';
import { renderConfig } from '../../src/config/render.js';
import { indexPathOf, recordHome } from '../../src/core/home-index.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { decisionPlaceOf, putDecision, recordDelegation } from '../../src/core/owner-record.js';
import { approvalOptions, boardKeys, commands, env, eventFile, files, guardIds, guardValues, program } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { mergeCheck } from '../../src/recipes/software/github-pr.js';
import { softwareGuardIds } from '../../src/recipes/software/guard-parts.js';
import type { ReadinessPr } from '../../src/recipes/software/merge-ready.js';
import { installGuard } from '../../src/state/guard.js';
import { layoutOf } from '../../src/state/layout.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { branchOf, workCopyOf, writeWorkerRecord } from '../../src/workers/registry.js';
import { APPROVAL_ID, APPROVAL_LINK, approvalAnswer, approvalRelay, approvalRequest } from '../helpers/approval-go.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { createFakeDeps, exited, type RunHandler } from '../helpers/fake-deps.js';
import { guardStoreText, withGuardsOff } from '../helpers/guarded-node.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { fakeWorkHost } from '../helpers/work-host.js';

const { item, point, ref, head } = APPROVAL_LINK;
const worker = 'alpha';
const query = { point, ref, branch: branchOf(worker) };
const target = { item, point, ref, head };
const event = { name: 'work-42.json', fields: { kind: 'done', count: 42 } };
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
  readonly runGh?: RunHandler;
  readonly realGit?: boolean;
  readonly beforeRecordRead?: () => Promise<void>;
}

let folder: string;
beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'factory-work-host-')));
});
afterEach(async () => {
  if (folder !== undefined) await rm(folder, { recursive: true });
});

const setup = async ({ off = [], delegated = false, outputTTY = true, runGh, realGit = false, beforeRecordRead }: Setup = {}) => {
  const home = join(folder, 'node');
  const state = join(folder, 'user-state');
  const layout = layoutOf(home);
  const calls = createFakeDeps(runGh === undefined ? {} : { run: runGh });
  const nodeDeps = createNodeDeps();
  const deps = {
    ...nodeDeps, cwd: home, env: { [env.stateHome]: state }, stdinIsTTY: true, stdoutIsTTY: outputTTY,
    programArgv: realGit ? [process.execPath, resolve('dist/factory.js')] : nodeDeps.programArgv,
    run: (async (command, args, options) => {
      if (command === 'git' && realGit) return nodeDeps.run(command, args, options);
      if (command === 'gh' && args.includes(mergeCheck.fieldList)) await beforeRecordRead?.();
      return calls.run(command, args, options);
    }) satisfies typeof nodeDeps.run,
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
  const putAnswer = async (answer = approvalAnswer(), mismatch = false) => {
    const { row, record } = answer;
    const place = valueOf(await decisionPlaceOf(deps, home, node));
    const { id, option, hash, at } = record;
    valueOf(await putDecision({ ...deps, stdoutIsTTY: true }, place, { id, option, hash: mismatch ? '0'.repeat(64) : hash, at }));
    return row;
  };
  const saveAnswer = async (mismatch = false) => writeLog(await putAnswer(approvalAnswer(), mismatch));
  const open = async () => {
    expect(host.openWork).toBeTypeOf('function');
    return valueOf(await host.openWork(deps, home, commands.item));
  };
  const git = async (...args: string[]) => {
    const result = valueOf(await deps.run('git', args, { cwd: layout.stateDir }));
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commitBase = async () => {
    await git('init', '--quiet');
    await git('config', '--local', 'user.name', 'Test User');
    await git('config', '--local', 'user.email', 'test@example.test');
    await git('config', '--local', 'commit.gpgsign', 'false');
    await git('add', '--', files.board, files.waiting, files.decisionLog);
    await git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Set up the board');
    valueOf(await installGuard(deps, layout.stateDir, layout.stateDir));
  };
  return { deps, home, open, saveAnswer, putAnswer, writeWaiting, writeLog, writeState, board, calls: calls.calls, git, commitBase };
};

describe('the work host on a local board', () => {
  it('writes an event in the outbox of the open node', async () => {
    const world = await setup();
    const work = await world.open();
    expect(work.writeEvent).toBeTypeOf('function');
    expect(valueOf(await work.writeEvent(event))).toBe('written');
    const text = await readFile(join(layoutOf(world.home).outboxDir, event.name), 'utf8');
    expect(JSON.parse(text)).toEqual(event.fields);
  });

  it('refuses absent proof when the owner go guard is off', async () => {
    const world = await setup({ off: [guardIds.ownerGo] });
    const work = await world.open();
    expect(work.guards[guardIds.ownerGo]).toBe(guardValues.off);
    expectRefusal(await work.approval(target), 1, 'no linked approval request', 'factory request add');
  });

  it('reads an owner store answer in delegated mode', async () => {
    const world = await setup({ delegated: true });
    await world.saveAnswer();
    const work = await world.open();
    expect(valueOf(await work.facts({ ...target, project: 'web' })).mode).toBe('delegated');
    expect(valueOf(await work.approval(target))).toEqual({ kind: 'record', id: APPROVAL_ID, decider: 'owner' });
  });

  it('reports a settled relay with the coordinator as decider in delegated mode', async () => {
    const world = await setup({ delegated: true });
    await world.writeLog(approvalRelay());
    const work = await world.open();
    expect(valueOf(await work.approval(target))).toEqual({ kind: 'relayed', id: APPROVAL_ID, decider: 'coordinator' });
  });

  it('stops on an owner store hash mismatch', async () => {
    const world = await setup({ delegated: true });
    await world.saveAnswer(true);
    const work = await world.open();
    expectRefusal(await work.approval(target), 4, 'has no settled approval', 'Add a linked request');
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
    expectRefusal(await work.record({ item, ref, head, project: 'web' }), 1, 'no linked approval request', 'factory request add');
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

interface MergeFixture {
  readonly view?: Partial<ReadinessPr>;
  readonly off?: readonly string[];
  readonly delegated?: boolean;
  readonly outputTTY?: boolean;
  readonly realGit?: boolean;
  readonly beforeRecordRead?: () => Promise<void>;
}

const mergeFixture = async ({ view, ...options }: MergeFixture = {}) => {
  const at = '2030-01-02T03:04:05.678Z';
  let merged = view?.state === 'MERGED';
  const work = await setup({ ...options, runGh: (call) => {
    if (call.args[0] === 'api') return exited(0, '{"behind_by":0}');
    if (call.args[1] === 'merge') { merged = true; return exited(0); }
    const state = { state: merged ? 'MERGED' : 'OPEN', mergedAt: merged ? at : null, headRefOid: head,
      mergeCommit: merged ? { oid: 'c'.repeat(40) } : null } as const;
    if (call.args.includes('state,mergedAt,headRefOid,mergeCommit')) return exited(0, JSON.stringify(state));
    const identity = { number: Number(ref), url: `https://github.com/acme/web/pull/${ref}`, headRefName: query.branch,
      baseRefName: 'main', isCrossRepository: false };
    const fields = call.args.includes(mergeCheck.fieldList) ? {} : {
      isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...view,
    };
    return exited(0, JSON.stringify({ ...identity, ...state, ...fields }));
  } });
  valueOf(await writeWorkerRecord(work.deps, work.home, {
    id: worker, project: 'web', branch: query.branch, workCopy: workCopyOf(work.home, 'web', worker),
  }));
  const run = async (...flags: string[]) => {
    const sink = captureSink();
    const code = await runCli(['pr', 'merge', ref, '--head', head, '--home', work.home, ...flags], work.deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };
  return { ...work, run, gh: () => work.calls.filter(({ command }) => command === 'gh') };
};

const mergeEventName = `merge-${ref}-${head}.json`;
const noStoreGo = 'The PR and head need an owner store go or a relayed go.';
const needStoreDecision = 'The PR and head need an owner store decision';

it.each(['check', 'pr merge'] as const)('uses one config snapshot for %s', async (command) => {
  const merge = command === 'pr merge';
  const world = await mergeFixture({ realGit: merge });
  if (merge) {
    await world.saveAnswer();
    await world.commitBase();
  }
  const layout = layoutOf(world.home);
  const fs = world.deps.fs;
  let sharedReads = 0;
  let localReads = 0;
  const readTextLimited: typeof fs.readTextLimited = async (path, ...args) => {
    const text = await fs.readTextLimited(path, ...args);
    if (path === layout.localConfigFile) localReads += 1;
    if (path !== layout.configFile) return text;
    sharedReads += 1;
    // The full load and the guard pre-read each read the local file once.
    if (!text.ok || localReads < 2) return text;
    return { ok: true, value: text.value.replace('github.com/acme/web.git', 'github.com/acme/other.git') };
  };
  const args = [...command.split(' '), ref, '--head', head, '--home', world.home];
  const sink = captureSink();
  const code = await runCli(args, { ...world.deps, fs: { ...fs, readTextLimited } }, sink);
  expect({ repo: world.gh()[0]?.args.slice(2, 4), sharedReads, localReads }).toEqual({
    repo: ['--repo', 'github.com/acme/web'], sharedReads: 4, localReads: 2,
  });
  expect(code).toBe(0);
  expect(sink.out.join('')).toMatch(merge ? /^MERGED AND RECORDED\n/ : /^READY\n/);
});

describe('pr merge through the local work host', () => {
  it('makes one board commit before the event and makes no extra commit or event on rerun', async () => {
    const world = await mergeFixture({ realGit: true });
    await world.saveAnswer();
    await world.commitBase();
    const outbox = layoutOf(world.home).outboxDir;
    const event = join(outbox, mergeEventName);
    expect(await world.run()).toMatchObject({ code: 0, out: expect.stringContaining('Proof: owner record. Decider: owner.') });
    expect(await world.git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(await world.git('show', 'HEAD:board.json')).toContain(head);
    expect(world.gh()).toHaveLength(5);
    expect(await readdir(outbox)).toEqual([mergeEventName]);
    const text = await readFile(event, 'utf8');
    expect(JSON.parse(text)).toEqual({ schema: 'factory.merge-event/v1', kind: 'merge', item, pr: Number(ref), head,
      merge_commit: 'c'.repeat(40), proof: 'record', request: APPROVAL_ID, decider: 'owner', at: expect.stringMatching(/Z$/) });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(eventFile.maxBytes);
    expect((await stat(event)).mode & 0o777).toBe(0o600);
    expect((await stat(outbox)).mode & 0o777).toBe(0o700);
    expect(await world.run()).toMatchObject({ code: 0, out: expect.stringMatching(/^MERGED AND ALREADY RECORDED\n/) });
    expect(await world.git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(world.gh().slice(5).map(({ args }) => args[1])).toEqual(['view', 'view']);
    expect(await readdir(outbox)).toEqual([mergeEventName]);
    expect(await readFile(event, 'utf8')).toBe(text);
  });

  it('recognizes a completed merge on a repeat without a linked request', async () => {
    const world = await mergeFixture({ realGit: true, off: [guardIds.ownerGo] });
    await world.commitBase();
    const outbox = layoutOf(world.home).outboxDir;
    const event = join(outbox, mergeEventName);
    expect(await world.run()).toMatchObject({ code: 0, out: expect.stringMatching(/^MERGED AND RECORDED\n/) });
    const text = await readFile(event, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ item, head, proof: 'none', request: null, decider: null });
    expect(await world.run()).toMatchObject({ code: 0, out: expect.stringMatching(/^MERGED AND ALREADY RECORDED\n/) });
    expect(await world.git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(world.gh().slice(5).map(({ args }) => args[1])).toEqual(['view', 'view']);
    expect(await readdir(outbox)).toEqual([mergeEventName]);
    expect(await readFile(event, 'utf8')).toBe(text);
  });

  const recorded = { status: 'done', stage: 'merged', [boardKeys.mergedPrHead]: head };
  const closedItem = itemRecord(item, { ...recorded, lane: worker });
  const decoys = [itemRecord('B-2', { lane: 'beta' }), itemRecord('B-3', { lane: 'beta' })] as const;

  it('writes the first event for a recorded merge from a former worker branch', async () => {
    const world = await mergeFixture({ view: { state: 'MERGED' }, realGit: true, off: [guardIds.ownerGo] });
    await world.writeState(files.board, boardText([itemRecord(item, { ...recorded, unassigned_from: [worker] })]));
    await world.commitBase();
    const outbox = layoutOf(world.home).outboxDir;
    expect(await world.run()).toMatchObject({ code: 0, out: expect.stringMatching(/^MERGED AND ALREADY RECORDED\n/) });
    expect(await world.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(world.gh().map(({ args }) => args[1])).toEqual(['view', 'view']);
    expect(await readdir(outbox)).toEqual([mergeEventName]);
    expect(JSON.parse(await readFile(join(outbox, mergeEventName), 'utf8')))
      .toMatchObject({ item, head, proof: 'none', request: null, decider: null });
  });

  it.each([
    {
      name: 'the closed item records another head', state: 'MERGED',
      rows: [{ ...closedItem, [boardKeys.mergedPrHead]: 'b'.repeat(40) }], cause: 'no item matches the reference or head branch',
    },
    {
      name: 'two closed items match', state: 'MERGED',
      rows: [closedItem, { ...closedItem, id: 'B-4' }], cause: 'several items match the head branch',
    },
    { name: 'the PR is open', state: 'OPEN', rows: [closedItem], cause: 'no item matches the reference or head branch' },
  ] as const)('refuses a closed branch match when $name', async ({ state, rows, cause }) => {
    const world = await mergeFixture({ view: { state }, off: [guardIds.ownerGo] });
    const board = boardText([decoys[0], ...rows, decoys[1]]);
    await world.writeState(files.board, board);
    expect(await world.run()).toMatchObject({
      code: 1, out: expect.stringContaining(`${cause}\nCheck the board and its request links. Run check again.`),
    });
    expect(world.gh().map(({ args }) => args[0])).toEqual(state === 'MERGED' ? ['pr'] : ['pr', 'api']);
    expect(await readFile(join(layoutOf(world.home).stateDir, files.board), 'utf8')).toBe(board);
    await expect(stat(layoutOf(world.home).outboxDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an absent proof before any merge, board commit or event', async () => {
    const world = await mergeFixture({ realGit: true });
    await world.commitBase();
    expect(await world.run()).toMatchObject({ code: 1, err: expect.stringContaining(noStoreGo) });
    expect(await world.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(world.gh()).toHaveLength(2);
    await expect(stat(layoutOf(world.home).outboxDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a stop at the outbox after the board commit', async () => {
    const world = await mergeFixture({ realGit: true });
    await world.saveAnswer();
    await world.commitBase();
    const outside = join(folder, 'outside');
    await mkdir(outside);
    await symlink(outside, layoutOf(world.home).outboxDir);
    const result = await world.run();
    expect(result.code).toBe(4);
    expect(result.out.split('\n').slice(0, 2)).toEqual(['MERGED AND RECORDED', expect.stringContaining('it is a link')]);
    expect(await world.git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a late stop under the record lock and writes no board commit or event', async () => {
    const stop = approvalAnswer(approvalRequest('D-2'), approvalOptions.stop);
    const world = await mergeFixture({ realGit: true, beforeRecordRead: async () => { await world.putAnswer(stop); } });
    await world.writeLog(stop.row, approvalRelay());
    await world.commitBase();
    expect(await world.run()).toMatchObject({ code: 1, out: expect.stringContaining(`MERGED NOT RECORDED\nRun "factory item record ${item} --ref ${ref}".`) });
    expect(world.gh()).toHaveLength(5);
    expect(await world.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(await readFile(join(layoutOf(world.home).stateDir, files.board), 'utf8')).toBe(world.board);
    await expect(stat(layoutOf(world.home).outboxDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses the newest owner stop even with an older owner go', async () => {
    const world = await mergeFixture();
    const go = await world.putAnswer();
    const stop = await world.putAnswer(approvalAnswer(approvalRequest('D-2'), approvalOptions.stop));
    await world.writeLog(go, stop);
    expect(await world.run()).toMatchObject({ code: 1, err: expect.stringMatching(/owner answered stop.*\nAdd a new linked approval request/) });
    expect(world.gh()).toHaveLength(2);
  });

  it('reports a mismatched owner record on a rerun that cannot record the merge', async () => {
    const world = await mergeFixture({ view: { state: 'MERGED' } });
    await world.saveAnswer(true);
    expect(await world.run()).toEqual({
      code: 4, out: `MERGED NOT RECORDED\nRun "factory item record ${item} --ref ${ref}".\n`, err: '',
    });
    expect(world.gh().map(({ args }) => args[1])).toEqual(['view']);
    expect(await readFile(join(layoutOf(world.home).stateDir, files.board), 'utf8')).toBe(world.board);
    await expect(stat(layoutOf(world.home).outboxDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a mismatched owner record as a stop before the merge', async () => {
    const world = await mergeFixture();
    await world.saveAnswer(true);
    expect(await world.run()).toMatchObject({ code: 4, err: expect.stringMatching(/has no settled approval.*\nAdd a linked request/) });
    expect(world.gh()).toHaveLength(2);
  });

  it.each([{ ref: '43' }, { head: 'b'.repeat(40) }])('refuses an owner go for another link: %j', async (changed) => {
    const world = await mergeFixture();
    await world.writeLog(await world.putAnswer(approvalAnswer(approvalRequest(APPROVAL_ID, { ...APPROVAL_LINK, ...changed }))));
    expect(await world.run()).toMatchObject({ code: 1, err: expect.stringContaining(noStoreGo) });
    expect(world.gh()).toHaveLength(2);
  });

  it.each(['ref', 'head'] as const)('requires the pinned link in delegated mode: %s', async (changed) => {
    const world = await mergeFixture({ delegated: true });
    const other = { ...APPROVAL_LINK, [changed]: changed === 'ref' ? '43' : 'b'.repeat(40) };
    await world.writeLog(await world.putAnswer(approvalAnswer(approvalRequest(APPROVAL_ID, other))));
    expect(await world.run()).toMatchObject({ code: 1, err: expect.stringContaining(needStoreDecision) });
    expect(world.gh()).toHaveLength(2);
  });

  it.each([
    { name: 'an approved review', extra: {} },
    { name: 'a note', extra: { notes: [{ at: '2030-01-02T03:04:05.678Z', text: 'approve' }] } },
    { name: 'a label', extra: { labels: ['approved'] } },
    { name: 'an assignee', extra: { assignee: 'owner' } },
    { name: 'a coordinator close', extra: {}, log: { ...approvalRelay(), relayed: undefined } },
  ])('does not treat $name as proof', async ({ extra, log }) => {
    const world = await mergeFixture();
    await world.writeState(files.board, boardText([itemRecord(item, { lane: worker, ...extra })]));
    if (log !== undefined) await world.writeLog(log);
    const { code, err } = await world.run();
    expect(code).toBe(1);
    expect(err).toContain(noStoreGo);
    expect(err).toContain('A review, note, label, assignee, or chat text is no proof.');
    expect(world.gh()).toHaveLength(2);
  });

  it('names delegated mode and refuses a relayed go before merge', async () => {
    const world = await mergeFixture({ delegated: true });
    await world.writeLog(approvalRelay());
    const { code, err } = await world.run();
    expect(code).toBe(1);
    expect(err).toContain(needStoreDecision);
    expect(err).toContain('Delegated proofs are not built.');
    expect(world.gh()).toHaveLength(2);
  });

  it.each([{ off: [] }, { off: [softwareGuardIds.approvalMerge, guardIds.ownerGo] }])('does not accept a relay for admin: %j', async ({ off }) => {
    const world = await mergeFixture({ off });
    await world.writeLog(approvalRelay());
    expect(await world.run('--admin')).toMatchObject({ code: 1, err: expect.stringContaining(needStoreDecision) });
    expect(world.gh()).toHaveLength(2);
  });

  it.each([{ off: [] }, { off: [guardIds.sessionChecks] }])('refuses piped JSON from an owner terminal: %j', async ({ off }) => {
    const world = await mergeFixture({ off, outputTTY: false });
    const { code, out, err } = await world.run('--json');
    expect(code).toBe(4);
    expect(err).toContain('terminal window for output');
    expect(JSON.parse(out)).toMatchObject({ schema: 'factory.error/v1', error: { kind: 'safety' } });
    expect(world.gh()).toEqual([]);
  });
});

describe('the fake work host', () => {
  it('lists calls in order and returns the result that the test gives it', async () => {
    const proof = { kind: 'record', id: APPROVAL_ID, decider: 'owner' } as const;
    const { work, calls } = fakeWorkHost({
      approval: async () => ({ ok: true, value: proof }),
      writeEvent: async () => ({ ok: true, value: 'exists' }),
    });
    await work.caller();
    await work.find(query);
    expect(valueOf(await work.approval(target))).toEqual(proof);
    expect(work.writeEvent).toBeTypeOf('function');
    expect(valueOf(await work.writeEvent(event))).toBe('exists');
    expect(calls).toEqual([['caller'], ['find', query], ['approval', target], ['writeEvent', event]]);
  });
});
