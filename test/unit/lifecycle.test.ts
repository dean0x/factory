import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { ok } from '../../src/core/result.js';
import { activeMachine, schemaIds, tmuxNames, type HookEvent } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { writeLastSeen } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { claudeFileText } from '../helpers/blocks.js';
import {
  createFakeDeps,
  exited,
  registerRoot,
  type FakeDeps,
  type FetchHandler,
  type RunCall,
} from '../helpers/fake-deps.js';
import { runReboot, runRestart, runShutdown } from '../helpers/package-registry.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { endsPane, startsSessions, withProgram, type Program } from '../helpers/worker-program.js';

const STATE_DIR = `${HOME}/.factory`;
const RUNTIME_DIR = `${STATE_DIR}/state`;
const MACHINE_ID_FILE = `${RUNTIME_DIR}/machine-id`;
const MARK_FILE = `${STATE_DIR}/active-machine.json`;
const COORDINATOR = `${HOME}/coordinator`;
const SETTINGS_FILE = `${COORDINATOR}/.claude/settings.local.json`;
const COPIES = `${HOME}/work-copies/web`;
const OWN_SETTINGS = `${JSON.stringify(ownSettingsEntries, null, 2)}\n`;
const OWN_MACHINE = '00000000-0000-4000-8000-000000000001';
const OTHER_MACHINE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_HOME = '/w/other-factory';
const PROXY_URL = 'http://127.0.0.1:8080/secret-path';

const IDS = ['alpha', 'beta', 'gamma'] as const;
type Id = (typeof IDS)[number];

const SESSION: Readonly<Record<Id, string>> = {
  alpha: '0b9f3c1e-5d2a-4e7b-9c10-a1b2c3d4e5f6',
  beta: 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd',
  gamma: 'c5b3e4f6-3d4e-4f70-8b12-34567890bcde',
};
const PID: Readonly<Record<Id, number>> = { alpha: 4101, beta: 4102, gamma: 4103 };
const PANE: Readonly<Record<Id, string>> = { alpha: '%10', beta: '%11', gamma: '%12' };
const byResume: Readonly<Record<string, string>> = Object.fromEntries(IDS.map((id) => [SESSION[id], id]));

const BAD_SETTINGS = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://other.example' } });
const WARNING_SETTINGS = JSON.stringify({ ...ownSettingsEntries, permissions: { allow: ['Bash'] } });

interface WorkerSpec {
  /** `live` (default): a pane that runs. `dead`: its program ended. `none`: no pane. `forged`: a pane with the mark that the launch did not make. */
  readonly pane?: 'live' | 'dead' | 'none' | 'forged';
  /** The last event of the line. Default: Stop (the session waits at the prompt). Null: no pointer and no line. */
  readonly event?: HookEvent | null;
  /** The session marker of the line. Null: none. Default: the id of the worker. */
  readonly marker?: string | null;
  /** The text of the settings file of the work copy. */
  readonly settings?: string;
}

interface Setup {
  /** The workers that have a record, with their panes. Default: alpha, beta and gamma, all live and idle. */
  readonly workers?: Readonly<Partial<Record<Id, WorkerSpec>>>;
  /** The tmux sessions. Default: the session of the node, with the home of the fixture. */
  readonly sessions?: TmuxFixture['sessions'];
  /** Panes of other sessions of the fixture. */
  readonly otherPanes?: readonly PaneFixture[];
  /** The command runs in this pane of the session: the pane of the coordinator, or the pane of a worker. Default: outside the session. */
  readonly from?: 'coordinator' | Id;
  readonly config?: FactoryConfig;
  readonly claudeFile?: string;
  readonly hookSettings?: string;
  /** The mark of the active machine: of this machine, or of another one. Default: no mark. */
  readonly mark?: 'own' | 'other';
  readonly fetch?: FetchHandler;
  /** The process of this worker does not end after TERM. */
  readonly stuck?: Id;
  /** The exit code of the commit in the state repo. Default: 0. */
  readonly commitExit?: number;
  /** What the program of a new pane does. Default: each resume starts the session of its worker. */
  readonly program?: Program;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** The id of the coordinator pane. */
  readonly coordinator: string;
  /** What happened, in order: `tmux <command>` and `terminate <pid>`. */
  readonly events: string[];
}

const answers: FetchHandler = () => ok({ status: 200 });

