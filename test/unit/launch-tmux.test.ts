import { describe, expect, it } from 'vitest';
import {
  isPaneId,
  killPaneArgs,
  newWindowArgs,
  paneListArgs,
  paneReadArgs,
  parsePaneList,
  parsePaneListSoft,
  parseSlotList,
  parseSummonMark,
  runShellBackgroundArgs,
  setPaneOptionArgs,
  slotListArgs,
  splitWorkerPaneArgs,
  startSteps,
  summonMarkText,
  summonTimerArgs,
  swapPaneArgs,
  tileWorkersArgs,
  unsetPaneOptionArgs,
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

describe('the tmux call that reads one pane', () => {
  it('prints the line of the pane, in the format of the list, for the pane id only', () => {
    expect(argvOf(paneReadArgs('%12'))).toEqual([
      'display-message',
      '-p',
      '-t',
      '%12',
      '#{pane_id}|#{pane_pid}|#{pane_dead}|#{@worker}',
    ]);
  });

  it.each(badPaneIds)('refuses the target %j', (target) => {
    expect(paneReadArgs(target).ok).toBe(false);
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

describe('the tmux call that unsets a pane option', () => {
  it('unsets the option of the pane by its id', () => {
    expect(argvOf(unsetPaneOptionArgs('%7', '@slot_summon'))).toEqual(['set-option', '-p', '-u', '-t', '%7', '@slot_summon']);
  });

  it.each(badPaneIds)('refuses the target %j', (target) => {
    expect(unsetPaneOptionArgs(target, '@slot_summon').ok).toBe(false);
  });

  it.each(['remain-on-exit', '-g', '@', '@Worker', '@a b', '', '@1x'])('refuses the option name %j', (name) => {
    expect(unsetPaneOptionArgs('%7', name).ok).toBe(false);
  });
});

describe('the tmux call that swaps two panes', () => {
  it('names both panes by their ids, and keeps the focus where it is (-d)', () => {
    expect(argvOf(swapPaneArgs('%3', '%9'))).toEqual(['swap-pane', '-d', '-s', '%3', '-t', '%9']);
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

describe('the tmux call that tiles the workers window', () => {
  it('names the window by its session and its name', () => {
    expect(tileWorkersArgs('demo')).toEqual(['select-layout', '-t', '=demo:workers', 'tiled']);
  });
});

describe('the tmux call that lists the slot marks', () => {
  it('lists every pane, with the window name last because it is free text', () => {
    expect(slotListArgs('demo')).toEqual([
      'list-panes',
      '-s',
      '-t',
      '=demo:',
      '-F',
      '#{pane_id}|#{@slot}|#{@slot_summon}|#{window_name}',
    ]);
  });
});

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'fedcba9876543210fedcba9876543210';

describe('the slot list', () => {
  it('reads the pane, the window, the board mark and the text of the summon mark of each line', () => {
    expect(parseSlotList(`%4|||view\n%5|board||view\n%6|||workers\n`)).toEqual({
      ok: true,
      value: [
        { paneId: '%4', window: 'view', board: false, summonText: '' },
        { paneId: '%5', window: 'view', board: true, summonText: '' },
        { paneId: '%6', window: 'workers', board: false, summonText: '' },
      ],
    });
  });

  it('keeps the text of the summon mark of the board pane', () => {
    const rows = parseSlotList(`%5|board|%3:${TOKEN}|workers\n`);
    expect(rows.ok && rows.value[0]?.summonText).toBe(`%3:${TOKEN}`);
  });

  it('reads a window name with the separator in it as one name', () => {
    const rows = parseSlotList('%4|||a|b|c\n');
    expect(rows.ok && rows.value[0]?.window).toBe('a|b|c');
  });

  it('reads a pane whose mark is any other text as a pane that is not the board', () => {
    const rows = parseSlotList('%4|bord||view\n%5|BOARD||view\n');
    expect(rows.ok && rows.value.map((row) => row.board)).toEqual([false, false]);
  });

  it('reads an empty text as no pane', () => {
    expect(parseSlotList('')).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['a line with too few fields', '%4||view\n'],
    ['a bad pane id', '4|||view\n'],
    ['a pane id with a letter', '%4a|||view\n'],
    ['an empty line in the list', '%4|||view\n\n%5|||view\n'],
    ['the same pane twice', '%4|||view\n%4|||workers\n'],
  ])('refuses the whole list for %s, and names the line and no text', (_what, text) => {
    const rows = parseSlotList(text);
    expect(rows.ok).toBe(false);
    expect(!rows.ok && rows.error).toMatch(/^line \d+ of the slot list/);
    expect(!rows.ok && rows.error).not.toContain('view');
  });
});

describe('the summon mark', () => {
  it('is the pane id, a colon and the token', () => {
    expect(summonMarkText('%3', TOKEN)).toEqual({ ok: true, value: `%3:${TOKEN}` });
  });

  it.each(badPaneIds)('refuses the pane %j', (pane) => {
    expect(summonMarkText(pane, TOKEN).ok).toBe(false);
  });

  it.each(['', 'abc', TOKEN.toUpperCase(), `${TOKEN}0`, TOKEN.slice(1), `${TOKEN.slice(1)}g`, `${TOKEN.slice(1)};`, ` ${TOKEN.slice(1)}`])(
    'refuses the token %j',
    (token) => {
      expect(summonMarkText('%3', token).ok).toBe(false);
    },
  );

  it('reads the mark back, and reads an empty text as no mark', () => {
    expect(parseSummonMark(`%3:${TOKEN}`)).toEqual({ ok: true, value: { pane: '%3', token: TOKEN } });
    expect(parseSummonMark('')).toEqual({ ok: true, value: null });
  });

  it.each(['%3', `3:${TOKEN}`, `%3:${TOKEN.toUpperCase()}`, `%3:${TOKEN}\n`, `%3:${TOKEN}:%4`, `%3: ${TOKEN}`, 'board'])(
    'refuses to read the text %j',
    (text) => {
      expect(parseSummonMark(text).ok).toBe(false);
    },
  );
});

describe('the tmux call that swaps the pane back after a time', () => {
  const input = { seconds: 900, board: '%5', pane: '%3', token: TOKEN };
  const TEXT =
    `sleep 900; tmux if-shell -F -t %5 '##{==:##{@slot_summon},%3:${TOKEN}}' ` +
    `'swap-pane -d -s %3 -t %5 ; set-option -p -u -t %5 @slot_summon'`;

  it('runs one shell text in the background: the wait, then a tmux command that checks the token', () => {
    expect(argvOf(summonTimerArgs(input))).toEqual(['run-shell', '-b', TEXT]);
  });

  it('escapes every hash sign, because run-shell expands the formats of its text before the shell runs it', () => {
    const text = argvOf(summonTimerArgs(input)).at(-1) ?? '';
    // Every hash sign is one half of the pair `##`, which run-shell turns into one hash sign. So no format is expanded at the
    // start of the timer, and if-shell reads the summon mark of the board pane at the end of the wait.
    expect(text.replaceAll('##', '')).not.toContain('#');
  });

  it('holds only digits, the token, pane ids and the fixed words of the restore', () => {
    const text = argvOf(summonTimerArgs(input)).at(-1) ?? '';
    expect(text).toMatch(/^[A-Za-z0-9 %#{}=:,@;'_-]+$/);
    // Take out every variable part: the digits of the wait, the token and the pane ids. Only the fixed words stay.
    const fixed = text.replace(TOKEN, 'TOKEN').replace(/%[0-9]+/g, 'PANE').replace(/^sleep [0-9]+/, 'sleep SECONDS');
    expect(fixed).toBe(
      "sleep SECONDS; tmux if-shell -F -t PANE '##{==:##{@slot_summon},PANE:TOKEN}' 'swap-pane -d -s PANE -t PANE ; set-option -p -u -t PANE @slot_summon'",
    );
  });

  it('takes the wait in seconds at the bounds of a summon, 1 second to 2 hours', () => {
    expect(argvOf(summonTimerArgs({ ...input, seconds: 1 })).at(-1)).toContain('sleep 1;');
    expect(argvOf(summonTimerArgs({ ...input, seconds: 7200 })).at(-1)).toContain('sleep 7200;');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 7201, 86_400])('refuses the wait %s', (seconds) => {
    expect(summonTimerArgs({ ...input, seconds }).ok).toBe(false);
  });

  it.each(badPaneIds)('refuses the board pane %j', (board) => {
    expect(summonTimerArgs({ ...input, board }).ok).toBe(false);
  });

  it.each(badPaneIds)('refuses the summoned pane %j', (pane) => {
    expect(summonTimerArgs({ ...input, pane }).ok).toBe(false);
  });

  it.each(['', TOKEN.toUpperCase(), `${TOKEN}0`, `${TOKEN.slice(1)}'`, `${TOKEN.slice(2)}; id`, `${TOKEN.slice(2)}$(`])(
    'refuses the token %j',
    (token) => {
      expect(summonTimerArgs({ ...input, token }).ok).toBe(false);
    },
  );

  it('gives a text with another token for another token', () => {
    expect(argvOf(summonTimerArgs({ ...input, token: OTHER_TOKEN })).at(-1)).toContain(`%3:${OTHER_TOKEN}`);
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

describe('the pane list with a soft check of the worker mark', () => {
  it('reads the same rows as the strict reader for a list of valid lines', () => {
    const text = '%0|4101|0|\n%1|4102|0|\n%5|4210|1|alpha\n';
    expect(parsePaneListSoft(text)).toEqual(parsePaneList(text));
    expect(parsePaneListSoft('')).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['a space', 'a b'],
    ['a leading dash', '-a'],
    ['a shell character', 'a$(x)'],
    ['the separator', 'a|b'],
    ['a trailing separator', 'a|'],
    ['too many characters', 'a'.repeat(101)],
    ['a carriage return', 'a\r'],
  ])('keeps the row of a pane whose worker mark has %s, and treats the pane as no worker', (_name, mark) => {
    expect(parsePaneListSoft(`%0|4101|0|\n%5|4210|0|${mark}\n%6|4211|1|beta\n`)).toEqual({
      ok: true,
      value: [
        { paneId: '%0', pid: 4101, dead: false, worker: null },
        { paneId: '%5', pid: 4210, dead: false, worker: null },
        { paneId: '%6', pid: 4211, dead: true, worker: 'beta' },
      ],
    });
    expect(parsePaneList(`%5|4210|0|${mark}`).ok).toBe(false);
  });

  it.each([
    ['too few fields', '%0|4101|0'],
    ['no pane id', '|4101|0|a'],
    ['a pane id with a letter', '%x|4101|0|a'],
    ['a pid with a letter', '%0|41a1|0|a'],
    ['a pid of 0, which names a process group', '%0|0|0|a'],
    ['a pid with a leading zero', '%0|0412|0|a'],
    ['a dead flag of 2', '%0|4101|2|a'],
    ['an empty dead flag', '%0|4101||a'],
  ])('still refuses the whole list for %s', (_name, line) => {
    const result = parsePaneListSoft(`%1|4102|0|\n${line}\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('line 2');
  });

  it('refuses an empty line inside the list, and names the line number but not the text', () => {
    const result = parsePaneListSoft('%0|4101|0|\n\n%1|4102|0|secret value\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('line 2');
      expect(result.error).not.toContain('secret');
    }
  });
});
