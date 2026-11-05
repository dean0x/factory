import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBlock } from '../../src/blocks/managed.js';
import { failure } from '../../src/cli/errors.js';
import { collectSetup } from '../../src/commands/init-received.js';
import type { StartOptions } from '../../src/commands/start.js';
import { runStart } from '../helpers/package-registry.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { shellWord } from '../../src/core/shell-word.js';
import { instructionFileWarnings, scanInstructionFiles } from '../../src/core/instruction-files.js';
import { effectiveModes } from '../../src/core/owner-record.js';
import { ok } from '../../src/core/result.js';
import { stripScript } from '../../src/launch/argv.js';
import { activeMachine, env, files, hookNames, schemaIds, tmuxNames, trackedFiles } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { safetyTemplateFor } from '../../src/templates/index.js';
import { writeCoordinatorSession, writeLastSeen } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { claudeFileText, softwareOwnerModes, workerFileText } from '../helpers/blocks.js';
import {
  createFakeDeps,
  exited,
  registerRoot,
  withFailingWrites,
  withFsWatch,
  type FakeDeps,
  type FetchHandler,
  type PromptHandler,
  type RunCall,
} from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { ACCEPTANCES, acceptFiles, acceptTracked } from '../helpers/setup-acceptance.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { chainOf, tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { endsPane, startsSessions, withProgram, type Program } from '../helpers/worker-program.js';

const HOME = '/w/node';
const COORDINATOR = '/w/node/coordinator';
const CLAUDE_FILE = '/w/node/coordinator/CLAUDE.md';
const SETTINGS_FILE = '/w/node/coordinator/.claude/settings.local.json';
/** The settings file as the writer of the hook settings leaves it. */
const OWN_SETTINGS = `${JSON.stringify(ownSettingsEntries, null, 2)}\n`;
const STATE_DIR = '/w/node/.factory';
const RUNTIME_DIR = '/w/node/.factory/state';
const MACHINE_ID_FILE = '/w/node/.factory/state/machine-id';
const MARK_FILE = '/w/node/.factory/active-machine.json';
const PROXY_URL = 'http://127.0.0.1:8080/secret-path';
const REMOVE_PROXY_VARIABLE = 'set-environment -t =demo -r ANTHROPIC_BASE_URL';
const SET_SESSION_MARKER = `set-environment -t =demo ${env.session} demo`;
const KEEP_PANE = 'set-option -w -t =demo:view remain-on-exit on';
const LAUNCH_BASE = [
  '/bin/sh',
  '-c',
  stripScript,
  'factory-launch',
  'env',
  '-u',
  'ANTHROPIC_BASE_URL',
  'PATH=/bin',
  'FACTORY_HOME=/w/node',
  'FACTORY_SESSION=demo',
  'claude',
  '--permission-mode',
  'auto',
  '--effort',
  'high',
];
/** The folders that the launch adds: the state folder first, then each project. */
const LAUNCH_DIRS = ['--add-dir', '/w/node/.factory', '--add-dir', '/w/node/web'];

interface Setup {
  readonly tmux?: TmuxFixture;
  readonly env?: Record<string, string | undefined>;
  readonly tty?: boolean;
  /** Overrides `tty` for the output only. */
  readonly stdoutTty?: boolean;
  readonly config?: FactoryConfig;
  readonly fetch?: FetchHandler;
  /** The programs on PATH. Default: tmux and claude. */
  readonly tools?: readonly string[];
  readonly links?: Record<string, string>;
  /** The top folder of the git work tree that holds the home. Default: the home is in no work tree. */
  readonly workTree?: string;
  /** The current folder. Default: /w. */
  readonly cwd?: string;
  /** False: the factory list has no entry for the home. Default: true. */
  readonly registered?: boolean;
  /** False: the home has no coordinator folder. Default: true. */
  readonly coordinatorFolder?: boolean;
  /** The text of coordinator/CLAUDE.md. Default: the blocks as the package renders them for the config. False: no file. */
  readonly claudeFile?: string | false;
  /** The text of coordinator/.claude/settings.local.json. Default: the own entries, so `start` asks nothing. False: no file. */
  readonly hookSettings?: string | false;
  /** The paths of the project folders that exist in the home. Default: the folder of each project of the config. */
  readonly projectFolders?: readonly string[];
  /** The paths that git tracks in the home. Default: none. */
  readonly tracked?: readonly string[];
  /** The paths that git ignores in the home. Default: git ignores every path. */
  readonly ignored?: readonly string[];
  /** True: `git check-ignore` fails with exit code 128 for every path. Default: it answers. */
  readonly ignoreFails?: boolean;
  /** The origin of the home in the factory list. Default: none, so the home counts as received. */
  readonly origin?: 'own' | 'received';
  /** True: the home is the top folder of no git work tree, so git can not list its files. */
  readonly noRepo?: boolean;
  /** The answer to a question. Default: no answer, so a question fails the command. */
  readonly prompt?: PromptHandler;
  /**
   * The state folder is a git repo of its own. It answers the status, the identity, the staging and the commit.
   * `status` is the porcelain text of `git status` (default: no change). `commitExit` is the exit code of the commit.
   */
  readonly stateRepo?: { readonly status?: string; readonly commitExit?: number };
}

/**
 * A fake of git. It knows the top folder of the work tree, and for the home it answers the questions of the root checks:
 * the top of the work tree, the tracked paths and the ignore rules. The tmux log does not record its calls.
 */
const gitAnswer = (setup: Setup) => (call: RunCall) => {
  const command = call.args.slice(2).join(' ');
  if (setup.stateRepo !== undefined && call.args[1] === STATE_DIR) {
    if (command === 'status --porcelain -z --untracked-files=all') return exited(0, setup.stateRepo.status ?? '');
    if (command === 'config user.name' || command === 'config user.email') return exited(0, 'Git User\n');
    return exited(command.includes(' commit ') ? (setup.stateRepo.commitExit ?? 0) : 0);
  }
  if (call.args.includes('--show-toplevel') && setup.workTree !== undefined) return exited(0, `${setup.workTree}\n`);
  if (setup.noRepo !== true) {
    if (command === 'rev-parse --is-inside-work-tree --show-prefix') return exited(0, 'true\n\n');
    if (command === 'ls-files -z') return exited(0, (setup.tracked ?? []).map((path) => `${path}\0`).join(''));
    if (call.args[2] === 'check-ignore') {
      if (setup.ignoreFails === true) return exited(128, '', 'fatal: check-ignore failed\n');
      const asked = call.args.slice(call.args.indexOf('--') + 1);
      const rules = setup.ignored;
      return asked.every((path) => rules === undefined || rules.includes(path)) ? exited(0) : exited(1);
    }
  }
  return exited(128, '', 'fatal: not a git repository\n');
};

const withProxy = (onFail: 'stop' | 'direct'): FactoryConfig => {
  const config = sampleConfig();
  return {
    ...config,
    core: {
      ...config.core,
      proxies: [{ id: 'local', base_url: PROXY_URL, health: '/health', on_fail: onFail }],
      session: { ...config.core.session, proxy: 'local' },
    },
  };
};

const make = (setup: Setup = {}): { deps: FakeDeps; tmux: TmuxLog } => {
  const { handler, log } = tmuxHandler(setup.tmux);
  // The state folder is a git repo of its own, as `init` makes it, so the mark of the active machine can be committed.
  const git = gitAnswer({ ...setup, stateRepo: setup.stateRepo ?? {} });
  const tty = setup.tty ?? false;
  const deps = createFakeDeps({
    cwd: setup.cwd ?? '/w',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...setup.env },
    run: (call) => (call.command === 'git' ? git(call) : handler(call)),
    stdinIsTTY: tty,
    stdoutIsTTY: setup.stdoutTty ?? tty,
    ...(setup.prompt === undefined ? {} : { prompt: setup.prompt }),
    ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  for (const tool of setup.tools ?? ['tmux', 'claude']) deps.seed(`/bin/${tool}`, '');
  deps.seedDir(`${STATE_DIR}/.git`);
  deps.seedDir(RUNTIME_DIR);
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  if (setup.coordinatorFolder !== false) deps.seedDir(COORDINATOR);
  if (setup.coordinatorFolder !== false && setup.claudeFile !== false) {
    deps.seed(CLAUDE_FILE, setup.claudeFile ?? claudeFileText(config));
  }
  if (setup.coordinatorFolder !== false && setup.hookSettings !== false) {
    deps.seed(SETTINGS_FILE, setup.hookSettings ?? OWN_SETTINGS);
  }
  for (const path of setup.projectFolders ?? config.recipe.projects.map((project) => project.path)) {
    deps.seedDir(`${HOME}/${path}`);
  }
  for (const path of setup.tracked ?? []) if (!deps.files.has(`${HOME}/${path}`)) deps.seed(`${HOME}/${path}`, 'text\n');
  if (setup.registered !== false) registerRoot(deps, HOME, config.core.node.id, [], setup.origin);
  return { deps, tmux: log };
};

const startFactory = async (deps: FakeDeps, options: Partial<StartOptions> = {}) =>
  runStart(deps, { home: HOME, dryRun: false, yes: false, ...options });

const succeeded = async (deps: FakeDeps, options: Partial<StartOptions> = {}) => {
  const result = await startFactory(deps, options);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const answers: FetchHandler = () => ok({ status: 200 });
const silent: FetchHandler = () => failure('no answer');

describe('start:a new session', () => {
  it('runs the tmux calls in order, with the launch of the coordinator in the first one', async () => {
    const { deps, tmux } = make();
    await succeeded(deps);
    expect(tmux.commands()).toEqual([
      '-V',
      'has-session -t =demo',
      `new-session -d -s demo -n view -c ${COORDINATOR} -- ${[...LAUNCH_BASE, ...LAUNCH_DIRS].join(' ')} ; ${KEEP_PANE}`,
      REMOVE_PROXY_VARIABLE,
      SET_SESSION_MARKER,
      'set-option -p -t =demo:view.{left} @node demo',
      'set-option -t =demo: @factory_home /w/node',
      `split-window -d -h -t =demo:view -c ${COORDINATOR}`,
      'set-option -p -t =demo:view.{right} @slot board',
      `new-window -d -t =demo: -n workers -c ${COORDINATOR}`,
    ]);
  });

  it('starts in the coordinator folder, with the root as the home, and adds no folder for the root (TP-46)', async () => {
    const { deps, tmux } = make();
    await succeeded(deps);
    const start = tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];
    expect(start[start.indexOf('-c') + 1]).toBe(COORDINATOR);
    expect(start).toContain('FACTORY_HOME=/w/node');
    const added = start.flatMap((arg, index) => (arg === '--add-dir' ? [start[index + 1]] : []));
    expect(added).toEqual([STATE_DIR, '/w/node/web']);
    expect(added).not.toContain(HOME);
    expect(tmux.commands()).toContain('set-option -t =demo: @factory_home /w/node');
  });

  it('sets remain-on-exit in the call that starts the session, so the pane cannot end before the option applies', async () => {
    const { deps, tmux } = make();
    await succeeded(deps);
    const keeping = tmux.calls.filter((call) => call.args.includes('remain-on-exit'));
    expect(keeping).toHaveLength(1);
    expect(keeping[0]?.args[0]).toBe('new-session');
    const args = keeping[0]?.args ?? [];
    expect(args.slice(args.indexOf(';'))).toEqual([';', 'set-option', '-w', '-t', '=demo:view', 'remain-on-exit', 'on']);
  });

  it('keeps the session and finishes the start when the program of the coordinator ends at once', async () => {
    const { deps, tmux } = make({ tmux: { programEndsAtOnce: true } });
    const output = await succeeded(deps);
    expect(tmux.sessions().has('demo')).toBe(true);
    expect(tmux.commands().some((line) => line.startsWith('kill-session'))).toBe(false);
    expect(tmux.commands().at(-1)).toBe(`new-window -d -t =demo: -n workers -c ${COORDINATOR}`);
    expect(output.json).toMatchObject({ started: true });
  });

  it('keeps a PATH that ends in a semicolon as one word of the launch, and not as the end of a command', async () => {
    const { deps, tmux } = make({ env: { PATH: '/bin:/opt/claude/bin;' } });
    await succeeded(deps);
    const start = tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];
    const [launch, keepPane] = chainOf(start);
    expect(chainOf(start)).toHaveLength(2);
    expect(launch).toContain('PATH=/bin:/opt/claude/bin;');
    expect(launch?.slice(-2)).toEqual(['--add-dir', '/w/node/web']);
    expect(keepPane).toEqual(['set-option', '-w', '-t', '=demo:view', 'remain-on-exit', 'on']);
  });

  it('gives the PATH of this process to the launch, so the PATH of the tmux server does not matter', async () => {
    const { deps, tmux } = make({ env: { PATH: '/opt/claude/bin:/bin' } });
    await succeeded(deps);
    const launch = tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];
    expect(launch).toContain('PATH=/opt/claude/bin:/bin');
    expect(launch.indexOf('PATH=/opt/claude/bin:/bin')).toBeLessThan(launch.indexOf('claude'));
  });

  it('removes the proxy variable from the environment of the session only, before any other window or pane exists', async () => {
    const { deps, tmux } = make();
    await succeeded(deps);
    const commands = tmux.commands();
    const removal = commands.indexOf(REMOVE_PROXY_VARIABLE);
    expect(removal).toBe(commands.findIndex((line) => line.startsWith('new-session')) + 1);
    expect(removal).toBeLessThan(commands.findIndex((line) => line.startsWith('split-window')));
    expect(removal).toBeLessThan(commands.findIndex((line) => line.startsWith('new-window')));
    const environmentCalls = tmux.calls.filter((call) => call.args[0] === 'set-environment' || call.args[0] === 'setenv');
    expect(environmentCalls.map((call) => call.args)).toEqual([
      ['set-environment', '-t', '=demo', '-r', 'ANTHROPIC_BASE_URL'],
      ['set-environment', '-t', '=demo', env.session, 'demo'],
    ]);
    expect(tmux.calls.some((call) => call.args.includes('-g'))).toBe(false);
  });

  it('puts the session marker in the environment of the session only, before any other window or pane exists (TP-80)', async () => {
    const { deps, tmux } = make();
    await succeeded(deps);
    const commands = tmux.commands();
    const marker = commands.indexOf(SET_SESSION_MARKER);
    expect(marker).toBeGreaterThan(commands.findIndex((line) => line.startsWith('new-session')));
    expect(marker).toBeLessThan(commands.findIndex((line) => line.startsWith('split-window')));
    expect(marker).toBeLessThan(commands.findIndex((line) => line.startsWith('new-window')));
    expect(tmux.calls.some((call) => call.args.includes(env.session) && call.args.includes('-g'))).toBe(false);
  });

  it('removes the variable from the session also when the config names a proxy, and never sets it there', async () => {
    const { deps, tmux } = make({ config: withProxy('stop'), fetch: answers });
    await succeeded(deps);
    expect(tmux.commands()).toContain(REMOVE_PROXY_VARIABLE);
    const environmentCalls = tmux.calls.filter((call) => call.args[0] === 'set-environment');
    expect(environmentCalls).toHaveLength(2);
    expect(JSON.stringify(environmentCalls)).not.toContain('127.0.0.1');
  });

  it('runs every tmux call with the environment of the process, so the panes get the locale of the person', async () => {
    const { deps, tmux } = make();
    await succeeded(deps);
    const startCalls = tmux.calls.filter((call) => call.args[0] !== '-V');
    expect(startCalls.length).toBeGreaterThan(5);
    expect(startCalls.every((call) => call.inheritEnv === true)).toBe(true);
  });

  it('prints how to attach, and says in JSON that it started and did not attach', async () => {
    const { deps } = make();
    const output = await succeeded(deps);
    expect(output.lines.at(-1)?.text).toBe('Session demo runs. Attach with: tmux attach -t demo');
    expect(output.json).toEqual({
      schema: 'factory.start/v1',
      session: 'demo',
      started: true,
      attached: false,
      proxy: null,
      coordinatorResumed: false,
      workers: { resumed: [], skipped: [], failed: [] },
    });
    expect(output.failed).toBe(false);
  });

  it('prints a short output', async () => {
    const { deps } = make();
    expectShortOutput(plainText(await succeeded(deps)));
  });

  it('adds one --add-dir for each project, with the absolute path', async () => {
    const config = sampleConfig();
    const second = { ...config.recipe.projects[0]!, id: 'api', url: 'https://github.com/acme/api', path: 'api' };
    const { deps, tmux } = make({ config: { ...config, recipe: { ...config.recipe, projects: [...config.recipe.projects, second] } } });
    await succeeded(deps);
    const call = tmux.calls.find((candidate) => candidate.args[0] === 'new-session')?.args ?? [];
    const launch = call.slice(call.indexOf('--') + 1, call.indexOf(';'));
    expect(launch.slice(launch.indexOf('--add-dir'))).toEqual([...LAUNCH_DIRS, '--add-dir', '/w/node/api']);
  });

  describe('a project folder that is missing (TP-120)', () => {
    const twoProjects = (): FactoryConfig => {
      const config = sampleConfig();
      const second = { ...config.recipe.projects[0]!, id: 'api', url: 'https://github.com/acme/api', path: 'api' };
      return { ...config, recipe: { ...config.recipe, projects: [...config.recipe.projects, second] } };
    };

    it('warns with the path of the folder and adds no --add-dir for it', async () => {
      const { deps, tmux } = make({ config: twoProjects(), projectFolders: ['web'] });
      const output = await succeeded(deps);
      const call = tmux.calls.find((candidate) => candidate.args[0] === 'new-session')?.args ?? [];
      const added = call.flatMap((arg, index) => (arg === '--add-dir' ? [call[index + 1]] : []));
      expect(added).toEqual([STATE_DIR, '/w/node/web']);
      expect(output.warnings).toEqual([expect.stringContaining('/w/node/api')]);
      expect(output.warnings.join(' ')).toContain('missing');
    });

    it('still starts the session', async () => {
      const { deps, tmux } = make({ config: twoProjects(), projectFolders: [] });
      await succeeded(deps);
      expect(tmux.commands().some((line) => line.startsWith('new-session'))).toBe(true);
    });

    it('treats a project path that is a file as a missing folder', async () => {
      const { deps } = make({ projectFolders: [] });
      deps.seed('/w/node/web', 'not a folder');
      const output = await succeeded(deps);
      expect(output.warnings).toEqual([expect.stringContaining('/w/node/web')]);
    });

    it('warns in the dry run, too', async () => {
      const { deps } = make({ projectFolders: [] });
      const output = await succeeded(deps, { dryRun: true });
      expect(output.warnings).toEqual([expect.stringContaining('/w/node/web')]);
    });

    it('gives no warning when every folder is there', async () => {
      const { deps } = make();
      expect((await succeeded(deps)).warnings).toEqual([]);
    });
  });

  it('passes the model and the effort of the config', async () => {
    const config = sampleConfig();
    const { deps, tmux } = make({
      config: { ...config, core: { ...config.core, session: { ...config.core.session, model: 'opus', effort: 'max' } } },
    });
    await succeeded(deps);
    const launch = tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];
    expect(launch.slice(launch.indexOf('--effort'), launch.indexOf('--effort') + 4)).toEqual(['--effort', 'max', '--model', 'opus']);
  });

  it('accepts a tmux that has a letter or a prefix in its version', async () => {
    for (const version of ['tmux 3.5a', 'tmux next-3.7', 'tmux 3.0', 'tmux 10.1']) {
      const { deps, tmux } = make({ tmux: { version } });
      await succeeded(deps);
      expect(tmux.commands().some((line) => line.startsWith('new-session'))).toBe(true);
    }
  });
});