const gitAnswer = (commitExit: number) => (call: RunCall) => {
  const command = call.args.slice(2).join(' ');
  if (call.args[1] === STATE_DIR) {
    if (command === 'status --porcelain -z --untracked-files=all') return exited(0, '');
    if (command === 'config user.name' || command === 'config user.email') return exited(0, 'Git User\n');
    return exited(command.includes(' commit ') ? commitExit : 0);
  }
  if (command === 'rev-parse --is-inside-work-tree --show-prefix') return exited(0, 'true\n\n');
  if (command === 'ls-files -z') return exited(0, '');
  if (call.args[2] === 'check-ignore') return exited(0);
  return exited(128, '', 'fatal: not a git repository\n');
};

const paneOf = (id: Id, spec: WorkerSpec): readonly PaneFixture[] => {
  const kind = spec.pane ?? 'live';
  if (kind === 'none') return [];
  return [workerPane(id, { id: PANE[id], pid: PID[id], dead: kind === 'dead', ...(kind === 'forged' ? { command: [] } : {}) })];
};

const must = (result: { readonly ok: boolean; readonly error?: { readonly message: string } }): void => {
  if (!result.ok) throw new Error(result.error?.message ?? 'the seed failed');
};

const markText = (machine: string): string =>
  `${JSON.stringify({
    [activeMachine.keys.schema]: schemaIds.activeMachine,
    [activeMachine.keys.machine]: machine,
    [activeMachine.keys.at]: '2029-12-31T10:00:00.000Z',
  })}\n`;

const seedWorker = async (deps: FakeDeps, id: Id, spec: WorkerSpec): Promise<void> => {
  must(await writeWorkerRecord(deps, HOME, { id, project: 'web', workCopy: `${COPIES}/${id}`, branch: `worker/${id}` }));
  deps.seedDir(`${COPIES}/${id}`);
  if (spec.settings !== undefined) deps.seed(`${COPIES}/${id}/.claude/settings.local.json`, spec.settings);
  if (spec.event === null) return;
  deps.seed(workerPathsOf(HOME, id).lastSessionFile, `${SESSION[id]}\n`);
  const marker = spec.marker === undefined ? id : spec.marker;
  must(await writeLastSeen(deps, HOME, SESSION[id], { kind: 'event', event: spec.event ?? 'Stop' }, marker === null ? undefined : marker));
};

/** A factory folder with a running session, the three workers of the setup, and the files that the checks of `start` read. */
const make = async (setup: Setup = {}): Promise<Made> => {
  const specs = setup.workers ?? { alpha: {}, beta: {}, gamma: {} };
  const sessions = setup.sessions ?? { [NODE]: HOME };
  const worked = IDS.filter((id) => id in specs);
  const panes = NODE in sessions ? worked.flatMap((id) => paneOf(id, specs[id] ?? {})) : [];
  const { handler, log } = tmuxHandler({ sessions, panes: [...panes, ...(setup.otherPanes ?? [])] });
  // The fixture makes the panes of the session after the panes with an id: the coordinator pane comes first among them.
  const coordinator = `%${Math.max(-1, ...panes.map((pane) => Number((pane.id ?? '%-1').slice(1)))) + 1}`;
  const from = setup.from === undefined ? {} : { TMUX_PANE: setup.from === 'coordinator' ? coordinator : PANE[setup.from] };
  const git = gitAnswer(setup.commitExit ?? 0);
  const events: string[] = [];
  const base = createFakeDeps({
    cwd: '/w',
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...from },
    run: (call) => {
      if (call.command === 'git') return git(call);
      events.push(`tmux ${call.args[0]}`);
      return handler(call);
    },
    fetch: setup.fetch ?? answers,
  });
  const stuckPid = setup.stuck === undefined ? undefined : PID[setup.stuck];
  const deps: FakeDeps = {
    ...base,
    terminate: (pid) => {
      events.push(`terminate ${pid}`);
      return base.terminate(pid);
    },
    isRunning: (pid) => (pid === stuckPid ? ok(true) : base.isRunning(pid)),
  };
  for (const tool of ['tmux', 'claude']) deps.seed(`/bin/${tool}`, '');
  deps.seedDir(`${STATE_DIR}/.git`);
  deps.seedDir(RUNTIME_DIR);
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  deps.seedDir(COORDINATOR);
  deps.seed(`${COORDINATOR}/CLAUDE.md`, setup.claudeFile ?? claudeFileText(config));
  deps.seed(SETTINGS_FILE, setup.hookSettings ?? OWN_SETTINGS);
  for (const project of config.recipe.projects) deps.seedDir(`${HOME}/${project.path}`);
  registerRoot(deps, HOME, config.core.node.id);
  for (const id of worked) await seedWorker(deps, id, specs[id] ?? {});
  if (setup.mark !== undefined) {
    deps.seed(MACHINE_ID_FILE, `${OWN_MACHINE}\n`);
    deps.seed(MARK_FILE, markText(setup.mark === 'own' ? OWN_MACHINE : OTHER_MACHINE));
  }
  deps.warned.splice(0);
  events.splice(0);
  return { deps: withProgram(deps, log, setup.program ?? startsSessions(HOME, byResume)), tmux: log, coordinator, events };
};

