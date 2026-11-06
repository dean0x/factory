import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSelfReset, selfReset, selfResetOutput, type SelfResetOutcome } from '../../src/commands/self.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { hookSettingsPlaceOf, ownSettingsEntries } from '../../src/core/claude-settings.js';
import { launchArgv } from '../../src/launch/argv.js';
import { maxFileBytes, schemaIds, type HookEvent } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeCoordinatorSession, writeLastSeen } from '../../src/workers/last-seen.js';
import { createFakeDeps, exited, withFsWatch, type FakeDeps, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { COORDINATOR_PANE, HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { tmuxHandler, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const SESSION = 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc';
const WORKER = 'alpha';
const IDLE_SCREEN = 'The task is done.\n\n> \n';
const DIALOG_SCREEN = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n';
const LIST_ENDING_SCREEN = 'The steps:\n1. first\n2. second\n\n> \n';
const COORDINATOR_PID = 4000;
const MINUTE = 60_000;

const RESUME_DIR = join(layoutOf(HOME).stateDir, 'resume');
const RESUME_FILE = join(RESUME_DIR, `${NODE}.md`);
const SETTINGS_FILE = hookSettingsPlaceOf(layoutOf(HOME).coordinatorDir).file;

const session = { effort: 'high', model: 'default', proxyBaseUrl: null, path: '/bin', agent: 'claude' } as const;

/** The program words of the coordinator pane, as the launch of the coordinator gives them. */
const coordinatorWords = (): readonly string[] => {
  const argv = launchArgv({
    ...session,
    home: HOME,
    coordinatorDir: layoutOf(HOME).coordinatorDir,
    stateDir: layoutOf(HOME).stateDir,
    sessionId: NODE,
    projects: [],
  });
  if (!argv.ok) throw new Error(argv.error);
  return argv.value;
};

/** The last-seen line of the session of the coordinator: an event, or none (a line that holds only a context percent). */
type Line = { readonly event: HookEvent | null; readonly marker?: string };

interface Setup {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tmux?: TmuxFixture;
  /** What `capture-pane` prints for the coordinator pane. Default: an idle prompt. */
  readonly screen?: string;
  readonly links?: Readonly<Record<string, string>>;
  /** The line of the session. `null`: no pointer at all. Default: `Stop`, a session that waits at its prompt. */
  readonly line?: Line | null;
  /** The text of the hook settings of the coordinator. `null`: no file. Default: the entries of the program. */
  readonly settings?: string | null;
  /** The text of the resume file. `null`: no file. Default: some notes. */
  readonly resume?: string | null;
  /** Changes the text of the n-th read of the coordinator pane (from 1). */
  readonly rewriteRead?: (nth: number, stdout: string) => string;
  /** Gets the first word of each tmux call, `coordinator` for each read of the coordinator pane, and `line` and `resume` for the reads of those files. */
  readonly watch?: (event: string) => void;
}

interface World {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  readonly run: () => Promise<CliResult<SelfResetOutcome>>;
}

const isCoordinatorRead = (call: RunCall): boolean => call.args[0] === 'display-message' && call.args.some((arg) => arg.includes('{left}'));

/** A node with a running tmux session and a coordinator pane, a session with a line, and every file that `self reset` needs. */
const make = async (setup: Setup = {}): Promise<World> => {
  const tmux = tmuxHandler({
    sessions: { [NODE]: HOME },
    coordinatorCommands: { [NODE]: coordinatorWords() },
    ...setup.tmux,
  });
  let reads = 0;
  const run: RunHandler = (call) => {
    setup.watch?.(isCoordinatorRead(call) ? 'coordinator' : (call.args[0] ?? ''));
    const result = tmux.handler(call);
    // The fake tmux holds no screen for the coordinator pane that it makes itself, so the capture of that pane prints the screen of the setup.
    if (call.args[0] === 'capture-pane' && call.args.includes(COORDINATOR_PANE) && result.ok && result.value.exitCode === 0) {
      return exited(0, setup.screen ?? IDLE_SCREEN);
    }
    if (setup.rewriteRead !== undefined && isCoordinatorRead(call) && result.ok) {
      reads += 1;
      return exited(result.value.exitCode, setup.rewriteRead(reads, result.value.stdout), result.value.stderr);
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
          if (method !== 'readTextLimited') return;
          if (path.startsWith(layoutOf(HOME).heartbeatDir)) setup.watch?.('line');
          if (path === RESUME_FILE) setup.watch?.('resume');
        });
  const settings = setup.settings === undefined ? JSON.stringify(ownSettingsEntries) : setup.settings;
  if (settings !== null) deps.seed(SETTINGS_FILE, settings);
  const resume = setup.resume === undefined ? 'what is done and what is next' : setup.resume;
  if (resume !== null) deps.seed(RESUME_FILE, resume);
  const line = setup.line === undefined ? { event: 'Stop' as const } : setup.line;
  if (line !== null) {
    const change = line.event === null ? ({ kind: 'percent', percent: 40 } as const) : ({ kind: 'event', event: line.event } as const);
    const written = await writeLastSeen(deps, HOME, SESSION, change, line.marker ?? NODE);
    if (!written.ok) throw new Error(written.error.message);
    const pointer = await writeCoordinatorSession(deps, HOME, SESSION);
    if (!pointer.ok) throw new Error(pointer.error.message);
  }
  deps.mtimes.set(RESUME_FILE, deps.now().getTime() - 5 * MINUTE);
  return { deps, tmux: tmux.log, run: () => selfReset(deps, { home: HOME, config: sampleConfig() }) };
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but self reset passed');
  return result.error;
};

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`self reset failed: ${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const codeOf = (error: CliError): number => exitCodeOf[error.kind];
const textOf = (error: CliError): string => `${error.message} ${error.hint ?? ''}`;

/** No key reached any pane: no send-keys call ran, and the fake tmux typed nothing. */
const expectNothingTyped = (world: World): void => {
  expect(world.tmux.typed()).toEqual([]);
  expect(world.tmux.commands().filter((command) => command.includes('send-keys'))).toEqual([]);
};

/** Self reset is refused before any key. */
const refused = async (world: World): Promise<CliError> => {
  const error = errorOf(await world.run());
  expectNothingTyped(world);
  return error;
};

const COMPACT_KEYS = [
  { pane: COORDINATOR_PANE, literal: false, text: 'C-u' },
  { pane: COORDINATOR_PANE, literal: true, text: '/compact' },
  { pane: COORDINATOR_PANE, literal: false, text: 'Enter' },
];

describe('TP-27: self reset types the compact line into its own pane', () => {
  it.each<[string, HookEvent]>([
    ['busy', 'UserPromptSubmit'],
    ['prompt', 'Stop'],
  ])('TP-27: types /compact in the coordinator pane when the state is %s: there is no idle gate', async (_state, event) => {
    const world = await make({ line: { event } });
    const outcome = valueOf(await world.run());
    expect(outcome.paneId).toBe(COORDINATOR_PANE);
    expect(world.tmux.typed()).toEqual(COMPACT_KEYS);
  });

  it('TP-27: types the compact line once, with the three keys in one tmux run', async () => {
    const world = await make();
    valueOf(await world.run());
    expect(world.tmux.commands().filter((command) => command.includes('send-keys'))).toHaveLength(1);
  });

  it('TP-27: types no hint after the compact line', async () => {
    const world = await make();
    valueOf(await world.run());
    expect(world.tmux.typed().filter((item) => item.literal).map((item) => item.text)).toEqual(['/compact']);
  });

  it('TP-27: a screen that ends with a numbered list but has no pointer line still types', async () => {
    const world = await make({ screen: LIST_ENDING_SCREEN });
    valueOf(await world.run());
    expect(world.tmux.typed()).toEqual(COMPACT_KEYS);
  });

  it('TP-27: a missing resume file is exit 3, names the file of the node in the resume folder, and types nothing', async () => {
    const world = await make({ resume: null });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(textOf(error)).toContain(RESUME_FILE);
    expect(error.hint).toContain('factory self reset');
  });

  it('TP-27: a resume file that is a link is exit 4', async () => {
    const world = await make({ links: { [RESUME_FILE]: '/elsewhere/notes.md' } });
    expect(codeOf(await refused(world))).toBe(4);
  });

  it('TP-27: a resume folder that is a link is exit 4', async () => {
    const world = await make({ links: { [RESUME_DIR]: '/elsewhere' } });
    expect(codeOf(await refused(world))).toBe(4);
  });

  it.each([
    ['empty', ''],
    ['only white space', ' \n\t\n'],
    ['over the size limit', 'x'.repeat(maxFileBytes + 1)],
  ])('TP-27: a resume file that is %s is exit 3 and names the file', async (_name, resume) => {
    const world = await make({ resume });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(textOf(error)).toContain(RESUME_FILE);
  });

  it('TP-27: a screen that shows a numbered list of choices is exit 3, after the capture, and types nothing', async () => {
    const world = await make({ screen: DIALOG_SCREEN });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(world.tmux.commands().some((command) => command.startsWith('capture-pane'))).toBe(true);
  });

  it('TP-27: a capture that fails is exit 1, and nothing is typed', async () => {
    const world = await make({ tmux: { failing: 'capture-pane' } });
    expect(codeOf(await refused(world))).toBe(1);
  });
});

describe('TP-28: self reset refuses a session that waits and a coordinator without the hook events', () => {
  it('TP-28: an own line in the state waits is exit 3, the remedy says to answer the dialog, and nothing is typed', async () => {
    const world = await make({ line: { event: 'Notification' } });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('dialog');
    expect(error.hint).toContain('factory self reset');
  });

  it('TP-28: coordinator settings without the event Notification are exit 3, and the remedy is upgrade, then reboot', async () => {
    const hooks = Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([name]) => name !== 'Notification'));
    const world = await make({ settings: JSON.stringify({ hooks }) });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('Notification');
    expect(error.hint).toContain('factory upgrade');
    expect(error.hint).toContain('factory reboot');
  });

  it('TP-28: coordinator settings that are missing are exit 3', async () => {
    expect(codeOf(await refused(await make({ settings: null })))).toBe(3);
  });

  it('TP-28: coordinator settings that are a link are exit 4', async () => {
    const world = await make({ links: { [SETTINGS_FILE]: '/elsewhere/settings.json' } });
    expect(codeOf(await refused(world))).toBe(4);
  });

  it('TP-28: the output has the QUEUED verdict, and the JSON object is the self-reset object, version 1', async () => {
    const world = await make();
    const output = selfResetOutput(valueOf(await world.run()));
    expect(output.failed).toBe(false);
    expect(output.lines.map((line) => line.text)).toEqual(['QUEUED: the compact runs after the current turn']);
    expect(output.json).toEqual({ schema: schemaIds.selfReset, pane: COORDINATOR_PANE, queued: true });
    expect(schemaIds.selfReset).toBe('factory.self-reset/v1');
  });
});

describe('TP-27: the own line of the coordinator', () => {
  it('TP-27: no pointer to a session is exit 3', async () => {
    const world = await make({ line: null });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(error.hint).toContain('factory self reset');
  });

  it('TP-27: a line of a session that another node or a worker wrote is not owned: exit 3', async () => {
    const world = await make({ line: { event: 'Stop', marker: WORKER } });
    expect(codeOf(await refused(world))).toBe(3);
  });

  it('TP-27: a line that holds no event says nothing about a dialog: exit 3', async () => {
    const world = await make({ line: { event: null } });
    expect(codeOf(await refused(world))).toBe(3);
  });

  it('TP-27: a pointer to a session that has no line is exit 3', async () => {
    const world = await make({ line: null });
    const pointer = await writeCoordinatorSession(world.deps, HOME, 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd');
    expect(pointer.ok).toBe(true);
    expect(codeOf(await refused(world))).toBe(3);
  });
});

describe('TP-27: the caller rule comes first', () => {
  it.each([
    ['no TMUX_PANE', { TMUX_PANE: undefined }],
    ['a TMUX_PANE that is no pane id', { TMUX_PANE: 'coordinator' }],
    ['the session word of a worker', { FACTORY_SESSION: WORKER }],
    ['no FACTORY_SESSION', { FACTORY_SESSION: undefined }],
  ])('TP-27: a caller with %s is exit 2, and no tmux call and no file read run', async (_name, env) => {
    const world = await make({ env });
    const before = world.deps.calls.length;
    expect(codeOf(await refused(world))).toBe(2);
    expect(world.deps.calls).toHaveLength(before);
  });

  it('TP-27: a tmux session that does not run is exit 3, and the remedy is the start command', async () => {
    const world = await make({ tmux: { sessions: {} } });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(error.hint).toContain('factory start');
  });

  it('TP-27: a tmux session of another factory folder is exit 4', async () => {
    expect(codeOf(await refused(await make({ tmux: { sessions: { [NODE]: '/other/node' } } })))).toBe(4);
  });

  it('TP-27: a coordinator pane that ended is exit 3, and the remedy is the start command', async () => {
    const error = await refused(await make({ tmux: { endedCoordinators: [NODE] } }));
    expect(codeOf(error)).toBe(3);
    expect(error.hint).toContain('factory start');
  });

  it('TP-27: a coordinator pane with a start command that is not the launch of the coordinator is exit 4', async () => {
    expect(codeOf(await refused(await make({ tmux: { coordinatorCommands: { [NODE]: ['sleep', '3000'] } } })))).toBe(4);
  });

  it('TP-27: a caller in a worker pane is exit 2', async () => {
    const world = await make({ env: { TMUX_PANE: '%3' }, tmux: { panes: [workerPane(WORKER)] } });
    expect(codeOf(await refused(world))).toBe(2);
  });

  it('TP-27: the caller rule checks before the settings, the line and the resume file are read', async () => {
    const world = await make({ env: { TMUX_PANE: '%1' }, settings: null, resume: null, line: null });
    const error = await refused(world);
    expect(codeOf(error)).toBe(2);
  });
});

describe('TP-27: the pane is bound again right before the keys', () => {
  const COORDINATOR_FIELDS = 4;
  const fieldsOf = (stdout: string): string[] => stdout.replace(/\n$/, '').split('|');
  const rewriteSecond =
    (change: (fields: string[]) => string[]) =>
    (nth: number, stdout: string): string =>
      nth === 2 ? `${change(fieldsOf(stdout)).join('|')}\n` : stdout;

  it('TP-27: a pane with another pid in the second read is exit 3, and nothing is typed', async () => {
    const world = await make({
      rewriteRead: rewriteSecond((fields) => fields.map((field, index) => (index === 1 ? String(COORDINATOR_PID + 1) : field))),
    });
    const error = await refused(world);
    expect(codeOf(error)).toBe(3);
    expect(error.message).toContain('changed');
  });

  it('TP-27: a pane that ended in the second read is exit 3', async () => {
    const world = await make({ rewriteRead: rewriteSecond((fields) => fields.map((field, index) => (index === 2 ? '1' : field))) });
    expect(codeOf(await refused(world))).toBe(3);
  });

  it('TP-27: a pane with another start command in the second read is exit 4', async () => {
    const world = await make({
      rewriteRead: rewriteSecond((fields) => [...fields.slice(0, COORDINATOR_FIELDS), 'sleep 3000']),
    });
    expect(codeOf(await refused(world))).toBe(4);
  });

  it('TP-27: a pane that is gone in the second read is exit 3', async () => {
    const world = await make({ rewriteRead: (nth, stdout) => (nth === 2 ? '||||\n' : stdout) });
    expect(codeOf(await refused(world))).toBe(3);
  });
});

describe('TP-27: the order of the reads', () => {
  it('TP-27: the line, then the resume file, then the second read of the pane, then the capture, then the keys', async () => {
    const seen: string[] = [];
    const world = await make({ watch: (event) => seen.push(event) });
    valueOf(await world.run());
    const first = (event: string): number => seen.indexOf(event);
    const last = (event: string): number => seen.lastIndexOf(event);
    expect(first('line')).toBeGreaterThan(first('coordinator'));
    expect(first('resume')).toBeGreaterThan(last('line'));
    expect(last('coordinator')).toBeGreaterThan(last('resume'));
    expect(first('capture-pane')).toBeGreaterThan(last('coordinator'));
    expect(first('send-keys')).toBeGreaterThan(first('capture-pane'));
  });

  it('TP-27: the capture is the last call before the keys', async () => {
    const seen: string[] = [];
    const world = await make({ watch: (event) => seen.push(event) });
    valueOf(await world.run());
    expect(seen[seen.indexOf('send-keys') - 1]).toBe('capture-pane');
  });

  it('TP-27: the pane process is not read: self reset has no process start check', async () => {
    const world = await make();
    valueOf(await world.run());
    expect(world.deps.calls.filter((call) => call.command === 'ps')).toEqual([]);
  });
});

describe('TP-27: the words of the command line', () => {
  it('TP-27: reads no argument', () => {
    expect(parseSelfReset([]).ok).toBe(true);
  });

  it('TP-27: an argument is exit 2, and the remedy names the command', () => {
    const error = errorOf(parseSelfReset(['alpha']));
    expect(codeOf(error)).toBe(2);
    expect(error.hint).toContain('factory self reset');
  });
});