describe('start:attach', () => {
  it('attaches with the terminal when a person types and reads, outside tmux', async () => {
    const { deps, tmux } = make({ tty: true });
    const output = await succeeded(deps);
    expect(deps.attached).toEqual([{ command: 'tmux', args: ['attach', '-t', '=demo'], cwd: undefined }]);
    expect(tmux.commands().some((line) => line.startsWith('switch-client'))).toBe(false);
    expect(output.json).toMatchObject({ started: true, attached: true });
    expect(output.lines.at(-1)?.text).toBe('Left the session demo. It still runs.');
  });

  it('switches the tmux client when it runs inside tmux', async () => {
    const { deps, tmux } = make({ tty: true, env: { TMUX: '/private/tmp/tmux-1/default,1,0' } });
    const output = await succeeded(deps);
    expect(deps.attached).toEqual([]);
    expect(tmux.commands().at(-1)).toBe('switch-client -t =demo');
    expect(output.json).toMatchObject({ attached: true });
    expect(output.lines.at(-1)?.text).toBe('Switched to the session demo.');
  });

  it('only prints when the output is not a terminal, also when the input is one', async () => {
    const { deps } = make({ tty: true, stdoutTty: false });
    expect(deps.stdinIsTTY).toBe(true);
    const output = await succeeded(deps);
    expect(deps.attached).toEqual([]);
    expect(output.json).toMatchObject({ attached: false });
  });

  it('fails when the attach ends with a non-zero exit code', async () => {
    const { deps } = make({ tty: true });
    const broken = { ...deps, runAttached: async () => ok(1) };
    const result = await runStart(broken, { home: HOME, dryRun: false, yes: false });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('attach ended with exit code 1');
  });
});

describe('start:a session that runs already', () => {
  it('starts nothing for a session of this home, and attaches', async () => {
    const { deps, tmux } = make({ tty: true, tmux: { sessions: { demo: HOME } } });
    const output = await succeeded(deps);
    expect(tmux.commands()).toEqual([
      '-V',
      'has-session -t =demo',
      'show-options -q -v -t =demo: @factory_home',
      'display-message -p -t =demo:view.{left} #{pane_dead}',
    ]);
    expect(deps.attached).toHaveLength(1);
    expect(output.json).toEqual({ schema: 'factory.start/v1', session: 'demo', started: false, attached: true, proxy: null });
    expect(output.lines.map((line) => line.text).join('\n')).not.toContain('Started');
    expect(output.lines.some((line) => line.level === 'warn')).toBe(false);
  });

  it('says that the coordinator has ended, and gives the remedy, when the pane stays after its program ended', async () => {
    const { deps } = make({ tty: true, tmux: { sessions: { demo: HOME }, endedCoordinators: ['demo'] } });
    const output = await succeeded(deps);
    const warning = output.lines.find((line) => line.level === 'warn');
    expect(warning?.text).toBe('The coordinator of the session demo has ended.');
    const remedy = output.lines.map((line) => line.text).join('\n');
    expect(remedy).toContain('"tmux kill-session -t =demo"');
    expect(remedy).toContain('"factory start --home /w/node"');
    expect(output.json).toEqual({
      schema: 'factory.start/v1',
      session: 'demo',
      started: false,
      attached: true,
      proxy: null,
      coordinatorEnded: true,
    });
    expect(output.failed).toBe(false);
    expect(deps.attached).toHaveLength(1);
  });

  it('says that the coordinator has ended also when nobody types, and still prints how to attach', async () => {
    const { deps } = make({ tmux: { sessions: { demo: HOME }, endedCoordinators: ['demo'] } });
    const output = await succeeded(deps);
    expect(output.lines.at(-1)?.text).toBe('Session demo runs. Attach with: tmux attach -t demo');
    expect(output.lines.some((line) => line.level === 'warn')).toBe(true);
    expectShortOutput(plainText(output));
  });

  it('says that the session runs when the state of the coordinator pane cannot be read', async () => {
    const { deps } = make({ tmux: { sessions: { demo: HOME }, endedCoordinators: ['demo'], failing: 'display-message' } });
    const output = await succeeded(deps);
    expect(output.lines.some((line) => line.level === 'warn')).toBe(false);
    expect(output.json).not.toHaveProperty('coordinatorEnded');
  });

  it('does not ask for the coordinator pane in a dry run', async () => {
    const { deps, tmux } = make({ tmux: { sessions: { demo: HOME }, endedCoordinators: ['demo'] } });
    await succeeded(deps, { dryRun: true });
    expect(tmux.commands()).toEqual(['has-session -t =demo']);
  });

  it('prints how to attach when nobody types', async () => {
    const { deps } = make({ tmux: { sessions: { demo: HOME } } });
    const output = await succeeded(deps);
    expect(output.lines).toEqual([{ level: 'text', text: 'Session demo runs. Attach with: tmux attach -t demo' }]);
    expectShortOutput(plainText(output));
  });

  it('knows the home through a link', async () => {
    const { deps, tmux } = make({ tmux: { sessions: { demo: '/w/link' } }, links: { '/w/link': HOME } });
    deps.seedDir('/w/link');
    await succeeded(deps);
    expect(tmux.commands().some((line) => line.startsWith('new-session'))).toBe(false);
  });

  it.each([
    ['another home', { demo: '/w/other-factory' }],
    ['no home option', { demo: null }],
  ])('refuses with exit kind safety for a session with %s, and the remedy names factory shutdown (TP-132)', async (_name, sessions) => {
    const { deps, tmux } = make({ tmux: { sessions } });
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) {
      expect(result.error.message).toBe('a tmux session demo belongs to another factory folder');
      expect(result.error.hint).toContain('Run "factory shutdown" in the factory folder that owns the session, or end that session by hand.');
      expect(result.error.hint).toContain('Then run "factory start" again.');
    }
    expect(tmux.commands().some((line) => line.startsWith('new-session'))).toBe(false);
  });

  it('does not check the proxy when it starts nothing', async () => {
    const { deps } = make({ config: withProxy('stop'), fetch: silent, tmux: { sessions: { demo: HOME } } });
    await succeeded(deps);
    expect(deps.fetched).toEqual([]);
  });
});

describe('start:the proxy', () => {
  it('sets the proxy variable for a proxy that answers, and prints only its label', async () => {
    const { deps, tmux } = make({ config: withProxy('stop'), fetch: answers });
    const output = await succeeded(deps);
    expect(deps.fetched).toEqual(['http://127.0.0.1:8080/secret-path/health']);
    const launch = tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];
    expect(launch).toContain(`ANTHROPIC_BASE_URL=${PROXY_URL}`);
    expect(output.json).toMatchObject({ proxy: 'local (127.0.0.1:8080)' });
    expect(JSON.stringify(output)).not.toContain('secret-path');
  });

  it('stops with the fix when the proxy is down and on_fail is stop', async () => {
    const { deps, tmux } = make({ config: withProxy('stop'), fetch: silent });
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe('local (127.0.0.1:8080) does not answer');
      expect(result.error.hint).toContain('session.proxy to none');
    }
    expect(tmux.commands().some((line) => line.startsWith('new-session'))).toBe(false);
  });

  it('starts without a proxy and warns when the proxy is down and on_fail is direct', async () => {
    const { deps, tmux } = make({ config: withProxy('direct'), fetch: silent });
    const output = await succeeded(deps);
    const launch = tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];
    expect(launch.filter((arg) => arg.startsWith('ANTHROPIC_BASE_URL='))).toEqual([]);
    expect(launch).toContain('-u');
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('starts without a proxy');
    expect(output.json).toMatchObject({ started: true, proxy: null });
  });
});

