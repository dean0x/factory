import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/blocks/managed.js';
import type { RequestProof } from '../../src/board/decide.js';
import { exitCodeOf, failure, safetyRefusal, type CliResult } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import { commandTable } from '../../src/cli/table.js';
import type { WorkerOptions } from '../../src/commands/worker.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { hookSettingsPlaceOf, ownSettingsEntries } from '../../src/core/claude-settings.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { ok } from '../../src/core/result.js';
import { guardSourceOf } from '../../src/guards/effective.js';
import { launchArgv } from '../../src/launch/argv.js';
import { paneBindArgs } from '../../src/launch/tmux.js';
import { decideProofReasons, env, files, guardIds, guardRecords, guardValues, program, relayedMarker, stateGuard, type HookEvent } from '../../src/names.js';
import { hasOwnerPrefix } from '../../src/safety/owner-prefix.js';
import { installGuard } from '../../src/state/guard.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { relayOutput, relayWorker } from '../../src/workers/relay.js';
import { summonWorker } from '../../src/workers/slot.js';
import { APPROVAL_ID, APPROVAL_LINK, approvalRequest } from '../helpers/approval-go.js';
import { boardText } from '../helpers/board-node.js';
import { createFakeDeps, exited, registerRoot, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { FOLDER_ORIGINS, GUARD_STORE } from '../helpers/guarded-node.js';
import { runWorker } from '../helpers/package-registry.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';
import { COORDINATOR_PANE, HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture } from '../helpers/tmux-fake.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { atWait, endsPane, withProgram, type Program } from '../helpers/worker-program.js';

const WORKER = 'alpha';
const PANE = '%3';
const SESSION = 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc';
const OTHER_SESSION = 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd';
const COPY = `${HOME}/work-copies/web/${WORKER}`;
const SETTINGS = hookSettingsPlaceOf(COPY).file;
const LAYOUT = layoutOf(HOME);
const DENIED = `${LAYOUT.stateDir}/${files.denied}`;
const LAST_SEEN = `${LAYOUT.heartbeatDir}/${SESSION}`;
const NOW = Date.parse('2030-01-03T00:00:00Z');
const AT = '2030-01-01T23:04:05.678-04:00';
const EXPECTED_LINE = "[From Test Owner, typed by demo at the owner's explicit instruction, 2030-01-02] Decision D-1: go. Read it: factory decide read D-1";
const { title, question } = approvalRequest();
const RECORD = { kind: 'record', option: 'go', at: AT, optionText: 'Private option', requestKind: 'decision', link: null,
  title, question, decision: 'Private display copy', decider: null } as const satisfies RequestProof;
const NO_PROOF = { at: null, title: null, question: null, decision: null, link: null, option: null, decider: null } as const;

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const coordinatorWords = () => {
  const argv = launchArgv({ home: HOME, coordinatorDir: LAYOUT.coordinatorDir, stateDir: LAYOUT.stateDir,
    sessionId: NODE, projects: [], effort: 'high', model: 'default', proxyBaseUrl: null, path: '/bin', agent: 'claude' });
  if (!argv.ok) throw new Error(argv.error);
  return argv.value;
};

const storePrefix = (deps: FakeDeps, prefix: string | null, root = HOME): void => {
  deps.seed(GUARD_STORE, JSON.stringify({ schema: guardRecords.schema, records: [{ node: NODE, root, values: {},
    prefix: prefix === null ? null : { hash: sha256Hex(prefix), at: deps.now().toISOString() } }] }));
};

const withOff = (deps: FakeDeps, id: string): FakeDeps => ({ ...deps,
  guards: guardSourceOf({ home: HOME, values: { [id]: guardValues.off }, state: null }),
});

const writesLine = (event: HookEvent, sessionId = SESSION): Program => async ({ deps }) => {
  if (sessionId !== SESSION) valueOf(await writeWorkerSession(deps, HOME, WORKER, sessionId));
  valueOf(await writeLastSeen(deps, HOME, sessionId, { kind: 'event', event }, WORKER));
};

interface Setup {
  readonly pane?: Partial<PaneFixture>;
  readonly tmux?: TmuxFixture;
  readonly prefix?: string;
  readonly display?: string;
  readonly rebind?: { readonly field: number; readonly value: string };
}

const validRelay = async (setup: Setup = {}) => {
  const sample = sampleConfig();
  const owner = { ...sample.core.owner, prefix: setup.prefix ?? sample.core.owner.prefix, display: setup.display ?? sample.core.owner.display };
  const config: FactoryConfig = { ...sample, core: { ...sample.core, owner } };
  const server = tmuxHandler({ sessions: { [NODE]: HOME }, coordinatorCommands: { [NODE]: coordinatorWords() },
    panes: [workerPane(WORKER, { pid: 4777, screen: 'Task done.\n\n> ', ...setup.pane })], ...setup.tmux });
  const git = gitHandler();
  const order: string[] = [];
  const bind = paneBindArgs(PANE, WORKER);
  if (!bind.ok) throw new Error(bind.error);
  let binds = 0;
  const deps = withFsWatch(createFakeDeps({ cwd: '/w', os: 'darwin', now: new Date(NOW - 60_000),
    env: { PATH: '/bin', [env.stateHome]: '/state', [env.tmuxPane]: COORDINATOR_PANE, [env.session]: NODE },
    run: (call) => {
      if (call.command === 'ps') return exited(0, '10:00\n');
      if (call.command === 'git') return git.handler(call);
      if (call.command !== 'tmux') return failure('unexpected command');
      if (call.args[0] === 'send-keys') order.push('keys');
      if (call.args[0] === 'capture-pane') order.push('screen');
      const result = server.handler(call);
      if (call.args.join(' ') !== bind.value.join(' ')) return result;
      order.push('bind');
      binds += 1;
      const change = setup.rebind;
      if (!result.ok || binds !== 2 || change === undefined) return result;
      const fields = result.value.stdout.split('|');
      fields[change.field] = change.value;
      return exited(result.value.exitCode, fields.join('|'), result.value.stderr);
    },
  }), (method, path) => {
    if (method === 'readTextLimited' && path === LAST_SEEN) order.push('last seen');
  });
  deps.seed(SETTINGS, JSON.stringify(ownSettingsEntries));
  deps.mtimes.set(SETTINGS, NOW - 3_600_000);
  valueOf(await writeWorkerRecord(deps, HOME, { id: WORKER, project: 'web', workCopy: COPY, branch: `worker/${WORKER}` }));
  valueOf(await writeWorkerSession(deps, HOME, WORKER, SESSION));
  valueOf(await writeLastSeen(deps, HOME, SESSION, { kind: 'event', event: 'Stop' }, WORKER));
  await deps.sleep(60_000);
  deps.sleeps.length = 0;
  order.length = 0;
  storePrefix(deps, owner.prefix);
  const readDecision = vi.fn<(id: string) => Promise<CliResult<{ node: string; root: string; proof: RequestProof }>>>()
    .mockResolvedValue(ok({ node: NODE, root: HOME, proof: RECORD }));
  const proof = (next: RequestProof): void => { readDecision.mockResolvedValue(ok({ node: NODE, root: HOME, proof: next })); };
  const run = (using = deps, id = APPROVAL_ID) => relayWorker(using, { home: HOME, config, workerId: WORKER, id }, readDecision);
  return { deps, tmux: server.log, config, order, readDecision, proof, run };
};

type World = Awaited<ReturnType<typeof validRelay>>;

const sendCalls = (world: World) => world.tmux.calls.filter(({ args }) => args[0] === 'send-keys');

const expectRefusal = (result: CliResult<unknown>, code: number, message: string, remedy: string | undefined) => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(exitCodeOf[result.error.kind], result.error.message).toBe(code);
  expect(result.error.message).toContain(message);
  if (remedy !== undefined) expect(result.error.hint ?? '').toContain(remedy);
};

