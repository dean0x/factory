import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOutput } from '../../src/core/deps.js';
import { failure, type CliResult } from '../../src/cli/errors.js';
import { guardSourceOf } from '../../src/guards/effective.js';
import { guardIds, guardValues, refreshRunPath, refreshText, refreshWait, type HookEvent } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeCoordinatorSession, writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import {
  cancelRefreshRun, claimRefreshRun, readRefreshRun, scheduleRefreshRun, updateRefreshRun, type RefreshWorkerPlan,
} from '../../src/workers/refresh-record.js';
import { actCoordinator, actWorker, pollOnce, refreshExitCode, runRefresh } from '../../src/workers/refresh-run.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { createFakeDeps, exited, missingProgram, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { ownSettingsWithRules, seedOwnHooks, seedUnacceptedSetup, settingsFileOf, STATE_ENV } from '../helpers/role-delivery.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { startCommandText, tmuxHandler, type PaneFixture, type TmuxFixture } from '../helpers/tmux-fake.js';
import { coordinatorWordsOf, launchWordsOf } from '../helpers/worker-launch-words.js';

const HOME = '/test/node';
const NODE = 'demo';
const FILES = layoutOf(HOME);
const COORDINATOR_PID = 4000;
const WORKER_PID = 4800;
const ALPHA = '00000000-0000-4000-8000-000000000001';
const BETA = '00000000-0000-4000-8000-000000000002';
const COORDINATOR = '00000000-0000-4000-8000-000000000003';
const NEXT = '00000000-0000-4000-8000-000000000004';
const COPY = `${HOME}/work-copies/web/alpha`;
const CONFIG = sampleConfig();

const value = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const hook = async (deps: FakeDeps, session: string, marker: string, event: HookEvent) =>
  value(await writeLastSeen(deps, HOME, session, { kind: 'event', event }, marker));

const psStart = (date: Date): string => {
  const [weekday, day, month, year, time] = date.toUTCString().replace(',', '').split(' ');
  return `${weekday} ${month} ${day} ${time} ${year}\n`;
};

const workerPane = (id: string, pid: number): PaneFixture => ({
  session: NODE, pid, options: { '@worker': id }, command: launchWordsOf(HOME, id),
});

interface Setup {
  readonly events?: Readonly<Record<string, HookEvent>>;
  readonly tmux?: TmuxFixture;
  readonly coordinatorPane?: boolean;
  readonly skipped?: RefreshWorkerPlan['skipped'];
  readonly workerHook?: HookEvent | null;
  readonly coordinatorHook?: HookEvent | null;
  readonly termStays?: boolean;
  readonly newProcess?: number;
  readonly timing?: 'normal' | 'frozen';
}