describe('start:the tools', () => {
  it('names tmux when it is not on PATH, and starts no tmux call', async () => {
    const { deps, tmux } = make({ tools: ['claude'] });
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('tmux is not on PATH');
    expect(tmux.calls).toEqual([]);
  });

  it('names claude when it is not on PATH', async () => {
    const { deps } = make({ tools: ['tmux'] });
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('claude is not on PATH');
  });

  it('names both when both are missing', async () => {
    const { deps } = make({ tools: [] });
    const result = await startFactory(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('tmux is not on PATH');
      expect(result.error.message).toContain('claude is not on PATH');
    }
  });

  it.each([['tmux 2.9a'], ['tmux 1.8'], ['tmux 2.99']])('refuses %s as too old', async (version) => {
    const { deps, tmux } = make({ tmux: { version } });
    const result = await startFactory(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('too old');
    expect(tmux.commands()).toEqual(['-V']);
  });

  it('refuses a tmux whose version it cannot read', async () => {
    const { deps } = make({ tmux: { version: 'tmux master' } });
    const result = await startFactory(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cannot read the version of tmux');
  });
});

describe('start:a step that fails', () => {
  it('removes the session that it made, and says so', async () => {
    const { deps, tmux } = make({ tmux: { failing: 'split-window' } });
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe('tmux split-window failed (exit code 1): split-window failed. The session demo was removed.');
    }
    expect(tmux.commands().at(-1)).toBe('kill-session -t =demo');
    expect(tmux.sessions().has('demo')).toBe(false);
  });

  it('removes the session when the removal of the proxy variable fails, before any other window exists', async () => {
    const { deps, tmux } = make({ tmux: { failing: 'set-environment' } });
    const result = await startFactory(deps);
    expect(result.ok).toBe(false);
    expect(tmux.commands().at(-1)).toBe('kill-session -t =demo');
    expect(tmux.commands().some((line) => line.startsWith('split-window') || line.startsWith('new-window'))).toBe(false);
    expect(tmux.sessions().has('demo')).toBe(false);
  });

  it('does not say that the session stays when the session is gone, and names the likely cause', async () => {
    const { deps, tmux } = make();
    const ended = {
      ...deps,
      run: async (command: string, args: readonly string[], runOptions?: Parameters<typeof deps.run>[2]) => {
        if (args[0] === 'set-environment') tmux.sessions().delete('demo');
        return deps.run(command, args, runOptions);
      },
    };
    const result = await runStart(ended, { home: HOME, dryRun: false, yes: false });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe(
        "tmux set-environment failed (exit code 1): can't find session. The session demo is gone. " +
          'The coordinator probably ended at once, or the tmux server stopped. Run claude in this shell to read its error.',
      );
    }
    expect(tmux.commands().at(-1)).toBe('has-session -t =demo');
    expect(tmux.commands().some((line) => line.startsWith('kill-session'))).toBe(false);
  });

  it('removes nothing when the first step fails, because no session exists', async () => {
    const { deps, tmux } = make({ tmux: { failing: 'new-session' } });
    const result = await startFactory(deps);
    expect(result.ok).toBe(false);
    expect(tmux.commands().some((line) => line.startsWith('kill-session'))).toBe(false);
  });

  it('tells the person how to remove the session when the removal fails too', async () => {
    const { deps } = make({ tmux: { failing: 'split-window' } });
    const broken = {
      ...deps,
      run: async (command: string, args: readonly string[], runOptions?: Parameters<typeof deps.run>[2]) =>
        args[0] === 'kill-session' ? failure('cannot run tmux: EPERM') : deps.run(command, args, runOptions),
    };
    const result = await runStart(broken, { home: HOME, dryRun: false, yes: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('remove it with "tmux kill-session -t =demo"');
  });
});

describe('start:--dry-run', () => {
  it('runs only has-session from tmux, and starts nothing', async () => {
    const { deps, tmux } = make();
    const output = await succeeded(deps, { dryRun: true });
    expect(tmux.commands()).toEqual(['has-session -t =demo']);
    expect(tmux.sessions().size).toBe(0);
    const text = output.lines.map((line) => line.text).join('\n');
    expect(text).toContain('Dry run');
    // The dry run shows each word as a person could type it: the strip text is one word in single quotes.
    const typed = [...LAUNCH_BASE, ...LAUNCH_DIRS].map(shellWord).join(' ');
    expect(text).toContain(`tmux new-session -d -s demo -n view -c ${COORDINATOR} -- ${typed}`);
    expect(text).toContain(`tmux new-window -d -t =demo: -n workers -c ${COORDINATOR}`);
    expect(output.json).toMatchObject({ schema: 'factory.start/v1', session: 'demo', started: false, attached: false, dryRun: true });
  });

  it('shows the removal of the proxy variable from the session, right after the new session', async () => {
    const { deps } = make();
    const output = await succeeded(deps, { dryRun: true });
    const calls = output.json['calls'];
    expect(Array.isArray(calls)).toBe(true);
    expect((calls as readonly string[])[0]).toContain('tmux new-session');
    expect((calls as readonly string[])[1]).toBe(`tmux ${REMOVE_PROXY_VARIABLE}`);
  });

  it('works without tmux and without claude, and says that a real run stops', async () => {
    const { deps, tmux } = make({ tools: [], tmux: { version: null } });
    const output = await succeeded(deps, { dryRun: true });
    expect(output.failed).toBe(false);
    expect(output.lines.filter((line) => line.level === 'warn').map((line) => line.text)).toEqual([
      'tmux is not on PATH. Install tmux 3.0 or newer. A real run stops here.',
      'claude is not on PATH. A real run stops here.',
    ]);
    expect(tmux.commands()).toEqual(['has-session -t =demo']);
  });

  it('shows the attach call as the last call', async () => {
    const { deps } = make({ tty: true });
    const output = await succeeded(deps, { dryRun: true });
    expect(output.lines.at(-1)?.text).toBe('  tmux attach -t =demo');
    expect(deps.attached).toEqual([]);
  });

  it('shows only the label of a proxy, never its URL', async () => {
    const { deps } = make({ config: withProxy('stop'), fetch: answers });
    const output = await succeeded(deps, { dryRun: true });
    const text = JSON.stringify(output);
    expect(text).not.toContain('secret-path');
    expect(text).not.toContain('127.0.0.1:8080/');
    expect(output.lines.map((line) => line.text).join('\n')).toContain("'ANTHROPIC_BASE_URL=<local (127.0.0.1:8080)>'");
  });

  it('stops for a proxy that is down with on_fail stop, as a real run does', async () => {
    const { deps } = make({ config: withProxy('stop'), fetch: silent });
    const result = await startFactory(deps, { dryRun: true });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('says that the session runs, and shows the attach call only', async () => {
    const { deps, tmux } = make({ tty: true, tmux: { sessions: { demo: '/w/other' } } });
    const output = await succeeded(deps, { dryRun: true });
    expect(tmux.commands()).toEqual(['has-session -t =demo']);
    const text = output.lines.map((line) => line.text).join('\n');
    expect(text).toContain('The session demo runs already');
    expect(text).not.toContain('new-session');
    expect(text).toContain('tmux attach -t =demo');
  });
});

describe('start:the hook settings of the coordinator (AC-6, AC-11, TP-15, TP-16, TP-17, TP-18, TP-19)', () => {
  const noFile = { hookSettings: false } as const;
  const WRITE_CALLS = ['writeText', 'writeTextExclusive', 'writeTextAtomic', 'rename', 'remove', 'mkdir', 'chmod', 'copyTree', 'removeEmptyDir'];
  const settingsOf = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(SETTINGS_FILE) ?? 'null');
  const launched = (tmux: TmuxLog): boolean => tmux.commands().some((command) => command.startsWith('new-session'));
  /** The files that the start writes after it made the session are the id of the machine and its mark: the hook writer writes neither. */
  const otherFiles = (deps: FakeDeps): string =>
    JSON.stringify(
      [...deps.files.entries()].filter(([path]) => path !== SETTINGS_FILE && path !== MACHINE_ID_FILE && path !== MARK_FILE).sort(),
    ) + [...deps.dirs].sort().join(',');
  const failed = async (deps: FakeDeps, options: Partial<StartOptions> = {}) => {
    const result = await startFactory(deps, options);
    if (result.ok) throw new Error('start should have stopped');
    return result.error;
  };

  describe('on a terminal window (TP-15)', () => {
    it('prints the exact change and the target before the write, and writes after a yes', async () => {
      const seen: { fileAtQuestion: boolean | null } = { fileAtQuestion: null };
      const held: { deps?: FakeDeps } = {};
      const made = make({
        ...noFile,
        tty: true,
        prompt: () => {
          seen.fileAtQuestion = held.deps?.files.has(SETTINGS_FILE) ?? null;
          return ok('y');
        },
      });
      held.deps = made.deps;
      await succeeded(made.deps);
      expect(seen.fileAtQuestion).toBe(false);
      expect(made.deps.prompts).toHaveLength(1);
      const question = made.deps.prompts[0] ?? '';
      expect(question).toContain(SETTINGS_FILE);
      for (const event of hookNames.events) expect(question).toContain(`"factory hook ${event}"`);
      expect(question).toContain('"factory hook statusline"');
      expect(question).toContain('[y/N]');
      expect(settingsOf(made.deps)).toEqual(ownSettingsEntries);
      expect(launched(made.tmux)).toBe(true);
    });
  });

  describe('with no terminal window and no yes flag (TP-16)', () => {
    it('writes nothing, starts nothing and exits 2 with the change, the target and the remedy', async () => {
      const { deps, tmux } = make(noFile);
      const before = JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');
      const error = await failed(deps);
      expect(error.kind).toBe('usage');
      expect(error.message).toContain(SETTINGS_FILE);
      expect(error.message).toContain('"factory hook Stop"');
      expect(error.hint).toContain('factory start');
      expect(error.hint).toContain('--yes');
      expect(JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',')).toBe(before);
      expect(launched(tmux)).toBe(false);
    });
  });

  describe('with the yes flag (TP-17)', () => {
    it('writes only the settings file of the coordinator, keeps its other keys and prints the change first', async () => {
      const { deps, tmux } = make({ hookSettings: '{"model":"opus"}\n' });
      const before = otherFiles(deps);
      await succeeded(deps, { yes: true });
      expect(settingsOf(deps)).toEqual({ model: 'opus', ...ownSettingsEntries });
      expect(otherFiles(deps)).toBe(before);
      expect(deps.prompts).toEqual([]);
      expect(deps.warned.some((line) => line.includes(SETTINGS_FILE) && line.includes('"factory hook Stop"'))).toBe(true);
      expect(launched(tmux)).toBe(true);
    });

    it('creates the .claude folder and the file when both are missing', async () => {
      const { deps } = make(noFile);
      await succeeded(deps, { yes: true });
      expect(deps.dirs.has(`${COORDINATOR}/.claude`)).toBe(true);
      expect(settingsOf(deps)).toEqual(ownSettingsEntries);
    });
  });

  describe('a second start (TP-18, AC-11)', () => {
    it('asks nothing, writes nothing and shows no presence warning for the file that the first start wrote', async () => {
      const { deps } = make(noFile);
      await succeeded(deps, { yes: true });
      const writes: string[] = [];
      const watched = withFsWatch(deps, (method, path) => {
        if (WRITE_CALLS.includes(method) && path.startsWith(`${COORDINATOR}/.claude`)) writes.push(`${method} ${path}`);
      });
      const warnedBefore = deps.warned.length;
      const output = await succeeded(watched);
      expect(output.failed).toBe(false);
      expect(deps.prompts).toEqual([]);
      expect(writes).toEqual([]);
      const warned = [...deps.warned.slice(warnedBefore), ...output.warnings, ...output.lines.filter((line) => line.level === 'warn').map((line) => line.text)];
      expect(warned.filter((line) => line.includes('settings.local.json'))).toEqual([]);
    });

    it('asks nothing and writes nothing when the entries are in place with another layout', async () => {
      const { deps } = make({ hookSettings: JSON.stringify(ownSettingsEntries) });
      const before = deps.files.get(SETTINGS_FILE);
      await succeeded(deps);
      expect(deps.prompts).toEqual([]);
      expect(deps.files.get(SETTINGS_FILE)).toBe(before);
    });
  });

  describe('inside a factory session (TP-19)', () => {
    it('exits 2 with the yes flag, writes nothing and starts nothing', async () => {
      const { deps, tmux } = make({ ...noFile, env: { [env.session]: 'demo' } });
      const before = JSON.stringify([...deps.files.entries()].sort());
      const error = await failed(deps, { yes: true });
      expect(error.kind).toBe('usage');
      expect(error.message).toContain(SETTINGS_FILE);
      expect(JSON.stringify([...deps.files.entries()].sort())).toBe(before);
      expect(deps.files.has(SETTINGS_FILE)).toBe(false);
      expect(launched(tmux)).toBe(false);
    });
  });

  describe('an answer of no on a terminal window', () => {
    it('goes on without the hook, writes nothing and prints one notice that names the effect and the way to add it', async () => {
      const { deps, tmux } = make({ ...noFile, tty: true, prompt: () => ok('n') });
      await succeeded(deps);
      expect(deps.files.has(SETTINGS_FILE)).toBe(false);
      expect(launched(tmux)).toBe(true);
      const notices = deps.warned.filter((line) => line.includes('resume the session by its id'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('last-seen');
      expect(notices[0]).toContain('"factory start"');
      expect(notices[0]).toContain('answer yes');
      expect(notices[0]).not.toContain('\n');
    });
  });

  describe('an error of the writer', () => {
    it('stops start with the exit code of the writer and starts nothing, for a file that is not a JSON object', async () => {
      const { deps, tmux } = make({ hookSettings: '[]\n' });
      const error = await failed(deps, { yes: true });
      expect(error.kind).toBe('failure');
      expect(error.message).toContain('is not a JSON object');
      expect(deps.files.get(SETTINGS_FILE)).toBe('[]\n');
      expect(launched(tmux)).toBe(false);
    });

    it('stops with exit 4 for a .claude folder that is a link, and starts nothing', async () => {
      const { deps, tmux } = make({ ...noFile, links: { [`${COORDINATOR}/.claude`]: '/outside' } });
      deps.seedDir('/outside');
      const error = await failed(deps, { yes: true });
      expect(error.kind).toBe('safety');
      expect(launched(tmux)).toBe(false);
      expect(deps.files.has('/outside/settings.local.json')).toBe(false);
    });
  });

  describe('--dry-run', () => {
    it('shows the change and the target, and asks and writes nothing, also with no terminal window', async () => {
      const { deps, tmux } = make(noFile);
      const before = JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');
      const output = await succeeded(deps, { dryRun: true });
      const text = output.lines.map((line) => line.text).join('\n');
      expect(text).toContain(SETTINGS_FILE);
      expect(text).toContain('"factory hook Stop"');
      expect(text).toContain('A real run asks before it writes this change.');
      expect(output.failed).toBe(false);
      expect(deps.prompts).toEqual([]);
      expect(JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',')).toBe(before);
      expect(launched(tmux)).toBe(false);
    });

    it('says that a real run writes the change with the yes flag', async () => {
      const { deps } = make(noFile);
      const output = await succeeded(deps, { dryRun: true, yes: true });
      expect(output.lines.map((line) => line.text).join('\n')).toContain('A real run writes this change.');
    });

    it('shows no change when the entries are in place', async () => {
      const { deps } = make();
      const output = await succeeded(deps, { dryRun: true });
      expect(output.lines.map((line) => line.text).join('\n')).not.toContain('This changes the settings');
    });
  });
});

describe('start:the recovery after a kill of the server and the mark of the active machine (AC-16, AC-17, AC-25, TP-17, TP-34, TP-35, TP-36, TP-37, TP-38, TP-39, TP-62, TP-134)', () => {
  const COPIES = `${HOME}/work-copies/web`;
  const IDS = ['alpha', 'beta', 'gamma'] as const;
  const SESSION = {
    alpha: '0b9f3c1e-5d2a-4e7b-9c10-a1b2c3d4e5f6',
    beta: 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd',
    gamma: 'c5b3e4f6-3d4e-4f70-8b12-34567890bcde',
  } as const;
  const COORDINATOR_SESSION = '0b6c1f9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';
  const OWN_MACHINE = '00000000-0000-4000-8000-000000000001';
  const OTHER_MACHINE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const OTHER_AT = '2029-12-31T10:00:00.000Z';
  const byResume: Readonly<Record<string, string>> = Object.fromEntries(IDS.map((id) => [SESSION[id], id]));

  /** Every resume starts its session, except the resume of this session: its pane ends at once. */
  const endsPaneFor =
    (session: string): Program =>
    async (wait) => {
      if (wait.resumeId === session) return endsPane(wait);
      return startsSessions(HOME, byResume)(wait);
    };

  /** Every resume starts its session, except the resume of this session: its pane runs, and the session writes no line. */
  const silentFor =
    (session: string): Program =>
    async (wait) => {
      if (wait.resumeId === session) return;
      return startsSessions(HOME, byResume)(wait);
    };

  interface Seed extends Setup {
    /** The workers that have a record. Default: alpha, beta and gamma. */
    readonly workers?: readonly string[];
    /** The text of the pointer of a worker. Null: no pointer. Default: the session of the worker. */
    readonly pointers?: Readonly<Record<string, string | null>>;
    /** The session marker of the line of a worker. Null: the line has none. Default: the id of the worker. */
    readonly markers?: Readonly<Record<string, string | null>>;
    /** The text of the settings file of the work copy of a worker. */
    readonly settings?: Readonly<Record<string, string>>;
    /** The pointer of the coordinator. Default: none. */
    readonly coordinator?: 'none' | 'owned' | 'junk' | 'line-of-a-worker';
    /** The text of the file of the mark. Default: no file. */
    readonly mark?: string;
    /** What the program of a new pane does. Default: each resume starts the session of its worker. */
    readonly program?: Program;
  }

  interface Made {
    readonly deps: FakeDeps;
    readonly tmux: TmuxLog;
    /** For each warning, in order: how many times `split-window` had run when it was printed. */
    readonly splitsAtWarnings: readonly number[];
  }

  const must = (result: { readonly ok: boolean; readonly error?: { readonly message: string } }): void => {
    if (!result.ok) throw new Error(result.error?.message ?? 'the seed failed');
  };

  const splitsOf = (deps: FakeDeps): number =>
    deps.calls.filter((call) => call.command === 'tmux' && call.args[0] === 'split-window').length;

  const killsOf = (tmux: TmuxLog): string[] => tmux.commands().filter((command) => command.startsWith('kill-session'));

  /** The panes that carry a worker mark, in the order of their making. */
  const workerPanes = (tmux: TmuxLog) => tmux.panes().filter((pane) => pane.options[tmuxNames.optionWorker] !== undefined);

  /** The session id that the program of each worker pane resumes, by worker. */
  const resumesOf = (tmux: TmuxLog): Record<string, string | undefined> =>
    Object.fromEntries(
      workerPanes(tmux).map((pane) => {
        const at = pane.command.indexOf('--resume');
        return [pane.options[tmuxNames.optionWorker] ?? '', at < 0 ? undefined : pane.command[at + 1]];
      }),
    );

  /** The writes in the state repo: the add, the reset, the remove and the commit calls, each one as the words after `-C <folder>`. */
  const stateWrites = (deps: FakeDeps): string[] =>
    deps.calls
      .filter((call) => call.command === 'git' && call.args[1] === STATE_DIR)
      .map((call) => call.args.slice(2).join(' '))
      .filter((call) => /^(add|rm|reset)\b/.test(call) || call.includes(' commit '));

  const markText = (machine: string): string =>
    `${JSON.stringify({
      [activeMachine.keys.schema]: schemaIds.activeMachine,
      [activeMachine.keys.machine]: machine,
      [activeMachine.keys.at]: OTHER_AT,
    })}\n`;

  const markedMachine = (deps: FakeDeps): unknown =>
    (JSON.parse(deps.files.get(MARK_FILE) ?? 'null') as Record<string, unknown> | null)?.[activeMachine.keys.machine];

  /** A home whose state folder holds the records, the pointers and the lines of the seed. No pane of a worker exists. */
  const seeded = async (seed: Seed = {}): Promise<Made> => {
    const { deps, tmux } = make(seed);
    const lines = new Set<string>();
    for (const id of seed.workers ?? IDS) {
      must(await writeWorkerRecord(deps, HOME, { id, project: 'web', workCopy: `${COPIES}/${id}`, branch: `worker/${id}` }));
      deps.seedDir(`${COPIES}/${id}`);
      const own = IDS.find((known) => known === id);
      const pointer = seed.pointers !== undefined && id in seed.pointers ? seed.pointers[id] : own === undefined ? null : SESSION[own];
      if (pointer === null || pointer === undefined) continue;
      deps.seed(workerPathsOf(HOME, id).lastSessionFile, `${pointer}\n`);
      const marker = seed.markers !== undefined && id in seed.markers ? seed.markers[id] : id;
      if (pointer in byResume && !lines.has(pointer)) {
        lines.add(pointer);
        must(await writeLastSeen(deps, HOME, pointer, { kind: 'event', event: 'Stop' }, marker === null ? undefined : marker));
      }
    }
    for (const [id, text] of Object.entries(seed.settings ?? {})) deps.seed(`${COPIES}/${id}/.claude/settings.local.json`, text);
    if (seed.coordinator === 'junk') deps.seed(layoutOf(HOME).coordinatorLastSessionFile, 'junk\n');
    if (seed.coordinator === 'owned' || seed.coordinator === 'line-of-a-worker') {
      must(await writeCoordinatorSession(deps, HOME, COORDINATOR_SESSION));
      const marker = seed.coordinator === 'owned' ? 'demo' : 'alpha';
      must(await writeLastSeen(deps, HOME, COORDINATOR_SESSION, { kind: 'event', event: 'Stop' }, marker));
    }
    if (seed.mark !== undefined) deps.seed(MARK_FILE, seed.mark);
    deps.warned.splice(0);
    const splitsAtWarnings: number[] = [];
    const noted: FakeDeps = {
      ...deps,
      warn: (message) => {
        splitsAtWarnings.push(splitsOf(deps));
        deps.warn(message);
      },
    };
    return { deps: withProgram(noted, tmux, seed.program ?? startsSessions(HOME, byResume)), tmux, splitsAtWarnings };
  };

  describe('the workers (AC-16, TP-34)', () => {
    it('resumes each recorded worker with the session id of its own pointer, and prints the ids that run again', async () => {
      const made = await seeded();
      const output = await succeeded(made.deps);
      expect(resumesOf(made.tmux)).toEqual(SESSION);
      expect(output.json).toMatchObject({ started: true, workers: { resumed: ['alpha', 'beta', 'gamma'], skipped: [], failed: [] } });
      expect(output.lines.map((line) => line.text)).toContain('Resumed the workers: alpha, beta, gamma.');
      expect(made.deps.warned).toEqual([]);
      expect(killsOf(made.tmux)).toEqual([]);
    });

    it('resumes the workers one at a time, after the session is made and before the person is attached', async () => {
      const attachedAtWaits: number[] = [];
      const program: Program = async (wait) => {
        attachedAtWaits.push(wait.deps.attached.length);
        await startsSessions(HOME, byResume)(wait);
      };
      const made = await seeded({ tty: true, program });
      await succeeded(made.deps);
      expect(made.tmux.commands().findIndex((command) => command.startsWith('new-window'))).toBeLessThan(
        made.tmux.commands().findIndex((command) => command.startsWith('split-window') && !command.includes('=demo:view')),
      );
      expect(attachedAtWaits.length).toBeGreaterThanOrEqual(IDS.length);
      expect(attachedAtWaits.every((count) => count === 0)).toBe(true);
      expect(made.deps.attached).toHaveLength(1);
    });

    it('resumes no worker when there is none, and prints no line about workers', async () => {
      const made = await seeded({ workers: [] });
      const output = await succeeded(made.deps);
      expect(output.json).toMatchObject({ workers: { resumed: [], skipped: [], failed: [] } });
      expect(output.lines.map((line) => line.text).join('\n')).not.toContain('Resumed the workers');
      expect(made.deps.warned).toEqual([]);
    });

    it('resumes nothing and writes no mark when the session does not start', async () => {
      const made = await seeded({ tmux: { failing: 'new-session' } });
      const result = await startFactory(made.deps);
      expect(result.ok).toBe(false);
      expect(workerPanes(made.tmux)).toEqual([]);
      expect(made.deps.files.has(MARK_FILE)).toBe(false);
      expect(made.deps.files.has(MACHINE_ID_FILE)).toBe(false);
    });

    it('resumes no worker for a session that runs already', async () => {
      const made = await seeded({ tmux: { sessions: { demo: HOME } } });
      const output = await succeeded(made.deps);
      expect(output.json).not.toHaveProperty('workers');
      expect(workerPanes(made.tmux)).toEqual([]);
      expect(splitsOf(made.deps)).toBe(0);
    });

    it('resumes nothing, writes nothing and shows the resume of the coordinator in a dry run', async () => {
      const made = await seeded({ coordinator: 'owned' });
      const output = await succeeded(made.deps, { dryRun: true });
      expect(output.lines.map((line) => line.text).join('\n')).toContain(`--resume ${COORDINATOR_SESSION}`);
      expect(made.tmux.commands()).toEqual(['has-session -t =demo']);
      expect(made.deps.files.has(MARK_FILE)).toBe(false);
      expect(made.deps.files.has(MACHINE_ID_FILE)).toBe(false);
      expect(stateWrites(made.deps)).toEqual([]);
    });
  });

  describe('a session that runs already (AC-16)', () => {
    const RUNNING = { demo: HOME };
    const paneOf = (worker: string, dead = false): PaneFixture => ({
      session: 'demo',
      options: { [tmuxNames.optionWorker]: worker },
      ...(dead ? { dead: true } : {}),
    });

    it('warns once with each worker that has no live pane and the command that starts it, resumes none, and exits 0', async () => {
      const made = await seeded({ tmux: { sessions: RUNNING, panes: [paneOf('beta')] } });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      const [warning = ''] = made.deps.warned;
      expect(warning).toContain('"factory worker resume alpha"');
      expect(warning).toContain('"factory worker resume gamma"');
      expect(warning).toContain('"factory reboot"');
      expect(warning).not.toContain('beta');
      expect(splitsOf(made.deps)).toBe(0);
      expect(workerPanes(made.tmux)).toHaveLength(1);
      if (result.ok) expect(result.value.json).toMatchObject({ started: false, workersWithoutPane: ['alpha', 'gamma'] });
    });

    it('counts a pane whose program ended as no live pane', async () => {
      const made = await seeded({ tmux: { sessions: RUNNING, panes: [paneOf('alpha', true), paneOf('beta'), paneOf('gamma')] } });
      const output = await succeeded(made.deps);
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('"factory worker resume alpha"');
      expect(output.json).toMatchObject({ workersWithoutPane: ['alpha'] });
    });

    it('prints no warning and no list when each recorded worker has a live pane', async () => {
      const made = await seeded({ tmux: { sessions: RUNNING, panes: IDS.map((id) => paneOf(id)) } });
      const output = await succeeded(made.deps);
      expect(made.deps.warned).toEqual([]);
      expect(output.json).not.toHaveProperty('workersWithoutPane');
    });

    it('claims the mark when there is none, with no warning', async () => {
      const made = await seeded({ workers: [], tmux: { sessions: RUNNING } });
      await succeeded(made.deps);
      const id = (made.deps.files.get(MACHINE_ID_FILE) ?? '').trim();
      expect(id).toMatch(activeMachine.idPattern);
      expect(markedMachine(made.deps)).toBe(id);
      expect(stateWrites(made.deps)).toHaveLength(2);
      expect(made.deps.warned).toEqual([]);
    });

    it('claims the mark that names another machine, and warns about the machine before it warns about the workers', async () => {
      const made = await seeded({ workers: ['alpha'], mark: markText(OTHER_MACHINE), tmux: { sessions: RUNNING } });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(2);
      expect(made.deps.warned[0]).toContain(OTHER_MACHINE);
      expect(made.deps.warned[1]).toContain('"factory worker resume alpha"');
      expect(markedMachine(made.deps)).toBe((made.deps.files.get(MACHINE_ID_FILE) ?? '').trim());
      expect(workerPanes(made.tmux)).toEqual([]);
    });

    it('writes nothing in the state repo when the mark names this machine', async () => {
      const made = await seeded({ workers: [], mark: markText(OWN_MACHINE), tmux: { sessions: RUNNING } });
      made.deps.seed(MACHINE_ID_FILE, `${OWN_MACHINE}\n`);
      await succeeded(made.deps);
      expect(stateWrites(made.deps)).toEqual([]);
      expect(markedMachine(made.deps)).toBe(OWN_MACHINE);
      expect(made.deps.warned).toEqual([]);
    });

    it('warns about the mark and about the workers, and exits 0, when the mark can not be committed', async () => {
      const made = await seeded({ workers: ['alpha'], stateRepo: { commitExit: 1 }, tmux: { sessions: RUNNING } });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(2);
      expect(made.deps.warned[0]).toContain('cannot commit the state files');
      expect(made.deps.warned[1]).toContain('"factory worker resume alpha"');
    });

    it('warns once, and exits 0, when the workers can not be listed', async () => {
      const made = await seeded({ workers: [], links: { [layoutOf(HOME).workersDir]: '/elsewhere/workers' }, tmux: { sessions: RUNNING } });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('it is a link');
      if (result.ok) expect(result.value.json).not.toHaveProperty('workersWithoutPane');
    });

    it('warns once, and exits 0, when the panes can not be listed', async () => {
      const made = await seeded({ tmux: { sessions: RUNNING, failing: 'list-panes' } });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('The workers are not checked');
      if (result.ok) expect(result.value.json).not.toHaveProperty('workersWithoutPane');
    });

    it('reads nothing of the workers and writes nothing in a dry run', async () => {
      const made = await seeded({ tmux: { sessions: RUNNING } });
      await succeeded(made.deps, { dryRun: true });
      expect(made.tmux.commands()).toEqual(['has-session -t =demo']);
      expect(stateWrites(made.deps)).toEqual([]);
      expect(made.deps.warned).toEqual([]);
    });
  });

  describe('the coordinator (AC-16, TP-37)', () => {
    const startArgs =(tmux: TmuxLog): readonly string[] => tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];

    it('resumes the session of its pointer in the launch of the new session, before the folders', async () => {
      const made = await seeded({ coordinator: 'owned', workers: [] });
      const output = await succeeded(made.deps);
      const start = startArgs(made.tmux);
      const at = start.indexOf('--resume');
      expect(start.slice(at, at + 2)).toEqual(['--resume', COORDINATOR_SESSION]);
      expect(at).toBeLessThan(start.indexOf('--add-dir'));
      expect(output.json).toMatchObject({ coordinatorResumed: true });
      expect(output.lines.map((line) => line.text)).toContain('The coordinator resumes its earlier conversation.');
      expect(output.warnings).toEqual([]);
    });

    it('starts a new conversation, with no warning, when it has no pointer', async () => {
      const made = await seeded({ workers: [] });
      const output = await succeeded(made.deps);
      expect(startArgs(made.tmux)).not.toContain('--resume');
      expect(output.json).toMatchObject({ coordinatorResumed: false });
      expect(output.warnings).toEqual([]);
      expect(made.deps.warned).toEqual([]);
    });

    it.each<[string, NonNullable<Seed['coordinator']>]>([
      ['a pointer that holds no session id', 'junk'],
      ['a line that belongs to a worker', 'line-of-a-worker'],
    ])('starts a new conversation, with one warning that names the pointer file, for %s', async (_name, coordinator) => {
      const made = await seeded({ coordinator, workers: [] });
      const output = await succeeded(made.deps);
      expect(startArgs(made.tmux)).not.toContain('--resume');
      expect(output.json).toMatchObject({ started: true, coordinatorResumed: false });
      expect(output.warnings).toHaveLength(1);
      expect(output.warnings[0]).toContain(layoutOf(HOME).coordinatorLastSessionFile);
      expect(output.warnings[0]).toContain('NOT resumed');
      expect(made.tmux.sessions().has('demo')).toBe(true);
    });
  });

  describe('a worker with no usable id (AC-16, TP-35, TP-134)', () => {
    it.each<[string, Seed]>([
      ['no pointer', { pointers: { beta: null } }],
      ['a pointer that holds no session id', { pointers: { beta: 'junk' } }],
      ['a line of the coordinator', { markers: { beta: 'demo' } }],
      ['a line with no session marker', { markers: { beta: null } }],
    ])('skips the worker with one warning, resumes the others and exits 0, for %s', async (_name, seed) => {
      const made = await seeded(seed);
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      const [warning = ''] = made.deps.warned;
      expect(warning).toContain('beta');
      expect(warning).toContain(workerPathsOf(HOME, 'beta').lastSessionFile);
      expect(warning).toContain('factory worker resume beta');
      expect(resumesOf(made.tmux)).toEqual({ alpha: SESSION.alpha, gamma: SESSION.gamma });
      expect(made.tmux.sessions().has('demo')).toBe(true);
      expect(killsOf(made.tmux)).toEqual([]);
      if (result.ok) expect(result.value.json).toMatchObject({ workers: { resumed: ['alpha', 'gamma'], skipped: ['beta'], failed: [] } });
    });
  });

  describe('a worker that does not start again (AC-17, TP-36, TP-17)', () => {
    it('warns with the worker, does not try again, goes on and keeps the session, when its pane ends at once', async () => {
      const made = await seeded({ program: endsPaneFor(SESSION.beta) });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('beta');
      expect(splitsOf(made.deps)).toBe(1 + IDS.length);
      expect(resumesOf(made.tmux)).toEqual({ alpha: SESSION.alpha, gamma: SESSION.gamma });
      expect(made.tmux.sessions().has('demo')).toBe(true);
      expect(killsOf(made.tmux)).toEqual([]);
      if (result.ok) expect(result.value.json).toMatchObject({ workers: { resumed: ['alpha', 'gamma'], skipped: [], failed: ['beta'] } });
    });

    it('warns with the worker, and keeps its pane, when the session writes no line', async () => {
      const made = await seeded({ program: silentFor(SESSION.beta) });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('beta');
      expect(splitsOf(made.deps)).toBe(1 + IDS.length);
      expect(resumesOf(made.tmux)).toEqual(SESSION);
      expect(killsOf(made.tmux)).toEqual([]);
      if (result.ok) expect(result.value.json).toMatchObject({ workers: { resumed: ['alpha', 'gamma'], failed: ['beta'] } });
    });

    it('starts no pane for a work copy with a wrong settings file, warns with the file, and exits 0', async () => {
      const bad = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://other.example' } });
      const made = await seeded({ settings: { beta: bad } });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('work-copies/web/beta/.claude/settings.local.json');
      expect(resumesOf(made.tmux)).toEqual({ alpha: SESSION.alpha, gamma: SESSION.gamma });
    });
  });

  describe('the proxy (AC-25, TP-62)', () => {
    it('asks a proxy once for the run, for the coordinator and for three workers that use it', async () => {
      const base = withProxy('stop');
      const config: FactoryConfig = {
        ...base,
        core: { ...base.core, workers: Object.fromEntries(IDS.map((id) => [id, { proxy: 'local' }])) },
      };
      const made = await seeded({ config, fetch: answers });
      await succeeded(made.deps);
      expect(made.deps.fetched).toHaveLength(1);
      expect(resumesOf(made.tmux)).toEqual(SESSION);
    });
  });

  describe('the mark of the active machine (AC-16, TP-38, TP-39)', () => {
    it('writes the machine id once and commits the mark that names it, with no other file', async () => {
      const made = await seeded();
      await succeeded(made.deps);
      const id = (made.deps.files.get(MACHINE_ID_FILE) ?? '').trim();
      expect(id).toMatch(activeMachine.idPattern);
      expect(markedMachine(made.deps)).toBe(id);
      expect(JSON.parse(made.deps.files.get(MARK_FILE) ?? 'null')).toMatchObject({ [activeMachine.keys.schema]: schemaIds.activeMachine });
      const writes = stateWrites(made.deps);
      expect(writes).toHaveLength(2);
      expect(writes[0]).toBe(`add -A -- ${files.activeMachine}`);
      expect(writes[1]).toContain(` commit -q -m ${activeMachine.commitMessages.set}`);
      expect(made.deps.warned).toEqual([]);
    });

    it('does not warn when the mark names this machine', async () => {
      const made = await seeded({ mark: markText(OWN_MACHINE) });
      made.deps.seed(MACHINE_ID_FILE, `${OWN_MACHINE}\n`);
      await succeeded(made.deps);
      expect(made.deps.warned).toEqual([]);
      expect(markedMachine(made.deps)).toBe(OWN_MACHINE);
    });

    it('warns once, before the first worker resumes, when the mark names another machine, and exits 0', async () => {
      const made = await seeded({ mark: markText(OTHER_MACHINE) });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain(OTHER_MACHINE);
      expect(made.deps.warned[0]).toContain(OTHER_AT);
      expect(made.deps.warned[0]).toContain('factory shutdown');
      // Only the split of the view window had run: no worker had a pane yet.
      expect(made.splitsAtWarnings).toEqual([1]);
      expect(splitsOf(made.deps)).toBe(1 + IDS.length);
      expect(resumesOf(made.tmux)).toEqual(SESSION);
      expect(markedMachine(made.deps)).not.toBe(OTHER_MACHINE);
      expect(markedMachine(made.deps)).toBe((made.deps.files.get(MACHINE_ID_FILE) ?? '').trim());
    });

    it('warns, and still resumes the workers and exits 0, when the mark can not be committed', async () => {
      const made = await seeded({ stateRepo: { commitExit: 1 } });
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: true, value: { failed: false } });
      expect(made.deps.warned).toHaveLength(1);
      expect(made.deps.warned[0]).toContain('cannot commit the state files');
      expect(resumesOf(made.tmux)).toEqual(SESSION);
    });
  });
});

