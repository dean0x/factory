import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { ok } from '../../src/core/result.js';
import { activeMachine, env, guardIds, marker, roleText, schemaIds, stateLock, tmuxNames, type HookEvent } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { writeCoordinatorSession, writeLastSeen } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { claudeFileText, noSetupTexts, workerFileText } from '../helpers/blocks.js';
import {
  createFakeDeps,
  exited,
  registerRoot,
  withFailingWrites,
  type FakeDeps,
  type FetchHandler,
  type RunCall,
} from '../helpers/fake-deps.js';
import { DEFAULT_GIT_VERSION, withoutStateWords } from '../helpers/git-fake.js';
import { GUARD_STORE, guardStatesOf, guardStoreText, withGuardsOff, withStoreReadFault } from '../helpers/guarded-node.js';
import { runReboot, runRestart, runShutdown } from '../helpers/package-registry.js';
import { ownSettingsWithRules, seedAcceptedSetup, seedUnacceptedSetup } from '../helpers/role-delivery.js';
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
const SECOND_PROXY_URL = 'http://127.0.0.1:8081/second-path';

const IDS = ['alpha', 'beta', 'gamma'] as const;
type Id = (typeof IDS)[number];

const SESSION: Readonly<Record<Id, string>> = {
  alpha: '0b9f3c1e-5d2a-4e7b-9c10-a1b2c3d4e5f6',
  beta: 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd',
  gamma: 'c5b3e4f6-3d4e-4f70-8b12-34567890bcde',
};
const PID: Readonly<Record<Id, number>> = { alpha: 4101, beta: 4102, gamma: 4103 };
const PANE: Readonly<Record<Id, string>> = { alpha: '%10', beta: '%11', gamma: '%12' };
/** The session id in the pointer of the coordinator. */
const COORDINATOR_SESSION = '0b6c1f9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';
const byResume: Readonly<Record<string, string>> = Object.fromEntries(IDS.map((id) => [SESSION[id], id]));

/** The remedy of a reboot that fails after the first stop, before the session ends, and after it ends. */
const REBOOT_AGAIN = 'Fix the fault. Then run "factory reboot" again: it starts the stopped workers again.';
const START_AFTER_END = 'The session is ended. Fix the fault, then run "factory start": it starts the session and resumes the workers.';

const BAD_SETTINGS = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://other.example' } });
const WARNING_SETTINGS = JSON.stringify({ ...ownSettingsEntries, permissions: { allow: ['Bash'] } });
const HOOKS_OFF = JSON.stringify({ ...ownSettingsEntries, disableAllHooks: true });

interface WorkerSpec {
  /**
   * `live` (default): a pane that runs. `dead`: its program ended. `none`: no pane. `forged`: a pane with the mark that the launch
   * did not make. `view`: a live pane in the view window, where no summon put it.
   */
  readonly pane?: 'live' | 'dead' | 'none' | 'forged' | 'view';
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
  /** True: the pointer of the coordinator holds a session id that the coordinator may resume. Default: no pointer. */
  readonly coordinatorResumes?: boolean;
  /** Panes of other sessions of the fixture. */
  readonly otherPanes?: readonly PaneFixture[];
  /** The command runs in this pane of the session: the pane of the coordinator, the board pane, or the pane of a worker. Default: outside the session. */
  readonly from?: 'coordinator' | 'board' | Id;
  readonly config?: FactoryConfig;
  readonly claudeFile?: string;
  readonly hookSettings?: string;
  /** How the factory folder came to this machine. Default: no origin, which counts as received. */
  readonly origin?: 'own' | 'received';
  readonly links?: Readonly<Record<string, string>>;
  /** A terminal window with this answer to the question about the hook settings. Default: no terminal window. */
  readonly answer?: string;
  /** The mark of the active machine: of this machine, or of another one. Default: no mark. */
  readonly mark?: 'own' | 'other';
  readonly fetch?: FetchHandler;
  /** The process of this worker, or of the coordinator, does not end after TERM. */
  readonly stuck?: Id | 'coordinator';
  /** True: the program of the coordinator pane has ended, and the pane stays. */
  readonly endedCoordinator?: boolean;
  /** The exit code of the commit in the state repo. Default: 0. */
  readonly commitExit?: number;
  /** The exit code of the list of the config scopes of the state repo. Default: 0. Git older than 2.26 exits with 129. */
  readonly configListExit?: number;
  /** What `git --version` prints. Default: a git that is new enough. */
  readonly gitVersion?: string;
  /** False: git has no user.name and user.email. Default: true. */
  readonly identity?: boolean;
  /** The first word of a tmux command that fails with exit code 1, for example `kill-session`. */
  readonly failing?: string;
  /** What the program of a new pane does. Default: each resume starts the session of its worker. */
  readonly program?: Program;
  /** The text that a capture of the screen of each new worker pane prints. Default: empty. */
  readonly newPaneScreen?: string;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** The id of the coordinator pane. */
  readonly coordinator: string;
  /** The process id of the coordinator pane, or undefined when no session runs. */
  readonly coordinatorPid: number | undefined;
  /**
   * What happened, in order: `tmux <command>`, `git <subcommand>`, `terminate <pid>`, `write <path>` (an atomic write, or the
   * rename that ends a write through a temporary file) and `warn` (a warning printed at once).
   */
  readonly events: string[];
}

const answers: FetchHandler = () => ok({ status: 200 });

const gitAnswer = (setup: Setup) => (call: RunCall) => {
  const commitExit = setup.commitExit ?? 0;
  const identity = setup.identity ?? true;
  if (call.args.length === 1 && call.args[0] === '--version') return exited(0, setup.gitVersion ?? DEFAULT_GIT_VERSION);
  const command = withoutStateWords(call.args).slice(2).join(' ');
  if (call.args[1] === STATE_DIR) {
    if (command === 'status --porcelain -z --untracked-files=all --ignore-submodules=dirty') return exited(0, '');
    if (command === 'config user.name' || command === 'config user.email') return identity ? exited(0, 'Git User\n') : exited(1);
    if (command.startsWith('config --list') && setup.configListExit !== undefined) return exited(setup.configListExit, '', 'error: unknown option');
    return exited(command.includes(' commit ') ? commitExit : 0);
  }
  if (command === 'rev-parse --is-inside-work-tree --show-prefix') return exited(0, 'true\n\n');
  if (command === 'ls-files -z') return exited(0, '');
  if (call.args[2] === 'check-ignore') return exited(0);
  return exited(128, '', 'fatal: not a git repository\n');
};

/** The subcommand of a git call: the first word after `-C <folder>` that is neither an option nor the value of `-c`. */
const subcommandOf = (call: RunCall): string => {
  const words = call.args.slice(2);
  return words.find((word, index) => !word.startsWith('-') && words[index - 1] !== '-c') ?? '';
};