const refuses = async (world: World, code: number, message: string, remedy: string, using = world.deps) => {
  const result = await world.run(using);
  expectRefusal(result, code, message, remedy);
  expect(sendCalls(world)).toEqual([]);
  return result;
};

const confirms = (world: World, using = world.deps, event: HookEvent = 'UserPromptSubmit') =>
  world.run(withProgram(using, world.tmux, atWait(1, writesLine(event))));

type Origin = (typeof FOLDER_ORIGINS)[number][1];
const DECISION_STORE = `/state/${program}/${files.ownerDecisions}`;
const LOG = `${LAYOUT.stateDir}/${files.decisionLog}`;
const WAITING = `${LAYOUT.stateDir}/${files.waiting}`;
const REQUEST = { id: APPROVAL_ID, title, question, kind: RECORD.requestKind, options: [{ key: RECORD.option, text: RECORD.optionText }] };
const CLOSED = { item: `${APPROVAL_ID}: ${title}`, date: '2030-01-02', decision: 'Use the plan' };

const seedLog = (deps: FakeDeps, ...rows: readonly Record<string, unknown>[]) => deps.seed(LOG, JSON.stringify({ rows }));
const seedWaiting = (deps: FakeDeps, ...items: readonly Record<string, unknown>[]) => deps.seed(WAITING, JSON.stringify({ intro: '', groups: [], items }));
const seedAnswer = (deps: FakeDeps, request: Readonly<Record<string, unknown>> = REQUEST, option: string = RECORD.option, hash?: string) => {
  const canonical = canonicalRequestText(request);
  if (!canonical.ok) throw new Error(canonical.error);
  seedLog(deps, { ...CLOSED, by: 'owner', request: canonical.value });
  const record = { root: HOME, node: NODE, id: APPROVAL_ID, option, hash: hash ?? requestHashOf(canonical.value), at: new Date(AT).toISOString() };
  deps.seed(DECISION_STORE, JSON.stringify({ schema: 1, records: [record] }));
};

