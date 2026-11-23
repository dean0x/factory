import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { recordDelegation } from '../../src/core/owner-record.js';
import { launchArgv } from '../../src/launch/argv.js';
import { files, guardIds, program } from '../../src/names.js';
import { mergeCheck } from '../../src/recipes/software/github-pr.js';
import { softwareGuardIds } from '../../src/recipes/software/guard-parts.js';
import { branchOf, workCopyOf, writeWorkerRecord } from '../../src/workers/registry.js';
import { APPROVAL_LINK, approvalAnswer, approvalRelay } from '../helpers/approval-go.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { exited, type RunCall } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { guardStoreText, GUARD_STORE, withGuardsOff } from '../helpers/guarded-node.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { tmuxHandler } from '../helpers/tmux-fake.js';

const { item, point, ref, head } = APPROVAL_LINK;
const worker = 'alpha';
const project = 'web';
const branch = branchOf(worker);
const command = ['pr', 'merge', ref, '--head', head, '--home', HOME];
const node = sampleConfigWithBoard().core.node.id;
const coordinatorPane = '%0';
const workerPane = '%1';

interface Setup {
  readonly off?: readonly string[];
  readonly proof?: 'owner' | 'relay';
  readonly caller?: Readonly<Record<string, string>>;
  readonly delegated?: boolean;
  readonly recordHead?: string;
  readonly hosted?: boolean;
  readonly noClosedState?: boolean;
}

const ghForMerge = (recordHead: string) => {
  const calls: RunCall[] = [];
  let merged = false;
  const run = (call: RunCall) => {
    calls.push(call);
    if (call.args[0] === 'api') return exited(0, '{"behind_by":0}');
    if (call.args[1] === 'merge') { merged = true; return exited(0); }
    const state = { headRefOid: head, state: merged ? 'MERGED' : 'OPEN', mergedAt: merged ? '2030-01-02T03:04:05.678Z' : null };
    if (call.args.includes('state,mergedAt,headRefOid')) return exited(0, JSON.stringify(state));
    const facts = call.args.includes(mergeCheck.fieldList) ? { headRefOid: recordHead, mergeCommit: { oid: 'c'.repeat(40) } } : {
      isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    };
    return exited(0, JSON.stringify({ ...state, ...facts, number: Number(ref), url: `https://github.com/acme/web/pull/${ref}`,
      headRefName: branch, baseRefName: 'main', isCrossRepository: false }));
  };
  return { run, calls, merges: () => calls.filter(({ args }) => args[1] === 'merge') };
};

