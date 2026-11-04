import { describe, expect, it } from 'vitest';
import {
  isPaneId,
  killPaneArgs,
  newWindowArgs,
  paneListArgs,
  parsePaneList,
  runShellBackgroundArgs,
  setPaneOptionArgs,
  splitWorkerPaneArgs,
  startSteps,
  swapPaneArgs,
  type TmuxArgs,
} from '../../src/launch/tmux.js';
import type { Result } from '../../src/core/result.js';

const argvOf = (result: Result<TmuxArgs, string>): TmuxArgs => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const badPaneIds = ['', '12', '%', '%1a', '%12;', '=demo', '%-1', ' %1', '%1\n', '%1 %2', '$(id)', '{left}', '%１'];

describe('the pane id check', () => {
  it('accepts a percent sign and digits only', () => {
    expect(isPaneId('%0')).toBe(true);
    expect(isPaneId('%12')).toBe(true);
  });

  it.each(badPaneIds)('refuses %j', (text) => {
    expect(isPaneId(text)).toBe(false);
  });
});

describe('the tmux call that lists the panes', () => {
  it('lists every pane of the session, with a separator that no valid field holds', () => {
    expect(paneListArgs('demo')).toEqual([
      'list-panes',
      '-s',
      '-t',
      '=demo:',
      '-F',
      '#{pane_id}|#{pane_pid}|#{pane_dead}|#{@worker}',
    ]);
  });
});

describe('the tmux call that ends a pane', () => {
  it('names the pane by its id', () => {
    expect(argvOf(killPaneArgs('%12'))).toEqual(['kill-pane', '-t', '%12']);
  });

  it.each(badPaneIds)('refuses the target %j', (target) => {
    expect(killPaneArgs(target).ok).toBe(false);
  });
});

describe('the tmux call that starts a worker pane', () => {
  it('splits the workers window, starts in the folder, and prints the id of the new pane', () => {
    expect(
      argvOf(splitWorkerPaneArgs({ id: 'demo', cwd: '/w/node/work-copies/a', command: ['env', 'claude', '--add-dir', '/w/web'] })),
    ).toEqual([
      'split-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      '=demo:workers',
      '-c',
      '/w/node/work-copies/a',
      '--',
      'env',
      'claude',
      '--add-dir',
      '/w/web',
    ]);
  });

  it('keeps a folder or an argument that ends in a semicolon as one word', () => {
    const argv = argvOf(splitWorkerPaneArgs({ id: 'demo', cwd: '/w/a;', command: ['claude', '/w/b;'] }));
    expect(argv).toContain('/w/a\\;');
    expect(argv.at(-1)).toBe('/w/b\\;');
    expect(argv).not.toContain(';');
  });

  it('refuses an empty command, because tmux would start a shell and no worker', () => {
    expect(splitWorkerPaneArgs({ id: 'demo', cwd: '/w/a', command: [] }).ok).toBe(false);
  });
});

describe('the tmux call that sets a pane option', () => {
  it('sets the option on the pane by its id', () => {
    expect(argvOf(setPaneOptionArgs('%7', '@worker', 'alpha'))).toEqual(['set-option', '-p', '-t', '%7', '@worker', 'alpha']);
  });

  it('keeps a value that ends in a semicolon as one word, and a value that starts with a dash as a value', () => {
    expect(argvOf(setPaneOptionArgs('%7', '@slot', 'a;')).at(-1)).toBe('a\\;');
    expect(argvOf(setPaneOptionArgs('%7', '@slot', '-x')).slice(-2)).toEqual(['@slot', '-x']);
  });

  it.each(badPaneIds)('refuses the target %j', (target) => {
    expect(setPaneOptionArgs(target, '@worker', 'alpha').ok).toBe(false);
  });

  it.each(['remain-on-exit', '-g', '@', '@Worker', '@a b', '@a;', '', '@1x'])('refuses the option name %j', (name) => {
    expect(setPaneOptionArgs('%7', name, 'on').ok).toBe(false);
  });
});