const validCommandRelay = async (origin: Origin, setup?: Setup) => {
  const world = await validRelay(setup);
  const { deps, config } = world;
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, NODE, [], origin);
  deps.seedDir(`${LAYOUT.stateDir}/.git`);
  valueOf(await installGuard(deps, LAYOUT.stateDir, LAYOUT.stateDir));
  deps.seed(`${LAYOUT.stateDir}/${files.board}`, boardText());
  seedWaiting(deps);
  seedAnswer(deps);
  return world;
};

const relayOptions = { words: ['relay', WORKER], home: HOME, project: undefined, duration: undefined, yes: false, decision: APPROVAL_ID };
type Change = (world: World) => FakeDeps | void | Promise<FakeDeps | void>;
interface CommandRefusal {
  readonly name: string;
  readonly code: number;
  readonly message: string;
  readonly remedy: string | undefined;
  readonly change?: Change;
  readonly setup?: Setup;
  readonly options?: Partial<WorkerOptions>;
  readonly keyCalls?: number;
}
const refusal = (name: string, code: number, message: string, remedy: string | undefined, details?: Omit<CommandRefusal, 'name' | 'code' | 'message' | 'remedy'>): CommandRefusal =>
  ({ name, code, message, remedy, ...details });
const onlyCaller = (deps: FakeDeps, pane: string): FakeDeps => ({ ...deps, env: { ...deps.env, [env.tmuxPane]: pane } });
const pastKeys = (world: World, action: Program) => withProgram(world.deps, world.tmux, atWait(1, action));