const paneOf = (id: Id, spec: WorkerSpec): readonly PaneFixture[] => {
  const kind = spec.pane ?? 'live';
  if (kind === 'none') return [];
  return [
    workerPane(id, {
      id: PANE[id],
      pid: PID[id],
      dead: kind === 'dead',
      ...(kind === 'forged' ? { command: [] } : {}),
      ...(kind === 'view' ? { window: tmuxNames.windowView } : {}),
    }),
  ];
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
  deps.seed(`${COPIES}/${id}/.claude/settings.local.json`, spec.settings ?? `${JSON.stringify(ownSettingsWithRules(HOME, `${COPIES}/${id}`), null, 2)}\n`);
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
  const { handler, log } = tmuxHandler({
    sessions,
    panes: [...panes, ...(setup.otherPanes ?? [])],
    ...(setup.failing === undefined ? {} : { failing: setup.failing }),
    ...(setup.endedCoordinator === true ? { endedCoordinators: [NODE] } : {}),
    ...(setup.newPaneScreen === undefined ? {} : { newPaneScreen: setup.newPaneScreen }),
  });
  // The fixture makes the panes of the session after the panes with an id: the coordinator pane comes first among them, then the board pane.
  const coordinator = `%${Math.max(-1, ...panes.map((pane) => Number((pane.id ?? '%-1').slice(1)))) + 1}`;
  const board = `%${Number(coordinator.slice(1)) + 1}`;
  const coordinatorPid = log.panes().find((pane) => pane.id === coordinator)?.pid;
  const callerPane = (pane: 'coordinator' | 'board' | Id): string => {
    if (pane === 'coordinator') return coordinator;
    return pane === 'board' ? board : PANE[pane];
  };
  const from = setup.from === undefined ? {} : { TMUX_PANE: callerPane(setup.from) };
  const git = gitAnswer(setup);
  const events: string[] = [];
  const base = createFakeDeps({
    cwd: '/w',
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...from },
    run: (call) => {
      if (call.command === 'git') {
        events.push(`git ${subcommandOf(call)}`);
        return git(call);
      }
      events.push(`tmux ${call.args[0]}`);
      return handler(call);
    },
    fetch: setup.fetch ?? answers,
    ...(setup.links === undefined ? {} : { links: setup.links }),
    ...(setup.answer === undefined ? {} : { stdinIsTTY: true, stdoutIsTTY: true, prompt: () => ok(setup.answer ?? '') }),
  });
  const stuckProcess = (): number | undefined => {
    if (setup.stuck === undefined) return undefined;
    return setup.stuck === 'coordinator' ? coordinatorPid : PID[setup.stuck];
  };
  const stuckPid = stuckProcess();
  const deps: FakeDeps = {
    ...base,
    fs: {
      ...base.fs,
      writeTextAtomic: (path, text, within, mode) => {
        events.push(`write ${path}`);
        return base.fs.writeTextAtomic(path, text, within, mode);
      },
      rename: (from, to) => {
        events.push(`write ${to}`);
        return base.fs.rename(from, to);
      },
    },
    terminate: (pid) => {
      events.push(`terminate ${pid}`);
      return base.terminate(pid);
    },
    isRunning: (pid) => (pid === stuckPid ? ok(true) : base.isRunning(pid)),
    warn: (message) => {
      events.push('warn');
      base.warn(message);
    },
  };
  for (const tool of ['tmux', 'claude']) deps.seed(`/bin/${tool}`, '');
  deps.seedDir(`${STATE_DIR}/.git`);
  deps.seedDir(RUNTIME_DIR);
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  deps.seed(layoutOf(HOME).workerMd, workerFileText(config, noSetupTexts));
  deps.seedDir(COORDINATOR);
  deps.seed(`${COORDINATOR}/CLAUDE.md`, setup.claudeFile ?? claudeFileText(config));
  deps.seed(SETTINGS_FILE, setup.hookSettings ?? OWN_SETTINGS);
  for (const project of config.recipe.projects) deps.seedDir(`${HOME}/${project.path}`);
  registerRoot(deps, HOME, config.core.node.id, [], setup.origin);
  for (const id of worked) await seedWorker(deps, id, specs[id] ?? {});
  if (setup.coordinatorResumes === true) {
    must(await writeCoordinatorSession(deps, HOME, COORDINATOR_SESSION));
    must(await writeLastSeen(deps, HOME, COORDINATOR_SESSION, { kind: 'event', event: 'Stop' }, NODE));
  }
  if (setup.mark !== undefined) {
    deps.seed(MACHINE_ID_FILE, `${OWN_MACHINE}\n`);
    deps.seed(MARK_FILE, markText(setup.mark === 'own' ? OWN_MACHINE : OTHER_MACHINE));
  }
  deps.warned.splice(0);
  events.splice(0);
  return { deps: withProgram(deps, log, setup.program ?? startsSessions(HOME, byResume)), tmux: log, coordinator, coordinatorPid, events };
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

/** The proxy of the session, and a second proxy for the worker beta only. */
const withWorkerProxy = (): FactoryConfig => {
  const config = withProxy();
  return {
    ...config,
    core: {
      ...config.core,
      proxies: [...config.core.proxies, { id: 'second', base_url: SECOND_PROXY_URL, health: '/health', on_fail: 'stop' }],
      workers: { beta: { proxy: 'second' } },
    },
  };
};

/** The second proxy does not answer. The proxy of the session does. */
const secondProxyDown: FetchHandler = (url) => (url.startsWith(SECOND_PROXY_URL) ? failure('no answer') : ok({ status: 200 }));

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

/** The proxy base URL that the command of each worker pane sets, by worker. A pane with no such word has none. */
const baseUrlsOf = (made: Made): Record<string, string | undefined> => {
  const prefix = `${env.proxyBaseUrl}=`;
  return Object.fromEntries(
    workerPanes(made).map((pane) => [
      pane.options[tmuxNames.optionWorker] ?? '',
      pane.command.find((word) => word.startsWith(prefix))?.slice(prefix.length),
    ]),
  );
};

/** Nothing stopped: no signal, no pane closed, no session ended. */
const expectNothingStopped = (made: Made): void => {
  expect(made.deps.terminated).toEqual([]);
  expect(countOf(made, 'kill-pane')).toBe(0);
  expect(countOf(made, 'kill-session')).toBe(0);
};

describe.each(['restart', 'reboot'] as const)('%s: linked folders', (command) => {
  describe.each(['own', 'received'] as const)('%s root', (origin) => {
    it('exits 4 for a linked work copy, shows the current remedy, and starts no pane', async () => {
      const made = await make({ origin, links: { [`${COPIES}/alpha`]: '/elsewhere/folder' } });
      made.deps.seedDir('/elsewhere/folder');
      const error = await failed(command === 'restart' ? restart(made, 'alpha') : reboot(made));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.message).toBe('work-copies/web/alpha is a link, so factory does not use it');
      expect(error.hint).toBe('Replace the link with a plain file inside the factory folder, then run "factory doctor".');
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
      expect(countOf(made, 'new-window')).toBe(0);
      expect(countOf(made, 'new-session')).toBe(0);
    });

    it('exits 4 for a linked .claude folder, names a plain folder, and starts no pane', async () => {
      const made = await make({ origin, links: { [`${COPIES}/alpha/.claude`]: '/elsewhere/folder' } });
      made.deps.seedDir('/elsewhere/folder');
      const error = await failed(command === 'restart' ? restart(made, 'alpha') : reboot(made));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.message).toBe('work-copies/web/alpha/.claude is a link, so factory does not use it');
      expect(error.hint).toBe('Make work-copies/web/alpha/.claude a plain folder, or remove it, then run "factory doctor".');
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
      expect(countOf(made, 'new-window')).toBe(0);
      expect(countOf(made, 'new-session')).toBe(0);
    });
  });
});

