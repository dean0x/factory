import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/blocks/managed.js';
import type { RequestProof } from '../../src/board/decide.js';
import { exitCodeOf, failure, safetyRefusal, type CliResult } from '../../src/cli/errors.js';
import { commandTable } from '../../src/cli/table.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { hookSettingsPlaceOf, ownSettingsEntries } from '../../src/core/claude-settings.js';
import { ok } from '../../src/core/result.js';
import { guardSourceOf } from '../../src/guards/effective.js';
import { launchArgv } from '../../src/launch/argv.js';
import { paneBindArgs } from '../../src/launch/tmux.js';
import { decideProofReasons, env, files, guardIds, guardRecords, guardValues, type HookEvent } from '../../src/names.js';
import { hasOwnerPrefix } from '../../src/safety/owner-prefix.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { relayOutput, relayWorker, type RelayOutcome } from '../../src/workers/relay.js';
import { summonWorker } from '../../src/workers/slot.js';
import { APPROVAL_ID, APPROVAL_LINK, approvalRequest } from '../helpers/approval-go.js';
import { createFakeDeps, exited, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { GUARD_STORE } from '../helpers/guarded-node.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { COORDINATOR_PANE, HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture } from '../helpers/tmux-fake.js';
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
  const order: string[] = [];
  const bind = paneBindArgs(PANE, WORKER);
  if (!bind.ok) throw new Error(bind.error);
  let binds = 0;
  const deps = withFsWatch(createFakeDeps({ cwd: '/w', os: 'darwin', now: new Date(NOW - 60_000),
    env: { PATH: '/bin', [env.stateHome]: '/state', [env.tmuxPane]: COORDINATOR_PANE, [env.session]: NODE },
    run: (call) => {
      if (call.command === 'ps') return exited(0, '10:00\n');
      if (call.command !== 'tmux') return failure('unexpected command');
      if (call.args[0] === 'send-keys') order.push('keys');
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

const expectRefusal = (result: CliResult<RelayOutcome>, code: number, message: string, remedy: string) => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(exitCodeOf[result.error.kind]).toBe(code);
  expect(result.error.message).toContain(message);
  expect(result.error.hint).toContain(remedy);
};

const refuses = async (world: World, code: number, message: string, remedy: string, using = world.deps) => {
  const result = await world.run(using);
  expectRefusal(result, code, message, remedy);
  expect(sendCalls(world)).toEqual([]);
  return result;
};

const confirms = (world: World, using = world.deps, event: HookEvent = 'UserPromptSubmit') =>
  world.run(withProgram(using, world.tmux, atWait(1, writesLine(event))));

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
  expect(world.order.slice(0, world.order.indexOf('keys') + 1)).toEqual(['bind', 'last seen', 'bind', 'keys']);
  expect(output.lines).toHaveLength(2);
  expect(output.lines[0]).toMatchObject({ level: 'ok', text: expect.stringMatching(/D-1.*go.*alpha.*%3/) });
  expect(output.json).toEqual({ schema: 'factory.worker-relay/v1', id: WORKER, decision: 'D-1', option: 'go', pane: PANE, confirmed: true });
  expect(JSON.stringify(output)).not.toMatch(/Private|Test Owner|\.factory/);
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

it('refuses a missing last-seen line before the final bind', async () => {
  const world = await validRelay();
  world.deps.files.delete(LAST_SEEN);
  await refuses(world, 3, 'cannot use the last-seen line', 'Wait until the session reports');
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
  expect(world.order).toEqual(['bind', 'last seen', 'bind']);
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