describe.each(FOLDER_ORIGINS)('worker relay in %s', (_title, origin) => {
  it('passes the decision flag to the scoped board read and reports success in JSON', async () => {
    const world = await validCommandRelay(origin);
    const sink = captureSink();
    const deps = pastKeys(world, writesLine('UserPromptSubmit'));
    const code = await runCli(['worker', 'relay', WORKER, '--decision', APPROVAL_ID, '--home', HOME, '--json'], deps, sink);
    expect(code, sink.errors.join('')).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toEqual({ schema: 'factory.worker-relay/v1', id: WORKER, decision: APPROVAL_ID, option: 'go', pane: PANE, confirmed: true });
    expect(world.tmux.typed().find(({ literal }) => literal)?.text).toBe(EXPECTED_LINE);
  });

  it.each([
    refusal('a noncanonical id', 2, 'canonical decision id', 'Use an id of the form D-1', { options: { decision: 'D-03' } }),
    ...[false, true].flatMap((off) => [PANE, '%2'].map((pane) =>
      refusal(`caller pane ${pane} with session checks off: ${off}`, 2, `the caller is in the pane ${pane}`, 'in the pane %0', {
        change: ({ deps }) => onlyCaller(off ? withOff(deps, guardIds.sessionChecks) : deps, pane),
      }))),
    refusal('a caller in Claude Code outside a factory session', 4, 'Claude Code session cannot', 'in your own terminal window', {
      change: ({ deps }) => ({ ...outside(deps), env: { ...outside(deps).env, [env.claudeCode]: '1' } }),
    }),
    refusal('a caller with no input terminal', 4, 'needs a terminal window for input', 'in your own terminal window', {
      change: ({ deps }) => ({ ...outside(deps), stdinIsTTY: false }),
    }),
    refusal('a caller with no output terminal', 4, 'needs a terminal window for output', 'in your own terminal window', {
      change: ({ deps }) => ({ ...outside(deps), stdoutIsTTY: false }),
    }),
    refusal('a missing worker record', 2, 'worker alpha has no record', 'factory worker relay ID --decision D-1', {
      change: ({ deps }) => { deps.files.delete(workerPathsOf(HOME, WORKER).recordFile); },
    }),
    refusal('an unknown id', 1, decideProofReasons.none, 'factory decide', { options: { decision: 'D-2' } }),
    refusal('an open request', 1, decideProofReasons.open, 'factory decide', {
      change: ({ deps }) => { seedWaiting(deps, REQUEST); seedLog(deps); deps.files.delete(DECISION_STORE); },
    }),
    refusal('a relayed answer', 1, decideProofReasons.relayed, 'factory decide', {
      change: ({ deps }) => seedLog(deps, { ...CLOSED, decider: 'coordinator', relayed: relayedMarker }),
    }),
    ...['coordinator', 'delegate'].map((decider) => refusal(`a decision from the ${decider}`, 1, decideProofReasons.closed, 'factory decide', {
      change: ({ deps }) => seedLog(deps, { ...CLOSED, decider }),
    })),
    refusal('a proof mismatch', 4, decideProofReasons.mismatch, 'factory doctor', {
      change: ({ deps }) => seedAnswer(deps, REQUEST, RECORD.option, '0'.repeat(64)),
    }),
    refusal('a damaged owner decision store', 4, decideProofReasons.error, 'factory doctor', {
      change: ({ deps }) => deps.seed(DECISION_STORE, '{'),
    }),
    refusal('a damaged decision log', 4, decideProofReasons.error, 'factory doctor', { change: ({ deps }) => deps.seed(LOG, '{') }),
    refusal('the board guard off', 4, 'the delete guard of .factory is off', 'factory upgrade', {
      change: ({ deps }) => { deps.files.delete(`${LAYOUT.stateDir}/.git/${stateGuard.folder}/${stateGuard.hookFiles[0]}`); },
    }),
    refusal('a decision store inside the factory folder', 4, 'inside the factory folder', 'Set the state folder to a folder outside', {
      change: ({ deps }) => {
        const inside = { ...deps, env: { ...deps.env, [env.stateHome]: `${HOME}/user-state` } };
        registerRoot(inside, HOME, NODE, [], origin);
        return inside;
      },
    }),
    refusal('no text for the chosen option', 4, 'lacks the option text or request kind', 'factory doctor', {
      change: ({ deps }) => seedAnswer(deps, REQUEST, 'missing'),
    }),
    refusal('no known request kind', 4, 'lacks the option text or request kind', 'factory doctor', {
      change: ({ deps }) => seedAnswer(deps, { ...REQUEST, kind: null }),
    }),
    ...['merge', 'release'].map((point) => refusal(`a ${point} link`, 4, 'linked to an approval point', 'approval point needs its own approval flow', {
      change: ({ deps }) => seedAnswer(deps, { ...REQUEST, fields: approvalRequest(APPROVAL_ID, { ...APPROVAL_LINK, point }).fields }),
    })),
    refusal('a missing prefix', 4, 'prefix has no confirmation record', 'factory guard confirm', {
      change: ({ deps }) => { deps.files.delete(GUARD_STORE); },
    }),
    ...[false, true].map((off) => refusal(`a different prefix with safety-block off: ${off}`, 4, 'prefix differs from its record', 'factory guard confirm', {
      change: ({ deps }) => { storePrefix(deps, 'Different prefix'); return off ? withOff(deps, guardIds.safetyBlock) : deps; },
    })),
    refusal('a guard store fault', 4, 'guard store', 'factory doctor', { change: ({ deps }) => deps.seed(GUARD_STORE, '{') }),
    refusal('a prefix record with a different folder case', 4, 'exact letter case', 'factory doctor', {
      change: ({ deps, config }) => storePrefix(deps, config.core.owner.prefix, HOME.toUpperCase()),
    }),
    refusal('no state place before the prefix check', 4, 'name no folder', 'Set XDG_STATE_HOME or HOME', {
      change: ({ deps }) => ({ ...deps, env: { ...deps.env, [env.stateHome]: undefined, [env.userHome]: undefined } }),
    }),
    refusal('a command request', 4, 'is a command request', 'Run the command yourself', {
      change: ({ deps }) => seedAnswer(deps, { ...REQUEST, kind: 'command' }),
    }),
    ...(['title', 'question', 'optionText'] as const).map((key) => refusal(`a denied match in ${key}`, 4, 'matches denied entry 3', '.factory/denied.json', {
      change: ({ deps }) => deps.seed(DENIED, JSON.stringify({ schema: 1, denied: ['decoy one', 'decoy two', RECORD[key].toUpperCase()] })),
    })),
    refusal('bad denied list JSON', 4, 'denied list is not valid JSON', '.factory/denied.json', { change: ({ deps }) => deps.seed(DENIED, '{') }),
    refusal('a denied list read fault', 4, 'denied list cannot be read', '.factory/denied.json', {
      change: ({ deps }) => {
        deps.seed(DENIED, '{"schema":1,"denied":[]}');
        return { ...deps, fs: { ...deps.fs, openChecked: async (path, request) =>
          path === DENIED ? failure('cannot read the denied list') : deps.fs.openChecked(path, request) } };
      },
    }),
    refusal('a long line', 1, 'more than 300 signs', 'owner.prefix', { setup: { prefix: `[{owner}] ${'x'.repeat(260)}` } }),
    refusal('a line with a non-ASCII sign', 1, 'not a printable ASCII sign', 'owner.prefix', { setup: { display: 'Tést Owner' } }),
    ...['!', '/', '@'].map((sign) => refusal(`a line that starts with ${sign}`, 4, 'must not start', 'owner.prefix', {
      setup: { prefix: `${sign}{owner}` },
    })),
    refusal('a line with @ inside it', 4, 'must not contain @', 'owner.prefix', { setup: { display: 'Test@Owner' } }),
    refusal('an unbound pane', 4, 'did not start it for that worker', 'clear its mark', { setup: { pane: { command: ['sh'] } } }),
    refusal('a pane in view', 3, 'a summon shows it there', 'factory layout', {
      change: async ({ deps }) => { valueOf(await summonWorker(deps, { home: HOME, session: NODE, workerId: WORKER, minutes: 15 })); },
    }),
    refusal('settings that changed after the session started', 3, 'changed after the session started', 'factory restart alpha', {
      change: ({ deps }) => { deps.mtimes.set(SETTINGS, NOW); },
    }),
    refusal('a missing last-seen line', 3, 'cannot use the last-seen line', 'Wait until the session reports', {
      change: ({ deps }) => { deps.files.delete(LAST_SEEN); },
    }),
    ...([
      ['PreToolUse', 'is busy', 'Wait until it waits at its prompt'], ['Notification', 'waits for an answer', 'answer the dialog'],
    ] as const).map(([event, message, remedy]) => refusal(event, 1, message, remedy, {
      change: async ({ deps }) => { valueOf(await writeLastSeen(deps, HOME, SESSION, { kind: 'event', event }, WORKER)); },
    })),
    refusal('a pane with synchronized input', 4, 'single-pane input', 'synchronize-panes is off', {
      setup: { tmux: { synchronizedPanes: [PANE] } }, change: ({ deps }) => withOff(deps, guardIds.paneSafety),
    }),
    refusal('a pane process change', 3, 'process of the pane %3 changed', 'Look at the pane %3 in tmux', { setup: { rebind: { field: 1, value: '4778' } } }),
    refusal('a pane end during the checks', 3, 'ended while the checks ran', 'factory worker resume alpha', { setup: { rebind: { field: 2, value: '1' } } }),
    refusal('a pane in tmux mode', 3, 'is in a mode of tmux', 'Press q', { setup: { tmux: { panesInMode: [PANE] } } }),
    refusal('a numbered list of choices', 3, 'numbered list of choices', 'answer the dialog there', {
      setup: { pane: { screen: 'Choose:\n❯ 1. Yes\n  2. No' } }, change: ({ deps }) => withOff(deps, guardIds.paneSafety),
    }),
    refusal('a key run fault', 1, 'send-keys failed', undefined, {
      setup: { tmux: { failing: 'send-keys' } }, keyCalls: 2,
    }),
    refusal('no later turn', 3, 'typed, not confirmed', 'factory worker summon alpha', { keyCalls: 1 }),
    refusal('a pane end after the keys', 1, 'pane %3 of the worker alpha is gone', 'factory worker resume alpha', {
      change: (world) => pastKeys(world, endsPane), keyCalls: 1,
    }),
  ])('refuses $name with exit $code', async ({ setup, change, options, code, message, remedy, keyCalls = 0 }) => {
    const world = await validCommandRelay(origin, setup);
    const deps = (await change?.(world)) ?? world.deps;
    expectRefusal(await runWorker(deps, { ...relayOptions, ...options }), code, message, remedy);
    expect(sendCalls(world)).toHaveLength(keyCalls);
  });
});