describe('the tmux call that swaps two panes', () => {
  it('names both panes by their ids', () => {
    expect(argvOf(swapPaneArgs('%3', '%9'))).toEqual(['swap-pane', '-s', '%3', '-t', '%9']);
  });

  it.each(badPaneIds)('refuses the source %j', (source) => {
    expect(swapPaneArgs(source, '%9').ok).toBe(false);
  });

  it.each(badPaneIds)('refuses the target %j', (target) => {
    expect(swapPaneArgs('%3', target).ok).toBe(false);
  });
});

describe('the tmux call that runs a command in the background', () => {
  it('gives the text as one word', () => {
    expect(argvOf(runShellBackgroundArgs('sleep 900 && tmux swap-pane -s %3 -t %9'))).toEqual([
      'run-shell',
      '-b',
      'sleep 900 && tmux swap-pane -s %3 -t %9',
    ]);
  });

  it('keeps a text that ends in a semicolon as one word', () => {
    expect(argvOf(runShellBackgroundArgs('sleep 1;')).at(-1)).toBe('sleep 1\\;');
  });

  it.each(['', 'a\nb', 'a\u0000b', 'a\rb', 'x'.repeat(1025)])('refuses the text %j', (text) => {
    expect(runShellBackgroundArgs(text).ok).toBe(false);
  });
});

describe('the tmux call that makes a window', () => {
  it('makes the window in the background, in the folder', () => {
    expect(newWindowArgs('demo', 'workers', '/w/node/coordinator')).toEqual([
      'new-window',
      '-d',
      '-t',
      '=demo:',
      '-n',
      'workers',
      '-c',
      '/w/node/coordinator',
    ]);
  });

  it('is the call that the start steps use for the workers window', () => {
    const steps = startSteps({ id: 'demo', home: '/w/node', coordinatorDir: '/w/node/coordinator', launch: ['claude'] });
    expect(steps.at(-1)).toEqual(newWindowArgs('demo', 'workers', '/w/node/coordinator'));
  });
});

describe('the pane list', () => {
  it('reads one row for each line', () => {
    const rows = parsePaneList('%0|4101|0|\n%1|4102|0|\n%5|4210|1|alpha\n');
    expect(rows).toEqual({
      ok: true,
      value: [
        { paneId: '%0', pid: 4101, dead: false, worker: null },
        { paneId: '%1', pid: 4102, dead: false, worker: null },
        { paneId: '%5', pid: 4210, dead: true, worker: 'alpha' },
      ],
    });
  });

  it('reads a list with no final newline, and an empty list', () => {
    expect(parsePaneList('%5|4210|0|a-1.b_2')).toEqual({
      ok: true,
      value: [{ paneId: '%5', pid: 4210, dead: false, worker: 'a-1.b_2' }],
    });
    expect(parsePaneList('')).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['too few fields', '%0|4101|0'],
    ['too many fields', '%0|4101|0|a|b'],
    ['no pane id', '|4101|0|a'],
    ['a pane id with no percent sign', '0|4101|0|a'],
    ['a pane id with a letter', '%x|4101|0|a'],
    ['a pid with a letter', '%0|41a1|0|a'],
    ['a negative pid', '%0|-5|0|a'],
    ['an empty pid', '%0||0|a'],
    ['a pid of 0, which names a process group', '%0|0|0|a'],
    ['a pid with a leading zero', '%0|0412|0|a'],
    ['a pid that is too long', '%0|12345678901|0|a'],
    ['a dead flag of 2', '%0|4101|2|a'],
    ['an empty dead flag', '%0|4101||a'],
    ['a worker with a space', '%0|4101|0|a b'],
    ['a worker that starts with a dash', '%0|4101|0|-a'],
    ['a worker that is too long', `%0|4101|0|${'a'.repeat(101)}`],
    ['a carriage return', '%0|4101|0|a\r'],
    ['a worker with a shell character', '%0|4101|0|a$(x)'],
  ])('refuses %s', (_name, line) => {
    expect(parsePaneList(line).ok).toBe(false);
  });

  it('refuses the whole list when one line is malformed, and names the line number but not the text', () => {
    const result = parsePaneList('%0|4101|0|\n%1|4102|0|secret value\n%2|4103|0|\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('line 2');
      expect(result.error).not.toContain('secret');
    }
  });

  it('refuses an empty line inside the list', () => {
    const result = parsePaneList('%0|4101|0|\n\n%1|4102|0|\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('line 2');
  });
});