describe('shutdown', () => {
  it('says that nothing runs and exits 0 when the tmux session does not run', async () => {
    const made = await make({ sessions: {} });
    const output = await succeeded(shutdown(made));
    expect(textOf(output)).toBe(`Nothing runs: the tmux session ${NODE} does not run.`);
    expect(output.failed).toBe(false);
    expect(output.json).toMatchObject({ schema: schemaIds.shutdown, running: false, workers: [] });
    expectNothingStopped(made);
  });

  it('still ends the workers and the session when the role text of a worker is refused: no worker starts again', async () => {
    const made = await make({ workers: { alpha: {}, beta: { settings: HOOKS_OFF } } });
    seedUnacceptedSetup(made.deps, HOME, 'Write tests first.\n');
    const output = await succeeded(shutdown(made));
    expect(made.deps.terminated).toEqual(expect.arrayContaining([PID.alpha, PID.beta]));
    expect(countOf(made, 'kill-session')).toBe(1);
    expect(output.failed).toBe(false);
  });

  it.each([
    ['another home', { [NODE]: OTHER_HOME }],
    ['no home option', { [NODE]: null }],
  ])('ends nothing and exits 4 for a session of the same name with %s, and names factory shutdown', async (_name, sessions) => {
    const made = await make({ sessions });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Run "factory shutdown" in the factory folder that owns the session');
    expectNothingStopped(made);
    expect(made.tmux.sessions().has(NODE)).toBe(true);
    expect(paneLists(made)).toBe(0);
  });

  it('stops each worker with TERM in order, then ends the session by its exact name', async () => {
    const made = await make({ workers: { alpha: { event: 'UserPromptSubmit' }, beta: {}, gamma: { event: 'UserPromptSubmit' } } });
    const output = await succeeded(shutdown(made));
    expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma, made.coordinatorPid]);
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

  describe('the end of the coordinator', () => {
    it.each([
      ['shutdown', shutdown],
      ['reboot', reboot],
    ] as const)('%s from outside the session: the coordinator gets TERM after the workers and before the session ends', async (_name, run) => {
      const made = await make();
      await succeeded(run(made));
      const termAt = made.events.indexOf(`terminate ${made.coordinatorPid}`);
      expect(termAt).toBeGreaterThan(made.events.lastIndexOf(`terminate ${PID.gamma}`));
      expect(termAt).toBeLessThan(made.events.indexOf('tmux kill-session'));
      expect(made.deps.terminated.filter((pid) => pid === made.coordinatorPid)).toHaveLength(1);
    });

    it('shutdown from the board pane: the coordinator gets TERM, then the report is printed, then the session ends', async () => {
      const made = await make({ from: 'board' });
      const output = await succeeded(shutdown(made));
      const termAt = made.events.indexOf(`terminate ${made.coordinatorPid}`);
      const reportAt = made.events.indexOf('warn');
      expect(termAt).toBeGreaterThan(made.events.lastIndexOf(`terminate ${PID.gamma}`));
      expect(reportAt).toBeGreaterThan(termAt);
      expect(made.events.indexOf('tmux kill-session')).toBeGreaterThan(made.events.lastIndexOf('warn'));
      expect(made.deps.warned.join('\n')).toContain(`The tmux session ${NODE} ends next`);
      expect(output.json).toMatchObject({ schema: schemaIds.shutdown, running: true, workers: ['alpha', 'beta', 'gamma'] });
    });

    it.each([
      ['shutdown', shutdown, 'Run "factory shutdown" again, or end the process yourself.'],
      ['reboot', reboot, REBOOT_AGAIN],
    ] as const)('%s: a coordinator that does not end keeps the session, sends no other signal and gives a remedy', async (_name, run, hint) => {
      const made = await make({ stuck: 'coordinator', mark: 'own' });
      const error = await failed(run(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(`the process ${made.coordinatorPid} of the pane ${made.coordinator} did not end`);
      expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
      expect(error.hint).toContain(hint);
      expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma, made.coordinatorPid]);
      expect(countOf(made, 'kill-session')).toBe(0);
      expect(countOf(made, 'new-session')).toBe(0);
      expect(made.tmux.sessions().has(NODE)).toBe(true);
    });

    it('exits 1, sends nothing to the coordinator and keeps the session when tmux gives an answer about its pane that is not one pane', async () => {
      const made = await make();
      const run = made.deps.run;
      const unreadable: Made = {
        ...made,
        deps: {
          ...made.deps,
          run: (command, args, options) =>
            command === 'tmux' && args[0] === 'display-message' && args.some((word) => word.endsWith('{left}'))
              ? Promise.resolve(exited(0, 'not a pane\n'))
              : run(command, args, options),
        },
      };
      const error = await failed(shutdown(unreadable));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('cannot read the pane of the coordinator');
      expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
      expect(error.hint).toBe('Run "factory shutdown" again.');
      expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma]);
      expect(countOf(made, 'kill-session')).toBe(0);
    });

    it('sends no signal to a coordinator whose program has ended, and still ends the session', async () => {
      const made = await make({ endedCoordinator: true });
      await succeeded(shutdown(made));
      expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma]);
      expect(made.tmux.sessions().has(NODE)).toBe(false);
    });

    it('sends no signal to a pane that has lost the node mark, and still ends the session', async () => {
      const made = await make();
      expect((await made.deps.run('tmux', ['set-option', '-p', '-u', '-t', made.coordinator, tmuxNames.optionNode])).ok).toBe(true);
      await succeeded(shutdown(made));
      expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma]);
      expect(made.tmux.sessions().has(NODE)).toBe(false);
    });
  });

  it('does one session check and one list of the panes for three workers', async () => {
    const made = await make();
    await succeeded(shutdown(made));
    expect(countOf(made, 'has-session')).toBe(1);
    expect(countOf(made, 'show-options')).toBe(1);
    expect(paneLists(made)).toBe(1);
  });

  it('exits 3 and stops nothing when one worker is in an unknown state', async () => {
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
    expect(made.deps.terminated).toEqual([made.coordinatorPid]);
  });

  it('closes the pane of a worker whose program ended, with no signal', async () => {
    const made = await make({ workers: { alpha: { pane: 'dead' } } });
    const output = await succeeded(shutdown(made));
    expect(made.deps.terminated).toEqual([made.coordinatorPid]);
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

  it('exits 4 and stops nothing for a pane that the launch did not make, also when workers come before it in order', async () => {
    const made = await make({ workers: { alpha: {}, beta: { pane: 'forged' } } });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(`the pane ${PANE.beta} carries the mark of the worker beta`);
    expectNothingStopped(made);
  });

  it('exits 2 and stops nothing when a worker has two live panes', async () => {
    const made = await make({ otherPanes: [workerPane('beta', { id: '%20', pid: 4200 })] });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('the worker beta has 2 live panes');
    expect(error.hint).toContain('Then run "factory shutdown" again.');
    expectNothingStopped(made);
  });

  it('exits 4 and stops nothing for a worker pane in the view window that no summon put there', async () => {
    const made = await make({ workers: { alpha: {}, beta: { pane: 'view' } } });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(`is in the window ${tmuxNames.windowView}, but no summon put it there`);
    expectNothingStopped(made);
  });

  it('names the workers that stopped, and the command to run again, when the session does not end', async () => {
    const made = await make({ failing: 'kill-session' });
    const error = await failed(shutdown(made));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
    expect(error.hint).toBe('Run "factory shutdown" again.');
  });

  describe('from a pane of its own session', () => {
    it('prints the report before it ends the session, because the end of the session ends the command', async () => {
      const made = await make({ from: 'coordinator', mark: 'own' });
      const output = await succeeded(shutdown(made));
      const killAt = made.events.indexOf('tmux kill-session');
      expect(made.events.slice(0, killAt)).toContain('warn');
      expect(made.events.slice(killAt)).not.toContain('warn');
      const report = made.deps.warned.join('\n');
      expect(report).toContain('Stopped the workers: alpha, beta, gamma.');
      expect(report).toContain('Cleared the mark of the active machine.');
      expect(report).toContain(`The tmux session ${NODE} ends next`);
      expect(output.failed).toBe(false);
      expect(output.json).toMatchObject({ schema: schemaIds.shutdown, running: true, workers: ['alpha', 'beta', 'gamma'], mark: 'cleared' });
    });

    it('sends no signal to its own coordinator pane: the report comes first, then the session ends', async () => {
      const made = await make({ from: 'coordinator' });
      await succeeded(shutdown(made));
      expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma]);
      expect(made.events.indexOf('warn')).toBeGreaterThan(made.events.lastIndexOf(`terminate ${PID.gamma}`));
      expect(made.events.indexOf('warn')).toBeLessThan(made.events.indexOf('tmux kill-session'));
    });

    it('exits 1 with the message of the fault when the session does not end', async () => {
      const made = await make({ from: 'coordinator', failing: 'kill-session' });
      const error = await failed(shutdown(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
    });

    it('prints nothing at once when it runs outside the session', async () => {
      const made = await make({ mark: 'own' });
      await succeeded(shutdown(made));
      expect(made.deps.warned).toEqual([]);
      expect(made.events).not.toContain('warn');
    });
  });

  describe('the mark of the active machine', () => {
    it('clears the mark of this machine before it ends the session, and commits the removal', async () => {
      const made = await make({ mark: 'own' });
      const output = await succeeded(shutdown(made));
      expect(made.deps.files.has(MARK_FILE)).toBe(false);
      expect(textOf(output)).toContain('Cleared the mark of the active machine.');
      expect(output.json).toMatchObject({ mark: 'cleared' });
      expect(countOf(made, 'kill-session')).toBe(1);
      const commitAt = made.events.indexOf('git commit');
      expect(commitAt).toBeGreaterThan(made.events.lastIndexOf(`terminate ${PID.gamma}`));
      expect(commitAt).toBeLessThan(made.events.indexOf('tmux kill-session'));
    });

    it.each([
      ['shutdown', shutdown, 'Run "factory shutdown" again.'],
      ['reboot', reboot, REBOOT_AGAIN],
    ] as const)('%s: the mark is cleared and committed already when the session does not end, and the remedy names the command', async (_name, run, hint) => {
      const made = await make({ mark: 'own', failing: 'kill-session' });
      const error = await failed(run(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
      expect(error.hint).toBe(hint);
      expect(made.deps.files.has(MARK_FILE)).toBe(false);
      const commitAt = made.events.indexOf('git commit');
      expect(commitAt).toBeGreaterThanOrEqual(0);
      expect(commitAt).toBeLessThan(made.events.indexOf('tmux kill-session'));
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

    it('names shutdown in the warning when the mark can not be cleared', async () => {
      const made = await make({ mark: 'own', identity: false });
      await succeeded(shutdown(made));
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('The mark of the active machine is not cleared');
      expect(made.deps.warned[0]).toContain('then run "factory shutdown" again.');
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

    it('warns with the lock path, writes and commits nothing, and still ends the session, with exit 0, when another writer holds the state lock', async () => {
      const lockFile = `${layoutOf(HOME).locksDir}/${stateLock.name}${stateLock.lock.suffix}`;
      const made = await make({ mark: 'own' });
      made.deps.seed(lockFile, '1\n');
      const output = await succeeded(shutdown(made));
      expect(output.failed).toBe(false);
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('The mark of the active machine is not cleared');
      expect(made.deps.warned[0]).toContain(lockFile);
      expect(output.json).toMatchObject({ mark: 'failed' });
      expect(made.deps.files.get(MARK_FILE)).toBe(markText(OWN_MACHINE));
      expect(made.deps.files.get(lockFile)).toBe('1\n');
      expect(made.events.filter((event) => event.startsWith('git '))).toEqual([]);
      expect(countOf(made, 'kill-session')).toBe(1);
    });
  });
});

describe('restart', () => {
  it('stops one worker with TERM and starts it again with its session id, and the other workers keep their panes', async () => {
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

  it('keeps assignment.md and resume.md in the folder of the worker', async () => {
    const made = await make();
    const { inboxDir } = workerPathsOf(HOME, 'beta');
    made.deps.seed(`${inboxDir}/assignment.md`, 'the task');
    made.deps.seed(`${inboxDir}/resume.md`, 'the notes');
    await succeeded(restart(made, 'beta'));
    expect(made.deps.files.get(`${inboxDir}/assignment.md`)).toBe('the task');
    expect(made.deps.files.get(`${inboxDir}/resume.md`)).toBe('the notes');
  });

  it('does one session check and one list of the panes', async () => {
    const made = await make();
    await succeeded(restart(made, 'alpha'));
    expect(countOf(made, 'has-session')).toBe(1);
    expect(countOf(made, 'show-options')).toBe(1);
    expect(paneLists(made)).toBe(1);
  });

  it('exits 3 and names factory start when no tmux session runs', async () => {
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
  ] as const)('exits 3 and stops nothing for a worker with %s', async (_name, spec) => {
    const made = await make({ workers: { alpha: {}, beta: spec } });
    const error = await failed(restart(made, 'beta'));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('the worker beta has no session id that it may resume');
    expect(error.hint).toContain('"factory worker resume beta"');
    expectNothingStopped(made);
  });

  it('exits 3 and stops nothing for a session whose line holds no event', async () => {
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

  it('exits 4 and stops nothing for a session of another home, and the remedy names factory shutdown', async () => {
    const made = await make({ sessions: { [NODE]: OTHER_HOME } });
    const error = await failed(restart(made, 'alpha'));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Run "factory shutdown"');
    expect(error.hint).toContain('Then run "factory restart alpha" again.');
    expectNothingStopped(made);
  });

  it('exits 2 and stops nothing when the worker has two live panes', async () => {
    const made = await make({ otherPanes: [workerPane('beta', { id: '%20', pid: 4200 })] });
    const error = await failed(restart(made, 'beta'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain('Then run "factory restart beta" again.');
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

  describe('the checks of the root come before any stop', () => {
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

  describe('the settings of the work copy', () => {
    it('starts the worker with the prepared guard decision when a second store read would fail', async () => {
      const off = [guardIds.settingsCheck];
      const made = await make({ config: withGuardsOff(sampleConfig(), off), workers: { alpha: {} } });
      made.deps.seed(GUARD_STORE, guardStoreText(NODE, HOME, off, made.deps.now()));
      made.deps.seed(`${COPIES}/alpha/.claude/settings.json`, BAD_SETTINGS);
      const result = await runRestart(withStoreReadFault(made.deps, 2), { home: HOME, words: ['alpha'] });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      expect(resumesOf(made)).toEqual({ alpha: SESSION.alpha });
    });

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

  describe('the role text of the worker', () => {
    it('exits 4 and stops nothing for a work copy whose settings turn off every hook', async () => {
      const made = await make({ workers: { alpha: { settings: HOOKS_OFF }, beta: {} } });
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.message).toContain('turns off every hook');
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
    });

    it('exits 3 and stops nothing for a work copy with no own hook entry, and names each command on its own line', async () => {
      const made = await make({ workers: { alpha: {}, beta: {} } });
      made.deps.files.delete(`${COPIES}/alpha/.claude/settings.local.json`);
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(3);
      expect(error.hint?.split('\n')).toEqual(expect.arrayContaining(['factory upgrade', 'factory restart alpha', 'factory dismiss alpha']));
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
    });

    it('exits 4 and stops nothing for a setup text that the owner did not accept, and names the restart as the command to run again', async () => {
      const made = await make();
      seedUnacceptedSetup(made.deps, HOME, 'Write tests first.\n');
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.hint).toContain('"factory restart alpha"');
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
    });

    it('exits 1 and stops nothing for a text above the cap, and names its size and the cap', async () => {
      const made = await make();
      seedAcceptedSetup(made.deps, HOME, `${'x'.repeat(roleText.maxChars - 500)}\n`);
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toMatch(/^the role text has \d+ characters, and the cap is 9000 characters$/);
      expectNothingStopped(made);
    });

    it('exits 4 and stops nothing in your own factory folder for an accepted setup text that holds a block marker', async () => {
      const made = await make({ origin: 'own' });
      seedAcceptedSetup(made.deps, HOME, `Write tests first.\n<!-- ${marker.prefix}${marker.begin} rules v1 -->\n`);
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(4);
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
    });

    it('exits 1 and stops nothing in a received factory folder for an accepted setup text that holds a block marker', async () => {
      const made = await make({ origin: 'received' });
      seedAcceptedSetup(made.deps, HOME, `Write tests first.\n<!-- ${marker.prefix}${marker.begin} rules v1 -->\n`);
      const error = await failed(restart(made, 'alpha'));
      expect(exitCodeOf[error.kind]).toBe(1);
      expectNothingStopped(made);
      expect(countOf(made, 'split-window')).toBe(0);
    });

    it('stops nothing for a worker that has no pane when its role text is refused', async () => {
      const made = await make({ workers: { alpha: { pane: 'none' } } });
      seedUnacceptedSetup(made.deps, HOME, 'Write tests first.\n');
      expect(exitCodeOf[(await failed(restart(made, 'alpha'))).kind]).toBe(4);
      expect(countOf(made, 'split-window')).toBe(0);
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

  it('exits 1, starts nothing and keeps every pane when the process of the worker does not end', async () => {
    const made = await make({ stuck: 'alpha' });
    const error = await failed(restart(made, 'alpha'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`the process ${PID.alpha}`);
    expect(error.message).not.toContain('did not start again');
    expect(error.hint).toContain('factory worker stop alpha');
    expect(made.deps.terminated).toEqual([PID.alpha]);
    expect(countOf(made, 'kill-pane')).toBe(0);
    expect(countOf(made, 'split-window')).toBe(0);
    expect(workerPanes(made)).toHaveLength(3);
  });
});

describe('reboot', () => {
  it('ends the session as shutdown does and starts it again with each worker resumed by its id', async () => {
    const made = await make({
      sessions: { [NODE]: HOME, other: OTHER_HOME },
      otherPanes: [{ session: 'other', options: { '@worker': 'alpha' }, pid: 9001 }],
    });
    const output = await succeeded(reboot(made));
    expect(made.deps.terminated).toEqual([PID.alpha, PID.beta, PID.gamma, made.coordinatorPid]);
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

  it('says that the coordinator resumes its earlier conversation, and that it must follow the current rules of the block', async () => {
    const made = await make({ coordinatorResumes: true });
    const output = await succeeded(reboot(made));
    expect(output.json).toMatchObject({ coordinatorResumed: true });
    expect(output.lines.map((line) => line.text)).toContain(
      'The coordinator resumes its earlier conversation. It must follow the current rules of the coordinator block.',
    );
  });

  it('exits 4 and ends nothing for a session of the same name that belongs to another home', async () => {
    const made = await make({ sessions: { [NODE]: OTHER_HOME } });
    const error = await failed(reboot(made));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Then run "factory reboot" again.');
    expectNothingStopped(made);
    expect(countOf(made, 'new-session')).toBe(0);
  });

  it('exits 3 and stops nothing when one worker has no session id that it may resume', async () => {
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

  describe('the checks come before any stop', () => {
    it('exits 4 and stops nothing when a root check fails', async () => {
      const made = await make({ claudeFile: claudeFileText(sampleConfig()).replace('Do not write keys', 'Write keys') });
      expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(4);
      expectNothingStopped(made);
    });

    it('prints a root warning once and goes on', async () => {
      const made = await make({ hookSettings: WARNING_SETTINGS });
      await succeeded(reboot(made));
      expect(made.deps.warned.filter((warning) => warning.includes('Bash'))).toHaveLength(1);
      expect(made.deps.terminated).toHaveLength(IDS.length + 1);
    });

    it('exits 4 and stops nothing when the settings file of one work copy is wrong', async () => {
      const made = await make({ workers: { alpha: {}, beta: { settings: BAD_SETTINGS }, gamma: {} } });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.hint).toContain('Remove the setting');
      expectNothingStopped(made);
    });

    it('exits 4 and stops nothing when the settings of one work copy turn off every hook', async () => {
      const made = await make({ workers: { alpha: {}, beta: { settings: HOOKS_OFF }, gamma: {} } });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.message).toContain('turns off every hook');
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
    });

    it('exits 3 and stops nothing when one work copy has no own hook entry', async () => {
      const made = await make();
      made.deps.files.delete(`${COPIES}/gamma/.claude/settings.local.json`);
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(3);
      expect(error.hint?.split('\n')).toEqual(expect.arrayContaining(['factory upgrade', 'factory reboot', 'factory dismiss gamma']));
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
    });

    it('exits 4 and stops nothing when the setup text of the worker is not accepted, and names the reboot as the command to run again', async () => {
      const made = await make();
      seedUnacceptedSetup(made.deps, HOME, 'Write tests first.\n');
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.hint).toContain('"factory reboot"');
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
    });

    it('exits 2 and stops nothing when the command runs in the pane of a worker', async () => {
      const made = await make({ from: 'gamma' });
      expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(2);
      expectNothingStopped(made);
    });

    it('exits 4 and stops nothing when a pane carries a worker mark that the launch did not make', async () => {
      const made = await make({ workers: { alpha: {}, beta: { pane: 'forged' }, gamma: {} } });
      expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(4);
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
    });
  });

  describe('the git that the start path needs (git 2.26)', () => {
    /** The exit code of a git that does not know the option `--show-scope`. */
    const UNKNOWN_OPTION = 129;
    const writes = (made: Made): string[] => made.events.filter((event) => event.startsWith('write '));

    it('exits 1, stops nothing and makes no session when git cannot list the config scopes', async () => {
      const made = await make({ configListExit: UNKNOWN_OPTION });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('git 2.26');
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
      expect(made.tmux.sessions().get(NODE)).toBe(HOME);
      expect(writes(made)).toEqual([]);
      expect(made.deps.warned).toEqual([]);
    });

    it('exits 1 and makes no session when no session runs', async () => {
      const made = await make({ sessions: {}, configListExit: UNKNOWN_OPTION });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('git 2.26');
      expect(countOf(made, 'new-session')).toBe(0);
      expect(made.tmux.sessions().size).toBe(0);
      expect(made.events.some((event) => event.startsWith('git commit'))).toBe(false);
    });

    it.each([
      ['git version 2.25.1\n', 'git 2.25 is older than 2.26'],
      ['', 'cannot read the version of git'],
    ])('exits 1, stops nothing and makes no session for the git version %j', async (gitVersion, shown) => {
      const made = await make({ gitVersion });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(shown);
      expect(error.hint).toContain('factory doctor');
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
    });

    it('goes on for another fault of the config list, which stays a warning of the claim of the active machine', async () => {
      const made = await make({ configListExit: 128 });
      const output = await succeeded(reboot(made));
      expect(output.json).toMatchObject({ started: true });
      expect(countOf(made, 'new-session')).toBe(1);
    });
  });

  describe('the steps of start that change a file, outside the session', () => {
    const CLAUDE_FILE = `${COORDINATOR}/CLAUDE.md`;
    const RENDERED_NOTICE =
      'Rendered the block safety in coordinator/CLAUDE.md again, because the package or a setting changed its text.';
    const outOfDate = (): Setup => {
      const config = sampleConfig();
      const changed = { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix: '[From {owner}, sent by {node}, {date}]' } } };
      return { config: changed, claudeFile: claudeFileText(config) };
    };

    it('renders a safety block that is out of date, before the first stop and before the session starts again', async () => {
      const setup = outOfDate();
      const made = await make(setup);
      await succeeded(reboot(made));
      expect(made.deps.files.get(CLAUDE_FILE)).not.toBe(setup.claudeFile);
      expect(made.deps.warned).toContain(RENDERED_NOTICE);
      const renderAt = made.events.indexOf(`write ${CLAUDE_FILE}`);
      expect(renderAt).toBeGreaterThanOrEqual(0);
      expect(renderAt).toBeLessThan(made.events.indexOf(`terminate ${PID.alpha}`));
      expect(renderAt).toBeLessThan(made.events.indexOf('tmux new-session'));
      expect(made.deps.terminated).toHaveLength(IDS.length + 1);
      expect(countOf(made, 'new-session')).toBe(1);
    });

    it('exits 1 and stops nothing when the safety block that is out of date can not be rendered again', async () => {
      const setup = outOfDate();
      const made = await make(setup);
      const faulty: Made = { ...made, deps: withFailingWrites(made.deps, (path, attempt) => path === CLAUDE_FILE && attempt === 1) };
      const error = await failed(reboot(faulty));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(`cannot write ${CLAUDE_FILE}`);
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
      expect(made.deps.files.get(CLAUDE_FILE)).toBe(setup.claudeFile);
      expect(made.deps.warned).not.toContain(RENDERED_NOTICE);
    });

    it('renders a safety block that is out of date when no session runs', async () => {
      const made = await make({ ...outOfDate(), sessions: {}, workers: {} });
      await succeeded(reboot(made));
      expect(made.deps.warned).toContain(RENDERED_NOTICE);
      expect(countOf(made, 'new-session')).toBe(1);
    });

    it('leaves a safety block that is out of date as it is when it runs in a pane of the session', async () => {
      const setup = outOfDate();
      const made = await make({ ...setup, from: 'coordinator' });
      await succeeded(reboot(made));
      expect(made.deps.files.get(CLAUDE_FILE)).toBe(setup.claudeFile);
    });

    it('writes the hook settings after a yes on a terminal window, before the first stop', async () => {
      const made = await make({ hookSettings: '{}\n', answer: 'y' });
      await succeeded(reboot(made));
      expect(made.deps.prompts).toHaveLength(1);
      expect(made.deps.files.get(SETTINGS_FILE)).toContain('factory hook');
      const writeAt = made.events.indexOf(`write ${SETTINGS_FILE}`);
      expect(writeAt).toBeGreaterThanOrEqual(0);
      expect(writeAt).toBeLessThan(made.events.indexOf(`terminate ${PID.alpha}`));
      expect(made.deps.terminated).toHaveLength(IDS.length + 1);
    });

    it('goes on without the hook settings after a no, and says so', async () => {
      const made = await make({ hookSettings: '{}\n', answer: 'n' });
      await succeeded(reboot(made));
      expect(made.deps.files.get(SETTINGS_FILE)).toBe('{}\n');
      expect(made.deps.warned.join(' ')).toContain('"factory reboot" again and answer yes');
    });

    it('exits 2 and stops nothing when the hook settings are not in place and no terminal window can ask', async () => {
      const made = await make({ hookSettings: '{}\n' });
      expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(2);
      expect(made.deps.files.get(SETTINGS_FILE)).toBe('{}\n');
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
    });
  });

  describe.each(['own', 'received'] as const)('idle compaction in an %s root', (origin) => {
    const oldSettings = `${JSON.stringify({ hooks: ownSettingsEntries.hooks, statusLine: ownSettingsEntries.statusLine })}\n`;

    it('starts all sessions with no settings write and one remedy line when no terminal can ask', async () => {
      const settingsWithoutIdle = (folder: string): string => `${JSON.stringify({
        hooks: ownSettingsEntries.hooks,
        statusLine: ownSettingsEntries.statusLine,
        permissions: ownSettingsWithRules(HOME, folder).permissions,
      })}\n`;
      const made = await make({
        origin,
        hookSettings: settingsWithoutIdle(COORDINATOR),
        workers: {
          alpha: { settings: settingsWithoutIdle(`${COPIES}/alpha`) },
          beta: { settings: settingsWithoutIdle(`${COPIES}/beta`) },
          gamma: { settings: settingsWithoutIdle(`${COPIES}/gamma`) },
        },
      });
      const output = await succeeded(reboot(made));
      expect(output.json).toMatchObject({ started: true, workers: { resumed: [...IDS], skipped: [], failed: [] } });
      expect(countOf(made, 'new-session')).toBe(1);
      expect(resumesOf(made)).toEqual(SESSION);
      for (const folder of [COORDINATOR, ...IDS.map((id) => `${COPIES}/${id}`)]) {
        const file = `${folder}/.claude/settings.local.json`;
        expect(made.deps.files.get(file)).toBe(settingsWithoutIdle(folder));
        expect(made.events).not.toContain(`write ${file}`);
      }
      expect(made.deps.prompts).toEqual([]);
      expect(made.deps.warned).toEqual([
        `The value of session.idle_compaction is not written to ${SETTINGS_FILE}, because no terminal window can ask. ` +
          'Run "factory upgrade" in a terminal window, or add --yes. The session starts as before.',
      ]);
    });

    it('reboots with a session marker and no terminal, keeps settings and names a usable remedy', async () => {
      const made = await make({ origin, hookSettings: oldSettings });
      const marked = { ...made, deps: { ...made.deps, env: { ...made.deps.env, [env.session]: NODE } } };
      const output = await succeeded(reboot(marked));
      expect(output.json).toMatchObject({ started: true, workers: { resumed: [...IDS], skipped: [], failed: [] } });
      expect(countOf(made, 'new-session')).toBe(1);
      expect(made.deps.files.get(SETTINGS_FILE)).toBe(oldSettings);
      expect(made.events).not.toContain(`write ${SETTINGS_FILE}`);
      expect(made.deps.prompts).toEqual([]);
      expect(made.deps.warned).toEqual([
        `The value of session.idle_compaction is not written to ${SETTINGS_FILE}, because no terminal window can ask. ` +
          'Run "factory upgrade" outside the factory session, or in a terminal window and answer the question. The session starts as before.',
      ]);
      expect(made.deps.warned.join('\n')).not.toContain('--yes');
    });

    it.each([false, true])('writes the config value %s after consent and before any session stops', async (idle) => {
      const base = sampleConfig();
      const config = { ...base, core: { ...base.core, session: { ...base.core.session, idle_compaction: idle } } };
      const made = await make({ origin, config, hookSettings: oldSettings, answer: 'y' });
      const output = await succeeded(reboot(made));
      expect(JSON.parse(made.deps.files.get(SETTINGS_FILE) ?? 'null')).toEqual({ ...ownSettingsEntries, idleCompaction: idle });
      expect(made.deps.prompts).toEqual([
        `This changes the settings of Claude Code in ${SETTINGS_FILE}:\n` +
          `  idleCompaction: set to ${idle} (session.idle_compaction in factory.yaml)\nWrite this change? [y/N] `,
      ]);
      const writeAt = made.events.indexOf(`write ${SETTINGS_FILE}`);
      expect(writeAt).toBeGreaterThanOrEqual(0);
      expect(writeAt).toBeLessThan(made.events.indexOf(`terminate ${PID.alpha}`));
      expect(output.json).toMatchObject({ started: true, workers: { resumed: [...IDS], skipped: [], failed: [] } });
    });

    it.each([
      ['hook', '{}\n'],
      ['status line', JSON.stringify({ hooks: ownSettingsEntries.hooks })],
    ])('refuses a %s change without a terminal before any write or stop', async (_name, hookSettings) => {
      const made = await make({ origin, hookSettings });
      const before = new Map(made.deps.files);
      expect(exitCodeOf[(await failed(reboot(made))).kind]).toBe(2);
      expect(made.deps.files).toEqual(before);
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
      expect(made.deps.warned.join('\n')).not.toContain('factory upgrade --yes');
    });

    it('refuses a non-boolean config value before any write or stop', async () => {
      const made = await make({ origin, hookSettings: oldSettings });
      const file = `${HOME}/factory.yaml`;
      made.deps.seed(file, (made.deps.files.get(file) ?? '').replace('idle_compaction: false', 'idle_compaction: "false"'));
      const before = new Map(made.deps.files);
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('session.idle_compaction');
      expect(made.deps.files).toEqual(before);
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
    });
  });

  it('keeps the coordinator pane and the session when it runs in a pane of the session', async () => {
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
    expect(error.hint).toBe(REBOOT_AGAIN);
    expect(countOf(made, 'new-session')).toBe(0);
    expect(countOf(made, 'kill-session')).toBe(0);
  });

  it('names factory reboot, not factory shutdown, when the session does not end after the workers stopped', async () => {
    const made = await make({ failing: 'kill-session' });
    const error = await failed(reboot(made));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
    expect(error.hint).toBe(REBOOT_AGAIN);
    expect(countOf(made, 'new-session')).toBe(0);
  });

  it('names factory start when the session ended and the new session does not start', async () => {
    const made = await make({ failing: 'new-session' });
    const error = await failed(reboot(made));
    expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
    expect(error.hint).toBe(START_AFTER_END);
    expect(countOf(made, 'kill-session')).toBe(1);
  });

  it('names factory reboot when the workers stopped inside the session and the recovery fails', async () => {
    const made = await make({ from: 'coordinator' });
    const workersDir = layoutOf(HOME).workersDir;
    const listing = made.deps.fs.list;
    // The list of the workers fails once every worker has stopped: the fault comes from the recovery, after the stops.
    const faulty: Made = {
      ...made,
      deps: {
        ...made.deps,
        fs: {
          ...made.deps.fs,
          list: async (path) =>
            path === workersDir && made.deps.terminated.length === IDS.length
              ? failure('cannot list the workers')
              : listing(path),
        },
      },
    };
    const error = await failed(reboot(faulty));
    expect(error.message).toContain('Stopped before this fault: alpha, beta, gamma');
    expect(error.hint).toBe(REBOOT_AGAIN);
    expect(countOf(made, 'kill-session')).toBe(0);
  });

  it('names reboot in the warning when the mark can not be cleared', async () => {
    const made = await make({ mark: 'own', identity: false });
    await succeeded(reboot(made));
    const warning = made.deps.warned.find((message) => message.includes('is not cleared'));
    expect(warning).toContain('then run "factory reboot" again.');
    expect(warning).not.toContain('factory shutdown');
  });

  describe('the output is short', () => {
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

    it('has the size of its output on the fixture of three workers in the token budget, row 3', async () => {
      const text = plainText(await succeeded(reboot(await make())));
      const row = budgetRow(3);
      expect(row.command).toBe('`factory reboot`');
      expect(row.measured).toBe(tokensOf(text));
      expect(tokensOf(text)).toBeLessThanOrEqual(row.budget);
    });
  });

  describe('the proxy is asked once for each run', () => {
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

    it.each<[string, 'coordinator' | undefined]>([
      ['from outside the session', undefined],
      ['from inside the session', 'coordinator'],
    ])('stops nothing and exits 1 when the proxy does not answer, %s: the proxy check comes before the first stop', async (_name, from) => {
      const made = await make({ config: withProxy(), fetch: () => failure('no answer'), ...(from === undefined ? {} : { from }) });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.hint).toContain('factory reboot');
      expectNothingStopped(made);
      expect(workerPanes(made)).toHaveLength(3);
      expect(made.deps.fetched).toHaveLength(1);
    });
  });

  describe('a worker with a proxy of its own is asked too', () => {
    it.each<[string, 'coordinator' | undefined]>([
      ['from outside the session', undefined],
      ['from inside the session', 'coordinator'],
    ])('stops nothing and exits 1 when that proxy does not answer, %s: the remedy names the setting of the worker', async (_name, from) => {
      const made = await make({ config: withWorkerProxy(), fetch: secondProxyDown, ...(from === undefined ? {} : { from }) });
      const error = await failed(reboot(made));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('second');
      expect(error.hint).toContain('workers.beta.proxy');
      expect(error.hint).toContain('factory reboot');
      expectNothingStopped(made);
      expect(countOf(made, 'new-session')).toBe(0);
      expect(workerPanes(made)).toHaveLength(3);
    });

    it('asks each proxy once, and starts each worker with the proxy of its own', async () => {
      const made = await make({ config: withWorkerProxy() });
      await succeeded(reboot(made));
      expect(made.deps.fetched).toHaveLength(2);
      expect(baseUrlsOf(made)).toEqual({ alpha: PROXY_URL, beta: SECOND_PROXY_URL, gamma: PROXY_URL });
    });
  });
});

describe('restart and reboot of a worker whose new pane waits on a folder trust question', () => {
  const TRUST_SCREEN = 'Quick safety check: Is this a project you created or one you trust?\n> 1. Yes, I trust this folder\n  2. No, exit\n';
  const ORIGINS = [
    ['your own', 'own'],
    ['a received', 'received'],
  ] as const;
  /** The id of the newest pane with the mark of the worker. */
  const newPaneOf = (made: Made, id: Id): string | undefined =>
    made.tmux.panes().filter((pane) => pane.options[tmuxNames.optionWorker] === id).at(-1)?.id;
  const trustRemedy = (pane: string | undefined, id: Id): string =>
    `The owner answers each folder trust question in the pane ${pane ?? 'none'}. Then run "factory worker watch --ready ${id}".`;
  /** Each resume starts its session, except for these workers: their panes run and write no line. */
  const silentWorkers = (...ids: readonly Id[]): Program => async (wait) => {
    if (ids.some((id) => wait.resumeId === SESSION[id])) return;
    await startsSessions(HOME, byResume)(wait);
  };
  const silentBeta = silentWorkers('beta');

  it.each(ORIGINS)('restart exits 3 in %s factory folder, says that the worker stopped, and names the pane and worker watch --ready', async (_words, origin) => {
    const made = await make({ origin, newPaneScreen: TRUST_SCREEN, program: () => undefined });
    const error = await failed(restart(made, 'alpha'));
    expect(made.deps.terminated).toEqual([PID.alpha]);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('waits on a folder trust question');
    expect(error.message).toContain('The worker alpha stopped and did not start again');
    expect(error.hint).toContain(trustRemedy(newPaneOf(made, 'alpha'), 'alpha'));
    expect(made.tmux.typed()).toEqual([]);
  });

  it.each(ORIGINS)('reboot exits 3 in %s factory folder when each worker that did not start again waits on the question, and names the remedy', async (_words, origin) => {
    const made = await make({ origin, newPaneScreen: TRUST_SCREEN, program: silentBeta });
    const output = await succeeded(reboot(made));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBe(3);
    expect(output.json['workers']).toEqual({ resumed: ['alpha', 'gamma'], skipped: [], failed: ['beta'] });
    expect(textOf(output)).toContain('Did not start again: beta.');
    expect(made.deps.warned.join('\n')).toContain(trustRemedy(newPaneOf(made, 'beta'), 'beta'));
    expect(made.tmux.typed()).toEqual([]);
  });

  it('reboot exits 3 and warns for each pane when beta and gamma wait on the question', async () => {
    const made = await make({ newPaneScreen: TRUST_SCREEN, program: silentWorkers('beta', 'gamma') });
    const output = await succeeded(reboot(made));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBe(3);
    expect(output.json['workers']).toEqual({ resumed: ['alpha'], skipped: [], failed: ['beta', 'gamma'] });
    expect(made.deps.warned).toEqual(expect.arrayContaining([
      expect.stringContaining(trustRemedy(newPaneOf(made, 'beta'), 'beta')),
      expect.stringContaining(trustRemedy(newPaneOf(made, 'gamma'), 'gamma')),
    ]));
  });

  it('reboot in the coordinator pane exits 3 when each worker that did not start again waits on the question', async () => {
    const made = await make({ from: 'coordinator', newPaneScreen: TRUST_SCREEN, program: silentBeta });
    const output = await succeeded(reboot(made));
    expect(output.json).toMatchObject({ inSession: true, workers: { resumed: ['alpha', 'gamma'], skipped: [], failed: ['beta'] } });
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBe(3);
    expect(made.deps.warned.join('\n')).toContain(trustRemedy(newPaneOf(made, 'beta'), 'beta'));
    expect(made.tmux.typed()).toEqual([]);
  });

  it.each([
    ['gamma', 'alpha', ['beta', 'gamma']],
    ['alpha', 'gamma', ['alpha', 'beta']],
  ] as const)('reboot keeps exit 1 when the pane of %s ends and beta waits on the question', async (ended, resumed, failedIds) => {
    const program: Program = async (wait) => {
      if (wait.resumeId === SESSION[ended]) {
        await endsPane(wait);
        return;
      }
      await silentBeta(wait);
    };
    const made = await make({ newPaneScreen: TRUST_SCREEN, program });
    const output = await succeeded(reboot(made));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBeUndefined();
    expect(output.json['workers']).toEqual({ resumed: [resumed], skipped: [], failed: failedIds });
  });

  it('reboot keeps exit 1 when the new pane of a worker that did not start again shows no trust question', async () => {
    const made = await make({ program: silentBeta });
    const output = await succeeded(reboot(made));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBeUndefined();
    expect(made.deps.warned.join('\n')).toContain('resume not confirmed');
  });

  it('reboot keeps exit 1 and the old remedy when the new pane shows earlier conversation text with "trust" but no "folder" on that line', async () => {
    const made = await make({ newPaneScreen: 'The work copy is trusted now.\nTrust comes from the git root.\n> ', program: silentBeta });
    const output = await succeeded(reboot(made));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBeUndefined();
    expect(made.deps.warned.join('\n')).toContain('resume not confirmed');
    expect(made.deps.warned.join('\n')).not.toContain('factory worker watch --ready');
  });

  it('reboot keeps exit 1 when the pane shows a trust quote with no choice list', async () => {
    const quote = 'Earlier answer: "Yes, I trust this folder".';
    const made = await make({ newPaneScreen: `${quote}\n> `, program: silentBeta });
    const output = await succeeded(reboot(made));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBeUndefined();
    const warning = made.deps.warned.join('\n');
    expect(warning).toContain('the last event is Stop, not SessionStart');
    expect(warning).toContain('factory worker summon beta');
    expect(warning).not.toContain('factory worker watch --ready');
    expect(warning).not.toContain(quote);
  });
});

describe('restart: the proxy of the worker', () => {
  it('asks the proxy once, before the stop, and the launch uses that answer', async () => {
    const made = await make({ config: withProxy() });
    await succeeded(restart(made, 'alpha'));
    expect(made.deps.fetched).toHaveLength(1);
    expect(baseUrlsOf(made).alpha).toBe(PROXY_URL);
  });

  it('asks the proxy of the worker, and not the proxy of the session, and starts the worker with it', async () => {
    const made = await make({ config: withWorkerProxy() });
    await succeeded(restart(made, 'beta'));
    expect(made.deps.fetched).toHaveLength(1);
    expect(made.deps.fetched[0]).toContain(SECOND_PROXY_URL);
    expect(baseUrlsOf(made).beta).toBe(SECOND_PROXY_URL);
  });

  it('stops nothing and exits 1 when the proxy of the worker does not answer, and the remedy names the setting of the worker', async () => {
    const made = await make({ config: withWorkerProxy(), fetch: secondProxyDown });
    const error = await failed(restart(made, 'beta'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain('workers.beta.proxy');
    expect(error.hint).toContain('factory restart beta');
    expectNothingStopped(made);
  });

  it('restarts a worker whose proxy answers when the proxy of another worker does not', async () => {
    const made = await make({ config: withWorkerProxy(), fetch: secondProxyDown });
    await succeeded(restart(made, 'alpha'));
    expect(made.deps.terminated).toEqual([PID.alpha]);
    expect(made.deps.fetched).toHaveLength(1);
    expect(made.deps.fetched[0]).toContain(PROXY_URL);
  });

  it('stops nothing and exits 1 when the proxy of the worker does not answer', async () => {
    const made = await make({ config: withProxy(), fetch: () => failure('no answer') });
    const error = await failed(restart(made, 'alpha'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain('factory restart alpha');
    expectNothingStopped(made);
    expect(made.deps.fetched).toHaveLength(1);
  });
});

describe.each(['own', 'received'] as const)('restart in an %s root: the guard of the proxy', (origin) => {
  it.each(guardStatesOf(guardIds.proxy))('stops nothing for a proxy that does not answer only while the guard counts as on, and else starts the worker with that proxy: %s', async (_state, setup, on) => {
    const off = setup.off ?? [];
    const made = await make({ origin, config: withGuardsOff(withProxy(), off), fetch: () => failure('no answer') });
    if (setup.record !== false) made.deps.seed(GUARD_STORE, guardStoreText(NODE, HOME, off, made.deps.now()));
    const result = await restart(made, 'alpha');
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(!on);
    expect(made.deps.fetched).toHaveLength(on ? 1 : 0);
    expect(made.deps.terminated).toEqual(on ? [] : [PID.alpha]);
    if (!on) expect(baseUrlsOf(made).alpha).toBe(PROXY_URL);
  });
});