it('shows the exact relay usage in worker help', () => {
  expect(commandTable.find(({ name }) => name === 'worker')?.usage).toContain('factory worker relay ID --decision D-n [--home DIR]');
});

it('types one literal line for the confirmed decision and prints only its identifiers', async () => {
  const world = await validRelay();
  const result = await confirms(world);
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  if (!result.ok) return;
  const output = relayOutput(result.value);
  expect(world.readDecision).toHaveBeenCalledExactlyOnceWith('D-1');
  expect(world.tmux.typed()).toEqual([
    { pane: PANE, literal: false, text: 'C-u' }, { pane: PANE, literal: true, text: EXPECTED_LINE }, { pane: PANE, literal: false, text: 'Enter' },
  ]);
  expect(sendCalls(world)).toHaveLength(1);
  const { prefix, display } = world.config.core.owner;
  expect(hasOwnerPrefix(EXPECTED_LINE, prefix, display)).toBe(true);
  expect(world.deps.calls.filter(({ command }) => command === 'git')).toEqual([]);
  expect(world.order.slice(0, world.order.indexOf('keys') + 1)).toEqual(['bind', 'last seen', 'screen', 'bind', 'keys']);
  expect(output.lines).toHaveLength(2);
  expect(output.lines[0]).toMatchObject({ level: 'ok', text: expect.stringMatching(/D-1.*go.*alpha.*%3/) });
  expect(output.json).toEqual({ schema: 'factory.worker-relay/v1', id: WORKER, decision: 'D-1', option: 'go', pane: PANE, confirmed: true });
  expect(JSON.stringify(output)).not.toMatch(/Private|Test Owner|\.factory/);
});