describe('start:the home and the config', () => {
  it('fails when the config is missing or invalid', async () => {
    const { deps } = make();
    deps.files.delete(`${HOME}/factory.yaml`);
    expect(await startFactory(deps)).toMatchObject({ ok: false, error: { kind: 'failure' } });
    deps.files.set(`${HOME}/factory.yaml`, 'schema: 2\n');
    expect(await startFactory(deps)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('fails when the home is not a folder', async () => {
    const { deps } = make();
    deps.seed('/w/file', 'x');
    const result = await startFactory(deps, { home: '/w/file' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toBe('/w/file is not a folder');
  });

  it('finds the home from FACTORY_HOME', async () => {
    const { deps } = make({ env: { FACTORY_HOME: HOME } });
    const result = await runStart(deps, { home: undefined, dryRun: true, yes: false });
    expect(result.ok).toBe(true);
  });

  it.each([false, true])('starts a registered home that is inside a git work tree (dry run: %s)', async (dryRun) => {
    const { deps } = make({ workTree: '/w' });
    expect((await startFactory(deps, { dryRun })).ok).toBe(true);
  });
});

describe('start:the registration check', () => {
  it.each([false, true])(
    'exits 4 for a home that the factory list does not list, with no proxy check and no tmux call (dry run: %s)',
    async (dryRun) => {
      const { deps, tmux } = make({ config: withProxy('stop'), fetch: answers, registered: false });
      const result = await startFactory(deps, { dryRun });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: `Run "factory init" in the factory folder ${HOME}.` } });
      if (!result.ok) expect(result.error.message).toContain(`${HOME}/factory.yaml`);
      expect(deps.fetched).toEqual([]);
      expect(tmux.calls).toEqual([]);
    },
  );

  it.each([
    ['FACTORY_HOME', { env: { FACTORY_HOME: HOME } }, undefined],
    ['the home flag', {}, HOME],
    ['a parent folder', { cwd: `${HOME}/deep` }, undefined],
  ])('applies to a home from %s', async (_name, setup, home) => {
    const { deps, tmux } = make({ ...setup, registered: false });
    deps.seedDir(deps.cwd);
    const result = await runStart(deps, { home, dryRun: true, yes: false });
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(tmux.calls).toEqual([]);
  });

  it('exits 4 when the entry of the factory list has another node id', async () => {
    const { deps } = make();
    registerRoot(deps, HOME, 'another');
    expect(await startFactory(deps, { dryRun: true })).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('exits 4 when the factory marker is missing', async () => {
    const { deps } = make();
    deps.files.delete(`${HOME}/.factory/node.json`);
    const result = await startFactory(deps, { dryRun: true });
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) expect(result.error.message).toContain('factory marker');
  });

  it.each([false, true])(
    'exits 4 from a clone that holds its own config file with a proxy, and sends no proxy check and no launch (dry run: %s)',
    async (dryRun) => {
      const { deps, tmux } = make({ cwd: `${HOME}/web/src`, fetch: answers });
      registerRoot(deps, HOME, 'demo', [`${HOME}/web`]);
      seedConfig(deps, `${HOME}/web`, withProxy('stop'));
      deps.seedDir(`${HOME}/web/src`);
      const result = await runStart(deps, { home: undefined, dryRun, yes: false });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) {
        expect(result.error.message).toContain(`${HOME}/web/factory.yaml`);
        expect(result.error.hint).toBe(`Go to the factory folder ${HOME}, or name it with --home ${HOME}. Then run "factory doctor".`);
      }
      expect(deps.fetched).toEqual([]);
      expect(tmux.calls).toEqual([]);
    },
  );

  it('keeps two registered roots apart: each resolves its own config', async () => {
    const { deps } = make({ cwd: `${HOME}/deep` });
    const other = { ...sampleConfig(), core: { ...sampleConfig().core, node: { id: 'other', layer: 1 } } };
    seedConfig(deps, '/w/other', other);
    registerRoot(deps, '/w/other', 'other');
    deps.seed('/w/other/coordinator/CLAUDE.md', claudeFileText(other));
    deps.seedDir(`${HOME}/deep`);
    deps.seedDir('/w/other/deep');
    const first = await runStart(deps, { home: undefined, dryRun: true, yes: false });
    expect(first.ok && first.value.json['session']).toBe('demo');
    const second = await runStart({ ...deps, cwd: '/w/other/deep' }, { home: undefined, dryRun: true, yes: false });
    expect(second.ok && second.value.json['session']).toBe('other');
  });
});

describe('start:the two config files', () => {
  const LOCAL = `${HOME}/factory.local.yaml`;

  it('exits 2 and names init when factory.yaml has no factory.local.yaml next to it, and starts nothing', async () => {
    const { deps, tmux } = make();
    deps.files.delete(LOCAL);
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!result.ok) {
      expect(result.error.message).toContain('factory.local.yaml not found');
      expect(result.error.hint).toContain('factory init');
    }
    expect(tmux.calls).toEqual([]);
  });

  it('fails the load, and makes no tmux call, when a pulled change adds a proxy entry to factory.yaml', async () => {
    const { deps, tmux } = make({ fetch: answers });
    const shared = deps.files.get(`${HOME}/factory.yaml`) ?? '';
    deps.seed(
      `${HOME}/factory.yaml`,
      `${shared}proxies:\n  - id: pulled\n    base_url: "http://203.0.113.9:8080"\n    health: /health\n`,
    );
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toContain('proxies');
      expect(result.error.message).toContain('factory.local.yaml');
    }
    expect(tmux.calls).toEqual([]);
    expect(deps.fetched).toEqual([]);
  });

  it('sets a local file that others can read back to mode 600, prints a notice, and goes on', async () => {
    const { deps } = make();
    deps.modes.set(LOCAL, 0o644);
    const output = await succeeded(deps);
    expect(deps.modes.get(LOCAL)).toBe(0o600);
    expect(output.warnings.join(' ')).toContain('factory.local.yaml');
    expect(output.warnings.join(' ')).toContain('644');
    expect(output.json['started']).toBe(true);
  });

  it('warns and names the chmod command, and changes no mode, in a dry run', async () => {
    const { deps } = make();
    deps.modes.set(LOCAL, 0o640);
    const output = await succeeded(deps, { dryRun: true });
    expect(deps.modes.get(LOCAL)).toBe(0o640);
    expect(output.warnings.join(' ')).toContain('chmod 600 factory.local.yaml');
  });

  it.each([
    ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o660)],
    ['an other write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o602)],
    ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL, 0)],
  ])('exits 4 with one remedy line, changes no mode and starts nothing for %s', async (_name, change) => {
    const { deps, tmux } = make({ fetch: answers });
    change(deps);
    const before = deps.modes.get(LOCAL);
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) {
      expect(result.error.message).toContain('factory.local.yaml');
      expect(result.error.hint).toContain('chmod 600 factory.local.yaml');
    }
    expect(deps.modes.get(LOCAL)).toBe(before);
    expect(tmux.calls).toEqual([]);
    expect(deps.fetched).toEqual([]);
  });

  it('exits 4 also in a dry run for a local file that others can write', async () => {
    const { deps } = make();
    deps.modes.set(LOCAL, 0o666);
    expect(await startFactory(deps, { dryRun: true })).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it.each([false, true])(
    'exits 4 with one remedy line for a local file that is a link, before the owner check, and changes no mode (TP-147, dry run: %s)',
    async (dryRun) => {
      const { deps, tmux } = make({ links: { [LOCAL]: '/outside/factory.local.yaml' }, fetch: answers });
      deps.modes.set(LOCAL, 0o644);
      deps.owners.set(LOCAL, 0);
      const files = new Map(deps.files);
      const result = await startFactory(deps, { dryRun });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) {
        expect(result.error.message).toBe('factory.local.yaml is a link, so factory does not use it');
        expect(result.error.hint).toBe('Move factory.local.yaml away, then run "factory init" to write a new one.');
      }
      expect(deps.modes.get(LOCAL)).toBe(0o644);
      expect(deps.files).toEqual(files);
      expect(tmux.calls).toEqual([]);
      expect(deps.fetched).toEqual([]);
    },
  );

  it('takes the proxy of the session from the local file only', async () => {
    const { deps, tmux } = make({ config: withProxy('stop'), fetch: answers });
    await succeeded(deps);
    expect(deps.fetched).toEqual([`${PROXY_URL}/health`]);
    expect(tmux.calls.length).toBeGreaterThan(0);
  });
});