const make = async (setup: Setup = {}) => {
  const events = setup.events ?? { alpha: 'Stop' };
  const workerIds = Object.keys(events);
  const workerSession = new Map([['alpha', ALPHA], ['beta', BETA]]);
  const panes = workerIds.map((id, i) => workerPane(id, WORKER_PID + i));
  const { handler, log } = tmuxHandler({
    sessions: { [NODE]: HOME, foreign: '/test/other' },
    coordinatorCommands: { [NODE]: coordinatorWordsOf(HOME, NODE) },
    panes: [...panes, { ...workerPane('intruder', 4999), session: 'foreign' }],
    ...setup.tmux,
  });
  const base = createFakeDeps({
    os: 'darwin', termEndsAfterChecks: setup.termStays === true ? 31 : 0,
    env: { ...STATE_ENV, PATH: '/bin', FACTORY_HOME: '/test/other', FACTORY_SESSION: 'foreign', TMUX_PANE: '%0' },
    fetch: () => failure('no answer'),
  });
  const trace: string[] = [];
  const calls: RunCall[] = [];
  const atStop: unknown[] = [];
  const coordinator = log.panes().find((row) => row.session === NODE && row.window === 'view');
  if (coordinator === undefined) throw new Error('fixture has no coordinator');
  let respawnWords: readonly string[] | null = null;
  let onRun: (call: RunCall) => Promise<CliResult<RunOutput> | undefined> = async () => undefined;
  let onSleep: (ms: number) => Promise<void> = async () => undefined;
  const deps: FakeDeps = {
    ...base,
    run: async (command, args, options) => {
      const call = { command, args, cwd: options?.cwd };
      calls.push(call);
      const override = await onRun(call);
      if (override !== undefined) return override;
      if (command === 'ps' && args[1] === 'lstart=') return exited(0, 'Wed Jan  2 03:00:00 2030\n');
      if (command === 'env' && args[0] === 'TZ=UTC0' && args[2] === '-o' && args[3] === 'lstart=') {
        return exited(0, Number(args[5]) === setup.newProcess ? psStart(base.now()) : 'Wed Jan  2 03:00:00 2030\n');
      }
      if (command !== 'tmux') return missingProgram(command);
      if (args[0] === 'respawn-pane') {
        trace.push('respawn');
        respawnWords = args.slice(args.indexOf('--') + 1);
        return exited(0);
      }
      const reply = handler(call);
      if (reply.ok && reply.value.exitCode === 0 && args[0] === 'display-message' && args[3]?.includes(':view.{left}')) {
        if (respawnWords !== null) return exited(0, `${coordinator.id}|9999|0|1|${startCommandText(respawnWords)}\n`);
        if (base.terminated.includes(coordinator.pid)) {
          trace.push('dead read');
          return exited(0, `${coordinator.id}|${coordinator.pid}|1|1|${startCommandText(coordinator.command)}\n`);
        }
      }
      return reply;
    },
    sleep: async (ms) => {
      if (setup.timing === 'frozen') base.sleeps.push(ms);
      else await base.sleep(ms);
      await onSleep(ms);
      for (const pane of log.panes()) {
        const id = pane.options['@worker'];
        if (id === undefined || pane.command.indexOf('--resume') < 0 || setup.workerHook === null) continue;
        const resume = pane.command[pane.command.indexOf('--resume') + 1];
        if (resume !== undefined) await hook(deps, resume, id, setup.workerHook ?? 'UserPromptSubmit');
      }
      if (respawnWords !== null && setup.coordinatorHook !== null) {
        await hook(deps, COORDINATOR, NODE, setup.coordinatorHook ?? 'UserPromptSubmit');
      }
    },
    terminate: (pid) => {
      trace.push(`TERM ${pid}`);
      const stored = base.files.get(join(HOME, refreshRunPath));
      if (stored !== undefined) atStop.push(JSON.parse(stored));
      return base.terminate(pid);
    },
  };
  deps.seedDir(FILES.stateDir);
  deps.seedDir(`${HOME}/web`);
  seedOwnHooks(deps, FILES.coordinatorDir, HOME);
  value(await writeCoordinatorSession(deps, HOME, COORDINATOR));
  await hook(deps, COORDINATOR, NODE, 'Stop');
  for (const [id, event] of Object.entries(events)) {
    const session = workerSession.get(id);
    if (session === undefined) throw new Error('fixture has no worker session');
    const workCopy = `${HOME}/work-copies/web/${id}`;
    seedOwnHooks(deps, workCopy, HOME);
    value(await writeWorkerRecord(deps, HOME, { id, project: 'web', workCopy, branch: `worker/${id}` }));
    value(await writeWorkerSession(deps, HOME, id, session));
    await hook(deps, session, id, event);
  }
  const skipped = setup.skipped ?? [];
  const scheduled = value(await scheduleRefreshRun(deps, HOME, {
    caller: setup.coordinatorPane === true ? 'pane' : 'terminal', coordinatorPane: setup.coordinatorPane ?? false,
  }, { workerIds: workerIds.filter((id) => !skipped.some((entry) => entry.id === id)), skipped }));
  return {
    deps, log, calls, trace, atStop, coordinator, request: { home: HOME, config: CONFIG, token: scheduled.token },
    onRun: (fn: typeof onRun) => { onRun = fn; }, onSleep: (fn: typeof onSleep) => { onSleep = fn; },
    tmux: (args: readonly string[]) => value(handler({ command: 'tmux', args, cwd: undefined })),
  };
};