it('matches the measured size and stays within the budget for a relay', async () => {
  const world = await validRelay();
  const output = relayOutput(valueOf(await confirms(world)));
  const tokens = tokensOf(plainText(output));
  const row = budgetRow(12);
  expect(row.measured).toBe(tokens);
  expect(tokens).toBeLessThanOrEqual(row.budget);
});

it('uses the option key, not the display copy of the decision', async () => {
  const world = await validRelay();
  world.proof({ ...RECORD, decision: 'Changed display copy' });
  expect((await confirms(world)).ok).toBe(true);
  expect(world.tmux.typed().find(({ literal }) => literal)?.text).toBe(EXPECTED_LINE);
});

it.each(['d-3', 'D-03', 'D-0', 'D-1 D-2', 'D-1\n'])('refuses a noncanonical id %j before any read', async (id) => {
  const world = await validRelay();
  const before = world.deps.calls.length;
  expectRefusal(await world.run(world.deps, id), 2, 'canonical decision id', 'Use an id of the form D-1');
  expect(world.readDecision).not.toHaveBeenCalled();
  expect(world.deps.calls).toHaveLength(before);
});

it('refuses an absent worker record before the decision read', async () => {
  const world = await validRelay();
  world.deps.files.delete(workerPathsOf(HOME, WORKER).recordFile);
  await refuses(world, 2, 'worker alpha has no record', 'factory worker relay ID --decision D-1');
  expect(world.readDecision).not.toHaveBeenCalled();
});

it.each([
  { ...NO_PROOF, kind: 'none' }, { ...NO_PROOF, kind: 'open' }, { ...NO_PROOF, kind: 'relayed', settled: true, decider: 'coordinator' },
  { ...NO_PROOF, kind: 'closed', decider: 'coordinator' }, { ...NO_PROOF, kind: 'closed', decider: 'delegate' },
] satisfies RequestProof[])('refuses a $kind proof from $decider', async (proof) => {
  const world = await validRelay();
  world.proof(proof);
  await refuses(world, 1, decideProofReasons[proof.kind], 'factory decide');
});

it.each(['mismatch', 'error'] as const)('refuses a %s proof with the doctor remedy', async (kind) => {
  const world = await validRelay();
  world.proof({ ...NO_PROOF, kind });
  await refuses(world, 4, decideProofReasons[kind], 'factory doctor');
});

it.each(['the board guard is off', 'the decision store is inside the factory folder'])('passes through the decision read fault: %s', async (message) => {
  const world = await validRelay();
  const error = safetyRefusal(message, 'Check the decision reader.');
  world.readDecision.mockResolvedValue(error);
  expect(await refuses(world, 4, message, 'Check the decision reader.')).toEqual(error);
});

it.each(['optionText', 'requestKind'] as const)('refuses a record with no %s', async (key) => {
  const world = await validRelay();
  world.proof({ ...RECORD, [key]: null });
  await refuses(world, 4, 'lacks the option text or request kind', 'factory doctor');
});

it.each(['merge', 'release'])('refuses a decision with a %s link', async (point) => {
  const world = await validRelay();
  world.proof({ ...RECORD, link: { ...APPROVAL_LINK, point } });
  await refuses(world, 4, 'linked to an approval point', 'approval point needs its own approval flow');
});

it.each(['title', 'question', 'optionText'] as const)('refuses a denied match in the %s without the entry text', async (key) => {
  const world = await validRelay();
  world.deps.seed(DENIED, JSON.stringify({ schema: 1, denied: ['decoy one', 'decoy two', RECORD[key].toUpperCase()] }));
  const refusal = await refuses(world, 4, 'matches denied entry 3', '.factory/denied.json');
  expect(JSON.stringify(refusal)).not.toMatch(/private|decoy/i);
});

it.each([false, true])('refuses a command request even when a denied match is %s', async (denied) => {
  const world = await validRelay();
  world.proof({ ...RECORD, requestKind: 'command' });
  if (denied) world.deps.seed(DENIED, JSON.stringify({ schema: 1, denied: [question] }));
  await refuses(world, 4, 'is a command request', 'Run the command yourself');
});

it('passes through a denied list fault', async () => {
  const world = await validRelay();
  world.deps.seed(DENIED, '{');
  await refuses(world, 4, 'denied list is not valid JSON', '.factory/denied.json');
});