describe('start:instruction files at the root and above it (TP-33)', () => {
  const ABOVE = '/w/CLAUDE.md';

  /** The deps whose first call of tmux notes how many warnings were printed by then. */
  const noteWarningsAtLaunch = (deps: FakeDeps): { readonly watched: FakeDeps; readonly seen: number[] } => {
    const seen: number[] = [];
    const watched: FakeDeps = {
      ...deps,
      run: async (command, args, options) => {
        if (command === 'tmux' && seen.length === 0) seen.push(deps.warned.length);
        return deps.run(command, args, options);
      },
    };
    return { watched, seen };
  };

  it('prints the warning before the first call of tmux, and starts the session', async () => {
    const { deps } = make();
    deps.seed(ABOVE, '');
    const { watched, seen } = noteWarningsAtLaunch(deps);
    const output = await succeeded(watched);
    expect(seen).toEqual([1]);
    expect(deps.warned).toEqual(instructionFileWarnings(await scanInstructionFiles(deps, HOME)));
    expect(deps.warned[0]).toContain(ABOVE);
    expect(output.json).toMatchObject({ started: true });
    expect(output.warnings.join(' ')).not.toContain(ABOVE);
  });

  it('prints nothing when no listed file is at the root or above it', async () => {
    const { deps } = make();
    await succeeded(deps);
    expect(deps.warned).toEqual([]);
  });

  it('prints the warning in a dry run, and the dry run goes on', async () => {
    const { deps, tmux } = make();
    deps.seed(`${HOME}/AGENTS.md`, '');
    const output = await succeeded(deps, { dryRun: true });
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain(`${HOME}/AGENTS.md`);
    expect(output.json).toMatchObject({ dryRun: true });
    expect(tmux.calls.some((call) => call.args[0] === 'new-session')).toBe(false);
  });

  it('gives a warning, not a failure, when a folder above the root can not be read', async () => {
    const { deps } = make();
    const unreadable: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        lstat: async (path) =>
          dirname(path) === '/w' && path !== HOME ? failure(`cannot stat ${path}: EACCES`) : deps.fs.lstat(path),
      },
    };
    const output = await succeeded(unreadable);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.warned.join(' ')).toContain('EACCES');
  });

  it('prints the warning once also when the command stops for another reason', async () => {
    const { deps, tmux } = make({ tools: [] });
    deps.seed(ABOVE, '');
    const result = await startFactory(deps);
    expect(result.ok).toBe(false);
    expect(deps.warned).toHaveLength(1);
    expect(tmux.calls).toEqual([]);
  });
});