type Lab = Awaited<ReturnType<typeof make>>;
const claimed = (lab: Lab) => claimRefreshRun(lab.deps, HOME, lab.request.token);
const run = (lab: Lab) => runRefresh(lab.deps, lab.request);
const finish = async (lab: Lab) => value(await run(lab));
const resumes = ({ calls }: Lab) => calls.filter(({ args }) => args[0] === 'split-window' || args[0] === 'respawn-pane');
const lists = ({ log }: Lab) => log.commands().filter((text) => text.startsWith('list-panes '));
const found = (call: RunCall, command: string) => call.command === 'tmux' && call.args[0] === command;

const expectFault = (result: Awaited<ReturnType<typeof finish>>, id: string, warning: string, remedy: string) => {
  expect(result.outcomes).toContainEqual(expect.objectContaining({
    id, status: 'fault', warning: expect.stringContaining(warning), remedy: expect.stringContaining(remedy),
  }));
};

describe('refresh runner', () => {
  it('completes a refresh and saves the final run record', async () => {
    const lab = await make({ events: {} });
    const record = await finish(lab);
    expect(record).toMatchObject({ state: 'done', outcomes: [{ id: NODE, status: 'resumed' }] });
    expect(value(await readRefreshRun(lab.deps, HOME))).toEqual(record);
  });

  it('reads the pane list once per poll and polls busy workers again after ten seconds', async () => {
    const lab = await make({ events: { alpha: 'PreToolUse' } });
    const poll = value(await pollOnce(lab.deps, lab.request, ['alpha']));
    expect(poll.workers.map(({ id, ready }) => ({ id, ready }))).toEqual([{ id: 'alpha', ready: false }]);
    expect(lists(lab)).toHaveLength(1);
    lab.onSleep(async (ms) => {
      if (ms !== refreshWait.intervalMs) return;
      expect(lab.deps.terminated).toEqual([]);
      await hook(lab.deps, ALPHA, 'alpha', 'Stop');
    });
    expect((await finish(lab)).outcomes.map(({ status }) => status)).toEqual(['resumed', 'resumed']);
    expect(lab.deps.sleeps[0]).toBe(10_000);
  });

  it('does not poll or stop a skipped worker even after it gets an owned session id', async () => {
    const skipped = {
      role: 'worker', id: 'beta', status: 'skipped', warning: 'The worker beta has no owned session id.', remedy: 'Check its pane.',
    } as const;
    const lab = await make({ events: { alpha: 'PreToolUse', beta: 'PreToolUse' }, skipped: [skipped] });
    await hook(lab.deps, NEXT, 'other', 'PreToolUse');
    value(await writeWorkerSession(lab.deps, HOME, 'beta', NEXT));
    const reads: string[] = [];
    const fs = { ...lab.deps.fs, readTextLimited: (...args: Parameters<FakeDeps['fs']['readTextLimited']>) => {
      reads.push(args[0]);
      return lab.deps.fs.readTextLimited(...args);
    } };
    lab.onSleep(async (ms) => {
      if (ms !== refreshWait.intervalMs) return;
      await hook(lab.deps, ALPHA, 'alpha', 'Stop');
      await hook(lab.deps, BETA, 'beta', 'Stop');
      value(await writeWorkerSession(lab.deps, HOME, 'beta', BETA));
    });
    const record = value(await runRefresh({ ...lab.deps, fs }, lab.request));
    expect(lab.deps.terminated).toEqual([WORKER_PID, COORDINATOR_PID]);
    expect(reads).toContain(join(FILES.heartbeatDir, ALPHA));
    expect(reads).not.toContain(join(FILES.heartbeatDir, NEXT));
    expect(reads).not.toContain(join(FILES.heartbeatDir, BETA));
    expect(record.outcomes).toContainEqual(skipped);
  });

  it('resumes an idle worker whose only report is SessionStart in its start second', async () => {
    const lab = await make({ events: { alpha: 'SessionStart' } });
    value(await cancelRefreshRun(lab.deps, HOME));
    lab.deps.advance(900);
    const record = value(await scheduleRefreshRun(lab.deps, HOME, { caller: 'terminal', coordinatorPane: false }, {
      workerIds: ['alpha'], skipped: [],
    }));
    lab.deps.advance(500);
    lab.onRun(async ({ command, args }) => {
      if (args.at(-1) !== String(WORKER_PID)) return undefined;
      if (command === 'env' && args.includes('lstart=')) return exited(0, 'Wed Jan  2 03:04:05 2030\n');
      return undefined;
    });
    const result = value(await runRefresh(lab.deps, { ...lab.request, token: record.token }));
    expect(result.outcomes).toContainEqual({ role: 'worker', id: 'alpha', status: 'resumed' });
    expect(lab.deps.terminated).toContain(WORKER_PID);
  });

  it('leaves a worker pending if it turns busy just before the idle-only stop', async () => {
    const lab = await make();
    value(await claimed(lab));
    const poll = value(await pollOnce(lab.deps, lab.request, ['alpha']));
    lab.onRun(async ({ command, args }) => {
      if (command === 'env' && args.includes('lstart=')) await hook(lab.deps, ALPHA, 'alpha', 'PreToolUse');
      return undefined;
    });
    expect(value(await actWorker(lab.deps, lab.request, 'alpha', poll.panes))).toBeNull();
    expect(lab.deps.terminated).toEqual([]);
    expect(value(await readRefreshRun(lab.deps, HOME))).toMatchObject({ acting: null, outcomes: [] });
  });

  it.each(['Notification', 'PreCompact'] as const)('leaves a worker with %s alone at the shared worker cap', async (event) => {
    const lab = await make({ events: { alpha: event, beta: 'Stop' } });
    const record = await finish(lab);
    expect(lab.deps.terminated).toEqual([WORKER_PID + 1, COORDINATOR_PID]);
    expect(record.deadlines.workerMs).toBe(record.startedAtMs + 3_600_000);
    expectFault(record, 'alpha', 'not idle', 'factory refresh');
    expect(refreshExitCode(record)).toBe(1);
    expect(record.outcomes).toContainEqual({ role: 'worker', id: 'beta', status: 'resumed' });
  });

  it('bounds both phases even if the clock does not advance', async () => {
    const lab = await make({ events: { alpha: 'PreToolUse' }, coordinatorPane: true, timing: 'frozen' });
    const record = await finish(lab);
    expect(lab.deps.sleeps).toEqual(Array.from({ length: 720 }, () => 10_000));
    expect(record.deadlines.coordinatorMs).toBe(record.startedAtMs + 3_600_000);
    expect(lists(lab)).toHaveLength(722);
    expectFault(record, 'alpha', 'not idle', 'factory refresh');
    expectFault(record, NODE, 'not idle', 'factory refresh');
    expect(lab.deps.terminated).toEqual([]);
  });

  it.each([guardValues.on, guardValues.off])('chooses the same targets and enforces idle with every guard %s', async (guard) => {
    const lab = await make({ events: { alpha: 'PreToolUse', beta: 'Stop' } });
    const deps = { ...lab.deps, guards: guardSourceOf({
      home: HOME, state: null, values: Object.fromEntries(Object.values(guardIds).map((id) => [id, guard])),
    }) };
    const workerPane = lab.log.panes().find(({ pid }) => pid === WORKER_PID + 1);
    expect(workerPane).toBeDefined();
    const record = value(await runRefresh({ ...deps, env: { ...deps.env, TMUX_PANE: workerPane?.id } }, lab.request));
    expect(lab.deps.terminated).toEqual([WORKER_PID + 1, COORDINATOR_PID]);
    expect(record.outcomes.map(({ id }) => id)).toEqual(['beta', 'alpha', NODE]);
  });

  it('re-reads the worker pointer after TERM and uses only owned launch words from the node', async () => {
    const lab = await make({ events: { alpha: 'Stop', beta: 'Stop' } });
    lab.onSleep(async () => {
      if (!lab.deps.terminated.includes(WORKER_PID) || resumes(lab).length !== 0) return;
      value(await writeWorkerSession(lab.deps, HOME, 'alpha', NEXT));
      await hook(lab.deps, NEXT, 'alpha', 'Stop');
    });
    const record = await finish(lab);
    expect(refreshExitCode(record)).toBe(0);
    expect(lab.trace).toEqual([`TERM ${WORKER_PID}`, `TERM ${WORKER_PID + 1}`, `TERM ${COORDINATOR_PID}`, 'dead read', 'respawn']);
    expect(resumes(lab).at(-1)?.args.slice(0, 5)).toEqual(['respawn-pane', '-t', lab.coordinator.id, '-c', FILES.coordinatorDir]);
    expect(lab.atStop).toMatchObject([
      { actingRole: 'worker', acting: 'alpha', outcomes: [] },
      { actingRole: 'worker', acting: 'beta', outcomes: [{ id: 'alpha', status: 'resumed' }] },
      { actingRole: 'coordinator', acting: NODE, outcomes: [{ id: 'alpha', status: 'resumed' }, { id: 'beta', status: 'resumed' }] },
    ]);
    const argv = resumes(lab).map(({ args }) => args.slice(args.indexOf('--') + 1));
    expect(argv.map((words) => words[words.indexOf('--resume') + 1])).toEqual([NEXT, BETA, COORDINATOR]);
    for (const words of argv) {
      expect(words.filter((word) => word === refreshText.continue)).toHaveLength(1);
      expect(words.indexOf(refreshText.continue)).toBeLessThan(words.indexOf('--add-dir'));
      expect(words).not.toContain('/test/other');
    }
    expect(lab.log.typed()).toEqual([]);
    expect(lab.deps.written).toEqual([]);
    expect(lab.deps.warned).toEqual([]);
    expect(lab.log.sessions().get('foreign')).toBe('/test/other');
  });

  it.each(['marker', 'pointer'] as const)('skips a worker whose %s does not prove ownership', async (broken) => {
    const lab = await make({ events: { alpha: 'Stop', beta: 'Stop' } });
    if (broken === 'marker') {
      await hook(lab.deps, NEXT, 'decoy', 'Stop');
      value(await writeWorkerSession(lab.deps, HOME, 'alpha', NEXT));
    } else value(await writeWorkerSession(lab.deps, HOME, 'beta', ALPHA));
    const record = await finish(lab);
    expectFault(record, 'alpha', 'no session id', 'factory worker resume alpha');
    expect(lab.deps.terminated).not.toContain(WORKER_PID);
    expect(lab.deps.terminated).toContain(COORDINATOR_PID);
  });

  it.each(['binding', 'copy', 'settings', 'role', 'proxy'] as const)('checks the worker %s before any stop', async (check) => {
    const lab = await make();
    let config = CONFIG;
    if (check === 'binding') lab.onRun(async ({ args }) => args[0] === 'display-message' && args[4]?.includes('@worker')
      ? exited(0, `${args[3]}|4800|0|1|0|0|0|sh\n`) : undefined);
    if (check === 'copy') value(await lab.deps.fs.remove(COPY));
    if (check === 'settings') lab.deps.seed(settingsFileOf(COPY), '{}');
    if (check === 'role') seedUnacceptedSetup(lab.deps, HOME, 'Text that the owner did not accept.');
    if (check === 'proxy') config = { ...CONFIG, core: { ...CONFIG.core, workers: { alpha: { proxy: 'p' } }, proxies: [
      { id: 'p', base_url: 'http://127.0.0.1:8899', health: '/health', on_fail: 'stop' },
    ] } };
    const record = value(await runRefresh(lab.deps, { ...lab.request, config }));
    const text = {
      binding: ['factory did not start', 'factory refresh'], copy: ['is not a folder', 'factory worker resume alpha'],
      settings: ['lack the events', 'factory upgrade'], role: ['setup file is not accepted', 'factory init'],
      proxy: ['does not answer', 'factory refresh'],
    } as const;
    const [warning, remedy] = text[check];
    expectFault(record, 'alpha', warning, remedy);
    expect(lab.deps.terminated).toEqual([COORDINATOR_PID]);
  });

  it('requires the busy hook even when the setup text guard is off', async () => {
    const lab = await make();
    const settings = ownSettingsWithRules(HOME, COPY);
    const { UserPromptSubmit: _, ...hooks } = settings.hooks;
    lab.deps.seed(settingsFileOf(COPY), JSON.stringify({ ...settings, hooks }));
    const guards = guardSourceOf({ home: HOME, state: null, values: { [guardIds.setupText]: guardValues.off } });
    const record = value(await runRefresh({ ...lab.deps, guards }, lab.request));
    expectFault(record, 'alpha', 'lack the events: UserPromptSubmit', 'factory upgrade');
    expect(lab.deps.terminated).toEqual([COORDINATOR_PID]);
  });

  it('rechecks the session owner after the poll', async () => {
    const lab = await make();
    value(await claimed(lab));
    const { panes } = value(await pollOnce(lab.deps, lab.request, ['alpha']));
    lab.log.sessions().set(NODE, '/test/other');
    const outcome = value(await actWorker(lab.deps, lab.request, 'alpha', panes));
    expect(outcome).toMatchObject({ warning: expect.stringContaining('belongs to another'), remedy: expect.stringContaining('factory shutdown') });
    expect(lab.deps.terminated).toEqual([]);
  });

  it.each(['live', 'pane', 'pid', 'mark', 'command'] as const)('refuses to respawn a coordinator when the dead read shows %s', async (mismatch) => {
    const lab = await make({ events: {} });
    const { coordinator: pane } = lab;
    lab.onRun(async (call) => {
      if (!found(call, 'display-message') || !lab.deps.terminated.includes(pane.pid)) return undefined;
      const fields = [mismatch === 'pane' ? '%90' : pane.id, mismatch === 'pid' ? 9000 : pane.pid,
        mismatch === 'live' ? 0 : 1, mismatch === 'mark' ? 0 : 1,
        mismatch === 'command' ? 'sh' : startCommandText(pane.command)];
      return exited(0, `${fields.join('|')}\n`);
    });
    const record = await finish(lab);
    expectFault(record, NODE, 'dead pane', 'factory start');
    expect(resumes(lab)).toEqual([]);
    expect(lab.deps.terminated).toEqual([pane.pid]);
  });

  it('sends only one TERM and never respawns a coordinator that does not end', async () => {
    const lab = await make({ events: {}, termStays: true });
    expectFault(await finish(lab), NODE, 'did not end', 'factory start');
    expect(lab.deps.terminated).toEqual([COORDINATOR_PID]);
    expect(resumes(lab)).toEqual([]);
  });

  it.each([WORKER_PID, COORDINATOR_PID])('never signals process %s if it started after the run', async (pid) => {
    const lab = await make({ newProcess: pid, coordinatorPane: true });
    lab.onSleep(async (ms) => {
      if (ms === refreshWait.intervalMs) await hook(lab.deps, COORDINATOR, NODE, 'Stop');
    });
    lab.deps.advance(1000);
    const record = await finish(lab);
    expectFault(record, pid === WORKER_PID ? 'alpha' : NODE, 'cannot confirm the pane process started before', 'factory refresh');
    expect(lab.deps.terminated).not.toContain(pid);
  });

  it('does not stop a coordinator on an idle report from an earlier process', async () => {
    const lab = await make({ events: {} });
    lab.deps.advance(10 * 60 * 60 * 1000);
    const coordinatorStart = psStart(new Date(lab.deps.now().getTime() - 60_000));
    lab.onRun(async ({ command, args }) =>
      command === 'env' && args.at(-1) === String(COORDINATOR_PID) ? exited(0, coordinatorStart) : undefined);
    const run = value(await scheduleRefreshRun(lab.deps, HOME, { caller: 'terminal', coordinatorPane: false }));
    const result = value(await runRefresh(lab.deps, { ...lab.request, token: run.token }));
    expectFault(result, NODE, 'not later than the start', 'factory refresh');
    expect(lab.deps.terminated).toEqual([]);
  });

  it('does not stop a coordinator that turns busy before its launch words are ready', async () => {
    const lab = await make({ events: {} });
    lab.onRun(async ({ command, args }) => {
      if (command === 'env' && args.includes('lstart=')) await hook(lab.deps, COORDINATOR, NODE, 'PreToolUse');
      return undefined;
    });
    expectFault(await finish(lab), NODE, 'not idle', 'factory refresh');
    expect(lab.deps.terminated).toEqual([]);
  });

  it('leaves the coordinator pending if its turn starts during the action marker write', async () => {
    const lab = await make({ events: {} });
    value(await claimed(lab));
    value(await updateRefreshRun(lab.deps, HOME, lab.request.token, { kind: 'wait-coordinator' }));
    const { fs } = lab.deps;
    const deps = { ...lab.deps, fs: { ...fs, rename: async (from: string, to: string) => {
      const result = await fs.rename(from, to);
      if (to === join(HOME, refreshRunPath)) await hook(lab.deps, COORDINATOR, NODE, 'UserPromptSubmit');
      return result;
    } } };
    expect(value(await actCoordinator(deps, lab.request))).toBeNull();
    expect(lab.deps.terminated).toEqual([]);
    expect(value(await readRefreshRun(lab.deps, HOME))).toMatchObject({ state: 'waiting', acting: null });
    expect(value(await cancelRefreshRun(lab.deps, HOME)).state).toBe('cancelled');
  });

  it('does not resume a coordinator id shared with a worker after TERM', async () => {
    const lab = await make();
    lab.onSleep(async () => {
      if (lab.deps.terminated.includes(COORDINATOR_PID)) value(await writeWorkerSession(lab.deps, HOME, 'alpha', COORDINATOR));
    });
    expectFault(await finish(lab), NODE, 'no longer owns the session id', 'factory start');
    expect(lab.trace).not.toContain('respawn');
  });

  it('does not create a second pane if a worker already runs at the resume step', async () => {
    const lab = await make();
    lab.onSleep(async () => {
      if (lab.deps.terminated.at(-1) !== WORKER_PID) return;
      const split = lab.tmux(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${NODE}:workers`, '--', ...launchWordsOf(HOME, 'alpha')]);
      lab.tmux(['set-option', '-p', '-t', split.stdout.trim(), '@worker', 'alpha']);
    });
    expectFault(await finish(lab), 'alpha', 'live pane', 'factory worker resume alpha');
    expect(resumes(lab).map(({ args }) => args[0])).toEqual(['respawn-pane']);
  });

  it('does not split if a live worker appears during the launch checks', async () => {
    const lab = await make();
    let added = false;
    lab.onRun(async ({ args }) => {
      if (added || args[0] !== 'list-panes' || !args.at(-1)?.includes('#{pane_pid}') || !lab.deps.terminated.includes(WORKER_PID)) return undefined;
      const before = lab.tmux(args);
      const split = lab.tmux(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${NODE}:workers`, '--', ...launchWordsOf(HOME, 'alpha')]);
      lab.tmux(['set-option', '-p', '-t', split.stdout.trim(), '@worker', 'alpha']);
      added = true;
      return exited(before.exitCode, before.stdout, before.stderr);
    });
    expectFault(await finish(lab), 'alpha', 'live pane', 'factory worker resume alpha');
    expect(resumes(lab).map(({ args }) => args[0])).toEqual(['respawn-pane']);
  });

  it.each([null, 'SessionStart'] as const)('does not confirm the worker continue line on %s', async (workerHook) => {
    const lab = await make({ workerHook });
    const record = await finish(lab);
    expectFault(record, 'alpha', 'not confirmed', 'factory worker resume alpha');
    expect(record.outcomes.at(-1)).toEqual({ role: 'coordinator', id: NODE, status: 'resumed' });
  });

  it('keeps the coordinator live if the worker needs an answer to a folder trust question', async () => {
    const lab = await make({ workerHook: null, tmux: { newPaneScreen: 'Do you trust this folder?\n❯ 1. Yes\n  2. No\n' } });
    const record = await finish(lab);
    expect(record.outcomes).toEqual([expect.objectContaining({ id: 'alpha', status: 'trust-wait', remedy: expect.stringContaining('answers each folder trust question') })]);
    expect(lab.deps.terminated).toEqual([WORKER_PID]);
    expect(refreshExitCode(record)).toBe(3);
  });

  it.each(['SessionStart', 'Notification'] as const)('keeps the coordinator live when a folder question holds the line after %s', async (workerHook) => {
    const screen = 'Adding a new directory\n/project\n\n❯ 1. Yes\n  2. No\n';
    const lab = await make({ workerHook, tmux: { newPaneScreen: screen } });
    const record = await finish(lab);
    expect(record.outcomes).toEqual([expect.objectContaining({ status: 'trust-wait', remedy: expect.stringContaining('answers each folder trust question') })]);
    expect(lab.deps.terminated).toEqual([WORKER_PID]);
    expect(lab.log.typed()).toEqual([]);
  });

  it('names the coordinator pane when a folder question holds its continue line', async () => {
    const lab = await make({ events: {}, coordinatorHook: 'SessionStart' });
    lab.onRun(async (call) => found(call, 'capture-pane') ? exited(0, 'Do you trust this folder?\n❯ 1. Yes\n  2. No\n') : undefined);
    const run = await finish(lab);
    expect(run.outcomes).toEqual([expect.objectContaining({ id: NODE, status: 'trust-wait', remedy: expect.stringContaining(`pane ${lab.coordinator.id}`) })]);
    expect(refreshExitCode(run)).toBe(3);
    expect(lab.log.typed()).toEqual([]);
  });

  it('records the remedy if a coordinator does not confirm its continue line', async () => {
    const lab = await make({ events: {}, coordinatorHook: 'SessionStart' });
    const record = await finish(lab);
    expectFault(record, NODE, 'not confirmed', 'factory start');
    expect(value(await readRefreshRun(lab.deps, HOME))).toEqual(record);
  });

  it('fails the run if the tmux session ends during the idle wait', async () => {
    const lab = await make({ events: { alpha: 'PreToolUse' } });
    lab.onSleep(async () => { lab.tmux(['kill-session', '-t', `=${NODE}`]); });
    expect(await finish(lab)).toMatchObject({ state: 'failed', fault: { warning: expect.stringContaining('does not run') } });
    expect(lab.deps.terminated).toEqual([]);
  });

  it('ends at the next token check when cancelled before a coordinator stop', async () => {
    const lab = await make({ coordinatorPane: true });
    lab.onSleep(async (ms) => {
      if (ms !== refreshWait.intervalMs) return;
      await hook(lab.deps, COORDINATOR, NODE, 'Stop');
      value(await cancelRefreshRun(lab.deps, HOME));
    });
    expect((await finish(lab)).state).toBe('cancelled');
    expect(lab.deps.terminated).toEqual([WORKER_PID]);
  });

  it('refuses cancel after the coordinator action marker and confirms the respawn', async () => {
    const lab = await make({ events: {} });
    value(await claimed(lab));
    value(await updateRefreshRun(lab.deps, HOME, lab.request.token, { kind: 'wait-coordinator' }));
    lab.onSleep(async () => {
      const cancel = await cancelRefreshRun(lab.deps, HOME);
      expect(cancel).toMatchObject({ ok: false, error: { message: 'cannot cancel refresh after the coordinator act has started' } });
    });
    expect(value(await actCoordinator(lab.deps, lab.request))).toEqual({ role: 'coordinator', id: NODE, status: 'resumed' });
    expect(lab.atStop[0]).toMatchObject({ acting: NODE, actingRole: 'coordinator' });
  });
});