describe.each([false, true])('with the guard off: %s', (off) => {
  const using = (world: World, guard: string) => off ? withOff(world.deps, guard) : world.deps;

  it.each([PANE, '%2'])('refuses caller pane %s', async (pane) => {
    const world = await validRelay();
    const deps = using(world, guardIds.sessionChecks);
    await refuses(world, 2, `the caller is in the pane ${pane}`, 'in the pane %0', { ...deps, env: { ...deps.env, [env.tmuxPane]: pane } });
    expect(world.readDecision).not.toHaveBeenCalled();
  });

  it('refuses a different prefix', async () => {
    const world = await validRelay();
    storePrefix(world.deps, 'Different prefix');
    await refuses(world, 4, 'prefix differs from its record', 'factory guard confirm', using(world, guardIds.safetyBlock));
  });

  it.each([
    ['PreToolUse', 'is busy', 'Wait until it waits at its prompt'],
    ['Notification', 'waits for an answer', 'answer the dialog'],
  ] as const)('refuses a last-seen line with %s', async (event, message, hint) => {
    const world = await validRelay();
    valueOf(await writeLastSeen(world.deps, HOME, SESSION, { kind: 'event', event }, WORKER));
    await refuses(world, 1, message, hint, using(world, guardIds.paneSafety));
  });

  it('refuses a numbered choice list', async () => {
    const world = await validRelay({ pane: { screen: 'Choose:\n❯ 1. Yes\n  2. No' } });
    await refuses(world, 3, 'numbered list of choices', 'answer the dialog there', using(world, guardIds.paneSafety));
  });

  it('refuses a pane in view', async () => {
    const world = await validRelay();
    valueOf(await summonWorker(world.deps, { home: HOME, session: NODE, workerId: WORKER, minutes: 15 }));
    await refuses(world, 3, 'a summon shows it there', 'factory layout', using(world, guardIds.paneSafety));
  });

  it('refuses an unbound pane', async () => {
    const world = await validRelay({ pane: { command: ['sh'] } });
    await refuses(world, 4, 'did not start it for that worker', 'clear its mark', using(world, guardIds.paneSafety));
  });
});

const outside = (deps: FakeDeps): FakeDeps => ({ ...deps, stdinIsTTY: true, stdoutIsTTY: true,
  env: { ...deps.env, [env.session]: undefined, [env.tmuxPane]: undefined },
});

it('allows an owner terminal outside a session', async () => {
  const world = await validRelay();
  expect((await confirms(world, outside(world.deps))).ok).toBe(true);
});

it.each([
  ['Claude Code', (deps: FakeDeps) => ({ ...deps, env: { ...deps.env, [env.claudeCode]: '1' } }), 'Claude Code session cannot'],
  ['no input terminal', (deps: FakeDeps) => ({ ...deps, stdinIsTTY: false }), 'needs a terminal window for input'],
  ['no output terminal', (deps: FakeDeps) => ({ ...deps, stdoutIsTTY: false }), 'needs a terminal window for output'],
] as const)('refuses an outside caller with %s', async (_name, change, message) => {
  const world = await validRelay();
  await refuses(world, 4, message, 'in your own terminal window', change(outside(world.deps)));
  expect(world.readDecision).not.toHaveBeenCalled();
});

it.each([false, true])('refuses a missing prefix before the kind check: command=%s', async (command) => {
  const world = await validRelay();
  world.deps.files.delete(GUARD_STORE);
  if (command) world.proof({ ...RECORD, requestKind: 'command' });
  await refuses(world, 4, 'prefix has no confirmation record', 'factory guard confirm');
});

it('refuses a prefix with no store place', async () => {
  const world = await validRelay();
  await refuses(world, 4, 'prefix has no confirmation record', 'factory guard confirm', {
    ...world.deps, env: { ...world.deps.env, [env.stateHome]: undefined },
  });
});

it('refuses a guard store fault even when safety-block is off', async () => {
  const world = await validRelay();
  world.deps.seed(GUARD_STORE, '{');
  await refuses(world, 4, 'guard store', 'factory doctor', withOff(world.deps, guardIds.safetyBlock));
});

it('refuses a guard record with a different folder case', async () => {
  const world = await validRelay();
  storePrefix(world.deps, world.config.core.owner.prefix, HOME.toUpperCase());
  await refuses(world, 4, 'exact letter case', 'factory doctor');
});

it.each([
  ['too long', { display: 'x'.repeat(301 - EXPECTED_LINE.length + 'Test Owner'.length) }, 1, 'more than 300 signs'],
  ['not ASCII', { display: 'Tést Owner' }, 1, 'not a printable ASCII sign'],
  ['starts with !', { prefix: '!{owner}' }, 4, 'must not start'],
  ['starts with /', { prefix: '/{owner}' }, 4, 'must not start'],
  ['starts with @', { prefix: '@{owner}' }, 4, 'must not start'],
  ['contains @', { display: 'Test@Owner' }, 4, 'must not contain @'],
] as const)('refuses a line that is %s before a worker pane read', async (_name, setup, code, message) => {
  const world = await validRelay(setup);
  await refuses(world, code, message, 'owner.prefix');
  expect(world.order).toEqual([]);
  expect(world.tmux.commands().every((line) => !line.startsWith('list-panes') && !line.includes(PANE))).toBe(true);
});

