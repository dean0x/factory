import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { runUp, type UpOptions } from '../../src/commands/up.js';
import { renderConfig } from '../../src/config/render.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { createFakeDeps, type FakeDeps, type FetchHandler } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { tmuxHandler, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const PROXY_URL = 'http://127.0.0.1:8080/secret-path';
const LAUNCH_BASE = [
  'env',
  '-u',
  'ANTHROPIC_BASE_URL',
  'FACTORY_HOME=/w/node',
  'FACTORY_SESSION=demo',
  'claude',
  '--permission-mode',
  'auto',
  '--effort',
  'high',
];

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
}

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
  const tty = setup.tty ?? false;
  const deps = createFakeDeps({
    cwd: '/w',
    env: { PATH: '/bin', ...setup.env },
    run: handler,
    stdinIsTTY: tty,
    stdoutIsTTY: setup.stdoutTty ?? tty,
    ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  for (const tool of setup.tools ?? ['tmux', 'claude']) deps.seed(`/bin/${tool}`, '');
  deps.seed(`${HOME}/factory.yaml`, renderConfig(setup.config ?? sampleConfig()));
  return { deps, tmux: log };
};

const up = async (deps: FakeDeps, options: Partial<UpOptions> = {}) => runUp(deps, { home: HOME, dryRun: false, ...options });

const succeeded = async (deps: FakeDeps, options: Partial<UpOptions> = {}) => {
  const result = await up(deps, options);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const answers: FetchHandler = () => ok({ status: 200 });
const silent: FetchHandler = () => failure('no answer');

describe('up: a new session', () => {
  it('runs the tmux calls in order, with the launch of the coordinator in the first one', async () => {
    const { deps, tmux } = make();
    await succeeded(deps);
    expect(tmux.commands()).toEqual([
      '-V',
      'has-session -t =demo',
      `new-session -d -s demo -n view -c /w/node -- ${[...LAUNCH_BASE, '--add-dir', '/w/web'].join(' ')}`,
      'set-option -w -t =demo:view remain-on-exit on',
      'set-option -p -t =demo:view.{left} @node demo',
      'set-option -t =demo: @factory_home /w/node',
      'split-window -d -h -t =demo:view -c /w/node',
      'set-option -p -t =demo:view.{right} @slot board',
      'new-window -d -t =demo: -n bench -c /w/node',
    ]);
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
    expect(output.json).toEqual({ schema: 'factory.up/v1', session: 'demo', started: true, attached: false, proxy: null });
    expect(output.failed).toBe(false);
  });

  it('adds one --add-dir for each project, with the absolute path', async () => {
    const config = sampleConfig();
    const second = { ...config.recipe.projects[0]!, id: 'api', path: '../api' };
    const { deps, tmux } = make({ config: { ...config, recipe: { ...config.recipe, projects: [...config.recipe.projects, second] } } });
    await succeeded(deps);
    const launch = tmux.calls.find((call) => call.args[0] === 'new-session')?.args ?? [];
    expect(launch.slice(launch.indexOf('--add-dir'))).toEqual(['--add-dir', '/w/web', '--add-dir', '/w/api']);
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

describe('up: attach', () => {
  it('attaches with the terminal when a person types and reads, outside tmux', async () => {
    const { deps, tmux } = make({ tty: true });
    const output = await succeeded(deps);
    expect(deps.attached).toEqual([{ command: 'tmux', args: ['attach', '-t', '=demo'], cwd: undefined }]);
    expect(tmux.commands().some((line) => line.startsWith('switch-client'))).toBe(false);
    expect(output.json).toMatchObject({ started: true, attached: true });
  });

  it('switches the tmux client when it runs inside tmux', async () => {
    const { deps, tmux } = make({ tty: true, env: { TMUX: '/private/tmp/tmux-1/default,1,0' } });
    const output = await succeeded(deps);
    expect(deps.attached).toEqual([]);
    expect(tmux.commands().at(-1)).toBe('switch-client -t =demo');
    expect(output.json).toMatchObject({ attached: true });
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
    const result = await runUp(broken, { home: HOME, dryRun: false });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('attach ended with exit code 1');
  });
});

describe('up: a session that runs already', () => {
  it('starts nothing for a session of this home, and attaches', async () => {
    const { deps, tmux } = make({ tty: true, tmux: { sessions: { demo: HOME } } });
    const output = await succeeded(deps);
    expect(tmux.commands()).toEqual(['-V', 'has-session -t =demo', 'show-options -q -v -t =demo: @factory_home']);
    expect(deps.attached).toHaveLength(1);
    expect(output.json).toMatchObject({ started: false, attached: true });
    expect(output.lines.map((line) => line.text).join('\n')).not.toContain('Started');
  });

  it('prints how to attach when nobody types', async () => {
    const { deps } = make({ tmux: { sessions: { demo: HOME } } });
    const output = await succeeded(deps);
    expect(output.lines).toEqual([{ level: 'text', text: 'Session demo runs. Attach with: tmux attach -t demo' }]);
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
    const result = await up(deps);
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

describe('up: the proxy', () => {
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
    const result = await up(deps);
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

describe('up: the tools', () => {
  it('names tmux when it is not on PATH, and starts no tmux call', async () => {
    const { deps, tmux } = make({ tools: ['claude'] });
    const result = await up(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('tmux is not on PATH');
    expect(tmux.calls).toEqual([]);
  });

  it('names claude when it is not on PATH', async () => {
    const { deps } = make({ tools: ['tmux'] });
    const result = await up(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('claude is not on PATH');
  });

  it('names both when both are missing', async () => {
    const { deps } = make({ tools: [] });
    const result = await up(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('tmux is not on PATH');
      expect(result.error.message).toContain('claude is not on PATH');
    }
  });

  it.each([['tmux 2.9a'], ['tmux 1.8'], ['tmux 2.99']])('refuses %s as too old', async (version) => {
    const { deps, tmux } = make({ tmux: { version } });
    const result = await up(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('too old');
    expect(tmux.commands()).toEqual(['-V']);
  });

  it('refuses a tmux whose version it cannot read', async () => {
    const { deps } = make({ tmux: { version: 'tmux master' } });
    const result = await up(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cannot read the version of tmux');
  });
});

describe('up: a step that fails', () => {
  it('removes the session that it made, and says so', async () => {
    const { deps, tmux } = make({ tmux: { failing: 'split-window' } });
    const result = await up(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe('tmux split-window failed (exit code 1): split-window failed. The session demo was removed.');
    }
    expect(tmux.commands().at(-1)).toBe('kill-session -t =demo');
    expect(tmux.sessions().has('demo')).toBe(false);
  });

  it('removes nothing when the first step fails, because no session exists', async () => {
    const { deps, tmux } = make({ tmux: { failing: 'new-session' } });
    const result = await up(deps);
    expect(result.ok).toBe(false);
    expect(tmux.commands().some((line) => line.startsWith('kill-session'))).toBe(false);
  });

  it('tells the person how to remove the session when the removal fails too', async () => {
    const { deps } = make({ tmux: { failing: 'set-option' } });
    const broken = {
      ...deps,
      run: async (command: string, args: readonly string[], runOptions?: Parameters<typeof deps.run>[2]) =>
        args[0] === 'kill-session' ? failure('cannot run tmux: EPERM') : deps.run(command, args, runOptions),
    };
    const result = await runUp(broken, { home: HOME, dryRun: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('remove it with "tmux kill-session -t =demo"');
  });
});

describe('up: --dry-run', () => {
  it('runs only has-session from tmux, and starts nothing', async () => {
    const { deps, tmux } = make();
    const output = await succeeded(deps, { dryRun: true });
    expect(tmux.commands()).toEqual(['has-session -t =demo']);
    expect(tmux.sessions().size).toBe(0);
    const text = output.lines.map((line) => line.text).join('\n');
    expect(text).toContain('Dry run');
    expect(text).toContain(`tmux new-session -d -s demo -n view -c /w/node -- ${[...LAUNCH_BASE, '--add-dir', '/w/web'].join(' ')}`);
    expect(text).toContain('tmux new-window -d -t =demo: -n bench -c /w/node');
    expect(output.json).toMatchObject({ schema: 'factory.up/v1', session: 'demo', started: false, attached: false, dryRun: true });
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
    const result = await up(deps, { dryRun: true });
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

describe('up: the home and the config', () => {
  it('fails when the config is missing or invalid', async () => {
    const { deps } = make();
    deps.files.delete(`${HOME}/factory.yaml`);
    expect(await up(deps)).toMatchObject({ ok: false, error: { kind: 'failure' } });
    deps.files.set(`${HOME}/factory.yaml`, 'schema: 2\n');
    expect(await up(deps)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('fails when the home is not a folder', async () => {
    const { deps } = make();
    deps.seed('/w/file', 'x');
    const result = await up(deps, { home: '/w/file' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toBe('/w/file is not a folder');
  });

  it('finds the home from FACTORY_HOME', async () => {
    const { deps } = make({ env: { FACTORY_HOME: HOME } });
    const result = await runUp(deps, { home: undefined, dryRun: true });
    expect(result.ok).toBe(true);
  });
});