const setup = async ({ off = [], proof, caller, delegated = false, recordHead = head, hosted = false, noClosedState = false }: Setup = {}) => {
  const sample = sampleConfigWithBoard();
  const base = noClosedState ? { ...sample, core: { ...sample.core, board: { ...sample.core.board, closed: undefined } } } : sample;
  const approval = delegated ? { ...base.core.approval, [point]: 'delegated' as const } : base.core.approval;
  const tracker = hosted ? { kind: 'github', items: 'acme/items', decisions: 'acme/decisions', watch_interval: '5m' } as const : base.core.tracker;
  const config = withGuardsOff({ ...base, core: { ...base.core, approval, tracker } }, off);
  const { row, record } = approvalAnswer();
  const proofRows = { owner: [row], relay: [approvalRelay()] };
  const rows = proof === undefined ? [] : proofRows[proof];
  const repo = await boardNode({ config, board: boardText([itemRecord(item, { lane: worker })]), decisionLog: JSON.stringify({ rows }) });
  if (off.length > 0) repo.deps.seed(GUARD_STORE, guardStoreText(node, HOME, off, repo.deps.now()));
  if (proof === 'owner') repo.deps.seed(`/state/${program}/${files.ownerDecisions}`, JSON.stringify({ schema: 1, records: [record] }));
  const terminal = { ...repo.deps, stdinIsTTY: true, stdoutIsTTY: true };
  if (delegated) expect(await recordDelegation(terminal, { root: HOME, node, point, mode: 'delegated' })).toMatchObject({ ok: true });
  expect(await writeWorkerRecord(repo.deps, HOME, { id: worker, project, branch, workCopy: workCopyOf(HOME, project, worker) })).toMatchObject({ ok: true });
  const launch = launchArgv({ home: HOME, coordinatorDir: `${HOME}/coordinator`, stateDir: `${HOME}/.factory`, sessionId: node,
    projects: [], effort: 'high', model: 'default', proxyBaseUrl: null, path: '/bin', agent: 'claude' });
  if (!launch.ok) throw new Error(launch.error);
  const tmux = tmuxHandler({ sessions: { [node]: HOME }, coordinatorCommands: { [node]: launch.value } });
  const gh = ghForMerge(recordHead);
  const deps = {
    ...repo.deps, env: { ...repo.deps.env, ...caller }, stdinIsTTY: true, stdoutIsTTY: true,
    run: async (name, args, options) => {
      const call = { command: name, args, cwd: options?.cwd };
      if (name === 'gh') return gh.run(call);
      if (name === 'tmux') return tmux.handler(call);
      return repo.deps.run(name, args, options);
    },
  } satisfies typeof repo.deps;
  const run = async (...flags: string[]) => {
    const sink = captureSink();
    const code = await runCli([...command, ...flags], deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };
  return { run, gh, commits: repo.commits, files: repo.deps.files };
};

const ownerGo = guardIds.ownerGo;
const { approvalMerge, adminMerge } = softwareGuardIds;
const noProof = 'Proof: none. Decider: none.';
const needGo = 'The PR and head need an owner store go or a relayed go.';
const needRecord = 'The PR and head need an owner store decision to go.';
const merged = /^MERGED AND RECORDED\n/;
const coordinator = { FACTORY_SESSION: node, TMUX_PANE: coordinatorPane };
const workerInNode = { ...coordinator, TMUX_PANE: workerPane };

describe('pr merge guard values', () => {
  it('checks the tracker before any external read even when proof is not required', async () => {
    const world = await setup({ off: [ownerGo], hosted: true });
    const result = await world.run();
    expect(result.code).toBe(4);
    expect(result.err).toContain('The github board is not in this version');
    expect(result.err).toContain('Set the tracker kind to local');
    expect(world.gh.calls).toEqual([]);
  });

  it('requires a closed state before any external read', async () => {
    const world = await setup({ noClosedState: true, proof: 'owner' });
    const result = await world.run();
    expect(result.code).toBe(2);
    expect(result.err).toContain('the setup names no closed state');
    expect(result.err).toContain('see the sample setup');
    expect(world.gh.calls).toEqual([]);
  });

  it('records nothing if the final read no longer matches the pin', async () => {
    const world = await setup({ off: [ownerGo], recordHead: 'c'.repeat(40) });
    const result = await world.run();
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining(`MERGED NOT RECORDED\nRun "factory item record ${item} --ref ${ref}".`) });
    expect(world.gh.merges()).toHaveLength(1);
    expect(world.commits).toHaveLength(0);
    expect([...world.files.keys()].filter((file) => file.endsWith(`merge-${ref}-${head}.json`))).toEqual([]);
  });

  it('checks for proof when owner go and merge approval are on', async () => {
    const world = await setup();
    const result = await world.run();
    expect(result.code).toBe(1);
    expect(result.err).toContain(needGo);
    expect(result.err).toContain('factory request add');
    expect(world.gh.merges()).toEqual([]);
  });

  it.each([
    { guard: ownerGo, delegated: false, offLine: 'The guard owner-go is off. The owner go rule did not apply.' },
    { guard: approvalMerge, delegated: true, offLine: 'The guard approval-merge is off. The merge approval rule did not apply.' },
  ])('merges without proof when $guard is off', async ({ guard, delegated, offLine }) => {
    const world = await setup({ off: [guard], delegated });
    const result = await world.run();
    expect(result).toMatchObject({ code: 0, out: expect.stringMatching(merged), err: '' });
    expect(result.out.trimEnd().split('\n')).toEqual(['MERGED AND RECORDED', noProof, offLine]);
    expect(world.gh.merges()).toHaveLength(1);
  });

  it.each([
    { place: 'a worker pane', caller: workerInNode, reason: 'the caller is in the pane %1', remedy: 'in the pane %0' },
    { place: 'a worker session', caller: { ...coordinator, FACTORY_SESSION: worker }, reason: 'the caller is not the coordinator', remedy: 'in the pane of the coordinator' },
  ])('refuses $place before any GitHub call when session checks are on', async ({ caller, reason, remedy }) => {
    const world = await setup({ caller, proof: 'owner' });
    const result = await world.run();
    expect(result.code).toBe(2);
    expect(result.err).toContain(reason);
    expect(result.err).toContain(`Run "factory pr" ${remedy}.`);
    expect(world.gh.calls).toEqual([]);
  });

  it.each([{ place: 'the owner terminal', caller: {} }, { place: 'the coordinator pane', caller: coordinator }])(
    'accepts $place when session checks are on', async ({ caller }) => {
      const world = await setup({ caller, proof: 'owner' });
      expect(await world.run()).toMatchObject({ code: 0, out: expect.stringMatching(merged), err: '' });
      expect(world.gh.merges()).toHaveLength(1);
    },
  );

  it('accepts a worker pane when session checks are off', async () => {
    const world = await setup({ caller: workerInNode, proof: 'owner', off: [guardIds.sessionChecks] });
    const result = await world.run();
    expect(result).toMatchObject({ code: 0, out: expect.stringMatching(merged), err: '' });
    expect(result.out.trimEnd().split('\n')).toContain('The guard session-checks is off. The command did not check the caller pane.');
    expect(world.gh.merges()).toHaveLength(1);
  });

  it.each([{ proof: undefined, name: 'no proof' }, { proof: 'relay', name: 'a relayed go' }] as const)(
    'refuses $name for the admin flag when the admin merge guard is on', async ({ proof }) => {
      const world = await setup(proof === undefined ? {} : { proof });
      const result = await world.run('--admin');
      expect(result.code).toBe(1);
      expect(result.err).toContain(needRecord);
      expect(result.err).toContain(proof === undefined ? 'factory request add' : 'Add a new linked request');
      expect(world.gh.merges()).toEqual([]);
    },
  );

  it('passes the admin flag once with an owner store go at the pin', async () => {
    const world = await setup({ proof: 'owner' });
    expect(await world.run('--admin')).toMatchObject({ code: 0, out: expect.stringMatching(merged), err: '' });
    expect(world.gh.merges().map(({ args }) => args.filter((arg) => arg === '--admin'))).toEqual([['--admin']]);
  });

  it('passes the explicit admin flag without proof when all merge proof guards are off', async () => {
    const world = await setup({ off: [ownerGo, approvalMerge, adminMerge] });
    const result = await world.run('--admin');
    expect(result).toMatchObject({ code: 0, out: expect.stringMatching(merged), err: '' });
    expect(result.out.trimEnd().split('\n')).toContain('The guard admin-merge is off. The admin flag needs no additional proof.');
    expect(world.gh.merges().map(({ args }) => args.filter((arg) => arg === '--admin'))).toEqual([['--admin']]);
  });
});