it.each([false, true])('refuses a missing last-seen line before the final bind with pane safety off: %s', async (off) => {
  const world = await validRelay();
  world.deps.files.delete(LAST_SEEN);
  const using = off ? withOff(world.deps, guardIds.paneSafety) : world.deps;
  await refuses(world, 3, 'cannot use the last-seen line', 'Wait until the session reports', using);
  expect(world.order.filter((event) => event === 'bind')).toHaveLength(1);
});

it('refuses settings that changed after the session started', async () => {
  const world = await validRelay();
  world.deps.mtimes.set(SETTINGS, NOW);
  await refuses(world, 3, 'changed after the session started', 'factory restart alpha');
});

it.each([
  [{ field: 1, value: '4778' }, 3, 'process of the pane %3 changed', 'Look at the pane %3 in tmux'],
  [{ field: 2, value: '1' }, 3, 'ended while the checks ran', 'factory worker resume alpha'],
] as const)('refuses a final pane read that shows %s', async (rebind, code, message, hint) => {
  const world = await validRelay({ rebind });
  await refuses(world, code, message, hint);
  expect(world.order).toEqual(['bind', 'last seen', 'screen', 'bind']);
});

it('refuses tmux mode only when pane safety is on, and names the skipped check otherwise', async () => {
  const tmux = { panesInMode: [PANE] };
  await refuses(await validRelay({ tmux }), 3, 'is in a mode of tmux', 'Press q');
  const world = await validRelay({ tmux });
  const result = await confirms(world, withOff(world.deps, guardIds.paneSafety));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const output = relayOutput(result.value);
  expect(output.lines).toHaveLength(3);
  expect(output.lines[2]?.text).toContain('pane-safety is off');
  expect(output.lines[2]?.text).toContain('tmux mode check');
});

it('does not confirm on a turn that came during the screen check before the keys', async () => {
  const world = await validRelay();
  const deps: FakeDeps = { ...world.deps, run: async (command, args, options) => {
    if (command === 'tmux' && args[0] === 'capture-pane') {
      await world.deps.sleep(10);
      valueOf(await writeLastSeen(world.deps, HOME, SESSION, { kind: 'event', event: 'Stop' }, WORKER));
      await world.deps.sleep(10);
    }
    return world.deps.run(command, args, options);
  } };
  expectRefusal(await world.run(deps), 3, 'typed, not confirmed', 'factory worker summon alpha');
  expect(sendCalls(world)).toHaveLength(1);
});

it.each(['PreToolUse', 'Stop'] as const)('confirms on a later %s from the same session', async (event) => {
  const world = await validRelay();
  expect((await confirms(world, world.deps, event)).ok).toBe(true);
  expect(world.deps.sleeps).toEqual([1000]);
});

it.each([
  ['an older turn', undefined, 'came before the typed line'],
  ['another session', writesLine('UserPromptSubmit', OTHER_SESSION), 'another session'],
  ['a notification from another session', writesLine('Notification', OTHER_SESSION), 'another session'],
  ['Notification', writesLine('Notification'), 'last event is Notification'],
  ['SessionStart', writesLine('SessionStart'), 'last event is SessionStart'],
] as const)('does not confirm on %s', async (_name, action, reason) => {
  const world = await validRelay();
  const deps = action === undefined ? world.deps : withProgram(world.deps, world.tmux, atWait(1, action));
  const result = await world.run(deps);
  expectRefusal(result, 3, 'typed, not confirmed', 'factory worker summon alpha');
  if (!result.ok) {
    expect(result.error.message).toContain(reason);
    expect(result.error.hint).toContain('types the owner line again');
  }
  expect(world.deps.sleeps).toEqual(Array.from({ length: 10 }, () => 1000));
  expect(sendCalls(world)).toHaveLength(1);
});

it('refuses after the pane ends during confirmation', async () => {
  const world = await validRelay();
  const result = await world.run(withProgram(world.deps, world.tmux, atWait(1, endsPane)));
  expectRefusal(result, 1, 'pane %3 of the worker alpha is gone', 'factory worker resume alpha');
  expect(world.deps.sleeps).toEqual([1000]);
  expect(sendCalls(world)).toHaveLength(1);
});

it('makes one clean-up call after the key run fails and does not poll for confirmation', async () => {
  const world = await validRelay({ tmux: { failing: 'send-keys' } });
  const result = await world.run();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(exitCodeOf[result.error.kind]).toBe(1);
    expect(result.error.message).toContain('send-keys failed');
  }
  expect(sendCalls(world)).toHaveLength(2);
  expect(sendCalls(world)[1]?.args).toEqual(['send-keys', '-t', PANE, 'C-u']);
  expect(world.deps.sleeps).toEqual([]);
});