describe('start:the root checks (TP-20, TP-61, TP-63, TP-78, TP-123, TP-133, TP-134, TP-154, TP-155, TP-168, TP-179, TP-180)', () => {
  const BYPASS = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
  const ALL_PROBES = ['factory.local.yaml', '.factory/node.json', 'coordinator/CLAUDE.md', 'work-copies/probe', 'web/CLAUDE.md'];

  /** The result of a run that the root checks stop: exit 4, the reason and one remedy line. */
  const stopOf = async (deps: FakeDeps, options: Partial<StartOptions> = {}) => {
    const result = await startFactory(deps, options);
    if (result.ok) throw new Error('expected a stop');
    expect(result.error.kind).toBe('safety');
    expect(result.error.hint).toBeDefined();
    expect(result.error.hint).not.toContain('\n');
    expect(result.error.message).not.toContain('\n');
    return result.error;
  };

  it('stops with exit 4 when git tracks the local file, names the path and the remedy, and starts nothing (TP-20)', async () => {
    const { deps, tmux } = make({ origin: 'own', tracked: ['factory.local.yaml'] });
    const error = await stopOf(deps);
    expect(error.message).toContain('factory.local.yaml');
    expect(error.hint).toContain('git rm --cached');
    expect(tmux.calls).toEqual([]);
  });

  it.each([
    ['a path under the state folder', '.factory/node.json'],
    ['a path under the coordinator folder', 'coordinator/CLAUDE.md'],
  ])('stops for %s that git tracks (TP-123)', async (_name, path) => {
    const { deps, tmux } = make({ origin: 'own', tracked: [path] });
    const error = await stopOf(deps);
    expect(error.message).toContain(path);
    expect(tmux.calls).toEqual([]);
  });

  it('stops in a dry run, too, and before the proxy health request', async () => {
    const { deps, tmux } = make({ origin: 'own', tracked: ['factory.local.yaml'], config: withProxy('stop'), fetch: answers });
    await stopOf(deps, { dryRun: true });
    await stopOf(deps);
    expect(deps.fetched).toEqual([]);
    expect(tmux.calls).toEqual([]);
  });

  it('stops when git does not ignore the local file, and goes on when git does not ignore the coordinator folder (TP-61)', async () => {
    const stopped = make({ ignored: ALL_PROBES.filter((path) => path !== 'factory.local.yaml') });
    const error = await stopOf(stopped.deps);
    expect(error.message).toContain('factory.local.yaml');
    expect(error.hint).toContain('.gitignore');
    expect(stopped.tmux.calls).toEqual([]);

    const warned = make({ ignored: ALL_PROBES.filter((path) => path !== 'coordinator/CLAUDE.md') });
    const output = await succeeded(warned.deps);
    expect(output.json).toMatchObject({ started: true });
    expect(warned.deps.warned.join(' ')).toContain('coordinator/');
  });

  it('stops, and names the command that fixes it, when git can not answer the ignore question for the local file', async () => {
    const { deps, tmux } = make({ origin: 'own', ignoreFails: true });
    const error = await stopOf(deps);
    expect(error.hint).toContain('run "factory doctor"');
    expect(tmux.calls).toEqual([]);
  });

  it('stops, and names the command that fixes it, when the list of tracked files is at its cap on an own root', async () => {
    const tracked = Array.from({ length: trackedFiles.maxCount + 1 }, (_value, index) => `docs/f${index}.md`);
    const { deps, tmux } = make({ origin: 'own', tracked });
    const error = await stopOf(deps);
    expect(error.hint).toContain('git rm --cached');
    expect(error.hint).toContain('run "factory doctor"');
    expect(tmux.calls).toEqual([]);
  });

  it('goes on, with a warning that names the path, when an own root tracks an instruction file (TP-155)', async () => {
    const { deps } = make({ origin: 'own', tracked: ['AGENTS.md'] });
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.warned.join(' ')).toContain('AGENTS.md');
    expect(deps.warned.join(' ')).toContain('every receiver');
  });

  it('stops for a received root whose tracked files the owner did not accept, and names the accept command', async () => {
    const { deps, tmux } = make({ origin: 'received', tracked: ['scripts/run.sh'] });
    const error = await stopOf(deps);
    expect(error.message).toContain('scripts/run.sh');
    expect(error.hint).toContain('factory init');
    expect(error.hint).toContain('terminal window');
    expect(tmux.calls).toEqual([]);
  });

  it('starts a received root after the owner accepted its tracked files', async () => {
    const { deps } = make({ origin: 'received', tracked: ['scripts/run.sh'] });
    await acceptTracked(deps, HOME, 'demo', ['scripts/run.sh']);
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.warned).toEqual([]);
  });

  it('stops for a project folder that is a link to a folder outside the root (TP-63)', async () => {
    const { deps, tmux } = make({ links: { [`${HOME}/web`]: '/elsewhere/web' } });
    deps.seedDir('/elsewhere/web');
    const error = await stopOf(deps);
    expect(error.message).toContain('project web');
    expect(error.message).toContain('outside');
    expect(tmux.calls).toEqual([]);
  });

  it('stops for a token in a tracked file, names the file and never shows the value (TP-45, TP-134)', async () => {
    const { deps, tmux } = make({ origin: 'own', tracked: ['docs/notes.md'] });
    deps.seed(`${HOME}/docs/notes.md`, `key ${FAKE_GITHUB_TOKEN}\n`);
    const error = await stopOf(deps);
    expect(error.message).toContain('docs/notes.md');
    expect(`${error.message} ${error.hint}`).not.toContain(FAKE_GITHUB_TOKEN);
    expect(JSON.stringify(deps.warned)).not.toContain(FAKE_GITHUB_TOKEN);
    expect(tmux.calls).toEqual([]);
  });

  it('goes on, with a warning, for a file URL in a tracked file', async () => {
    const { deps } = make({ origin: 'own', tracked: ['docs/setup.md'] });
    deps.seed(`${HOME}/docs/setup.md`, 'repo: file:///srv/repos/web.git\n');
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.warned.join(' ')).toContain('docs/setup.md');
  });

  it.each([
    ['the coordinator folder', 'coordinator'],
    ['a project folder', 'web'],
  ])('stops for a setting that skips permission prompts in %s (TP-133)', async (_name, folder) => {
    const { deps, tmux } = make();
    deps.seed(`${HOME}/${folder}/.claude/settings.local.json`, BYPASS);
    const error = await stopOf(deps);
    expect(error.message).toContain(`${folder}/.claude/settings.local.json`);
    expect(error.message).toContain('skips the permission checks');
    expect(tmux.calls).toEqual([]);
  });

  it('stops for such a setting in a tracked settings path at any depth, also after the owner accepted the files (TP-168)', async () => {
    const path = 'tools/deep/.claude/settings.json';
    const { deps, tmux } = make({ origin: 'received', tracked: [path] });
    deps.seed(`${HOME}/${path}`, BYPASS);
    await acceptTracked(deps, HOME, 'demo', [path]);
    const error = await stopOf(deps);
    expect(error.message).toContain(path);
    expect(tmux.calls).toEqual([]);
  });

  it('stops for a settings file that sets or clears the session marker (TP-179)', async () => {
    const { deps } = make();
    deps.seed(`${HOME}/coordinator/.claude/settings.json`, JSON.stringify({ env: { [env.session]: '' } }));
    const error = await stopOf(deps);
    expect(error.message).toContain('coordinator/.claude/settings.json');
    expect(error.message).toContain(env.factoryPrefix);
  });

  it.each([env.home, 'FACTORY_ANYTHING'])(
    'stops for a coordinator settings file whose env sets %s, with exit 4 and one remedy line, before any tmux call (AC-8, TP-23)',
    async (name) => {
      const { deps, tmux } = make();
      deps.seed(`${HOME}/coordinator/.claude/settings.local.json`, JSON.stringify({ env: { [name]: 'x' } }));
      const error = await stopOf(deps);
      expect(error.message).toContain('coordinator/.claude/settings.local.json');
      expect(error.message).toContain(env.factoryPrefix);
      expect(error.hint).toContain('Remove the setting from coordinator/.claude/settings.local.json');
      expect(tmux.calls).toEqual([]);
    },
  );

  it('stops for a coordinator settings file that can not be read, with exit 4, and starts nothing (AC-8, TP-24)', async () => {
    const { deps, tmux } = make();
    const file = `${COORDINATOR}/.claude/settings.local.json`;
    deps.seed(file, '{}');
    const readTextLimited: FakeDeps['fs']['readTextLimited'] = async (path, max) =>
      path === file ? failure(`cannot read ${path}: EACCES`) : deps.fs.readTextLimited(path, max);
    const error = await stopOf({ ...deps, fs: { ...deps.fs, readTextLimited } });
    expect(error.message).toContain('coordinator/.claude/settings.local.json');
    expect(error.message).toContain('did not read');
    expect(tmux.calls).toEqual([]);
  });

  it.each([
    ['a settings file', 'settings.local.json'],
    ['a settings folder', ''],
  ])('stops for a coordinator %s that is a link, with exit 4, and starts nothing (AC-8, TP-24)', async (_name, file) => {
    const target = file === '' ? `${COORDINATOR}/.claude` : `${COORDINATOR}/.claude/${file}`;
    const { deps, tmux } = make({ links: { [target]: '/elsewhere/claude' } });
    deps.seed('/elsewhere/claude/settings.local.json', '{}');
    if (file !== '') deps.seed(target, '{}');
    const error = await stopOf(deps);
    expect(error.message).toContain('coordinator/.claude');
    expect(error.message).toContain('link');
    expect(tmux.calls).toEqual([]);
  });

  it('stops for a settings file that sets the proxy of the session', async () => {
    const { deps, tmux } = make();
    deps.seed(`${HOME}/web/.claude/settings.json`, JSON.stringify({ env: { [env.proxyBaseUrl]: 'http://127.0.0.1:1' } }));
    const error = await stopOf(deps);
    expect(error.message).toContain('web/.claude/settings.json');
    expect(error.message).toContain(env.proxyBaseUrl);
    expect(tmux.calls).toEqual([]);
  });

  it('stops for a hook in the coordinator folder, and goes on, with a warning, for a hook in the factory folder', async () => {
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] };
    const stopped = make();
    stopped.deps.seed(`${HOME}/coordinator/.claude/settings.local.json`, JSON.stringify({ hooks }));
    const error = await stopOf(stopped.deps);
    expect(error.message).toContain('coordinator/.claude/settings.local.json');
    expect(error.message).toContain('hooks');

    const warned = make();
    warned.deps.seed(`${HOME}/.claude/settings.local.json`, JSON.stringify({ hooks }));
    expect((await succeeded(warned.deps)).json).toMatchObject({ started: true });
    expect(warned.deps.warned.join(' ')).toContain('hooks');
  });

  it('goes on, with a warning, for a settings file in the coordinator folder and for a whole-tool allow rule (TP-154)', async () => {
    const { deps } = make({ hookSettings: JSON.stringify({ ...ownSettingsEntries, permissions: { allow: ['Bash'] } }) });
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.warned.join(' ')).toContain('coordinator/.claude/settings.local.json');
    expect(deps.warned.join(' ')).toContain('Bash');
  });

  it('goes on, with a warning that names the setting, for a setting that approves project MCP servers (TP-180)', async () => {
    const { deps } = make();
    deps.seed(`${HOME}/web/.claude/settings.json`, JSON.stringify({ enableAllProjectMcpServers: true }));
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.warned.join(' ')).toContain('enableAllProjectMcpServers');
    expect(deps.warned.join(' ')).toContain('web/.claude/settings.json');
  });

  it('prints the active delegations before the first call of tmux, and a value with no record as a warning (TP-78)', async () => {
    const config = sampleConfig();
    const delegated = { ...config, core: { ...config.core, approval: { ...config.core.approval, merge: 'delegated' as const, release: 'delegated' as const } } };
    const { deps } = make({ config: delegated });
    deps.seed(
      '/state/factory/owner-records.json',
      JSON.stringify({ schema: 1, records: [{ kind: 'delegation', node: 'demo', root: HOME, point: 'merge', mode: 'delegated', at: '2030-01-02T03:04:05.678Z' }] }),
    );
    // The safety block of the file follows the effective modes, which the record changes.
    deps.seed(CLAUDE_FILE, claudeFileText(delegated, await effectiveModes(deps, HOME, delegated)));
    const seen: number[] = [];
    const watched: FakeDeps = {
      ...deps,
      run: async (command, args, options) => {
        if (command === 'tmux' && seen.length === 0) seen.push(deps.warned.length);
        return deps.run(command, args, options);
      },
    };
    const output = await succeeded(watched);
    expect(output.json).toMatchObject({ started: true });
    expect(seen).toEqual([2]);
    const text = deps.warned.join('\n');
    expect(text).toContain('merge since 2030-01-02T03:04:05.678Z');
    expect(text).toContain('release is set to delegated');
    expect(text).toContain('factory init');
  });

  it('prints no notice for a root with no finding and no delegation', async () => {
    const { deps } = make({ origin: 'own' });
    await succeeded(deps);
    expect(deps.warned).toEqual([]);
  });
});

