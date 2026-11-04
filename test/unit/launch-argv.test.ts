import { describe, expect, it } from 'vitest';
import { launchArgv, stripScript, workerLaunchArgv, type LaunchInput, type WorkerLaunchInput } from '../../src/launch/argv.js';
import { startSteps } from '../../src/launch/tmux.js';
import { env } from '../../src/names.js';
import { chainOf } from '../helpers/tmux-fake.js';

/** The variables that a parent Claude Code session sets. The names are written out here, so a test pins them. */
const PARENT_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
];

/** The words in front of `env`: the shell, the fixed strip text and its fixed name. */
const STRIP = ['/bin/sh', '-c', stripScript, 'factory-launch'];

/** The `env` words that remove the proxy variable. The strip text removes the variables of a parent session before `env` runs. */
const CLEARED = ['-u', 'ANTHROPIC_BASE_URL'];

/** The start of every argument list: the strip words, then `env` and its words that clear the proxy variable. */
const HEAD = [...STRIP, 'env', ...CLEARED];

const SESSION_ID = '0b9f3c1e-5d2a-4e7b-9c10-a1b2c3d4e5f6';

const input = (change: Partial<LaunchInput> = {}): LaunchInput => ({
  home: '/w/demo-factory',
  coordinatorDir: '/w/demo-factory/coordinator',
  stateDir: '/w/demo-factory/.factory',
  sessionId: 'demo',
  effort: 'high',
  model: 'default',
  proxyBaseUrl: null,
  path: null,
  agent: 'claude',
  projects: ['/w/web'],
  ...change,
});

