import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { hookSettingsPlaceOf, ownSettingsEntries } from '../../src/core/claude-settings.js';
import type { RunOutput } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { launchArgv } from '../../src/launch/argv.js';
import { maxFileBytes, resetConfirm, schemaIds, type HookEvent, type ResetKind } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { parseReset, resetOutput, resetWorker, type ResetOutcome } from '../../src/workers/reset.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { summonWorker } from '../../src/workers/slot.js';
import { createFakeDeps, exited, withFsWatch, type FakeDeps, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { atWait, endsPane, withProgram, type Program } from '../helpers/worker-program.js';

const WORKER = 'alpha';
const COORDINATOR_PANE = '%0';
/** The pane of the worker: the first pane after the three panes that a session of the fixture holds. */
const PANE = '%3';
const SESSION = 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc';
const NEW_SESSION = 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const NOW = new Date('2030-01-02T03:04:05.678Z').getTime();
/** The pane process started 10 minutes ago. */
const ETIME = '10:00';
const START = NOW - 10 * MINUTE;

const CLONE = `${HOME}/web`;
const COPY = `${HOME}/work-copies/web/${WORKER}`;
const ADMIN = `${CLONE}/.git/worktrees/${WORKER}`;
const HEAD = 'a'.repeat(40);
const INBOX = workerPathsOf(HOME, WORKER).inboxDir;
const RESUME_FILE = join(INBOX, 'resume.md');
const ASSIGNMENT_FILE = join(INBOX, 'assignment.md');
const SETTINGS_FILE = hookSettingsPlaceOf(COPY).file;
const IDLE_SCREEN = 'The task is done.\n\n> \n';
const DIALOG_SCREEN = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n';

const session = { effort: 'high', model: 'default', proxyBaseUrl: null, path: '/bin', agent: 'claude' } as const;

/** The program words of the coordinator pane, as the launch of the coordinator gives them. */
const coordinatorWords = (): readonly string[] => {
  const argv = launchArgv({
    ...session,
    home: HOME,
    coordinatorDir: `${HOME}/coordinator`,
    stateDir: layoutOf(HOME).stateDir,
    sessionId: NODE,
    projects: [],
  });
  if (!argv.ok) throw new Error(argv.error);
  return argv.value;
};

const pushedGit = (change: GitFixture = {}): GitFixture => ({
  repos: { [CLONE]: {} },
  heads: { [COPY]: HEAD },
  remotes: { [CLONE]: { copies: { [`worker/${WORKER}`]: HEAD } } },
  ...change,
});

const lineFile = (sessionId: string): string => `${layoutOf(HOME).heartbeatDir}/${sessionId}`;

/** The text of a last-seen line file, with the event at `at` (milliseconds since the epoch). */
const lineText = (event: HookEvent | null, at: number, sessionId = SESSION, marker: string | null = WORKER): string =>
  `${JSON.stringify({
    schema: schemaIds.lastSeen,
    session_id: sessionId,
    event,
    event_at: event === null ? null : new Date(at).toISOString(),
    context_pct: event === null ? 40 : null,
    pct_at: event === null ? new Date(at).toISOString() : null,
    ...(marker === null ? {} : { session_marker: marker }),
  })}\n`;

interface Setup {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tmux?: TmuxFixture;
  readonly panes?: readonly PaneFixture[];
  readonly git?: GitFixture;
  readonly screen?: string;
  readonly links?: Readonly<Record<string, string>>;
  /** Runs when `ps` is called: the point between the pane read and the settings checks. */
  readonly atPs?: (world: World) => void;
  /** Runs at each git call. */
  readonly atGit?: (call: RunCall, world: World) => void;
  /** Changes the text of the n-th read of the worker pane (from 1). */
  readonly rewriteBind?: (nth: number, stdout: string) => string;
  /** Gets the first word of each tmux call, and `line` for each read of a last-seen line file, in order. */
  readonly watch?: (event: string) => void;
}

interface World {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** Runs one tmux call as the tmux server would, between two steps of the reset. */
  readonly serverCall: (args: readonly string[]) => void;
  readonly setPs: (answer: CliResult<RunOutput>) => void;
  readonly setGit: (change: GitFixture) => void;
  readonly reset: (kind?: ResetKind, using?: FakeDeps) => Promise<CliResult<ResetOutcome>>;
}

/** A node with a running tmux session, a coordinator pane, one worker with an idle session, and every file a reset needs. */
const make = async (setup: Setup = {}): Promise<World> => {
  const tmux = tmuxHandler({
    sessions: { [NODE]: HOME },
    coordinatorCommands: { [NODE]: coordinatorWords() },
    panes: setup.panes ?? [workerPane(WORKER, { pid: 4777, screen: setup.screen ?? IDLE_SCREEN })],
    ...setup.tmux,
  });
  let git = gitHandler(pushedGit(setup.git));
  let psAnswer: CliResult<RunOutput> = exited(0, `${ETIME}\n`);
  let binds = 0;
  const run: RunHandler = (call) => {
    if (call.command === 'ps') {
      setup.atPs?.(world);
      return psAnswer;
    }
    if (call.command === 'git') {
      setup.atGit?.(call, world);
      return git.handler(call);
    }
    setup.watch?.(call.args[0] ?? '');
    const result = tmux.handler(call);
    if (setup.rewriteBind !== undefined && call.args[0] === 'display-message' && call.args.includes(PANE) && result.ok) {
      binds += 1;
      return exited(result.value.exitCode, setup.rewriteBind(binds, result.value.stdout), result.value.stderr);
    }
    return result;
  };
  const created = createFakeDeps({
    cwd: '/w',
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', TMUX_PANE: COORDINATOR_PANE, FACTORY_SESSION: NODE, ...setup.env },
    run,
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  const deps =
    setup.watch === undefined
      ? created
      : withFsWatch(created, (method, path) => {
          if (method === 'readTextLimited' && path.startsWith(layoutOf(HOME).heartbeatDir)) setup.watch?.('line');
        });
  // The record is written on plain deps and copied, because a setup with a link in the inbox path could not write it.
  const plain = createFakeDeps();
  const written = await writeWorkerRecord(plain, HOME, { id: WORKER, project: 'web', workCopy: COPY, branch: `worker/${WORKER}` });
  if (!written.ok) throw new Error(written.error.message);
  const recordFile = workerPathsOf(HOME, WORKER).recordFile;
  deps.seed(recordFile, plain.files.get(recordFile) ?? '');
  deps.seedDir(INBOX);
  // As `git worktree add` makes them: the file `.git` of the work copy names the git folder of the clone, and that folder names it back.
  deps.seedDir(CLONE);
  deps.seedDir(COPY);
  deps.seed(`${COPY}/.git`, `gitdir: ${ADMIN}\n`);
  deps.seed(`${ADMIN}/gitdir`, `${COPY}/.git\n`);
  deps.seed(SETTINGS_FILE, JSON.stringify(ownSettingsEntries));
  deps.mtimes.set(SETTINGS_FILE, NOW - HOUR);
  deps.seed(RESUME_FILE, 'what is done and what is next');
  deps.mtimes.set(RESUME_FILE, NOW - 5 * MINUTE);
  deps.seed(ASSIGNMENT_FILE, 'the task');
  const pointer = await writeWorkerSession(deps, HOME, WORKER, SESSION);
  if (!pointer.ok) throw new Error(pointer.error.message);
  deps.seed(lineFile(SESSION), lineText('Stop', NOW - 5 * MINUTE));
  const world: World = {
    deps,
    tmux: tmux.log,
    serverCall: (args) => {
      tmux.handler({ command: 'tmux', args, cwd: undefined });
    },
    setPs: (answer) => {
      psAnswer = answer;
    },
    setGit: (change) => {
      git = gitHandler(pushedGit(change));
    },
    reset: (kind = 'clear', using = deps) => resetWorker(using, { home: HOME, config: sampleConfig(), workerId: WORKER, kind }),
  };
  return world;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the reset passed');
  return result.error;
};

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`the reset failed: ${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const codeOf = (error: CliError): number => exitCodeOf[error.kind];
const textOf = (error: CliError): string => `${error.message} ${error.hint ?? ''}`;

/** No key reached any pane: no send-keys call ran, and the fake tmux typed nothing. */
const expectNothingTyped = (world: World): void => {
  expect(world.tmux.typed()).toEqual([]);
  expect(world.tmux.commands().filter((command) => command.includes('send-keys'))).toEqual([]);
};

/**
 * The reset is refused before any key, and the refusal gives its remedy: the text that the remedy holds.
 * `null` is for the one refusal that has no remedy line (the fetch that fails); its reason is in the message.
 */
const refused = async (world: World, remedy: string | null, kind: ResetKind = 'clear'): Promise<CliError> => {
  const error = errorOf(await world.reset(kind));
  expectNothingTyped(world);
  if (remedy === null) expect(error.hint).toBeUndefined();
  else expect(error.hint).toContain(remedy);
  return error;
};

/** The hook of the session writes a line: the event at the time of the fake clock, for the session, and for a new session also the pointer. */
const writesLine =
  (event: HookEvent, sessionId = SESSION, pointer = false): Program =>
  async ({ deps }) => {
    if (pointer) {
      const moved = await writeWorkerSession(deps, HOME, WORKER, sessionId);
      if (!moved.ok) throw new Error(moved.error.message);
    }
    const line = await writeLastSeen(deps, HOME, sessionId, { kind: 'event', event }, WORKER);
    if (!line.ok) throw new Error(line.error.message);
  };

const AGAIN_CLEAR = 'factory worker reset alpha --clear';

/** The fields of the read of a pane (`paneBindArgs`): seven fields of facts, then the start command. */
const BIND_FACTS = 7;
const fieldsOf = (stdout: string): string[] => stdout.replace(/\n$/, '').split('|');
const withPid = (stdout: string, pid: number): string => `${fieldsOf(stdout).map((field, index) => (index === 1 ? String(pid) : field)).join('|')}\n`;
const withEndedFlag = (stdout: string): string => `${fieldsOf(stdout).map((field, index) => (index === 2 ? '1' : field)).join('|')}\n`;
const withStartCommand = (stdout: string, command: string): string => `${[...fieldsOf(stdout).slice(0, BIND_FACTS), command].join('|')}\n`;

describe('TP-22: the words of the command line (refusal 1)', () => {
  it.each([
    ['neither flag', { words: [WORKER], clear: false, compact: false }],
    ['both flags', { words: [WORKER], clear: true, compact: true }],
    ['no worker id', { words: [], clear: true, compact: false }],
    ['two worker ids', { words: [WORKER, 'beta'], clear: true, compact: false }],
  ])('TP-22: %s is exit 2, and the remedy names the command', (_name, input) => {
    const error = errorOf(parseReset(input));
    expect(codeOf(error)).toBe(2);
    expect(error.hint).toContain('factory worker reset');
  });

  it('TP-22: reads one worker id with one flag', () => {
    expect(valueOf(parseReset({ words: [WORKER], clear: true, compact: false }))).toEqual({ workerId: WORKER, kind: 'clear' });
    expect(valueOf(parseReset({ words: [WORKER], clear: false, compact: true }))).toEqual({ workerId: WORKER, kind: 'compact' });
  });
});

describe('TP-22: the caller rule refuses before the worker is read (refusals 2 to 4)', () => {
  it.each([
    ['no TMUX_PANE', { TMUX_PANE: undefined }],
    ['a TMUX_PANE that is no pane id', { TMUX_PANE: 'coordinator' }],
    ['the session word of a worker', { FACTORY_SESSION: WORKER }],
  ])('TP-22: a caller with %s is exit 2, and no tmux call runs', async (_name, env) => {
    const world = await make({ env });
    const before = world.deps.calls.length;
    expect(codeOf(await refused(world, 'in the pane of the coordinator'))).toBe(2);
    expect(world.deps.calls).toHaveLength(before);
  });

  it('TP-22: a tmux session that does not run is exit 3, and the remedy is the start command', async () => {
    const world = await make({ tmux: { sessions: {} }, panes: [] });
    const error = await refused(world, 'factory start');
    expect(codeOf(error)).toBe(3);
  });

  it('TP-22: a tmux session of another factory folder is exit 4, and the remedy names the shutdown command', async () => {
    const world = await make({ tmux: { sessions: { [NODE]: '/other/node' } }, panes: [] });
    expect(codeOf(await refused(world, 'factory shutdown'))).toBe(4);
  });

  it('TP-22: a coordinator pane that ended is exit 3, and the remedy is the start command', async () => {
    const error = await refused(await make({ tmux: { endedCoordinators: [NODE] } }), 'factory start');
    expect(codeOf(error)).toBe(3);
  });

  it('TP-22: a coordinator pane with a start command that is not the launch of the coordinator is exit 4, and the remedy is to look at the pane', async () => {
    expect(
      codeOf(await refused(await make({ tmux: { coordinatorCommands: { [NODE]: ['sleep', '3000'] } } }), 'Look at the pane in tmux')),
    ).toBe(4);
  });

  it('TP-22: a caller in another pane of the session is exit 2, and the remedy names the pane of the coordinator', async () => {
    expect(codeOf(await refused(await make({ env: { TMUX_PANE: '%1' } }), 'in the pane %0'))).toBe(2);
  });
});

describe('TP-22: the worker, its record and its pane (refusals 5 to 8)', () => {
  it('TP-22: a worker with no record is exit 2', async () => {
    const world = await make();
    const error = errorOf(await resetWorker(world.deps, { home: HOME, config: sampleConfig(), workerId: 'beta', kind: 'clear' }));
    expect(codeOf(error)).toBe(2);
    expectNothingTyped(world);
    expect(error.hint).toContain('factory worker list');
  });

  it('TP-22: a record that names another work copy is exit 4', async () => {
    const world = await make();
    const file = workerPathsOf(HOME, WORKER).recordFile;
    world.deps.seed(file, (world.deps.files.get(file) ?? '').replace(COPY, '/elsewhere/copy'));
    expect(codeOf(await refused(world, 'Check who changed the file'))).toBe(4);
  });

  it('TP-22: two live panes of the worker are exit 2, and the remedy is to close all but one', async () => {
    const world = await make({ panes: [workerPane(WORKER), workerPane(WORKER)] });
    expect(codeOf(await refused(world, 'Close all but one of these panes'))).toBe(2);
  });

  it('TP-22: a worker with no pane is exit 3, and the remedy is the resume command', async () => {
    const error = await refused(await make({ panes: [] }), 'factory worker resume alpha');
    expect(codeOf(error)).toBe(3);
  });

  it('TP-22: a worker whose pane ended is exit 3, and the remedy is the resume command', async () => {
    const error = await refused(await make({ panes: [workerPane(WORKER, { dead: true })] }), 'factory worker resume alpha');
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('ended');
  });

  it('TP-22: a pane that a summon shows in the view window is exit 3, and the remedy names the layout command', async () => {
    const world = await make();
    valueOf(await summonWorker(world.deps, { home: HOME, session: NODE, workerId: WORKER, minutes: 15 }));
    const error = await refused(world, 'factory layout');
    expect(codeOf(error)).toBe(3);
  });
});

describe('TP-22: the process, the settings and the push (refusals 9 to 12)', () => {
  it.each([
    ['ps fails', exited(1, '', 'no such process\n')],
    ['ps prints nothing', exited(0, '')],
    ['ps prints text that is no time', exited(0, 'elapsed\n')],
  ])('TP-22: when %s, the start of the pane process is not readable: exit 3', async (_name, answer) => {
    const world = await make();
    world.setPs(answer);
    const error = await refused(world, 'Look at the pane in tmux');
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('process of the pane started');
  });

  it('TP-22: work copy settings without a hook event are exit 3, and the remedy is upgrade, then restart', async () => {
    const world = await make();
    const hooks = Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([name]) => name !== 'Notification'));
    world.deps.seed(SETTINGS_FILE, JSON.stringify({ hooks }));
    world.deps.mtimes.set(SETTINGS_FILE, NOW - HOUR);
    const error = await refused(world, 'factory upgrade');
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('Notification');
    expect(error.hint).toContain('factory restart alpha');
  });

  it('TP-24: a settings file newer than the pane process is exit 3, and the remedy is the restart command', async () => {
    const world = await make();
    world.deps.mtimes.set(SETTINGS_FILE, START + SECOND);
    const error = await refused(world, 'factory restart alpha');
    expect(codeOf(error)).toBe(3);
    expect(error.hint).toContain('permission rule');
  });

  it('TP-24: a settings file that changed at the very start of the pane process is refused too: it must be strictly earlier', async () => {
    const world = await make();
    world.deps.mtimes.set(SETTINGS_FILE, START);
    expect(codeOf(await refused(world, 'factory restart alpha'))).toBe(3);
  });

  it('TP-22: work that is not pushed is exit 1, and the refusal gives the reason', async () => {
    const world = await make({ git: { remotes: { [CLONE]: { copies: { [`worker/${WORKER}`]: 'b'.repeat(40) } } } } });
    const error = await refused(world, 'Push the work of the worker alpha');
    expect(codeOf(error)).toBe(1);
    expect(error.message).toContain('is not pushed');
    expect(error.message).toContain(`worker/${WORKER}`);
    expect(error.hint).toContain(AGAIN_CLEAR);
  });

  it('TP-22: a changed file in the work copy is exit 1, and the remedy is to push the work', async () => {
    const world = await make({ git: { status: { [COPY]: ' M src/index.ts\0' } } });
    const error = await refused(world, 'Push the work of the worker alpha');
    expect(codeOf(error)).toBe(1);
    expect(error.message).toContain('src/index.ts');
  });

  it('TP-22: a fetch that fails is exit 1, and the refusal has no remedy line', async () => {
    const world = await make({ git: { remotes: { [CLONE]: { copies: { [`worker/${WORKER}`]: HEAD }, fetchExit: 128 } } } });
    expect(codeOf(await refused(world, null))).toBe(1);
  });
});

describe('TP-22: the refusals of the path checks speak the words of reset', () => {
  const AGAIN = `Run "${AGAIN_CLEAR}" again.`;

  /** The refusal names the reset command, and no word of the dismiss command. */
  const expectResetWords = (error: CliError): void => {
    expect(textOf(error)).not.toContain('dismiss');
    expect(error.hint).toContain(AGAIN);
  };

  it('TP-22: a .git entry that does not name the folder of the clone is exit 4, and says worker reset', async () => {
    const world = await make();
    world.deps.seed(`${COPY}/.git`, 'not a link to a git folder\n');
    const error = await refused(world, 'Check the file .git in the work copy');
    expect(codeOf(error)).toBe(4);
    expect(error.message).toContain('so worker reset runs no git command there');
    expect(error.hint).toBe(`Check the file .git in the work copy. ${AGAIN}`);
    expectResetWords(error);
  });

  it('TP-22: a clone that lies inside the work copy is exit 4, and says worker reset', async () => {
    const world = await make({ links: { [CLONE]: COPY } });
    const error = await refused(world, 'Check the path of the project in the config');
    expect(codeOf(error)).toBe(4);
    expect(error.message).toContain('so worker reset does not use it');
    expect(error.hint).toBe(`Check the path of the project in the config. ${AGAIN}`);
    expectResetWords(error);
  });

  it('TP-22: a work copy whose real path leaves work-copies/ is exit 4, and says worker reset', async () => {
    const world = await make({ links: { [`${HOME}/work-copies/web`]: '/elsewhere/web' } });
    world.deps.seedDir('/elsewhere/web/alpha');
    const hidden: FakeDeps = {
      ...world.deps,
      fs: { ...world.deps.fs, lstat: async (path) => (path === `${HOME}/work-copies/web` ? ok('dir' as const) : world.deps.fs.lstat(path)) },
    };
    const error = errorOf(await world.reset('clear', hidden));
    expect(codeOf(error)).toBe(4);
    expect(error.message).toContain('so worker reset does not use it');
    expect(error.hint).toBe(`Check the folder and the links in its path. ${AGAIN}`);
    expectResetWords(error);
  });

  it('TP-22: a project that the config does not list is exit 1, and says worker reset', async () => {
    const world = await make();
    const config = sampleConfig();
    const error = errorOf(
      await resetWorker(world.deps, { home: HOME, config: { ...config, recipe: { ...config.recipe, projects: [] } }, workerId: WORKER, kind: 'clear' }),
    );
    expect(codeOf(error)).toBe(1);
    expect(error.hint).toBe(`Add the project to the config. ${AGAIN}`);
    expectResetWords(error);
  });

  it('TP-22: a clone that is not a git work tree is exit 1, and says worker reset', async () => {
    const world = await make({ git: { repos: {} } });
    const error = await refused(world, 'Clone the repo of the project into that folder');
    expect(codeOf(error)).toBe(1);
    expect(error.hint).toBe(`Clone the repo of the project into that folder. ${AGAIN}`);
    expectResetWords(error);
  });
});

describe('TP-22: the resume file (refusal 13)', () => {
  it('TP-22: a missing resume file is exit 3, and the refusal names the file', async () => {
    const world = await make();
    world.deps.files.delete(RESUME_FILE);
    const error = await refused(world, RESUME_FILE);
    expect(codeOf(error)).toBe(3);
    expect(textOf(error)).toContain(RESUME_FILE);
  });

  it('TP-22: a resume file that is a link is exit 4, and the remedy is to replace the link', async () => {
    const world = await make({ links: { [RESUME_FILE]: '/elsewhere/notes.md' } });
    world.deps.seed('/elsewhere/notes.md', 'notes');
    expect(codeOf(await refused(world, 'Replace the link'))).toBe(4);
  });

  it('TP-22: an inbox folder that is a link is exit 4, and the remedy is to replace the link', async () => {
    const world = await make({ links: { [INBOX]: '/elsewhere' } });
    world.deps.seed('/elsewhere/resume.md', 'notes');
    expect(codeOf(await refused(world, 'Replace the link'))).toBe(4);
  });

  it.each([
    ['empty', ''],
    ['only white space', '  \n\t\n'],
    ['above 1 MiB', 'x'.repeat(maxFileBytes + 1)],
  ])('TP-22: a resume file that is %s is exit 3, and the refusal names the file', async (_name, text) => {
    const world = await make();
    world.deps.seed(RESUME_FILE, text);
    const error = await refused(world, RESUME_FILE);
    expect(codeOf(error)).toBe(3);
    expect(textOf(error)).toContain(RESUME_FILE);
  });
});

describe('TP-22: the bind right before the keys, and the line of the session (refusals 14 to 17)', () => {
  const BIND_REMEDY = `run "tmux set-option -p -u -t ${PANE} @worker" to clear its mark`;
  const LOOK_AT_PANE = `Look at the pane ${PANE} in tmux`;
  const WAIT_FOR_LINE = 'Wait until the session reports';

  it('TP-22: a pane that loses the mark of the worker after the checks is exit 4, and the remedy clears the mark', async () => {
    const world = await make({ atPs: (made) => made.serverCall(['set-option', '-p', '-u', '-t', PANE, '@worker']) });
    expect(codeOf(await refused(world, BIND_REMEDY))).toBe(4);
  });

  it('TP-22: a pane whose start command changes after the checks is exit 4, and the remedy clears the mark', async () => {
    const world = await make({ rewriteBind: (nth, stdout) => (nth === 1 ? stdout : withStartCommand(stdout, 'sleep 300')) });
    expect(codeOf(await refused(world, BIND_REMEDY))).toBe(4);
  });

  it('TP-22: a pane whose process id changes after the checks is exit 3', async () => {
    const world = await make({ rewriteBind: (nth, stdout) => (nth === 1 ? stdout : withPid(stdout, 4778)) });
    const error = await refused(world, LOOK_AT_PANE);
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('process');
  });

  it('TP-22: the bind comes before the read of the line: a bad bind wins over a busy session', async () => {
    const world = await make({ rewriteBind: (nth, stdout) => (nth === 1 ? stdout : withPid(stdout, 4778)) });
    world.deps.seed(lineFile(SESSION), lineText('UserPromptSubmit', NOW));
    expect(codeOf(await refused(world, LOOK_AT_PANE))).toBe(3);
  });

  it('TP-22: a line of another session marker is not owned: exit 3, and the remedy is to wait for the session', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText('Stop', NOW - MINUTE, SESSION, 'beta'));
    const error = await refused(world, WAIT_FOR_LINE);
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('last-seen line');
  });

  it('TP-22: a line with no session marker is not owned: exit 3, and the remedy is to wait for the session', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText('Stop', NOW - MINUTE, SESSION, null));
    expect(codeOf(await refused(world, WAIT_FOR_LINE))).toBe(3);
  });

  it('TP-22: a worker with no pointer has no line: exit 3, and the remedy is to wait for the session', async () => {
    const world = await make();
    world.deps.files.delete(workerPathsOf(HOME, WORKER).lastSessionFile);
    expect(codeOf(await refused(world, WAIT_FOR_LINE))).toBe(3);
  });

  it('TP-22: a line with a percent and no event says nothing: exit 3, and the remedy is to wait for the session', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText(null, NOW - MINUTE));
    expect(codeOf(await refused(world, WAIT_FOR_LINE))).toBe(3);
  });

  it.each([
    ['UserPromptSubmit', 'busy'],
    ['PreToolUse', 'busy'],
    ['PreCompact', 'busy'],
  ] as const)('TP-22: a session whose last event is %s is exit 1', async (event, word) => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText(event, NOW - MINUTE));
    const error = await refused(world, 'Wait until it waits at its prompt');
    expect(codeOf(error)).toBe(1);
    expect(error.message).toContain(word);
    expect(error.hint).toContain(AGAIN_CLEAR);
  });

  it('TP-22: a session that waits at a dialog is exit 1, and the remedy says to answer the dialog', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText('Notification', NOW - MINUTE));
    const error = await refused(world, 'answer the dialog');
    expect(codeOf(error)).toBe(1);
    expect(error.message).toContain('waits for an answer');
  });

  it('TP-23: a session that turns busy after the push check and before the line read is exit 1, with no key', async () => {
    const turnsBusy = (call: RunCall, made: World): void => {
      if (call.args.includes('stash')) made.deps.seed(lineFile(SESSION), lineText('UserPromptSubmit', NOW));
    };
    const world = await make({ atGit: turnsBusy });
    const error = await refused(world, 'Wait until it waits at its prompt');
    expect(codeOf(error)).toBe(1);
    expect(error.message).toContain('busy');
  });

  it('TP-22: a line at the start of the pane process is refused: it must be strictly later', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText('Stop', START));
    const error = await refused(world, 'Wait until the session reports');
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('not later than the start');
  });

  it('TP-22: a line 500 ms before the start of the pane process is refused', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText('Stop', START - 500));
    expect(codeOf(await refused(world, 'Wait until the session reports'))).toBe(3);
  });
});

describe('TP-22: the capture (refusal 18)', () => {
  it('TP-22: a numbered list of choices on the screen is exit 3, after one capture and with no key', async () => {
    const world = await make({ screen: DIALOG_SCREEN });
    const error = await refused(world, `Look at pane ${PANE} and answer the dialog there`);
    expect(codeOf(error)).toBe(3);
    expect(world.tmux.commands().filter((command) => command.startsWith('capture-pane'))).toHaveLength(1);
  });

  it('TP-22: a numbered list with no pointer line does not stop the reset', async () => {
    const world = await make({ screen: 'The steps:\n1. build\n2. test\n\n> \n' });
    valueOf(await world.reset('compact', withProgram(world.deps, world.tmux, atWait(1, writesLine('PreCompact')))));
    expect(world.tmux.typed()).toHaveLength(3);
  });
});

describe('TP-22: the order of the checks', () => {
  /** The failing checks one by one, from the first to the last: each repair shows the next refusal. */
  it('TP-22: with every check broken, the refusals come in the order of the steps, and the keys come last', async () => {
    const world = await make({ screen: DIALOG_SCREEN, git: { status: { [COPY]: ' M a.ts\0' } } });
    const noEvent = Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([name]) => name !== 'PreToolUse'));
    world.setPs(exited(1, '', 'no such process\n'));
    world.deps.seed(SETTINGS_FILE, JSON.stringify({ hooks: noEvent }));
    world.deps.files.delete(RESUME_FILE);
    world.deps.seed(lineFile(SESSION), lineText('Stop', NOW - MINUTE, SESSION, 'beta'));

    const next = async (): Promise<string> => {
      const error = errorOf(await world.reset());
      return textOf(error);
    };

    expect(await next()).toContain('process of the pane started');
    world.setPs(exited(0, `${ETIME}\n`));
    expect(await next()).toContain('PreToolUse');
    world.deps.seed(SETTINGS_FILE, JSON.stringify(ownSettingsEntries));
    world.deps.mtimes.set(SETTINGS_FILE, NOW);
    expect(await next()).toContain('changed after the session started');
    world.deps.mtimes.set(SETTINGS_FILE, NOW - HOUR);
    expect(await next()).toContain('is not pushed');
    world.setGit({});
    expect(await next()).toContain(RESUME_FILE);
    world.deps.seed(RESUME_FILE, 'notes');
    expect(await next()).toContain('last-seen line');
    world.deps.seed(lineFile(SESSION), lineText('UserPromptSubmit', NOW - MINUTE));
    expect(await next()).toContain('busy');
    world.deps.seed(lineFile(SESSION), lineText('Stop', START - 1));
    expect(await next()).toContain('not later than the start');
    world.deps.seed(lineFile(SESSION), lineText('Stop', NOW - MINUTE));
    expect(await next()).toContain('numbered list');
    expectNothingTyped(world);
  });
});

describe('the keys of a reset that passed every check', () => {
  const typedLine = (world: World, text: string): void => {
    expect(world.tmux.typed()).toEqual([
      { pane: PANE, literal: false, text: 'C-u' },
      { pane: PANE, literal: true, text },
      { pane: PANE, literal: false, text: 'Enter' },
    ]);
  };

  it('TP-25: types /clear into the pane of the worker, and nothing else', async () => {
    const world = await make();
    valueOf(await world.reset('clear', withProgram(world.deps, world.tmux, atWait(1, writesLine('SessionStart', NEW_SESSION, true)))));
    typedLine(world, '/clear');
  });

  it('TP-25: types /compact into the pane of the worker, and nothing else', async () => {
    const world = await make();
    valueOf(await world.reset('compact', withProgram(world.deps, world.tmux, atWait(1, writesLine('PreCompact')))));
    typedLine(world, '/compact');
  });

  it('TP-22: the capture is the last read before the keys, and the line is read after the bind', async () => {
    const events: string[] = [];
    const world = await make({ watch: (event) => events.push(event) });
    valueOf(await world.reset('compact', withProgram(world.deps, world.tmux, atWait(1, writesLine('PreCompact')))));
    const tail = events.slice(events.indexOf('send-keys') - 3);
    expect(tail.slice(0, 4)).toEqual(['display-message', 'line', 'capture-pane', 'send-keys']);
  });
});

describe('TP-25: the confirm', () => {
  const sleepsOf = (world: World): number[] => world.deps.sleeps;

  it('TP-25: --clear is confirmed by the SessionStart line of a new session, at the check where it shows', async () => {
    const world = await make();
    const outcome = valueOf(
      await world.reset('clear', withProgram(world.deps, world.tmux, atWait(3, writesLine('SessionStart', NEW_SESSION, true)))),
    );
    expect(outcome).toMatchObject({ workerId: WORKER, kind: 'clear', paneId: PANE });
    expect(sleepsOf(world)).toEqual([resetConfirm.intervalMs, resetConfirm.intervalMs, resetConfirm.intervalMs]);
  });

  it('TP-25: --clear is not confirmed by a SessionStart line of the same session', async () => {
    const world = await make();
    const error = errorOf(await world.reset('clear', withProgram(world.deps, world.tmux, atWait(2, writesLine('SessionStart')))));
    expect(codeOf(error)).toBe(3);
  });

  it('TP-25: --clear is not confirmed by a PreCompact line of a new session', async () => {
    const world = await make();
    const error = errorOf(await world.reset('clear', withProgram(world.deps, world.tmux, atWait(2, writesLine('PreCompact', NEW_SESSION, true)))));
    expect(codeOf(error)).toBe(3);
  });

  it.each(['PreCompact', 'SessionStart'] as const)('TP-25: --compact is confirmed by a %s line of the same session', async (event) => {
    const world = await make();
    valueOf(await world.reset('compact', withProgram(world.deps, world.tmux, atWait(2, writesLine(event)))));
    expect(sleepsOf(world)).toHaveLength(2);
  });

  it('TP-25: --compact is not confirmed by a Stop line', async () => {
    const world = await make();
    const error = errorOf(await world.reset('compact', withProgram(world.deps, world.tmux, atWait(1, writesLine('Stop')))));
    expect(codeOf(error)).toBe(3);
  });

  it('TP-25: a SessionStart line from before the typing does not confirm a --compact', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION), lineText('SessionStart', NOW - MINUTE));
    const error = errorOf(await world.reset('compact', withProgram(world.deps, world.tmux, () => undefined)));
    expect(codeOf(error)).toBe(3);
  });

  it('TP-25: with no confirmation it waits 10 times 1000 ms, then exits 3 and names the pane and the command to run again', async () => {
    const world = await make();
    const error = errorOf(await world.reset('clear', withProgram(world.deps, world.tmux, () => undefined)));
    expect(codeOf(error)).toBe(3);
    expect(sleepsOf(world)).toEqual(Array.from({ length: 10 }, () => 1000));
    expect(textOf(error)).toContain(`look at the pane ${PANE}`);
    expect(error.hint).toContain(AGAIN_CLEAR);
    expect(world.tmux.typed()).toHaveLength(3);
  });

  it('TP-25: a pane that tmux removes during the confirm is exit 1, and the wait stops there', async () => {
    const world = await make();
    const error = errorOf(await world.reset('clear', withProgram(world.deps, world.tmux, atWait(3, endsPane))));
    expect(codeOf(error)).toBe(1);
    expect(error.message).toContain('is gone');
    expect(error.hint).toContain('factory worker resume alpha');
    expect(sleepsOf(world)).toHaveLength(3);
  });

  it('TP-25: a pane whose program ended during the confirm is exit 1, and the wait stops at the first check that sees it', async () => {
    const world = await make({ rewriteBind: (nth, stdout) => (nth <= 4 ? stdout : withEndedFlag(stdout)) });
    const error = errorOf(await world.reset('clear', withProgram(world.deps, world.tmux, () => undefined)));
    expect(codeOf(error)).toBe(1);
    expect(error.message).toContain('ended during the reset');
    expect(sleepsOf(world)).toHaveLength(3);
  });

  it('TP-25: a pane that no longer runs the launch of the worker is exit 1', async () => {
    const world = await make({ rewriteBind: (nth, stdout) => (nth <= 2 ? stdout : withStartCommand(stdout, 'sleep 300')) });
    const error = errorOf(await world.reset('clear', withProgram(world.deps, world.tmux, () => undefined)));
    expect(codeOf(error)).toBe(1);
  });
});

describe('TP-26: the output of a reset', () => {
  const outcome: ResetOutcome = { workerId: WORKER, kind: 'clear', paneId: PANE, name: 'demo-alpha', resumeAgeMs: 5 * MINUTE };

  it('TP-26: prints the verdict, the age of the resume file and the next step', () => {
    const text = resetOutput(outcome).lines.map((line) => line.text).join('\n');
    expect(text).toContain('Cleared the session of the worker alpha');
    expect(text).toContain(PANE);
    expect(text).toContain('5 minutes');
    expect(text).toContain('SendMessage');
    expect(text).toContain('ListAgents');
    expect(text).toContain('factory restart alpha');
  });

  it('TP-26: a compact says compacted, and it does not tell the person to look for the name of the session', () => {
    const text = resetOutput({ ...outcome, kind: 'compact' }).lines.map((line) => line.text).join('\n');
    expect(text).toContain('Compacted the session of the worker alpha');
    expect(text).toContain('SendMessage');
    expect(text).not.toContain('factory restart');
  });

  it.each([
    [0, 'less than a minute'],
    [59 * SECOND, 'less than a minute'],
    [MINUTE, '1 minute'],
    [2 * HOUR, '2 hours'],
    [49 * HOUR, '2 days'],
  ])('TP-26: shows the age %d ms as %s', (ms, words) => {
    const text = resetOutput({ ...outcome, resumeAgeMs: ms }).lines.map((line) => line.text).join('\n');
    expect(text).toContain(words);
  });

  it('TP-26: gives the object of version 1 with --json', () => {
    expect(resetOutput(outcome).json).toEqual({
      schema: 'factory.worker-reset/v1',
      id: WORKER,
      kind: 'clear',
      pane: PANE,
      name: 'demo-alpha',
      confirmed: true,
      resumeAgeSeconds: 300,
    });
  });

  it('TP-26: a reset that passed gives that output, and it is not a failure', async () => {
    const world = await make();
    const done = valueOf(await world.reset('clear', withProgram(world.deps, world.tmux, atWait(1, writesLine('SessionStart', NEW_SESSION, true)))));
    expect(done).toEqual({ workerId: WORKER, kind: 'clear', paneId: PANE, name: 'demo-alpha', resumeAgeMs: 5 * MINUTE });
    expect(resetOutput(done).failed).toBe(false);
  });
});

describe('TP-39: the output of a reset is short, and its size is in the token budget (row 7)', () => {
  const outcome: ResetOutcome = { workerId: WORKER, kind: 'clear', paneId: PANE, name: 'demo-alpha', resumeAgeMs: 5 * MINUTE };

  it.each<ResetKind>(['clear', 'compact'])('TP-39: the output of a %s passes the short-output check', (kind) => {
    expectShortOutput(plainText(resetOutput({ ...outcome, kind })));
  });

  it('TP-39: the size of the output of a clear on this fixture is the value of the row 7', () => {
    const text = plainText(resetOutput(outcome));
    const row = budgetRow(7);
    expect(row.command).toBe('`factory worker reset`');
    expect(row.measured).toBe(tokensOf(text));
    expect(tokensOf(text)).toBeLessThanOrEqual(row.budget);
  });
});

describe('TP-42: the files of the inbox survive a reset', () => {
  it('TP-42: assignment.md and resume.md stay in the worker folder after a --clear reset', async () => {
    const world = await make();
    valueOf(await world.reset('clear', withProgram(world.deps, world.tmux, atWait(1, writesLine('SessionStart', NEW_SESSION, true)))));
    expect(world.deps.files.get(ASSIGNMENT_FILE)).toBe('the task');
    expect(world.deps.files.get(RESUME_FILE)).toBe('what is done and what is next');
  });

  it('TP-42: they stay after a --clear reset that is not confirmed', async () => {
    const world = await make();
    errorOf(await world.reset('clear', withProgram(world.deps, world.tmux, () => undefined)));
    expect(world.deps.files.has(ASSIGNMENT_FILE)).toBe(true);
    expect(world.deps.files.has(RESUME_FILE)).toBe(true);
  });
});
