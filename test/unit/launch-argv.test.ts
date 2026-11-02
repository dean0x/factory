import { describe, expect, it } from 'vitest';
import { launchArgv, type LaunchInput } from '../../src/launch/argv.js';

const input = (change: Partial<LaunchInput> = {}): LaunchInput => ({
  home: '/w/demo-factory',
  sessionId: 'demo',
  effort: 'high',
  model: 'default',
  proxyBaseUrl: null,
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

  it('adds one --add-dir for each project, in the order of the config', () => {
    const argv = argvOf({ projects: ['/w/web', '/w/api', '/srv/docs'] });
    const dirs = argv.flatMap((arg, index) => (arg === '--add-dir' ? [argv[index + 1]] : []));
    expect(dirs).toEqual(['/w/web', '/w/api', '/srv/docs']);
  });

  it('adds no --add-dir for a node without projects', () => {
    expect(argvOf({ projects: [] })).not.toContain('--add-dir');
  });

  it('adds --model only when the model is not the default', () => {
    expect(argvOf()).not.toContain('--model');
    const argv = argvOf({ model: 'opus' });
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(argv.indexOf('--model')).toBeGreaterThan(argv.indexOf('--effort'));
    expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('--add-dir'));
  });

  it('keeps a path with spaces or shell characters as one argument', () => {
    const argv = argvOf({ home: '/w/my factory;$(x)', projects: ['/w/a b'] });
    expect(argv).toContain('FACTORY_HOME=/w/my factory;$(x)');
    expect(argv).toContain('/w/a b');
  });

  it.each([
    ['a relative home', { home: 'demo-factory' }],
    ['a relative project path', { projects: ['../web'] }],
    ['a project path that starts with a dash', { projects: ['-x'] }],
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
      for (const change of [{ model: value }, { effort: value }, { projects: [value] }, { home: value }]) {
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