const withProxy = (): FactoryConfig => {
  const config = sampleConfig();
  return {
    ...config,
    core: {
      ...config.core,
      proxies: [{ id: 'local', base_url: PROXY_URL, health: '/health', on_fail: 'stop' }],
      session: { ...config.core.session, proxy: 'local' },
    },
  };
};

const shutdown = (made: Made) => runShutdown(made.deps, { home: HOME });
const restart = (made: Made, id: string) => runRestart(made.deps, { home: HOME, words: [id] });
const reboot = (made: Made) => runReboot(made.deps, { home: HOME });

const succeeded = async (run: Promise<CliResult<CommandOutput>>): Promise<CommandOutput> => {
  const result = await run;
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const failed = async (run: Promise<CliResult<CommandOutput>>): Promise<CliError> => {
  const result = await run;
  if (result.ok) throw new Error(`the command should have failed, it gave ${JSON.stringify(result.value.json)}`);
  return result.error;
};

const textOf = (output: CommandOutput): string => output.lines.map((line) => line.text).join('\n');

/** The line of the session of a worker holds no event, only a percent: the state of the session is not known. */
const seedLineWithoutEvent = (deps: FakeDeps, id: Id): void => {
  const line = {
    schema: schemaIds.lastSeen,
    session_id: SESSION[id],
    event: null,
    event_at: null,
    context_pct: 40,
    pct_at: '2030-01-02T03:04:05.678Z',
    session_marker: id,
  };
  deps.seed(`${layoutOf(HOME).heartbeatDir}/${SESSION[id]}`, `${JSON.stringify(line)}\n`);
};

const countOf = (made: Made, word: string): number => made.tmux.commands().filter((command) => command.startsWith(word)).length;

/** The lists of the panes of the session that a command reads: the calls of `list-panes` that print the pid of a pane. */
const paneLists = (made: Made): number =>
  made.tmux.commands().filter((command) => command.startsWith('list-panes') && command.includes('#{pane_pid}')).length;

/** The panes that carry a worker mark, in the order of their making. */
const workerPanes = (made: Made) => made.tmux.panes().filter((pane) => pane.session === NODE && pane.options[tmuxNames.optionWorker] !== undefined);

/** The session id that each worker pane resumes, by worker. */
const resumesOf = (made: Made): Record<string, string | undefined> =>
  Object.fromEntries(
    workerPanes(made).map((pane) => {
      const at = pane.command.indexOf('--resume');
      return [pane.options[tmuxNames.optionWorker] ?? '', at < 0 ? undefined : pane.command[at + 1]];
    }),
  );

/** Nothing stopped: no signal, no pane closed, no session ended. */
const expectNothingStopped = (made: Made): void => {
  expect(made.deps.terminated).toEqual([]);
  expect(countOf(made, 'kill-pane')).toBe(0);
  expect(countOf(made, 'kill-session')).toBe(0);
};

describe('shutdown (AC-18)', () => {
  it('says that nothing runs and exits 0 when the tmux session does not run (TP-41)', async () => {
    const made = await make({ sessions: {} });
    const output = await succeeded(shutdown(made));
    expect(textOf(output)).toBe(`Nothing runs: the tmux session ${NODE} does not run.`);
    expect(output.failed).toBe(false);
    expect(output.json).toMatchObject({ schema: schemaIds.shutdown, running: false, workers: [] });
    expectNothingStopped(made);
  });

  it.each([
    ['another home', { [NODE]: OTHER_HOME }],
    ['no home option', { [NODE]: null }],
  ])('ends nothing and exits 4 for a session of the same name with %s, and names factory shutdown (TP-40)', async (_name, sessions) => {
    const made = await make({ sessions });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Run "factory shutdown" in the factory folder that owns the session');
    expectNothingStopped(made);
    expect(made.tmux.sessions().has(NODE)).toBe(true);
    expect(paneLists(made)).toBe(0);
  });

  it('stops each worker with TERM in order, then ends the session by its exact name (TP-135)', async () => {
    const made = await make({ workers: { alpha: { event: 'UserPromptSubmit' }, beta: {}, gamma: { event: 'UserPromptSubmit' } } });
    const output = await succeeded(shutdown(made));
    expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma]);
    expect(made.tmux.commands().filter((command) => command.startsWith('kill-pane'))).toEqual([
      `kill-pane -t ${PANE.alpha}`,
      `kill-pane -t ${PANE.beta}`,
      `kill-pane -t ${PANE.gamma}`,
    ]);
    expect(made.tmux.commands().filter((command) => command.startsWith('kill-session'))).toEqual([`kill-session -t =${NODE}`]);
    expect(made.events.at(-1)).toBe('tmux kill-session');
    expect(made.tmux.sessions().has(NODE)).toBe(false);
    expect(textOf(output)).toBe(`Stopped the workers: alpha, beta, gamma.\nEnded the tmux session ${NODE}.`);
    expect(output.json).toMatchObject({ schema: schemaIds.shutdown, running: true, workers: ['alpha', 'beta', 'gamma'] });
  });

  it('does one session check and one list of the panes for three workers', async () => {
    const made = await make();
    await succeeded(shutdown(made));
    expect(countOf(made, 'has-session')).toBe(1);
    expect(countOf(made, 'show-options')).toBe(1);
    expect(paneLists(made)).toBe(1);
  });

  it('exits 3 and stops nothing when one worker is in an unknown state (TP-42)', async () => {
    const made = await make({ workers: { alpha: {}, beta: { event: null }, gamma: {} } });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('the worker beta');
    expect(error.message).toContain(`The pane ${PANE.beta} runs the process ${PID.beta}`);
    expectNothingStopped(made);
    expect(made.tmux.sessions().has(NODE)).toBe(true);
  });

  it('exits 3 and stops nothing for a line of another session', async () => {
    const made = await make({ workers: { alpha: { marker: 'gamma' }, beta: {}, gamma: {} } });
    expect(exitCodeOf[(await failed(shutdown(made))).kind]).toBe(3);
    expectNothingStopped(made);
  });

  it('exits 3 and stops nothing for a line that holds no event', async () => {
    const made = await make();
    seedLineWithoutEvent(made.deps, 'beta');
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('the last-seen line holds no event');
    expectNothingStopped(made);
  });

  it('ends a session that has no worker pane, and leaves the other sessions alone', async () => {
    const made = await make({
      workers: {},
      sessions: { [NODE]: HOME, other: OTHER_HOME },
      otherPanes: [{ session: 'other', options: { '@worker': 'alpha' }, pid: 9001 }],
    });
    const output = await succeeded(shutdown(made));
    expect(textOf(output)).toBe(`Ended the tmux session ${NODE}.`);
    expect(made.tmux.sessions().get('other')).toBe(OTHER_HOME);
    expect(made.tmux.panes().some((pane) => pane.session === 'other')).toBe(true);
    expect(made.deps.terminated).toEqual([]);
  });

  it('closes the pane of a worker whose program ended, with no signal', async () => {
    const made = await make({ workers: { alpha: { pane: 'dead' } } });
    const output = await succeeded(shutdown(made));
    expect(made.deps.terminated).toEqual([]);
    expect(made.tmux.commands()).toContain(`kill-pane -t ${PANE.alpha}`);
    expect(output.json).toMatchObject({ workers: ['alpha'] });
  });

  it('exits 2 and stops nothing when the command runs in the pane of a worker that it would stop', async () => {
    const made = await make({ from: 'beta' });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(`its own pane ${PANE.beta}`);
    expectNothingStopped(made);
  });

  it('names the workers that stopped when a process does not end, and keeps the session and the mark', async () => {
    const made = await make({ stuck: 'beta', mark: 'own' });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`the process ${PID.beta}`);
    expect(error.message).toContain('Stopped before this fault: alpha');
    expect(made.deps.terminated).toEqual([PID.alpha, PID.beta]);
    expect(countOf(made, 'kill-session')).toBe(0);
    expect(made.deps.files.has(MARK_FILE)).toBe(true);
  });

  it('exits 4 for a pane that the launch did not make, names the workers that stopped, and sends it no signal', async () => {
    const made = await make({ workers: { alpha: {}, beta: { pane: 'forged' } } });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('Stopped before this fault: alpha');
    expect(made.deps.terminated).toEqual([PID.alpha]);
    expect(countOf(made, 'kill-session')).toBe(0);
  });

  describe('the mark of the active machine (TP-39)', () => {
    it('clears the mark of this machine before it ends the session, and commits the removal', async () => {
      const made = await make({ mark: 'own' });
      const output = await succeeded(shutdown(made));
      expect(made.deps.files.has(MARK_FILE)).toBe(false);
      expect(made.deps.calls.some((call) => call.command === 'git' && call.args.includes('commit'))).toBe(true);
      expect(textOf(output)).toContain('Cleared the mark of the active machine.');
      expect(output.json).toMatchObject({ mark: 'cleared' });
      expect(countOf(made, 'kill-session')).toBe(1);
    });

    it('keeps a mark that names another machine, and says so', async () => {
      const made = await make({ mark: 'other' });
      const output = await succeeded(shutdown(made));
      expect(made.deps.files.get(MARK_FILE)).toBe(markText(OTHER_MACHINE));
      expect(textOf(output)).toContain('names another machine, so it stays');
      expect(made.deps.warned).toEqual([]);
    });

    it('clears the mark of this machine also when no session runs', async () => {
      const made = await make({ sessions: {}, mark: 'own' });
      const output = await succeeded(shutdown(made));
      expect(made.deps.files.has(MARK_FILE)).toBe(false);
      expect(textOf(output)).toContain('Nothing runs');
      expect(textOf(output)).toContain('Cleared the mark of the active machine.');
    });

    it('warns and still ends the session, with exit 0, when the commit of the mark fails', async () => {
      const made = await make({ mark: 'own', commitExit: 1 });
      const output = await succeeded(shutdown(made));
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('The mark of the active machine is not cleared');
      expect(output.failed).toBe(false);
      expect(countOf(made, 'kill-session')).toBe(1);
      expect(made.deps.files.get(MARK_FILE)).toBe(markText(OWN_MACHINE));
    });
  });
});