describe('start:the setup text needs the owner (TP-128, TP-145, TP-151, TP-152, TP-153, TP-158, TP-160, TP-165, TP-173, TP-174, TP-175, TP-178, TP-182, TP-183)', () => {
  const SETUP_FILE = `${HOME}/setup/coordinator.md`;
  const SETUP_PATH = 'setup/coordinator.md';
  const ACCEPT_COMMAND = 'Run "factory start" or "factory upgrade" in a terminal window outside a factory session.';
  const INIT_COMMAND = 'Run "factory init" in a terminal window and accept the files.';
  const yes: PromptHandler = () => ok('y');
  const no: PromptHandler = () => ok('n');

  /** An own root whose setup text the owner accepted, and that a pull changed afterwards. */
  const changed = async (setup: Setup = {}) => {
    const made = make({ origin: 'own', ...setup });
    made.deps.seed(SETUP_FILE, 'First rules.\n');
    await acceptFiles(made.deps, HOME, 'demo', [SETUP_PATH]);
    made.deps.seed(SETUP_FILE, 'Second rules.\n');
    return made;
  };

  const storeOf = (deps: FakeDeps): string => deps.files.get(ACCEPTANCES) ?? '';

  const hashOf = async (deps: FakeDeps, paths: readonly string[]): Promise<string> => {
    const set = await collectSetup(deps, HOME, paths, 'init');
    if (!set.ok) throw new Error(set.error.message);
    return set.value.collected.manifest.hash;
  };

  const recordsOf = (deps: FakeDeps): { hash: string; node: string }[] =>
    (JSON.parse(storeOf(deps) || '{"acceptances":[]}') as { acceptances: { hash: string; node: string }[] }).acceptances;

  /** A run that must stop with exit 4: one reason, one remedy line, and no call of tmux. */
  const stopped = async (made: { deps: FakeDeps; tmux: TmuxLog }, options: Partial<StartOptions> = {}) => {
    const result = await startFactory(made.deps, options);
    if (result.ok) throw new Error('expected a stop');
    expect(result.error.kind).toBe('safety');
    expect(result.error.hint).toBeDefined();
    expect(result.error.hint).not.toContain('\n');
    expect(result.error.message).not.toContain('\n');
    expect(made.tmux.calls).toEqual([]);
    return result.error;
  };

  describe('the text is accepted, or there is no text', () => {
    it('starts, asks nothing and writes nothing when the owner accepted the setup text as it is', async () => {
      const made = make({ origin: 'own', tty: true, prompt: yes });
      made.deps.seed(SETUP_FILE, 'First rules.\n');
      await acceptFiles(made.deps, HOME, 'demo', [SETUP_PATH]);
      const before = storeOf(made.deps);
      expect((await succeeded(made.deps)).json).toMatchObject({ started: true });
      expect(made.deps.prompts).toEqual([]);
      expect(storeOf(made.deps)).toBe(before);
    });

    it('needs no acceptance for an empty subject: a setup file that holds only white space', async () => {
      const made = make({ origin: 'own' });
      made.deps.seed(SETUP_FILE, '\n  \n');
      expect((await succeeded(made.deps)).json).toMatchObject({ started: true });
    });
  });

  describe('no acceptance at all for the root (TP-173, TP-183, TP-145, TP-182)', () => {
    it.each([
      ['no terminal window', {}, {}],
      ['a terminal window', { tty: true }, {}],
      ['a terminal window and a dry run', { tty: true }, { dryRun: true }],
    ])('exits 4 and names init in a terminal window, with %s, asks nothing and writes no acceptance', async (_name, setup, options) => {
      const made = make({ origin: 'own', prompt: yes, ...setup });
      made.deps.seed(SETUP_FILE, 'First rules.\n');
      const error = await stopped(made, options);
      expect(error.message).toContain(SETUP_PATH);
      expect(error.hint).toBe(INIT_COMMAND);
      expect(made.deps.prompts).toEqual([]);
      expect(made.deps.files.has(ACCEPTANCES)).toBe(false);
    });

    it('exits 4 for the worker text alone, because the worker text goes into session instructions too', async () => {
      const made = make({ origin: 'own', tty: true, prompt: yes });
      made.deps.seed(`${HOME}/setup/roles/worker.md`, 'Worker rules.\n');
      const error = await stopped(made);
      expect(error.message).toContain('setup/roles/worker.md');
      expect(made.deps.files.has(ACCEPTANCES)).toBe(false);
    });

    it('exits 4 on a moved root that tracks only the config, the ignore file and the setup file, also on a terminal window (TP-145)', async () => {
      const made = make({
        origin: 'received',
        tty: true,
        prompt: yes,
        tracked: ['factory.yaml', '.gitignore', SETUP_PATH],
      });
      made.deps.seed(SETUP_FILE, 'Moved rules.\n');
      const error = await stopped(made);
      expect(error.message).toContain(SETUP_PATH);
      expect(error.hint).toBe(INIT_COMMAND);
      expect(made.deps.prompts).toEqual([]);
      expect(made.deps.files.has(ACCEPTANCES)).toBe(false);
    });

    it('exits 4 for a received root with an empty setup file and a tracked instruction file (TP-182)', async () => {
      const made = make({ origin: 'received', tty: true, prompt: yes, tracked: [SETUP_PATH, 'CLAUDE.md'] });
      made.deps.seed(SETUP_FILE, '');
      const error = await stopped(made);
      expect(error.message).toContain('CLAUDE.md');
      expect(error.message).not.toContain(SETUP_PATH);
      expect(error.hint).toBe(INIT_COMMAND);
      expect(made.deps.prompts).toEqual([]);
    });

    it('does not ask after a no at init: start exits 4 and names the same command (TP-183)', async () => {
      const made = make({ origin: 'received', tty: true, prompt: yes, tracked: ['scripts/run.sh'] });
      const error = await stopped(made);
      expect(error.hint).toBe(INIT_COMMAND);
      expect(made.deps.prompts).toEqual([]);
    });
  });

  describe('a change after an older acceptance', () => {
    it('shows the old and the new hash and the change, and with a yes records the new hash and goes on (TP-151)', async () => {
      const made = await changed({ tty: true, prompt: yes });
      const oldHash = recordsOf(made.deps)[0]?.hash ?? '';
      const newHash = await hashOf(made.deps, [SETUP_PATH]);
      const output = await succeeded(made.deps);
      expect(output.json).toMatchObject({ started: true });
      expect(made.deps.prompts).toHaveLength(1);
      const question = made.deps.prompts[0] ?? '';
      expect(question).toContain(`Hash of all files: ${newHash}`);
      expect(question).toContain(`Hash of the files that you accepted before: ${oldHash}`);
      expect(question).toContain(`Changed files:\n  ${SETUP_PATH}`);
      expect(question).toContain('Second rules.');
      expect(recordsOf(made.deps)).toEqual([expect.objectContaining({ node: 'demo', hash: newHash })]);
      expect(newHash).not.toBe(oldHash);
    });

    it('asks no more after the yes: the next start has nothing to accept', async () => {
      const made = await changed({ tty: true, prompt: yes });
      await succeeded(made.deps);
      made.deps.prompts.length = 0;
      await succeeded(made.deps);
      expect(made.deps.prompts).toEqual([]);
    });

    it('renders the setup block again from the bytes that it hashed, also when the file changes while the owner reads', async () => {
      const made = await changed({
        tty: true,
        prompt: () => {
          made.deps.seed(SETUP_FILE, 'Third rules.\n');
          return ok('y');
        },
      });
      const hashed = await hashOf(made.deps, [SETUP_PATH]);
      await succeeded(made.deps);
      expect(made.deps.files.get(CLAUDE_FILE)).toContain('Second rules.');
      expect(made.deps.files.get(CLAUDE_FILE)).not.toContain('Third rules.');
      expect(recordsOf(made.deps)[0]?.hash).toBe(hashed);
    });

    it('keeps the safety block and the role block as they are when it renders the setup block', async () => {
      const made = await changed({ tty: true, prompt: yes });
      const before = made.deps.files.get(CLAUDE_FILE) ?? '';
      await succeeded(made.deps);
      const after = made.deps.files.get(CLAUDE_FILE) ?? '';
      expect(after.startsWith(before.trimEnd())).toBe(true);
      expect(after).toContain('<!-- factory:begin setup v');
    });

    it('keeps a setup block that a person edited, and names the command that puts the text back', async () => {
      const made = await changed({ tty: true, prompt: yes });
      const rendered = renderBlock({ name: 'setup', version: 1, body: 'First rules.' });
      if (!rendered.ok) throw new Error(rendered.error.message);
      const edited = rendered.value.replace('First rules.', 'Edited by hand.');
      made.deps.seed(CLAUDE_FILE, `${made.deps.files.get(CLAUDE_FILE) ?? ''}\n${edited}\n`);
      await succeeded(made.deps);
      expect(made.deps.files.get(CLAUDE_FILE)).toContain('Edited by hand.');
      expect(made.deps.warned.join('\n')).toContain('factory upgrade');
    });

    it('writes nothing through a link at the coordinator file when the owner accepts the change', async () => {
      const links: Record<string, string> = {};
      const made = await changed({ tty: true, prompt: yes, links });
      links[CLAUDE_FILE] = '/elsewhere/CLAUDE.md';
      const before = made.deps.files.get(CLAUDE_FILE);
      const error = await stopped(made);
      expect(error.message).toContain('coordinator/CLAUDE.md is a link');
      expect(made.deps.files.get(CLAUDE_FILE)).toBe(before);
      expect(made.deps.files.has('/elsewhere/CLAUDE.md')).toBe(false);
    });

    it('exits 4 with one remedy line on a no, and writes no acceptance (TP-152)', async () => {
      const made = await changed({ tty: true, prompt: no });
      const before = storeOf(made.deps);
      const error = await stopped(made);
      expect(error.hint).toBe(ACCEPT_COMMAND);
      expect(made.deps.prompts).toHaveLength(1);
      expect(storeOf(made.deps)).toBe(before);
    });

    it('takes an empty answer as a no', async () => {
      const made = await changed({ tty: true, prompt: () => ok('') });
      const before = storeOf(made.deps);
      await stopped(made);
      expect(storeOf(made.deps)).toBe(before);
    });

    it.each([
      ['a terminal window in a factory session (TP-153)', { tty: true, env: { FACTORY_SESSION: 'demo' } }, {}],
      ['a terminal window in a dry run (TP-174)', { tty: true }, { dryRun: true }],
      ['no terminal window (TP-175)', {}, {}],
      ['a terminal window for input and none for output (TP-178)', { tty: true, stdoutTty: false }, {}],
      ['a terminal window for output and none for input (TP-178)', { tty: false, stdoutTty: true }, {}],
    ])('asks nothing, exits 4, names the accept command and writes no acceptance, with %s', async (_name, setup, options) => {
      const made = await changed({ prompt: yes, ...setup });
      const before = storeOf(made.deps);
      const error = await stopped(made, options);
      expect(error.hint).toBe(ACCEPT_COMMAND);
      expect(error.message).toContain(SETUP_PATH);
      expect(made.deps.prompts).toEqual([]);
      expect(storeOf(made.deps)).toBe(before);
    });

    it('stops without a question when another check fails, too, and lists both reasons', async () => {
      const made = await changed({ tty: true, prompt: yes, tracked: ['docs/notes.md'] });
      made.deps.seed(`${HOME}/docs/notes.md`, `key ${FAKE_GITHUB_TOKEN}\n`);
      const error = await stopped(made);
      expect(error.message).toContain('docs/notes.md');
      expect(error.message).toContain(SETUP_PATH);
      expect(`${error.message} ${error.hint}`).not.toContain(FAKE_GITHUB_TOKEN);
      expect(made.deps.prompts).toEqual([]);
    });

    it('exits 4 and names the accept command when the acceptance is for another node id', async () => {
      const made = make({ origin: 'own', tty: true, prompt: yes });
      made.deps.seed(SETUP_FILE, 'First rules.\n');
      await acceptFiles(made.deps, HOME, 'other', [SETUP_PATH]);
      const error = await stopped(made, { dryRun: true });
      expect(error.hint).toBe(ACCEPT_COMMAND);
    });
  });

  describe('the worker file in the state repo', () => {
    const WORKER_SETUP_FILE = `${HOME}/setup/roles/worker.md`;
    const WORKER_SETUP_PATH = 'setup/roles/worker.md';
    const WORKER_FILE = `${STATE_DIR}/roles/worker.md`;

    /** An own root whose two setup texts the owner accepted, and whose worker text a pull changed afterwards. */
    const changedWorker = async (setup: Setup = {}) => {
      const made = make({ origin: 'own', tty: true, prompt: yes, stateRepo: {}, ...setup });
      made.deps.seedDir(`${STATE_DIR}/.git`);
      made.deps.seed(SETUP_FILE, 'First rules.\n');
      made.deps.seed(WORKER_SETUP_FILE, 'First worker rules.\n');
      await acceptFiles(made.deps, HOME, 'demo', [SETUP_PATH, WORKER_SETUP_PATH]);
      made.deps.seed(WORKER_FILE, workerFileText(sampleConfig(), { coordinator: 'First rules.', worker: 'First worker rules.' }));
      made.deps.seed(WORKER_SETUP_FILE, 'Second worker rules.\n');
      return made;
    };

    /** The git calls in the state repo, each one as the words after `-C <folder>`. */
    const stateGit = (deps: FakeDeps): string[] =>
      deps.calls.filter((call) => call.command === 'git' && call.args[1] === STATE_DIR).map((call) => call.args.slice(2).join(' '));

    /** The writes of the render: the add, the reset and the commit calls, without those of the mark of the active machine. */
    const writesOf = (calls: readonly string[]): string[] =>
      calls
        .filter((call) => call.startsWith('add') || call.startsWith('reset') || call.includes(' commit '))
        .filter((call) => !call.includes(files.activeMachine) && !call.includes(activeMachine.commitMessages.set));

    it('commits the worker file that it renders, and no other file', async () => {
      const made = await changedWorker();
      await succeeded(made.deps);
      expect(made.deps.files.get(WORKER_FILE)).toContain('Second worker rules.');
      expect(made.deps.files.get(CLAUDE_FILE)).toContain('<!-- factory:begin setup v');
      const writes = writesOf(stateGit(made.deps));
      expect(writes).toHaveLength(2);
      expect(writes[0]).toBe('add -A -- roles/worker.md');
      expect(writes[1]).toContain(' commit -q -m ');
    });

    it('makes no commit when only a file outside the state repo changes', async () => {
      const made = make({ origin: 'own', tty: true, prompt: yes, stateRepo: {} });
      made.deps.seed(SETUP_FILE, 'First rules.\n');
      await acceptFiles(made.deps, HOME, 'demo', [SETUP_PATH]);
      made.deps.seed(SETUP_FILE, 'Second rules.\n');
      await succeeded(made.deps);
      expect(made.deps.files.get(CLAUDE_FILE)).toContain('Second rules.');
      expect(writesOf(stateGit(made.deps))).toEqual([]);
    });

    it('stops with the command to run again, and writes and commits nothing, when the owner changed the worker file', async () => {
      const made = await changedWorker({ stateRepo: { status: ' M roles/worker.md\0' } });
      const before = [made.deps.files.get(CLAUDE_FILE), made.deps.files.get(WORKER_FILE)];
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: false, error: { hint: expect.stringContaining('Then run "factory start" again.') } });
      expect([made.deps.files.get(CLAUDE_FILE), made.deps.files.get(WORKER_FILE)]).toEqual(before);
      expect(writesOf(stateGit(made.deps))).toEqual([]);
    });

    it('puts the coordinator file back when the worker file cannot be written', async () => {
      const made = await changedWorker();
      const before = [made.deps.files.get(CLAUDE_FILE), made.deps.files.get(WORKER_FILE)];
      const result = await startFactory(withFailingWrites(made.deps, (path, attempt) => path === WORKER_FILE && attempt === 1));
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('disk full') } });
      expect([made.deps.files.get(CLAUDE_FILE), made.deps.files.get(WORKER_FILE)]).toEqual(before);
      expect(writesOf(stateGit(made.deps))).toEqual([]);
    });

    it('puts both files back and clears the staged worker file when the commit fails', async () => {
      const made = await changedWorker({ stateRepo: { commitExit: 1 } });
      const before = [made.deps.files.get(CLAUDE_FILE), made.deps.files.get(WORKER_FILE)];
      const result = await startFactory(made.deps);
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('cannot commit the state files') } });
      expect([made.deps.files.get(CLAUDE_FILE), made.deps.files.get(WORKER_FILE)]).toEqual(before);
      expect(stateGit(made.deps)).toContain('reset -q -- roles/worker.md');
    });
  });

  describe('the files of a received root (TP-158, TP-160, TP-165)', () => {
    const received = async (path: string, before: string, after: string, setup: Setup = {}) => {
      const made = make({ origin: 'received', tracked: [path], ...setup });
      made.deps.seed(`${HOME}/${path}`, before);
      await acceptTracked(made.deps, HOME, 'demo', [path]);
      made.deps.seed(`${HOME}/${path}`, after);
      return made;
    };

    it('exits 4 with the accept command when an accepted tracked file changed and no terminal window can ask (TP-158)', async () => {
      const made = await received('scripts/run.sh', 'echo one\n', 'echo two\n');
      const error = await stopped(made);
      expect(error.message).toContain('scripts/run.sh');
      expect(error.hint).toBe(ACCEPT_COMMAND);
    });

    it('exits 4 with the accept command when the tracked MCP config file changed (TP-165)', async () => {
      const made = await received('.mcp.json', '{"mcpServers":{}}\n', '{"mcpServers":{"a":{}}}\n');
      const error = await stopped(made);
      expect(error.message).toContain('.mcp.json');
      expect(error.hint).toBe(ACCEPT_COMMAND);
    });

    it('names the settings file as changed and shows its change, and a no writes no acceptance (TP-160)', async () => {
      const made = await received('.claude/settings.json', '{"model":"sonnet"}\n', '{"model":"opus"}\n', {
        tty: true,
        prompt: no,
      });
      const before = storeOf(made.deps);
      const error = await stopped(made);
      expect(error.hint).toBe(ACCEPT_COMMAND);
      const question = made.deps.prompts[0] ?? '';
      expect(question).toContain('Changed files:\n  .claude/settings.json');
      expect(question).toContain('"model":"opus"');
      expect(storeOf(made.deps)).toBe(before);
    });

    it('records the new hash after a yes and starts', async () => {
      const made = await received('scripts/run.sh', 'echo one\n', 'echo two\n', { tty: true, prompt: yes });
      expect((await succeeded(made.deps)).json).toMatchObject({ started: true });
      expect(recordsOf(made.deps)[0]?.hash).toBe(await hashOf(made.deps, ['scripts/run.sh']));
    });
  });
});