const argvOf = (change: Partial<LaunchInput> = {}): readonly string[] => {
  const result = launchArgv(input(change));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const workerInput = (change: Partial<WorkerLaunchInput> = {}): WorkerLaunchInput => ({
  home: '/w/demo-factory',
  workerId: 'web-search',
  effort: 'high',
  model: 'default',
  proxyBaseUrl: null,
  path: null,
  agent: 'claude',
  ...change,
});

const workerArgvOf = (change: Partial<WorkerLaunchInput> = {}): readonly string[] => {
  const result = workerLaunchArgv(workerInput(change));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const addDirsOf = (argv: readonly string[]): readonly (string | undefined)[] =>
  argv.flatMap((arg, index) => (arg === '--add-dir' ? [argv[index + 1]] : []));

describe('launch argument list', () => {
  it('strips the variables of a parent session, clears the proxy variable, sets the two variables, and starts claude in auto mode', () => {
    expect(argvOf()).toEqual([
      ...HEAD,
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
    expect(argv.slice(0, HEAD.length + 2)).toEqual([
      ...HEAD,
      'ANTHROPIC_BASE_URL=http://127.0.0.1:8080',
      'FACTORY_HOME=/w/demo-factory',
    ]);
  });

  it('sets PATH after it clears the proxy variable, and before claude, when it has a PATH', () => {
    const argv = argvOf({ path: '/opt/claude/bin:/usr/bin', proxyBaseUrl: 'http://127.0.0.1:8080' });
    expect(argv.slice(0, HEAD.length + 5)).toEqual([
      ...HEAD,
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

  it('never holds a flag other than the five of the launch, whatever the input is', () => {
    const known = ['--permission-mode', '--effort', '--model', '--resume', '--add-dir'];
    const hostile = ['--dangerously-skip-permissions', '--permission-mode=bypassPermissions', 'bypassPermissions'];
    for (const value of hostile) {
      const changes = [{ model: value }, { effort: value }, { projects: [value] }, { home: value }, { path: value }, { agent: value }, { resumeId: value }];
      for (const change of changes) {
        const result = launchArgv(input(change));
        if (result.ok) {
          expect(result.value.filter((arg) => arg.startsWith('-') && !known.includes(arg) && arg !== '-u' && arg !== '-c')).toEqual([]);
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

  it('starts the program of the agent input, and no other program', () => {
    const argv = argvOf({ agent: 'other-agent' });
    expect(argv).toContain('other-agent');
    expect(argv).not.toContain('claude');
  });

  it.each([
    ['an empty program name', ''],
    ['a program name with a leading dash', '-claude'],
    ['a program name that reads as an assignment', 'A=claude'],
    ['a program name with a path', '/usr/bin/claude'],
    ['a program name with a space', 'claude --dangerously-skip-permissions'],
  ])('refuses %s', (_name, agent) => {
    expect(launchArgv(input({ agent })).ok).toBe(false);
  });
});

describe('the variables of a parent session', () => {
  it('strips them in the coordinator launch before env runs, with the fixed strip text (TP-10)', () => {
    const argv = argvOf();
    expect(argv.slice(0, HEAD.length)).toEqual(HEAD);
    for (const name of PARENT_VARIABLES) expect(argv).not.toContain(name);
  });

  it('strips them in the worker launch before env runs, with the fixed strip text (TP-10)', () => {
    const argv = workerArgvOf();
    expect(argv.slice(0, HEAD.length)).toEqual(HEAD);
    for (const name of PARENT_VARIABLES) expect(argv).not.toContain(name);
  });

  it('names no variable in the argument list: the strip text removes every name that starts with CLAUDE', () => {
    for (const argv of [argvOf(), workerArgvOf()]) {
      expect(argv.filter((word) => word !== stripScript && /CLAUDE/.test(word))).toEqual([]);
      expect(argv.filter((arg, index) => arg === '-u' && argv[index + 1] !== 'ANTHROPIC_BASE_URL')).toEqual([]);
    }
  });

  it('sets none of them again: no word of the launch starts with one of the names and an equal sign', () => {
    for (const argv of [argvOf({ proxyBaseUrl: 'http://127.0.0.1:1', path: '/bin' }), workerArgvOf({ proxyBaseUrl: 'http://127.0.0.1:1' })]) {
      expect(argv.filter((word) => PARENT_VARIABLES.some((name) => word.startsWith(`${name}=`)))).toEqual([]);
    }
  });
});

describe('the resume id of the coordinator launch (TP-11)', () => {
  it('adds --resume and the id once, before the folders, when the id is a UUID', () => {
    const argv = argvOf({ resumeId: SESSION_ID });
    expect(argv.filter((arg) => arg === '--resume')).toHaveLength(1);
    expect(argv[argv.indexOf('--resume') + 1]).toBe(SESSION_ID);
    expect(argv.indexOf('--resume')).toBeLessThan(argv.indexOf('--add-dir'));
  });

  it('adds no --resume for a new session', () => {
    expect(argvOf()).not.toContain('--resume');
  });

  it.each([
    ['text that is not a UUID', 'latest'],
    ['an empty id', ''],
    ['a UUID with upper case letters', SESSION_ID.toUpperCase()],
    ['a UUID with a space after it', `${SESSION_ID} `],
    ['a UUID with a flag after it', `${SESSION_ID} --dangerously-skip-permissions`],
    ['a flag', '--dangerously-skip-permissions'],
    ['a UUID with a line break', `${SESSION_ID}\n`],
    ['a UUID that is too short', SESSION_ID.slice(0, -1)],
  ])('refuses %s', (_name, resumeId) => {
    expect(launchArgv(input({ resumeId })).ok).toBe(false);
  });

  it('does not repeat a refused id in the error', () => {
    const result = launchArgv(input({ resumeId: 'secret-id-value' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret-id-value');
  });
});

describe('the worker launch argument list (TP-10)', () => {
  const INBOX = '/w/demo-factory/.factory/workers/web-search/inbox';

  it('strips the variables, clears the proxy variable, sets the three variables, and starts the agent in auto mode with the inbox folder', () => {
    expect(workerArgvOf()).toEqual([
      ...HEAD,
      'FACTORY_HOME=/w/demo-factory',
      'FACTORY_SESSION=web-search',
      `FACTORY_INBOX=${INBOX}`,
      'claude',
      '--permission-mode',
      'auto',
      '--effort',
      'high',
      '--add-dir',
      INBOX,
    ]);
  });

  it('adds exactly one --add-dir: the inbox of the worker, and no project folder, no state folder and no home', () => {
    const argv = workerArgvOf({ model: 'opus', proxyBaseUrl: 'http://127.0.0.1:8080', path: '/bin' });
    expect(addDirsOf(argv)).toEqual([INBOX]);
  });

  it('sets the session variable to the id of the worker', () => {
    expect(workerArgvOf({ workerId: 'api-fix' })).toContain('FACTORY_SESSION=api-fix');
  });

  it('starts the program of the agent input, and no other program', () => {
    const argv = workerArgvOf({ agent: 'other-agent' });
    expect(argv).toContain('other-agent');
    expect(argv).not.toContain('claude');
  });

  it('always sets the permission mode to auto, and only once', () => {
    const argv = workerArgvOf({ model: 'opus', resumeId: SESSION_ID });
    expect(argv.filter((arg) => arg === '--permission-mode')).toHaveLength(1);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto');
  });

  it('sets the proxy variable after it clears it, and PATH after the proxy variable, when it has them', () => {
    const argv = workerArgvOf({ proxyBaseUrl: 'http://127.0.0.1:8080', path: '/opt/bin:/usr/bin' });
    expect(argv.slice(HEAD.length, HEAD.length + 3)).toEqual([
      'ANTHROPIC_BASE_URL=http://127.0.0.1:8080',
      'PATH=/opt/bin:/usr/bin',
      'FACTORY_HOME=/w/demo-factory',
    ]);
  });

  it('adds --model only when the model is not the default', () => {
    expect(workerArgvOf()).not.toContain('--model');
    const argv = workerArgvOf({ model: 'opus' });
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(argv.indexOf('--model')).toBeGreaterThan(argv.indexOf('--effort'));
    expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('--add-dir'));
  });

  it('adds --resume and the id once, before the inbox folder, when the id is a UUID', () => {
    const argv = workerArgvOf({ resumeId: SESSION_ID });
    expect(argv.filter((arg) => arg === '--resume')).toHaveLength(1);
    expect(argv[argv.indexOf('--resume') + 1]).toBe(SESSION_ID);
    expect(argv.indexOf('--resume')).toBeLessThan(argv.indexOf('--add-dir'));
  });

  it('adds no --resume for a new worker', () => {
    expect(workerArgvOf()).not.toContain('--resume');
  });

  it('keeps a home with spaces or shell characters as one argument', () => {
    const argv = workerArgvOf({ home: '/w/my factory;$(x)' });
    expect(argv).toContain('FACTORY_HOME=/w/my factory;$(x)');
    expect(argv).toContain('FACTORY_INBOX=/w/my factory;$(x)/.factory/workers/web-search/inbox');
    expect(addDirsOf(argv)).toEqual(['/w/my factory;$(x)/.factory/workers/web-search/inbox']);
  });

  it.each([
    ['a resume id that is not a UUID (TP-11)', { resumeId: 'latest' }],
    ['a resume id with upper case letters (TP-11)', { resumeId: SESSION_ID.toUpperCase() }],
    ['a resume id that is a flag (TP-11)', { resumeId: '--dangerously-skip-permissions' }],
    ['an empty resume id (TP-11)', { resumeId: '' }],
    ['a relative home', { home: 'demo-factory' }],
    ['a worker id that is a path', { workerId: '../web' }],
    ['a worker id that starts with a dash', { workerId: '-x' }],
    ['a worker id with upper case letters', { workerId: 'Web' }],
    ['an empty worker id', { workerId: '' }],
    ['an effort that is not one of the words', { effort: '--dangerously-skip-permissions' }],
    ['a model that starts with a dash', { model: '--dangerously-skip-permissions' }],
    ['an empty PATH', { path: '' }],
    ['a program name with a leading dash', { agent: '-claude' }],
  ])('refuses %s', (_name, change) => {
    expect(workerLaunchArgv(workerInput(change)).ok).toBe(false);
  });

  it('does not repeat a refused value in the error', () => {
    for (const change of [{ resumeId: 'secret-id-value' }, { workerId: 'Secret/Worker' }, { model: '--secret-flag-value' }]) {
      const result = workerLaunchArgv(workerInput(change));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toMatch(/secret/i);
    }
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
