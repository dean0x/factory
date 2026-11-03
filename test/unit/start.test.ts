import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { runStart, type StartOptions } from '../../src/commands/start.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { env } from '../../src/names.js';
import { createFakeDeps, exited, registerRoot, type FakeDeps, type FetchHandler, type RunCall } from '../helpers/fake-deps.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { chainOf, tmuxHandler, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const COORDINATOR = '/w/node/coordinator';
const STATE_DIR = '/w/node/.factory';
const PROXY_URL = 'http://127.0.0.1:8080/secret-path';
const REMOVE_PROXY_VARIABLE = 'set-environment -t =demo -r ANTHROPIC_BASE_URL';
const SET_SESSION_MARKER = `set-environment -t =demo ${env.session} demo`;
const KEEP_PANE = 'set-option -w -t =demo:view remain-on-exit on';
const LAUNCH_BASE = [
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
  /** The paths of the project folders that exist in the home. Default: the folder of each project of the config. */
  readonly projectFolders?: readonly string[];
}

/** A fake of git: it knows only the top folder of the work tree. The tmux log does not record its calls. */
const gitAnswer = (workTree: string | undefined) => (call: RunCall) =>
  call.args.includes('--show-toplevel') && workTree !== undefined
    ? exited(0, `${workTree}\n`)
    : exited(128, '', 'fatal: not a git repository\n');

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
  const git = gitAnswer(setup.workTree);
  const tty = setup.tty ?? false;
  const deps = createFakeDeps({
    cwd: setup.cwd ?? '/w',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...setup.env },
    run: (call) => (call.command === 'git' ? git(call) : handler(call)),
    stdinIsTTY: tty,
    stdoutIsTTY: setup.stdoutTty ?? tty,
    ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  for (const tool of setup.tools ?? ['tmux', 'claude']) deps.seed(`/bin/${tool}`, '');
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  if (setup.coordinatorFolder !== false) deps.seedDir(COORDINATOR);
  for (const path of setup.projectFolders ?? config.recipe.projects.map((project) => project.path)) {
    deps.seedDir(`${HOME}/${path}`);
  }
  if (setup.registered !== false) registerRoot(deps, HOME, config.core.node.id);
  return { deps, tmux: log };
};

const startFactory = async (deps: FakeDeps, options: Partial<StartOptions> = {}) =>
  runStart(deps, { home: HOME, dryRun: false, ...options });

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
      `new-window -d -t =demo: -n bench -c ${COORDINATOR}`,
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

  it('stops before any proxy check or tmux call when the coordinator folder is missing', async () => {
    const fetched: string[] = [];
    const { deps, tmux } = make({
      coordinatorFolder: false,
      config: withProxy('stop'),
      fetch: (url) => {
        fetched.push(url);
        return ok({ status: 200 });
      },
    });
    const result = await startFactory(deps);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'failure',
        message: 'the coordinator folder coordinator is missing',
        hint: 'Run "factory upgrade --overwrite coordinator --overwrite safety" to write it.',
      },
    });
    expect(fetched).toEqual([]);
    expect(tmux.commands().some((line) => line.startsWith('new-session'))).toBe(false);
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
    expect(tmux.commands().at(-1)).toBe(`new-window -d -t =demo: -n bench -c ${COORDINATOR}`);
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
    expect(output.json).toEqual({ schema: 'factory.start/v1', session: 'demo', started: true, attached: false, proxy: null });
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
    const result = await runStart(broken, { home: HOME, dryRun: false });
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
  ])('refuses with exit kind safety for a session with %s', async (_name, sessions) => {
    const { deps, tmux } = make({ tmux: { sessions } });
    const result = await startFactory(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) expect(result.error.message).toBe('a tmux session demo belongs to another node home');
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
    const result = await runStart(ended, { home: HOME, dryRun: false });
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
    const result = await runStart(broken, { home: HOME, dryRun: false });
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
    expect(text).toContain(`tmux new-session -d -s demo -n view -c ${COORDINATOR} -- ${[...LAUNCH_BASE, ...LAUNCH_DIRS].join(' ')}`);
    expect(text).toContain(`tmux new-window -d -t =demo: -n bench -c ${COORDINATOR}`);
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
    const result = await runStart(deps, { home: undefined, dryRun: true });
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
    const result = await runStart(deps, { home, dryRun: true });
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
      const result = await runStart(deps, { home: undefined, dryRun });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) {
        expect(result.error.message).toContain(`${HOME}/web/factory.yaml`);
        expect(result.error.hint).toContain(`name it with --home ${HOME}`);
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
    deps.seedDir('/w/other/coordinator');
    deps.seedDir(`${HOME}/deep`);
    deps.seedDir('/w/other/deep');
    const first = await runStart(deps, { home: undefined, dryRun: true });
    expect(first.ok && first.value.json['session']).toBe('demo');
    const second = await runStart({ ...deps, cwd: '/w/other/deep' }, { home: undefined, dryRun: true });
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

  it('takes the proxy of the session from the local file only', async () => {
    const { deps, tmux } = make({ config: withProxy('stop'), fetch: answers });
    await succeeded(deps);
    expect(deps.fetched).toEqual([`${PROXY_URL}/health`]);
    expect(tmux.calls.length).toBeGreaterThan(0);
  });
});
