import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { CliResult } from '../../src/cli/errors.js';
import { guardIds, hookNames, refreshRunPath, refreshWait, type HookEvent } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { writeCoordinatorSession, writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { claimRefreshRun, readRefreshRun, scheduleRefreshRun, updateRefreshRun } from '../../src/workers/refresh-record.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { claudeFileText, noSetupTexts, workerFileText } from '../helpers/blocks.js';
import { createFakeDeps, exited, FAKE_PROGRAM_ARGV, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { FOLDER_ORIGINS, guardStatesOf, seedGuardedHome, type GuardedSetup } from '../helpers/guarded-node.js';
import { ownSettingsWithRules, seedOwnHooks, settingsFileOf, STATE_ENV } from '../helpers/role-delivery.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';
import { coordinatorWordsOf, launchWordsOf } from '../helpers/worker-launch-words.js';

const HOME = '/test/node with spaces';
const NODE = 'demo';
const COORDINATOR = '00000000-0000-4000-8000-000000000001';
const ALPHA = '00000000-0000-4000-8000-000000000002';
const FILES = layoutOf(HOME);
const SETTINGS = settingsFileOf(FILES.coordinatorDir);
const ALPHA_FILES = workerPathsOf(HOME, 'alpha');
const RUN_FILE = join(HOME, refreshRunPath);
const CALLER = { caller: 'pane', coordinatorPane: true } as const;
const ALPHA_PANE = { id: '%10', session: NODE, pid: 4800, options: { '@worker': 'alpha' }, command: launchWordsOf(HOME, 'alpha') };
const OTHER_PANE = { ...ALPHA_PANE, id: '%12', session: 'other' };

const value = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

interface Setup {
  readonly tmux?: TmuxFixture;
  readonly inside?: boolean;
  readonly claim?: boolean;
  readonly terminal?: boolean;
  readonly workerEvent?: HookEvent;
  readonly prefix?: string;
  readonly guards?: GuardedSetup;
}

const make = async (origin: 'own' | 'received', setup: Setup = {}) => {
  const { handler, log } = tmuxHandler({
    sessions: { [NODE]: HOME, other: '/test/other' },
    coordinatorCommands: { [NODE]: coordinatorWordsOf(HOME, NODE) },
    panes: [ALPHA_PANE, OTHER_PANE],
    ...setup.tmux,
  });
  const coordinator = log.panes().find((pane) => pane.session === NODE && pane.window === 'view');
  const git = gitHandler({ repos: { [HOME]: {}, [FILES.stateDir]: {} } });
  const calls: RunCall[] = [];
  const renderedBeforeWindow: string[] = [];
  const base = createFakeDeps({
    cwd: '/test', os: 'darwin', stdinIsTTY: setup.terminal ?? false, stdoutIsTTY: setup.terminal ?? false,
    prompt: () => ({ ok: true, value: 'y' }),
    env: { ...STATE_ENV, PATH: '/bin:/path with spaces', TMUX_PANE: setup.inside === true ? coordinator?.id : OTHER_PANE.id },
  });
  const deps: FakeDeps = {
    ...base,
    run: async (command, args, options) => {
      const call = { command, args, cwd: options?.cwd };
      calls.push(call);
      if (call.command === 'git') return git.handler(call);
      if (call.command === 'ps' && call.args[1] === 'lstart=') return exited(0, 'Wed Jan  2 03:00:00 2030\n');
      if (call.command === 'ps' && call.args[1] === 'etime=') return exited(0, '08:00:00\n');
      if (call.command === 'tmux' && call.args[0] === 'new-window') {
        renderedBeforeWindow.push(deps.files.get(SETTINGS) ?? '');
        if (setup.claim === true) {
          const record = value(await readRefreshRun(deps, HOME));
          if (record === null) throw new Error('no refresh record before the runner started');
          value(await claimRefreshRun(deps, HOME, record.token));
        }
      }
      return handler(call);
    },
  };
  const sample = sampleConfig();
  const config = {
    ...sample, core: { ...sample.core, owner: { display: 'factory', prefix: setup.prefix ?? sample.core.owner.prefix } },
  };
  seedGuardedHome(deps, HOME, { off: [], ...setup.guards, origin, config });
  for (const tool of ['tmux', 'claude']) deps.seed(`/bin/${tool}`, '');
  deps.seedDir(join(FILES.stateDir, '.git'));
  deps.seedDir(join(HOME, 'web'));
  deps.seed(FILES.claudeMd, claudeFileText(config));
  deps.seed(FILES.workerMd, workerFileText(config, noSetupTexts));
  seedOwnHooks(deps, FILES.coordinatorDir, HOME);
  const workCopy = join(HOME, 'work-copies/web/alpha');
  seedOwnHooks(deps, workCopy, HOME);
  value(await writeWorkerRecord(deps, HOME, { id: 'alpha', project: 'web', workCopy, branch: 'worker/alpha' }));
  value(await writeWorkerSession(deps, HOME, 'alpha', ALPHA));
  value(await writeLastSeen(deps, HOME, ALPHA, { kind: 'event', event: setup.workerEvent ?? 'Stop' }, 'alpha'));
  value(await writeCoordinatorSession(deps, HOME, COORDINATOR));
  value(await writeLastSeen(deps, HOME, COORDINATOR, { kind: 'event', event: 'Stop' }, NODE));
  const run = async (...args: string[]) => {
    const sink = captureSink();
    const code = await runCli(['refresh', '--home', HOME, ...args], deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };
  const changes = () => calls.filter(({ command, args }) => command === 'tmux' &&
    ['new-window', 'split-window', 'respawn-pane', 'kill-pane', 'send-keys', 'set-option'].includes(args[0] ?? ''));
  return { deps, run, changes, coordinator, renderedBeforeWindow };
};

type Lab = Awaited<ReturnType<typeof make>>;
const expectNoAct = (lab: Lab): void => {
  expect(lab.deps.terminated).toEqual([]);
  expect(lab.changes()).toEqual([]);
};

const refuse = async (lab: Lab, code: number, reason: string, remedy: string, ...args: string[]) => {
  const before = [...lab.deps.files];
  const result = await lab.run(...args);
  expect(result.code, result.err).toBe(code);
  expect(result.err).toContain(reason);
  expect(result.err).toContain(`"factory ${remedy}"`);
  expect([...lab.deps.files]).toEqual(before);
  expectNoAct(lab);
};

const warning = 'background tasks, crons and watches';
const draftLimit = 'Refresh cannot see unsent drafts or menus that send no hook event. Save drafts before refresh. Do not type in the panes until it ends.';

it('warns in the dry run that drafts and menus can go unseen', async () => {
  const lab = await make('own');
  const result = await lab.run('--dry-run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain(draftLimit);
});

it('shows pane, state, resume id state, order, caps and the folder count without a change', async () => {
  const lab = await make('own', { inside: true, terminal: true, workerEvent: 'PreToolUse' });
  const { statusLine: _, ...settings } = ownSettingsWithRules(HOME, FILES.coordinatorDir);
  lab.deps.seed(SETTINGS, JSON.stringify(settings));
  const before = [...lab.deps.files];
  const result = await lab.run('--dry-run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toMatch(/1\. worker alpha: pane %10; busy; resume id owned/);
  expect(result.out).toContain(`2. coordinator ${NODE}: pane ${lab.coordinator?.id}; idle; resume id owned`);
  for (const line of ['Caller: pane (coordinator)', '60 min per phase', '10 s', 'Folder questions: up to 5', warning]) {
    expect(result.out).toContain(line);
  }
  expect(result.out).not.toContain(OTHER_PANE.id);
  expect([...lab.deps.files]).toEqual(before);
  expect(lab.deps.prompts).toEqual([]);
  expectNoAct(lab);
});

it('shows only live targets, and names a bound pane with no record as skipped', async () => {
  const ghost = { ...ALPHA_PANE, id: '%11', options: { '@worker': 'ghost' }, command: launchWordsOf(HOME, 'ghost') };
  const lab = await make('received', { tmux: { panes: [ghost, OTHER_PANE] } });
  const result = await lab.run('--dry-run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).not.toContain('worker alpha');
  expect(result.out).toContain('worker ghost: pane %11; unknown; resume id missing; skip');
  expect(result.err).toContain('worker ghost has no record');
  expectNoAct(lab);
});

it('saves a skip for a live pane with no worker record without an idle wait', async () => {
  const ghost = { ...ALPHA_PANE, id: '%11', options: { '@worker': 'ghost' }, command: launchWordsOf(HOME, 'ghost') };
  const lab = await make('received', { tmux: { panes: [ghost, OTHER_PANE] } });
  await lab.run();
  expect(lab.deps.warned).toContain('The worker ghost has no record. Check its pane. Run "factory refresh" again.');
  expect(lab.deps.sleeps).not.toContain(refreshWait.intervalMs);
  expect(lab.deps.terminated).not.toContain(ghost.pid);
  expect(value(await readRefreshRun(lab.deps, HOME))).toMatchObject({
    workerIds: [],
    outcomes: expect.arrayContaining([{
      role: 'worker', id: 'ghost', status: 'skipped', warning: 'The worker ghost has no record.',
      remedy: 'Check its pane. Run "factory refresh" again.',
    }]),
  });
});

it('says that nothing runs when the node has no session', async () => {
  const lab = await make('received', { tmux: { sessions: {}, panes: [] } });
  const result = await lab.run();
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain('nothing runs');
  expect(lab.deps.files.has(RUN_FILE)).toBe(false);
  expectNoAct(lab);
});

it('renders start files before it starts one detached runner with argument words', async () => {
  const lab = await make('own', { inside: true, claim: true, terminal: true });
  const { statusLine: _, ...settings } = ownSettingsWithRules(HOME, FILES.coordinatorDir);
  lab.deps.seed(SETTINGS, JSON.stringify(settings));
  const result = await lab.run();
  const record = value(await readRefreshRun(lab.deps, HOME));
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain(`SCHEDULED: ${record?.runId}`);
  expect(result.out).toContain('"factory refresh --result"');
  expect(lab.deps.warned.join('\n')).toContain(warning);
  expect(result.out).not.toContain(record?.token);
  const windows = lab.changes().filter(({ args }) => args[0] === 'new-window');
  expect(windows).toHaveLength(1);
  const args = windows[0]?.args ?? [];
  expect(args.slice(args.indexOf('--') + 1)).toEqual([...FAKE_PROGRAM_ARGV, 'refresh', '--runner', record?.token, '--home', HOME]);
  expect(lab.changes().map(({ args }) => args[0])).toEqual(['new-window', 'set-option']);
  expect(lab.renderedBeforeWindow[0]).toContain('"statusLine"');
  expect(record).toMatchObject({ ...CALLER, state: 'waiting', workerIds: ['alpha'] });
  expect(lab.deps.terminated).toEqual([]);
});

it('saves a failed run when the runner does not claim in time', async () => {
  const lab = await make('own', { inside: true });
  const result = await lab.run();
  expect(result.code, result.err).toBe(1);
  expect(result.err).toContain('did not claim');
  expect(result.err).toContain('"factory refresh --result"');
  expect(lab.deps.sleeps).toEqual(Array.from({ length: refreshWait.claimChecks }, () => refreshWait.claimIntervalMs));
  expect(lab.deps.terminated).toEqual([]);
  expect(value(await readRefreshRun(lab.deps, HOME))).toMatchObject({
    state: 'failed', runner: null,
    fault: { warning: expect.stringContaining('did not claim'), remedy: 'Run "factory refresh" again.' },
  });
  const shown = await lab.run('--result');
  expect(shown.code).toBe(1);
  expect(shown.out).toContain('failed');
});

it('runs in the foreground from a pane of another session and returns the saved verdict', async () => {
  const lab = await make('received', { workerEvent: 'PreToolUse' });
  const result = await lab.run();
  expect(result.code, result.err).toBe(1);
  expect(lab.deps.warned.join('\n')).toContain(warning);
  expect(result.out).toContain('worker alpha was not idle');
  expect(lab.changes().map(({ args }) => args[0])).not.toContain('new-window');
  expect(value(await readRefreshRun(lab.deps, HOME))).toMatchObject({ caller: 'terminal', state: 'done' });
  expect(lab.deps.terminated).not.toContain(ALPHA_PANE.pid);
});

it('prints a saved fault, the acting worker and its remedy, but no token or runner identity', async () => {
  const lab = await make('received');
  const { token } = value(await scheduleRefreshRun(lab.deps, HOME, CALLER));
  value(await claimRefreshRun(lab.deps, HOME, token));
  value(await updateRefreshRun(lab.deps, HOME, token, { kind: 'acting', role: 'worker', id: 'alpha' }));
  value(await updateRefreshRun(lab.deps, HOME, token, {
    kind: 'failed', fault: { warning: 'the runner ended', remedy: 'Run "factory refresh --result".' },
  }));
  const text = await lab.run('--result');
  const json = await lab.run('--result', '--json');
  expect(text.code).toBe(1);
  expect(json.code).toBe(1);
  expect(text.out).toContain('the runner ended');
  expect(text.out).toContain('acting: worker alpha');
  expect(text.out).toContain('"factory worker resume alpha"');
  for (const out of [text.out, json.out]) {
    for (const hidden of [token, 'pid', 'startMs', String(lab.deps.pid)]) expect(out).not.toContain(hidden);
  }
  expectNoAct(lab);
});

it('cancels a scheduled run without a pane operation', async () => {
  const lab = await make('received');
  value(await scheduleRefreshRun(lab.deps, HOME, CALLER));
  expect((await lab.run('--cancel')).code).toBe(0);
  expect(value(await readRefreshRun(lab.deps, HOME))).toMatchObject({ state: 'cancelled' });
  expectNoAct(lab);
});

describe.each(FOLDER_ORIGINS)('refresh in %s', (_name, origin) => {
  it.each([{ form: 'plan', args: [] }, { form: 'dry run', args: ['--dry-run'] }])(
    'refuses a pane with a worker mark but no worker launch in the $form form', async ({ args }) => {
      const lab = await make(origin, { tmux: { panes: [{ ...ALPHA_PANE, command: ['bash'] }, OTHER_PANE] } });
      await refuse(lab, 4, 'start command does not hold the launch of the worker', 'refresh', ...args);
    },
  );

  it('refuses a second live pane of a worker', async () => {
    const lab = await make(origin, { tmux: { panes: [ALPHA_PANE, { ...ALPHA_PANE, id: '%11' }, OTHER_PANE] } });
    await refuse(lab, 2, 'worker alpha has 2 live panes', 'refresh');
  });

  it('refuses a session with another factory home', async () => {
    const lab = await make(origin, { tmux: { sessions: { [NODE]: '/test/foreign', other: '/test/other' } } });
    await refuse(lab, 4, 'belongs to another factory folder', 'refresh');
  });

  it.each(['absent', 'invalid', 'not owned', 'shared'])('refuses a coordinator id that is %s', async (problem) => {
    const lab = await make(origin);
    if (problem === 'absent') lab.deps.files.delete(FILES.coordinatorLastSessionFile);
    if (problem === 'invalid') lab.deps.seed(FILES.coordinatorLastSessionFile, 'bad id\n');
    if (problem === 'not owned') lab.deps.seed(FILES.coordinatorLastSessionFile, `${ALPHA}\n`);
    if (problem === 'shared') lab.deps.seed(ALPHA_FILES.lastSessionFile, `${COORDINATOR}\n`);
    await refuse(lab, 3, 'no owned coordinator session id', 'refresh');
  });

  it('refuses a dead coordinator pane', async () => {
    const lab = await make(origin, { tmux: { endedCoordinators: [NODE] } });
    await refuse(lab, 4, 'coordinator ended', 'start');
  });

  it.each(guardStatesOf(guardIds.paneSafety))('checks the coordinator hooks with pane safety %s', async (_state, guards) => {
    const lab = await make(origin, { guards });
    const { hooks, ...settings } = ownSettingsWithRules(HOME, FILES.coordinatorDir);
    const { [hookNames.events[0]]: _, ...remaining } = hooks;
    lab.deps.seed(SETTINGS, JSON.stringify({ ...settings, hooks: remaining }));
    await refuse(lab, 4, `lack the events: ${hookNames.events[0]}`, 'upgrade');
  });

  it.each(guardStatesOf(guardIds.safetyBlock))('checks the continue text with safety block %s', async (_state, guards) => {
    const lab = await make(origin, { prefix: '{owner}: this session was restarted', guards });
    await refuse(lab, 4, 'continue text contains the owner prefix', 'refresh');
  });

  it.each(guardStatesOf(guardIds.paneSafety))('keeps the gate and targets with pane safety %s', async (_state, guards) => {
    const lab = await make(origin, { guards, workerEvent: 'Notification' });
    const result = await lab.run('--dry-run');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('worker alpha: pane %10; waits; resume id owned');
    expect(result.out).not.toContain(OTHER_PANE.id);
    expectNoAct(lab);
  });

  it.each(['other marker', 'shared pointer'])('skips a worker with a %s', async (problem) => {
    const lab = await make(origin);
    if (problem === 'other marker') {
      const foreign = '00000000-0000-4000-8000-000000000004';
      value(await writeLastSeen(lab.deps, HOME, foreign, { kind: 'event', event: 'Stop' }, 'other'));
      lab.deps.seed(ALPHA_FILES.lastSessionFile, `${foreign}\n`);
    } else {
      const id = 'beta';
      value(await writeWorkerRecord(lab.deps, HOME, { id, project: 'web', workCopy: join(HOME, `work-copies/web/${id}`), branch: `worker/${id}` }));
      value(await writeWorkerSession(lab.deps, HOME, id, ALPHA));
    }
    const result = await lab.run('--dry-run');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('worker alpha: pane %10; idle; resume id not owned; skip');
    expect(result.err).toContain('worker alpha has no owned session id');
    expect(result.err).toContain('"factory refresh"');
    expectNoAct(lab);
  });

  it('refuses a needed settings write without a terminal', async () => {
    const lab = await make(origin, { inside: true });
    const { statusLine: _, ...settings } = ownSettingsWithRules(HOME, FILES.coordinatorDir);
    lab.deps.seed(SETTINGS, JSON.stringify(settings));
    await refuse(lab, 2, 'hook settings need a write', 'refresh');
  });

  it('refuses another run while the record is live and names both remedies', async () => {
    const lab = await make(origin);
    value(await scheduleRefreshRun(lab.deps, HOME, CALLER));
    const result = await lab.run('--dry-run');
    expect(result.code, result.err).toBe(1);
    expect(result.err).toContain('a refresh run is already live');
    for (const form of ['--result', '--cancel']) expect(result.err).toContain(`"factory refresh ${form}"`);
    expectNoAct(lab);
  });

  it.each(['unknown', 'used', 'extra word', 'extra flag', 'help flag', 'repeated home'])('refuses a runner with %s', async (problem) => {
    const lab = await make(origin);
    const { token } = value(await scheduleRefreshRun(lab.deps, HOME, CALLER));
    if (problem === 'used') value(await claimRefreshRun(lab.deps, HOME, token));
    const extra = { 'extra word': ['stray'], 'extra flag': ['--json'], 'help flag': ['--help'], 'repeated home': ['--home', HOME] };
    await refuse(lab, 4, problem === 'unknown' || problem === 'used' ? 'does not own a live token' : 'takes only',
      'refresh --result', '--runner', problem === 'unknown' ? '0'.repeat(32) : token, ...extra[problem as keyof typeof extra] ?? []);
  });

  it('refuses a runner if the owner prefix changed to match the continue text', async () => {
    const lab = await make(origin, { prefix: '{owner}: this session was restarted' });
    const { token } = value(await scheduleRefreshRun(lab.deps, HOME, CALLER));
    await refuse(lab, 4, 'continue text contains the owner prefix', 'refresh', '--runner', token);
  });

  it('refuses cancel after the coordinator act starts', async () => {
    const lab = await make(origin);
    const { token } = value(await scheduleRefreshRun(lab.deps, HOME, CALLER));
    value(await claimRefreshRun(lab.deps, HOME, token));
    value(await updateRefreshRun(lab.deps, HOME, token, { kind: 'wait-coordinator' }));
    value(await updateRefreshRun(lab.deps, HOME, token, { kind: 'acting', role: 'coordinator', id: NODE }));
    await refuse(lab, 1, 'cannot cancel refresh after the coordinator act has started', 'refresh --result', '--cancel');
  });
});
