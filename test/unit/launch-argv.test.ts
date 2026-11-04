import { describe, expect, it } from 'vitest';
import { launchArgv, type LaunchInput } from '../../src/launch/argv.js';
import { startSteps } from '../../src/launch/tmux.js';
import { env } from '../../src/names.js';
import { chainOf } from '../helpers/tmux-fake.js';

const input = (change: Partial<LaunchInput> = {}): LaunchInput => ({
  home: '/w/demo-factory',
  coordinatorDir: '/w/demo-factory/coordinator',
  stateDir: '/w/demo-factory/.factory',
  sessionId: 'demo',
  effort: 'high',
  model: 'default',
  proxyBaseUrl: null,
  path: null,
  projects: ['/w/web'],
  ...change,
});

const argvOf = (change: Partial<LaunchInput> = {}): readonly string[] => {
  const result = launchArgv(input(change));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe('launch argument list', () => {
  it('clears the proxy variable, sets the two variables, and starts claude in auto mode', () => {
    expect(argvOf()).toEqual([
      'env',
      '-u',
      'ANTHROPIC_BASE_URL',
      'FACTORY_HOME=/w/demo-factory',
      'FACTORY_SESSION=demo',
      'claude',
      '--permission-mode',
      'auto',
      '--effort',
      'high',
      '--add-dir',
      '/w/demo-factory/.factory',
      '--add-dir',
      '/w/web',
    ]);
  });

  it('sets the proxy variable after it clears the variable, when the config names a proxy', () => {
    const argv = argvOf({ proxyBaseUrl: 'http://127.0.0.1:8080' });
    expect(argv.slice(0, 5)).toEqual([
      'env',
      '-u',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_BASE_URL=http://127.0.0.1:8080',
      'FACTORY_HOME=/w/demo-factory',
    ]);
  });

  it('sets PATH after it clears the proxy variable, and before claude, when it has a PATH', () => {
    const argv = argvOf({ path: '/opt/claude/bin:/usr/bin', proxyBaseUrl: 'http://127.0.0.1:8080' });
    expect(argv.slice(0, 8)).toEqual([
      'env',
      '-u',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_BASE_URL=http://127.0.0.1:8080',
      'PATH=/opt/claude/bin:/usr/bin',
      'FACTORY_HOME=/w/demo-factory',
      'FACTORY_SESSION=demo',
      'claude',
    ]);
  });

  it('keeps the PATH as one argument, whatever it holds', () => {
    const argv = argvOf({ path: '/a b:/c;$(x):--dangerously-skip-permissions' });
    expect(argv).toContain('PATH=/a b:/c;$(x):--dangerously-skip-permissions');
    expect(argv.filter((arg) => arg === '--dangerously-skip-permissions')).toEqual([]);
  });

  it('refuses an empty PATH', () => {
    expect(launchArgv(input({ path: '' })).ok).toBe(false);
  });

  it('adds one --add-dir for the state folder, and one for each project in the order of the config', () => {
    const argv = argvOf({ projects: ['/w/web', '/w/api', '/srv/docs'] });
    const dirs = argv.flatMap((arg, index) => (arg === '--add-dir' ? [argv[index + 1]] : []));
    expect(dirs).toEqual(['/w/demo-factory/.factory', '/w/web', '/w/api', '/srv/docs']);
  });

  it('adds only the state folder for a node without projects', () => {
    const argv = argvOf({ projects: [] });
    expect(argv.filter((arg) => arg === '--add-dir')).toHaveLength(1);
    expect(argv).toContain('/w/demo-factory/.factory');
  });

  it('adds no --add-dir for the root, and no one for the coordinator folder', () => {
    const argv = argvOf({ projects: ['/w/demo-factory/web', '/w/api'] });
    const dirs = argv.flatMap((arg, index) => (arg === '--add-dir' ? [argv[index + 1]] : []));
    expect(dirs).not.toContain('/w/demo-factory');
    expect(dirs).not.toContain('/w/demo-factory/coordinator');
    expect(dirs).toEqual(['/w/demo-factory/.factory', '/w/demo-factory/web', '/w/api']);
  });

  it('adds --model only when the model is not the default', () => {
    expect(argvOf()).not.toContain('--model');
    const argv = argvOf({ model: 'opus' });
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(argv.indexOf('--model')).toBeGreaterThan(argv.indexOf('--effort'));
    expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('--add-dir'));
  });

  it('keeps a path with spaces or shell characters as one argument', () => {
    const argv = argvOf({
      home: '/w/my factory;$(x)',
      coordinatorDir: '/w/my factory;$(x)/coordinator',
      stateDir: '/w/my factory;$(x)/.factory',
      projects: ['/w/a b'],
    });
    expect(argv).toContain('FACTORY_HOME=/w/my factory;$(x)');
    expect(argv).toContain('/w/my factory;$(x)/.factory');
    expect(argv).toContain('/w/a b');
  });

  it.each([
    ['a relative home', { home: 'demo-factory' }],
    ['a relative project path', { projects: ['../web'] }],
    ['a project path that starts with a dash', { projects: ['-x'] }],
    ['a project folder that is the home', { projects: ['/w/demo-factory'] }],
    ['a project folder that holds the home', { projects: ['/w'] }],
    ['a relative coordinator folder', { coordinatorDir: 'coordinator' }],
    ['a coordinator folder that is the home', { coordinatorDir: '/w/demo-factory' }],
    ['a coordinator folder outside the home', { coordinatorDir: '/w/other/coordinator' }],
    ['a coordinator folder beside the home with the same start', { coordinatorDir: '/w/demo-factory-x/coordinator' }],
    ['a relative state folder', { stateDir: '.factory' }],
    ['a state folder that is the home', { stateDir: '/w/demo-factory' }],
    ['a state folder outside the home', { stateDir: '/w/other/.factory' }],
    ['an effort that is not one of the words', { effort: '--dangerously-skip-permissions' }],
    ['a model that starts with a dash', { model: '--dangerously-skip-permissions' }],
    ['a model with a space', { model: 'opus --dangerously-skip-permissions' }],
    ['a model with a control character', { model: 'opus\n--x' }],
  ])('refuses %s', (_name, change) => {
    expect(launchArgv(input(change)).ok).toBe(false);
  });

  it('never holds a flag other than the four of the launch, whatever the input is', () => {
    const known = ['--permission-mode', '--effort', '--model', '--add-dir'];
    const hostile = ['--dangerously-skip-permissions', '--permission-mode=bypassPermissions', 'bypassPermissions'];
    for (const value of hostile) {
      for (const change of [{ model: value }, { effort: value }, { projects: [value] }, { home: value }, { path: value }]) {
        const result = launchArgv(input(change));
        if (result.ok) {
          expect(result.value.filter((arg) => arg.startsWith('-') && !known.includes(arg) && arg !== '-u')).toEqual([]);
          expect(result.value.filter((arg) => arg === '--permission-mode')).toHaveLength(1);
        }
      }
    }
  });

  it('always sets the permission mode to auto, and only once', () => {
    const argv = argvOf({ model: 'opus', proxyBaseUrl: 'http://127.0.0.1:1' });
    expect(argv.filter((arg) => arg === '--permission-mode')).toHaveLength(1);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto');
  });

  it('does not repeat a refused value in the error', () => {
    const result = launchArgv(input({ model: '--secret-flag-value' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret-flag-value');
  });
});

describe('the tmux calls that start a session', () => {
  const launch = ['env', 'PATH=/bin:/x;', 'FACTORY_HOME=/w/node;', 'claude', '--add-dir', '/w/web;'];

  it('starts every window in the coordinator folder, and keeps the home in the session option (TP-46)', () => {
    const steps = startSteps({ id: 'demo', home: '/w/node', coordinatorDir: '/w/node/coordinator', launch: ['claude'] });
    const commands = steps.flatMap(chainOf);
    const folders = commands.flatMap((command) => (command.includes('-c') ? [command[command.indexOf('-c') + 1]] : []));
    expect(folders).toEqual(['/w/node/coordinator', '/w/node/coordinator', '/w/node/coordinator']);
    expect(commands[5]).toEqual(['set-option', '-t', '=demo:', '@factory_home', '/w/node']);
    expect(commands[0]).toEqual(['new-session', '-d', '-s', 'demo', '-n', 'view', '-c', '/w/node/coordinator', '--', 'claude']);
  });

  it('puts the session marker in the environment of the session before the second pane and every other window (TP-80)', () => {
    const steps = startSteps({ id: 'demo', home: '/w/node', coordinatorDir: '/w/node/coordinator', launch: ['claude'] });
    const commands = steps.flatMap(chainOf);
    const marker = commands.findIndex((command) => command[0] === 'set-environment' && command.includes(env.session));
    expect(commands[marker]).toEqual(['set-environment', '-t', '=demo', env.session, 'demo']);
    const firstPane = commands.findIndex((command) => command[0] === 'new-session');
    const secondPane = commands.findIndex((command) => command[0] === 'split-window');
    const otherWindow = commands.findIndex((command) => command[0] === 'new-window');
    expect(marker).toBeGreaterThan(firstPane);
    expect(marker).toBeLessThan(secondPane);
    expect(marker).toBeLessThan(otherWindow);
  });

  it('reads a path that ends in a semicolon as one value, and not as the end of a command', () => {
    const steps = startSteps({ id: 'demo', home: '/w/node;', coordinatorDir: '/w/node;/coordinator;', launch });
    const commands = steps.flatMap(chainOf);
    expect(commands.map((command) => command[0])).toEqual([
      'new-session',
      'set-option',
      'set-environment',
      'set-environment',
      'set-option',
      'set-option',
      'split-window',
      'set-option',
      'new-window',
    ]);
    expect(commands[0]).toEqual(['new-session', '-d', '-s', 'demo', '-n', 'view', '-c', '/w/node;/coordinator;', '--', ...launch]);
    expect(commands[5]).toEqual(['set-option', '-t', '=demo:', '@factory_home', '/w/node;']);
    const folders = commands.flatMap((command) => (command.includes('-c') ? [command[command.indexOf('-c') + 1]] : []));
    expect(folders).toEqual(['/w/node;/coordinator;', '/w/node;/coordinator;', '/w/node;/coordinator;']);
  });

  it('keeps a backslash before the last semicolon of a value', () => {
    const steps = startSteps({ id: 'demo', home: '/w/node\;', coordinatorDir: '/w/node\;/coordinator\;', launch: ['claude'] });
    expect(steps.flatMap(chainOf)[0]).toContain('/w/node\;/coordinator\;');
    expect(steps.flatMap(chainOf)).toHaveLength(9);
  });

  it('leaves a word without a final semicolon as it is, with the one separator of the first call', () => {
    const steps = startSteps({
      id: 'demo',
      home: '/w/node',
      coordinatorDir: '/w/node/coordinator',
      launch: ['claude', '--add-dir', '/w/a;b'],
    });
    expect(steps[0]?.filter((word) => word === ';')).toEqual([';']);
    expect(steps[0]).toContain('/w/a;b');
    expect(steps.slice(1).flat().filter((word) => word.includes(';'))).toEqual([]);
  });
});