describe('start:the safety block (TP-43, TP-77, TP-107, TP-125, TP-131)', () => {
  const STORE = '/state/factory/owner-records.json';
  const REMEDY = 'factory upgrade --overwrite safety';
  const RENDERED_NOTICE = 'Rendered the block safety in coordinator/CLAUDE.md again, because the package or a setting changed its text.';

  const withPrefix = (prefix: string): FactoryConfig => {
    const config = sampleConfig();
    return { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix } } };
  };

  const delegatedMerge = (): FactoryConfig => {
    const config = sampleConfig();
    return { ...config, core: { ...config.core, approval: { ...config.core.approval, merge: 'delegated' as const } } };
  };

  const delegationRecord = JSON.stringify({
    schema: 1,
    records: [{ kind: 'delegation', node: 'demo', root: HOME, point: 'merge', mode: 'delegated', at: '2030-01-02T03:04:05.678Z' }],
  });

  const rendered = claudeFileText(sampleConfig());
  const editedSafety = rendered.replace('Never skip permissions', 'Skip permissions');
  const withoutSafety = (text: string): string =>
    text.slice(0, text.indexOf('<!-- factory:begin safety')) +
    text.slice(text.indexOf('<!-- factory:end safety -->') + '<!-- factory:end safety -->'.length);

  /** The result of a run that the safety block stops: exit 4, one remedy line, and nothing started. */
  const stopOf = async (setup: Setup, options: Partial<StartOptions> = {}) => {
    const { deps, tmux } = make({ config: withProxy('stop'), fetch: answers, ...setup });
    const before = new Map(deps.files);
    const result = await startFactory(deps, options);
    if (result.ok) throw new Error('expected a stop');
    expect(result.error.kind).toBe('safety');
    expect(result.error.hint).not.toContain('\n');
    expect(deps.fetched).toEqual([]);
    expect(tmux.calls).toEqual([]);
    expect(deps.files).toEqual(before);
    return result.error;
  };

  it('goes on and writes nothing when the block equals the text that the package renders', async () => {
    const { deps } = make();
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.files.get(CLAUDE_FILE)).toBe(rendered);
    // The only write is the mark of the active machine, which the start writes after it made the session.
    expect(deps.atomicWrites).toEqual([MARK_FILE]);
    expect(deps.warned.join(' ')).not.toContain('safety');
  });

  it('exits 4 for an edited block, in a real run and in a dry run, and names the command (TP-43)', async () => {
    for (const dryRun of [false, true]) {
      const error = await stopOf({ claudeFile: editedSafety }, { dryRun });
      expect(error.message).toBe('the block safety in coordinator/CLAUDE.md was edited');
      expect(error.hint).toBe(`Run "${REMEDY}" to replace the text. It keeps the old text in a backup file.`);
    }
  });

  it('exits 4 for a safety block that is not in the file (TP-43)', async () => {
    const error = await stopOf({ claudeFile: `Notes of mine.\n\n${withoutSafety(rendered)}` });
    expect(error.message).toBe('the block safety is missing in coordinator/CLAUDE.md');
    expect(error.hint).toBe(`Run "${REMEDY}" to add it.`);
  });

  it.each([
    ['the file is not there', { claudeFile: false as const }],
    ['the coordinator folder is not there', { coordinatorFolder: false }],
  ])('exits 4 when %s (TP-43)', async (_name, setup) => {
    const error = await stopOf(setup);
    expect(error.message).toBe('the block safety is missing in coordinator/CLAUDE.md');
    expect(error.hint).toBe(`Run "${REMEDY}" to add it.`);
  });

  it('exits 4 when the markers of the file do not parse, and names the file to fix', async () => {
    const error = await stopOf({ claudeFile: '<!-- factory:begin safety v2 sha256=zz -->\n' });
    expect(error.message).toContain('the block safety in coordinator/CLAUDE.md can not be read');
    expect(error.hint).toBe('Fix the marker lines in coordinator/CLAUDE.md, then run "factory doctor".');
  });

  it('exits 4 for an edited prefix line, because the owner prefix is part of the block (TP-125)', async () => {
    const text = rendered.replace(/- The owner prefix is `[^`]*`/, '- The owner prefix is `[From anyone]`');
    expect(text).not.toBe(rendered);
    const error = await stopOf({ claudeFile: text });
    expect(error.message).toContain('was edited');
  });

  it('checks the block of a session that runs already, too', async () => {
    const error = await stopOf({ claudeFile: editedSafety, tty: true, tmux: { sessions: { demo: HOME } } });
    expect(error.hint).toContain(REMEDY);
  });

  it('renders an intact block again with a notice after a new prefix value in the local file, and goes on (TP-125)', async () => {
    const config = withPrefix('[From {owner}, sent by {node}, {date}]');
    const { deps } = make({ config, claudeFile: `My own rules.\n\n${claudeFileText(sampleConfig())}\nMore of my rules.\n` });
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    expect(deps.files.get(CLAUDE_FILE)).toBe(`My own rules.\n\n${claudeFileText(config)}\nMore of my rules.\n`);
    expect(deps.files.get(CLAUDE_FILE)).toContain('sent by');
    expect(deps.warned).toContain(RENDERED_NOTICE);
  });

  it('renders the block again, with a notice, after a delegation record goes away (TP-77)', async () => {
    const config = delegatedMerge();
    const { deps } = make({ config });
    deps.seed(STORE, delegationRecord);
    const delegatedModes = await effectiveModes(deps, HOME, config);
    const safetyOf = (modes: typeof delegatedModes): string => {
      const block = renderBlock(safetyTemplateFor(config, modes));
      if (!block.ok) throw new Error(block.error.message);
      return block.value;
    };
    expect(safetyOf(delegatedModes)).not.toBe(safetyOf(softwareOwnerModes));
    deps.seed(CLAUDE_FILE, claudeFileText(config, delegatedModes));
    deps.files.delete(STORE);
    const output = await succeeded(deps);
    expect(output.json).toMatchObject({ started: true });
    // Only the safety block is rendered again; the role block is the business of upgrade.
    expect(deps.files.get(CLAUDE_FILE)).toContain(safetyOf(softwareOwnerModes));
    expect(deps.files.get(CLAUDE_FILE)).not.toContain(safetyOf(delegatedModes));
    expect(deps.warned).toContain(RENDERED_NOTICE);
  });

  it('renders the block again, with a notice, when the package renders another text (TP-77)', async () => {
    const other = renderBlock({ name: 'safety', version: 2, body: 'An older text of the package.' });
    if (!other.ok) throw new Error(other.error.message);
    const { deps } = make({ claudeFile: `${withoutSafety(rendered).trimEnd()}\n\n${other.value}\n` });
    await succeeded(deps);
    expect(deps.files.get(CLAUDE_FILE)).toContain('Never skip permissions');
    expect(deps.files.get(CLAUDE_FILE)).not.toContain('An older text of the package.');
    expect(deps.warned).toContain(RENDERED_NOTICE);
  });

  it('writes nothing in a dry run, and reports that a real run renders the block again', async () => {
    const config = withPrefix('[From {owner}, sent by {node}, {date}]');
    const { deps } = make({ config, claudeFile: claudeFileText(sampleConfig()) });
    const before = deps.files.get(CLAUDE_FILE);
    const output = await succeeded(deps, { dryRun: true });
    expect(deps.files.get(CLAUDE_FILE)).toBe(before);
    expect(deps.atomicWrites).toEqual([]);
    expect(output.warnings).toContain('The block safety in coordinator/CLAUDE.md is out of date. A real run renders it again.');
  });

  it('renders the safety block only: another block that differs stays as it is', async () => {
    const other = renderBlock({ name: 'coordinator', version: 1, body: 'An older coordinator text.' });
    if (!other.ok) throw new Error(other.error.message);
    const claudeFile = `${other.value}\n\n${rendered.slice(rendered.indexOf('<!-- factory:begin safety'))}`;
    const { deps } = make({ claudeFile });
    await succeeded(deps);
    expect(deps.files.get(CLAUDE_FILE)).toBe(claudeFile);
    expect(deps.warned).not.toContain(RENDERED_NOTICE);
  });

  it('stops with a failure, and starts nothing, when the new text can not be written', async () => {
    const config = withPrefix('[From {owner}, sent by {node}, {date}]');
    const { deps, tmux } = make({ config, claudeFile: claudeFileText(sampleConfig()) });
    const result = await startFactory(withFailingWrites(deps, (path) => path === CLAUDE_FILE));
    expect(result.ok).toBe(false);
    expect(tmux.calls.some((call) => call.args[0] === 'new-session')).toBe(false);
  });

  it('exits 4 for a link at coordinator/CLAUDE.md, and reads nothing through it (TP-131)', async () => {
    const error = await stopOf({ links: { [CLAUDE_FILE]: '/outside/CLAUDE.md' } });
    expect(error.message).toBe('coordinator/CLAUDE.md is a link, so factory does not use it');
    expect(error.hint).toContain('Replace the link with a plain file');
  });

  it('exits 4 for a link at the coordinator folder (TP-131)', async () => {
    const error = await stopOf({ links: { [COORDINATOR]: '/outside' } });
    expect(error.message).toBe('coordinator is a link, so factory does not use it');
  });

  it('does not write through a link when the text differs', async () => {
    const config = withPrefix('[From {owner}, sent by {node}, {date}]');
    const { deps } = make({ config, claudeFile: claudeFileText(sampleConfig()), links: { [CLAUDE_FILE]: '/outside/CLAUDE.md' } });
    const result = await startFactory(deps);
    expect(result.ok).toBe(false);
    expect(deps.files.has('/outside/CLAUDE.md')).toBe(false);
  });
});