describe('restart (AC-19)', () => {
  it('stops one worker with TERM and starts it again with its session id, and the other workers keep their panes (TP-43)', async () => {
    const made = await make();
    const output = await succeeded(restart(made, 'beta'));
    expect(made.deps.terminated).toEqual([PID.beta]);
    expect(made.tmux.panes().map((pane) => pane.id)).toEqual(expect.arrayContaining([PANE.alpha, PANE.gamma]));
    expect(made.tmux.panes().map((pane) => pane.id)).not.toContain(PANE.beta);
    expect(resumesOf(made)).toEqual({ alpha: undefined, gamma: undefined, beta: SESSION.beta });
    expect(countOf(made, 'kill-session')).toBe(0);
    expect(textOf(output)).toContain('Stopped the worker beta.');
    expect(textOf(output)).toContain('Resumed the worker beta in the pane');
    expect(output.json).toMatchObject({ schema: schemaIds.restart, id: 'beta', stopped: true, sessionId: SESSION.beta });
  });

  it('starts a worker that has no pane, with its session id, and stops nothing', async () => {
    const made = await make({ workers: { alpha: { pane: 'none' } } });
    const output = await succeeded(restart(made, 'alpha'));
    expect(made.deps.terminated).toEqual([]);
    expect(resumesOf(made)).toEqual({ alpha: SESSION.alpha });
    expect(output.json).toMatchObject({ stopped: false });
  });

  it('does one session check and one list of the panes', async () => {
    const made = await make();
    await succeeded(restart(made, 'alpha'));
    expect(countOf(made, 'has-session')).toBe(1);
    expect(countOf(made, 'show-options')).toBe(1);
    expect(paneLists(made)).toBe(1);
  });

  it('exits 3 and names factory start when no tmux session runs (TP-44)', async () => {
    const made = await make({ sessions: {} });
    const error = await failed(restart(made, 'alpha'));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.hint).toContain('"factory start"');
    expect(error.hint).toContain('"factory restart alpha"');
  });

  it.each([
    ['no pointer', { event: null }],
    ['a line of another session', { marker: 'gamma' }],
    ['a line with no session marker', { marker: null }],
  ] as const)('exits 3 and stops nothing for a worker with %s (TP-44)', async (_name, spec) => {
    const made = await make({ workers: { alpha: {}, beta: spec } });
    const error = await failed(restart(made, 'beta'));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('the worker beta has no session id that it may resume');
    expect(error.hint).toContain('"factory worker resume beta"');
    expectNothingStopped(made);
  });

  it('exits 3 and stops nothing for a session whose line holds no event (TP-44)', async () => {
    const made = await make({ workers: { alpha: {} } });
    seedLineWithoutEvent(made.deps, 'alpha');
    const error = await failed(restart(made, 'alpha'));
    expect(exitCodeOf[error.kind]).toBe(3);
    expectNothingStopped(made);
  });

  it('exits 2 for an id that has no record, and for a call with no id or two ids', async () => {
    const made = await make();
    expect(exitCodeOf[(await failed(restart(made, 'delta'))).kind]).toBe(2);
    expect(exitCodeOf[(await failed(runRestart(made.deps, { home: HOME, words: [] }))).kind]).toBe(2);
    expect(exitCodeOf[(await failed(runRestart(made.deps, { home: HOME, words: ['alpha', 'beta'] }))).kind]).toBe(2);
    expectNothingStopped(made);
  });

  it('exits 4 and stops nothing for a session of another home, and the remedy names factory shutdown (TP-132)', async () => {
    const made = await make({ sessions: { [NODE]: OTHER_HOME } });
    const error = await failed(restart(made, 'alpha'));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Run "factory shutdown"');
    expect(error.hint).toContain('Then run "factory restart alpha" again.');
    expectNothingStopped(made);
  });

  it('exits 2 when the command runs in the pane of the worker that it would stop', async () => {
    const made = await make({ from: 'alpha' });
    expect(exitCodeOf[(await failed(restart(made, 'alpha'))).kind]).toBe(2);
    expectNothingStopped(made);
  });

  it('does not check the other workers: one that is in an unknown state does not stop the restart of another', async () => {
    const made = await make({ workers: { alpha: {}, beta: { event: null } } });
    await succeeded(restart(made, 'alpha'));
    expect(made.deps.terminated).toEqual([PID.alpha]);
  });

  describe('the checks of the root come before any stop (TP-131)', () => {
    it('exits 4 and stops nothing when a root check fails', async () => {
      const config = sampleConfig();
      const made = await make({ claudeFile: claudeFileText(config).replace('Do not write keys', 'Write keys') });
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(4);
      expectNothingStopped(made);
    });

    it('prints a root warning once and goes on', async () => {
      const made = await make({ hookSettings: WARNING_SETTINGS });
      await succeeded(restart(made, 'alpha'));
      expect(made.deps.warned.filter((warning) => warning.includes('Bash'))).toHaveLength(1);
      expect(made.deps.terminated).toEqual([PID.alpha]);
    });
  });

  describe('the settings of the work copy (TP-17, AC-7)', () => {
    it('exits 4 with one remedy and stops nothing for a wrong settings file', async () => {
      const made = await make({ workers: { alpha: { settings: BAD_SETTINGS }, beta: {} } });
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.hint).toContain('Remove the setting');
      expect(error.hint).not.toContain('\n');
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
    });

    it('prints the warning of a work copy once: the check before the stop prints none', async () => {
      const made = await make({ workers: { alpha: { settings: WARNING_SETTINGS } } });
      await succeeded(restart(made, 'alpha'));
      expect(made.deps.warned.filter((warning) => warning.includes('Bash'))).toHaveLength(1);
    });

    it('exits 1 and stops nothing for a work copy that is not a folder', async () => {
      const made = await make({ workers: { alpha: {} } });
      made.deps.files.set(`${COPIES}/alpha`, 'a file');
      made.deps.dirs.delete(`${COPIES}/alpha`);
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(1);
      expectNothingStopped(made);
    });
  });

  it('says that the worker stopped and did not start again when its new session writes no line, and names the retry', async () => {
    const made = await make({ program: () => undefined });
    const error = await failed(restart(made, 'alpha'));
    expect(made.deps.terminated).toEqual([PID.alpha]);
    expect(error.message).toContain('resume not confirmed');
    expect(error.message).toContain('The worker alpha stopped and did not start again');
    expect(error.hint).toContain('factory worker resume alpha');
  });

  it('says that the worker stopped and did not start again when its new pane ends at once', async () => {
    const made = await make({ program: endsPane });
    const error = await failed(restart(made, 'alpha'));
    expect(made.deps.terminated).toEqual([PID.alpha]);
    expect(error.message).toContain('The worker alpha stopped and did not start again');
  });

  it('does not say that the worker stopped when the worker had no pane', async () => {
    const made = await make({ workers: { alpha: { pane: 'none' } }, program: () => undefined });
    const error = await failed(restart(made, 'alpha'));
    expect(error.message).not.toContain('stopped and did not start again');
  });
});

describe('reboot (AC-20)', () => {
  it('ends the session as shutdown does and starts it again with each worker resumed by its id (TP-45)', async () => {
    const made = await make({
      sessions: { [NODE]: HOME, other: OTHER_HOME },
      otherPanes: [{ session: 'other', options: { '@worker': 'alpha' }, pid: 9001 }],
    });
    const output = await succeeded(reboot(made));
    expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma]);
    expect(countOf(made, 'kill-session')).toBe(1);
    expect(countOf(made, 'new-session')).toBe(1);
    expect(made.events.indexOf('tmux kill-session')).toBeGreaterThan(made.events.lastIndexOf(`terminate ${PID.gamma}`));
    expect(made.events.indexOf('tmux new-session')).toBeGreaterThan(made.events.indexOf('tmux kill-session'));
    expect(resumesOf(made)).toEqual(SESSION);
    expect(made.tmux.sessions().get('other')).toBe(OTHER_HOME);
    expect(made.tmux.panes().some((pane) => pane.session === 'other' && pane.pid === 9001)).toBe(true);
    expect(output.failed).toBe(false);
    expect(output.json).toMatchObject({
      schema: schemaIds.reboot,
      inSession: false,
      started: true,
      stopped: ['alpha', 'beta', 'gamma'],
      workers: { resumed: ['alpha', 'beta', 'gamma'], skipped: [], failed: [] },
    });
    expect(textOf(output)).toContain('Started the session demo again.');
    expect(textOf(output)).toContain('Attach with: tmux attach -t demo');
  });

  it('exits 4 and ends nothing for a session of the same name that belongs to another home (TP-45)', async () => {
    const made = await make({ sessions: { [NODE]: OTHER_HOME } });
    const error = await failed(reboot(made));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Then run "factory reboot" again.');
    expectNothingStopped(made);
    expect(countOf(made, 'new-session')).toBe(0);
  });

  it('exits 3 and stops nothing when one worker has no session id that it may resume (TP-46)', async () => {
    const made = await make({ workers: { alpha: {}, beta: { event: null }, gamma: {} } });
    const error = await failed(reboot(made));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('the worker beta');
    expectNothingStopped(made);
    expect(countOf(made, 'new-session')).toBe(0);
  });

  it('exits 3 and stops nothing for a worker with no pane and no usable id, too', async () => {
    const made = await make({ workers: { alpha: {}, beta: { pane: 'none', marker: null } } });
    expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(3);
    expectNothingStopped(made);
  });

  describe('the checks come before any stop (TP-131, TP-17)', () => {
    it('exits 4 and stops nothing when a root check fails', async () => {
      const made = await make({ claudeFile: claudeFileText(sampleConfig()).replace('Do not write keys', 'Write keys') });
      expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(4);
      expectNothingStopped(made);
    });

    it('prints a root warning once and goes on', async () => {
      const made = await make({ hookSettings: WARNING_SETTINGS });
      await succeeded(reboot(made));
      expect(made.deps.warned.filter((warning) => warning.includes('Bash'))).toHaveLength(1);
      expect(made.deps.terminated).toHaveLength(3);
    });

    it('exits 4 and stops nothing when the settings file of one work copy is wrong', async () => {
      const made = await make({ workers: { alpha: {}, beta: { settings: BAD_SETTINGS }, gamma: {} } });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.hint).toContain('Remove the setting');
      expectNothingStopped(made);
    });

    it('exits 2 and stops nothing when the command runs in the pane of a worker', async () => {
      const made = await make({ from: 'gamma' });
      expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(2);
      expectNothingStopped(made);
    });
  });

  it('keeps the coordinator pane and the session when it runs in a pane of the session (TP-47)', async () => {
    const made = await make({ from: 'coordinator' });
    const output = await succeeded(reboot(made));
    expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma]);
    expect(countOf(made, 'kill-session')).toBe(0);
    expect(countOf(made, 'new-session')).toBe(0);
    const ids = made.tmux.panes().map((pane) => pane.id);
    expect(ids).toContain(made.coordinator);
    for (const id of IDS) expect(ids).not.toContain(PANE[id]);
    expect(resumesOf(made)).toEqual(SESSION);
    expect(output.json).toMatchObject({ inSession: true, started: false, workers: { resumed: ['alpha', 'beta', 'gamma'] } });
    expect(textOf(output)).toContain('Kept the session demo and the coordinator pane.');
  });

  it('starts a worker with no pane when it runs in a pane of the session', async () => {
    const made = await make({ workers: { alpha: {}, beta: { pane: 'none' } }, from: 'coordinator' });
    await succeeded(reboot(made));
    expect(made.deps.terminated).toEqual([PID.alpha]);
    expect(resumesOf(made)).toEqual({ alpha: SESSION.alpha, beta: SESSION.beta });
  });

  it('starts the session with the recovery when no session runs, and stops nothing', async () => {
    const made = await make({ sessions: {}, workers: { alpha: { pane: 'none' }, beta: { pane: 'none', event: null } } });
    const output = await succeeded(reboot(made));
    expect(countOf(made, 'kill-session')).toBe(0);
    expect(countOf(made, 'new-session')).toBe(1);
    expect(output.json).toMatchObject({ workers: { resumed: ['alpha'], skipped: ['beta'] } });
    expect(made.deps.warned.join(' ')).toContain('beta');
  });

  it('reports a worker that did not start again, and exits 1', async () => {
    const silentBeta: Program = async (wait) => {
      if (wait.resumeId === SESSION.beta) return;
      await startsSessions(HOME, byResume)(wait);
    };
    const made = await make({ program: silentBeta });
    const output = await succeeded(reboot(made));
    expect(output.failed).toBe(true);
    expect(output.json).toMatchObject({ workers: { resumed: ['alpha', 'gamma'], failed: ['beta'] } });
    expect(textOf(output)).toContain('Did not start again: beta.');
    expect(countOf(made, 'kill-session')).toBe(1);
  });

  it('says which workers stopped when a stop fails, and does not start the session again', async () => {
    const made = await make({ stuck: 'gamma' });
    const error = await failed(reboot(made));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('Stopped before this fault: alpha, beta');
    expect(countOf(made, 'new-session')).toBe(0);
    expect(countOf(made, 'kill-session')).toBe(0);
  });

  describe('the output is short (TP-63, TP-64)', () => {
    it('has a short first line and few lines, from outside the session, from inside it, with no session, and with a worker that did not start', async () => {
      const silentBeta: Program = async (wait) => {
        if (wait.resumeId === SESSION.beta) return;
        await startsSessions(HOME, byResume)(wait);
      };
      const shapes = [
        await make(),
        await make({ from: 'coordinator' }),
        await make({ sessions: {}, workers: { alpha: { pane: 'none' }, beta: { pane: 'none', event: null } } }),
        await make({ program: silentBeta }),
      ];
      for (const made of shapes) expectShortOutput(plainText(await succeeded(reboot(made))));
    });

    it('has the size of its output on the fixture of three workers in the token budget, row 3 (TP-64)', async () => {
      const text = plainText(await succeeded(reboot(await make())));
      const row = budgetRow(3);
      expect(row.command).toBe('`factory reboot`');
      expect(row.measured).toBe(tokensOf(text));
      expect(tokensOf(text)).toBeLessThanOrEqual(row.budget);
    });
  });

  describe('the proxy is asked once for each run (TP-62, AC-25)', () => {
    it('sends one health check for three workers on one proxy, from outside the session', async () => {
      const made = await make({ config: withProxy() });
      await succeeded(reboot(made));
      expect(made.deps.fetched).toHaveLength(1);
    });

    it('sends one health check for three workers on one proxy, from inside the session', async () => {
      const made = await make({ config: withProxy(), from: 'coordinator' });
      await succeeded(reboot(made));
      expect(made.deps.fetched).toHaveLength(1);
    });

    it('stops nothing and exits 1 when the proxy of the session does not answer, after the checks', async () => {
      const made = await make({ config: withProxy(), fetch: () => failure('no answer') });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBeGreaterThanOrEqual(1);
      expect(made.deps.fetched).toHaveLength(1);
    });
  });
});
