import { describe, expect, it } from 'vitest';
import {
  killPaneArgs,
  paneListArgs,
  paneReadArgs,
  parsePaneList,
  parseSlotList,
  runShellBackgroundArgs,
  setPaneOptionArgs,
  slotListArgs,
  splitWorkerPaneArgs,
  startSteps,
  summonTimerArgs,
  swapPaneArgs,
  tileWorkersArgs,
  unsetPaneOptionArgs,
  type PaneRow,
  type TmuxArgs,
} from '../../src/launch/tmux.js';
import type { Result } from '../../src/core/result.js';
import { tmuxCallOfShellText, tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';

const must = (result: Result<TmuxArgs, string>): TmuxArgs => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const fakeTmux = (fixture?: TmuxFixture) => {
  const { handler, log, runShell } = tmuxHandler(fixture);
  const run = (args: readonly string[]) => {
    const result = handler({ command: 'tmux', args, cwd: undefined });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const rowsOf = (id: string): readonly PaneRow[] => {
    const listed = parsePaneList(run(paneListArgs(id)).stdout);
    if (!listed.ok) throw new Error(listed.error);
    return listed.value;
  };
  const startSession = (id: string): void => {
    const program = ['/opt/bin/node', '/opt/lib/factory.js'] as const;
    for (const step of startSteps({ id, home: '/w/node', coordinatorDir: '/w/node/coordinator', launch: ['claude'], program })) {
      expect(run(step).exitCode).toBe(0);
    }
  };
  return { run, log, rowsOf, startSession, runShell };
};

const where = (log: ReturnType<typeof fakeTmux>['log']) => log.panes().map((pane) => `${pane.id}@${pane.window}`);

describe('the tmux fake: windows and panes', () => {
  it('gives a started session the view window with two panes and the workers window with one pane', () => {
    const { log, startSession } = fakeTmux();
    startSession('demo');
    expect(where(log)).toEqual(['%0@view', '%1@view', '%2@workers']);
    expect(log.panes().map((pane) => pane.options)).toEqual([{ '@node': 'demo' }, { '@slot': 'board' }, {}]);
    expect(log.panes()[0]?.cwd).toBe('/w/node/coordinator');
    expect(log.panes()[0]?.command).toEqual(['claude']);
    expect(log.sessions().get('demo')).toBe('/w/node');
  });

  it('gives a session of the fixture the same windows', () => {
    const { log, rowsOf } = fakeTmux({ sessions: { demo: '/w/node' } });
    expect(where(log)).toEqual(['%0@view', '%1@view', '%2@workers']);
    expect(rowsOf('demo').map((row) => row.worker)).toEqual([null, null, null]);
  });

  it('gives a session of the fixture the pane options that start sets: the node mark and the board mark', () => {
    const { log } = fakeTmux({ sessions: { demo: '/w/node' } });
    expect(log.panes().map((pane) => pane.options)).toEqual([{ '@node': 'demo' }, { '@slot': 'board' }, {}]);
  });

  it('lists the panes with the id, the pid, the dead flag and the worker option, and the list parses', () => {
    const { rowsOf } = fakeTmux({
      sessions: { demo: '/w/node' },
      panes: [{ id: '%9', session: 'demo', options: { '@worker': 'alpha' }, pid: 5001, dead: true }],
    });
    expect(rowsOf('demo').at(-1)).toEqual({ paneId: '%9', pid: 5001, dead: true, worker: 'alpha' });
    expect(rowsOf('demo')).toHaveLength(4);
  });

  it('reads one pane by its id: the same line as the list, and the other panes stay out', () => {
    const { run } = fakeTmux({
      sessions: { demo: '/w/node' },
      panes: [{ id: '%9', session: 'demo', options: { '@worker': 'alpha' }, pid: 5001 }],
    });
    expect(run(must(paneReadArgs('%9'))).stdout).toBe('%9|5001|0|alpha\n');
  });

  it('prints the extra lines of a worker option that holds a new line, as tmux does', () => {
    const { run } = fakeTmux({
      sessions: { demo: '/w/node' },
      panes: [{ id: '%9', session: 'demo', options: { '@worker': 'x\n%2|1234|0|alpha' }, pid: 5001 }],
    });
    expect(run(must(paneReadArgs('%9'))).stdout).toBe('%9|5001|0|x\n%2|1234|0|alpha\n');
  });

  it('answers the read of a pane that does not exist with exit 0 and empty fields, as tmux does', () => {
    const { run } = fakeTmux({ sessions: { demo: '/w/node' } });
    const result = run(must(paneReadArgs('%99')));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('|||\n');
  });

  it('fails the kill of a pane that does not exist, and names the pane', () => {
    const { run } = fakeTmux({ sessions: { demo: '/w/node' } });
    const result = run(must(killPaneArgs('%99')));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('%99');
  });

  it('gives a pane of the fixture the next free id after the highest id of the fixture', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null }, panes: [{ id: '%20', session: 'demo' }] });
    expect(where(log)).toEqual(['%21@view', '%22@view', '%23@workers', '%20@workers']);
    expect(run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w', command: ['claude'] }))).stdout).toBe('%24\n');
  });

  it('makes a worker pane in the workers window, prints its id, and keeps the folder, the command and the option', () => {
    const { log, run, rowsOf, startSession } = fakeTmux();
    startSession('demo');
    const made = run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w/node/work-copies/a', command: ['env', 'claude'] })));
    expect(made.stdout).toBe('%3\n');
    expect(run(must(setPaneOptionArgs('%3', '@worker', 'alpha'))).exitCode).toBe(0);
    expect(rowsOf('demo').at(-1)).toEqual({ paneId: '%3', pid: 4003, dead: false, worker: 'alpha' });
    expect(log.panes().at(-1)).toMatchObject({
      window: 'workers',
      cwd: '/w/node/work-copies/a',
      command: ['env', 'claude'],
      options: { '@worker': 'alpha' },
    });
  });

  it('makes a pane that ends at once as a dead pane, when the fixture says so', () => {
    const { run, rowsOf } = fakeTmux({ sessions: { demo: null }, newPanesEndAtOnce: true });
    run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w', command: ['claude'] })));
    expect(rowsOf('demo').map((row) => row.dead)).toEqual([false, false, false, true]);
  });

  it('keeps the dead flag of the coordinator for a session whose coordinator has ended', () => {
    const { rowsOf } = fakeTmux({ sessions: { demo: null }, endedCoordinators: ['demo'] });
    expect(rowsOf('demo').map((row) => row.dead)).toEqual([true, false, false]);
  });

  it('ends a pane by its id, and ends the window and then the session with its last pane', () => {
    const { log, run } = fakeTmux({ sessions: { demo: '/w/node' } });
    expect(run(must(killPaneArgs('%2'))).exitCode).toBe(0);
    expect(where(log)).toEqual(['%0@view', '%1@view']);
    expect(run(['new-window', '-d', '-t', '=demo:', '-n', 'workers']).exitCode).toBe(0);
    expect(where(log)).toEqual(['%0@view', '%1@view', '%3@workers']);
    run(must(killPaneArgs('%0')));
    run(must(killPaneArgs('%1')));
    run(must(killPaneArgs('%3')));
    expect(log.panes()).toEqual([]);
    expect(log.sessions().has('demo')).toBe(false);
  });

  it('swaps two panes: each pane keeps its id and options, and takes the place of the other', () => {
    const { log, run, rowsOf } = fakeTmux({ sessions: { demo: null } });
    run(must(splitWorkerPaneArgs({ id: 'demo', cwd: '/w', command: ['claude'] })));
    run(must(setPaneOptionArgs('%3', '@worker', 'alpha')));
    run(must(setPaneOptionArgs('%1', '@slot', 'board')));
    expect(run(must(swapPaneArgs('%3', '%1'))).exitCode).toBe(0);
    expect(log.panes().find((pane) => pane.id === '%3')).toMatchObject({ window: 'view', options: { '@worker': 'alpha' } });
    expect(log.panes().find((pane) => pane.id === '%1')).toMatchObject({ window: 'workers', options: { '@slot': 'board' } });
    expect(rowsOf('demo').map((row) => row.paneId)).toEqual(['%0', '%3', '%2', '%1']);
  });

  it('records a background shell call and does nothing else', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null } });
    expect(run(must(runShellBackgroundArgs('sleep 900'))).exitCode).toBe(0);
    expect(log.commands().at(-1)).toBe('run-shell -b sleep 900');
    expect(log.panes()).toHaveLength(3);
  });

  it('unsets a pane option, and leaves the other options of the pane', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null } });
    run(must(setPaneOptionArgs('%1', '@slot_summon', '%2:abc')));
    expect(log.panes()[1]?.options).toEqual({ '@slot': 'board', '@slot_summon': '%2:abc' });
    expect(run(must(unsetPaneOptionArgs('%1', '@slot_summon'))).exitCode).toBe(0);
    expect(log.panes()[1]?.options).toEqual({ '@slot': 'board' });
  });

  it('lists the slot marks: the board pane and the summon mark of the board pane', () => {
    const { run } = fakeTmux({ sessions: { demo: null } });
    run(must(setPaneOptionArgs('%1', '@slot_summon', `%2:${'a'.repeat(32)}`)));
    const rows = parseSlotList(run(slotListArgs('demo')).stdout);
    expect(rows).toEqual({
      ok: true,
      value: [
        { paneId: '%0', window: 'view', board: false, summonText: '' },
        { paneId: '%1', window: 'view', board: true, summonText: `%2:${'a'.repeat(32)}` },
        { paneId: '%2', window: 'workers', board: false, summonText: '' },
      ],
    });
  });

  it('tiles a window, and keeps the layout of each window', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null } });
    expect(run(tileWorkersArgs('demo')).exitCode).toBe(0);
    expect(log.layouts()).toEqual({ 'demo:workers': 'tiled' });
  });

  it('fails a split with "no space for new pane" after the splits of the fixture, until the window is tiled', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null }, splitsBeforeTile: 2 });
    const split = () => run(['split-window', '-d', '-t', '=demo:workers']);
    expect([split().exitCode, split().exitCode, split().exitCode]).toEqual([0, 0, 1]);
    expect(split().stderr).toContain('no space for new pane');
    expect(log.panes()).toHaveLength(5);
    expect(run(tileWorkersArgs('demo')).exitCode).toBe(0);
    expect(split().exitCode).toBe(0);
  });

  it('counts the splits of each window apart', () => {
    const { run } = fakeTmux({ sessions: { demo: null }, splitsBeforeTile: 1 });
    expect(run(['split-window', '-d', '-t', '=demo:workers']).exitCode).toBe(0);
    expect(run(['split-window', '-d', '-t', '=demo:view']).exitCode).toBe(0);
    expect(run(['split-window', '-d', '-t', '=demo:workers']).exitCode).toBe(1);
  });

  it('fails the tiling of a window that does not exist, and of a session that does not exist', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null } });
    expect(run(['select-layout', '-t', '=demo:nowhere', 'tiled']).exitCode).toBe(1);
    expect(run(tileWorkersArgs('other')).exitCode).toBe(1);
    expect(log.layouts()).toEqual({});
  });
});

describe('the tmux fake: the active pane of a window', () => {
  const started = () => {
    const made = fakeTmux();
    made.startSession('demo');
    return made;
  };
  const activeFormat = (run: ReturnType<typeof fakeTmux>['run'], pane: string): string =>
    run(['display-message', '-p', '-t', pane, '#{pane_active}']).stdout.trim();

  it('gives the focus to the first pane of each window, and keeps it there when start splits the view window', () => {
    const { log } = started();
    expect(log.activePane('demo', 'view')).toBe('%0');
    expect(log.activePane('demo', 'workers')).toBe('%2');
    expect(log.activePane('demo', 'nowhere')).toBeUndefined();
  });

  it('prints the pane_active format: 1 for the active pane of its window, 0 for any other pane', () => {
    const { run } = started();
    expect([activeFormat(run, '%0'), activeFormat(run, '%1'), activeFormat(run, '%2')]).toEqual(['1', '0', '1']);
  });

  it('gives the focus to a new pane when split-window has no -d, and keeps it with -d', () => {
    const { log, run } = started();
    run(['split-window', '-d', '-t', '=demo:workers']);
    expect(log.activePane('demo', 'workers')).toBe('%2');
    run(['split-window', '-t', '=demo:workers']);
    expect(log.activePane('demo', 'workers')).toBe('%4');
  });

  it('moves the focus with select-pane, and fails for a pane that does not exist', () => {
    const { log, run } = started();
    expect(run(['select-pane', '-t', '%1']).exitCode).toBe(0);
    expect(log.activePane('demo', 'view')).toBe('%1');
    expect(run(['select-pane', '-t', '%99']).exitCode).toBe(1);
  });

  it('gives each window the pane that came into it when swap-pane has no -d, as tmux does', () => {
    const { log, run } = started();
    run(['swap-pane', '-s', '%2', '-t', '%1']);
    expect(log.activePane('demo', 'view')).toBe('%2');
    expect(log.activePane('demo', 'workers')).toBe('%1');
  });

  it('keeps the focus of both windows when swap-pane has -d and neither pane has it', () => {
    const { log, run } = started();
    run(['split-window', '-d', '-t', '=demo:workers']);
    run(['swap-pane', '-d', '-s', '%3', '-t', '%1']);
    expect(log.activePane('demo', 'view')).toBe('%0');
    expect(log.activePane('demo', 'workers')).toBe('%2');
    expect(where(log)).toEqual(['%0@view', '%3@view', '%2@workers', '%1@workers']);
  });

  it('gives the focus to the pane that takes the place of the active pane when swap-pane has -d', () => {
    const { log, run } = started();
    run(['select-pane', '-t', '%1']);
    run(['swap-pane', '-d', '-s', '%2', '-t', '%1']);
    expect(log.activePane('demo', 'view')).toBe('%2');
    expect(log.activePane('demo', 'workers')).toBe('%1');
  });

  it('gives the focus to the first pane of a window when its active pane is closed', () => {
    const { log, run } = started();
    run(['select-pane', '-t', '%1']);
    run(['kill-pane', '-t', '%1']);
    expect(log.activePane('demo', 'view')).toBe('%0');
  });
});

describe('the tmux fake: formats and the conditional command', () => {
  const { run, log } = fakeTmux({ sessions: { demo: null }, panes: [{ id: '%9', session: 'demo', options: { '@worker': 'alpha' } }] });
  const shown = (format: string): string => run(['display-message', '-p', '-t', '%9', format]).stdout;

  it('expands a format that holds another format, and compares two texts', () => {
    expect(shown('#{==:#{@worker},alpha}')).toBe('1\n');
    expect(shown('#{==:#{@worker},beta}')).toBe('0\n');
    expect(shown('#{==:#{@worker},#{@worker}}')).toBe('1\n');
    expect(shown('a #{@worker} b')).toBe('a alpha b\n');
  });

  it('reads the escape pairs as tmux does: ## gives #, #, gives a comma and #} gives a brace', () => {
    expect(shown('##{@worker}')).toBe('#{@worker}\n');
    expect(shown('a ## b #, c #}')).toBe('a # b , c }\n');
    expect(shown('#{==:#{@worker},al#,pha}')).toBe('0\n');
  });

  it('runs the command after the format when the format is true, with a chain of commands', () => {
    const result = run(['if-shell', '-F', '-t', '%9', '#{==:#{@worker},alpha}', 'set-option -p -t %9 @a 1 ; set-option -p -t %9 @b 2']);
    expect(result.exitCode).toBe(0);
    expect(log.panes().find((pane) => pane.id === '%9')?.options).toMatchObject({ '@a': '1', '@b': '2' });
  });

  it('runs nothing when the format is false, and runs the command after it when the call has one', () => {
    run(['if-shell', '-F', '-t', '%9', '#{==:#{@worker},beta}', 'set-option -p -t %9 @c 1']);
    expect(log.panes().find((pane) => pane.id === '%9')?.options['@c']).toBeUndefined();
    run(['if-shell', '-F', '-t', '%9', '#{==:#{@worker},beta}', 'set-option -p -t %9 @c 1', 'set-option -p -t %9 @d 1']);
    expect(log.panes().find((pane) => pane.id === '%9')?.options).toMatchObject({ '@d': '1' });
  });

  it('counts an empty text and 0 as false, as tmux does', () => {
    run(['if-shell', '-F', '-t', '%9', '', 'set-option -p -t %9 @e 1']);
    run(['if-shell', '-F', '-t', '%9', '0', 'set-option -p -t %9 @e 1']);
    expect(log.panes().find((pane) => pane.id === '%9')?.options['@e']).toBeUndefined();
  });

  it('gives the failure of the first command of the chain that fails, and runs no command after it', () => {
    const result = run(['if-shell', '-F', '-t', '%9', '1', 'swap-pane -s %99 -t %9 ; set-option -p -t %9 @f 1']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('%99');
    expect(log.panes().find((pane) => pane.id === '%9')?.options['@f']).toBeUndefined();
  });

  it('fails for a target pane that does not exist', () => {
    expect(run(['if-shell', '-F', '-t', '%99', '1', 'set-option -p -t %9 @g 1']).exitCode).toBe(1);
  });
});

describe('the tmux fake: the shell text of a summon', () => {
  const TOKEN = '0123456789abcdef0123456789abcdef';

  it('gives the tmux call of the shell text, with no wait, and the quoted words as one word each', () => {
    const text = must(summonTimerArgs({ seconds: 900, board: '%5', pane: '%3', token: TOKEN })).at(-1) ?? '';
    expect(tmuxCallOfShellText(text)).toEqual([
      'if-shell',
      '-F',
      '-t',
      '%5',
      `#{==:#{@slot_summon},%3:${TOKEN}}`,
      'swap-pane -d -s %3 -t %5 ; set-option -p -u -t %5 @slot_summon',
    ]);
  });

  it('expands the formats of the text first, as run-shell does: a format that is not escaped is gone before the wait', () => {
    const text = `sleep 900; tmux if-shell -F -t %5 '#{==:#{@slot_summon},%3:${TOKEN}}' 'swap-pane -s %3 -t %5'`;
    expect(tmuxCallOfShellText(text)).toEqual(['if-shell', '-F', '-t', '%5', '0', 'swap-pane -s %3 -t %5']);
    const escaped = `sleep 900; tmux if-shell -F -t %5 '##{==:##{@slot_summon},%3:${TOKEN}}' 'swap-pane -s %3 -t %5'`;
    expect(tmuxCallOfShellText(escaped)[4]).toBe(`#{==:#{@slot_summon},%3:${TOKEN}}`);
  });

  it('refuses a text that is not a wait and a tmux call', () => {
    expect(() => tmuxCallOfShellText('echo hi')).toThrow('not the shell text of a summon');
    expect(() => tmuxCallOfShellText('sleep 1; ls -l')).toThrow('not the shell text of a summon');
  });

  it('leaves the `; true` after the call out of the call', () => {
    const text = must(summonTimerArgs({ seconds: 900, board: '%5', pane: '%3', token: TOKEN })).at(-1) ?? '';
    expect(text.endsWith("'; true")).toBe(true);
    expect(tmuxCallOfShellText(text).at(-1)).toBe('swap-pane -d -s %3 -t %5 ; set-option -p -u -t %5 @slot_summon');
  });
});

describe('the tmux fake: the shell of a run-shell text', () => {
  const failing = "sleep 1; tmux if-shell -F -t %99 '1' 'set-option -p -t %0 @a 1'";
  const working = "sleep 1; tmux if-shell -F -t %0 '1' 'set-option -p -t %0 @a 1'";

  it('gives exit 0 and shows no screen when the call works', () => {
    const { log, runShell } = fakeTmux({ sessions: { demo: null } });
    expect(runShell(working, '%0')).toBe(0);
    expect(log.modes()).toEqual({});
    expect(log.panes()[0]?.options).toMatchObject({ '@a': '1' });
  });

  it('gives the exit code of the call, and puts the pane that ran run-shell in view mode, when the text has no `; true`', () => {
    const { log, run, runShell } = fakeTmux({ sessions: { demo: null } });
    expect(runShell(failing, '%1')).toBe(1);
    expect(log.modes()).toEqual({ '%1': `'${failing}' returned 1` });
    expect(run(['display-message', '-p', '-t', '%1', '#{pane_in_mode}']).stdout).toBe('1\n');
    expect(run(['display-message', '-p', '-t', '%0', '#{pane_in_mode}']).stdout).toBe('0\n');
  });

  it('puts a pane of the fixture in a mode from the start, and no other pane', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null }, panesInMode: ['%1'] });
    expect(log.modes()).toEqual({ '%1': 'copy mode' });
    expect(run(['display-message', '-p', '-t', '%1', '#{pane_in_mode}']).stdout).toBe('1\n');
    expect(run(['display-message', '-p', '-t', '%0', '#{pane_in_mode}']).stdout).toBe('0\n');
  });

  it('refuses a fixture that puts a pane in a mode when the pane does not exist', () => {
    expect(() => fakeTmux({ sessions: { demo: null }, panesInMode: ['%99'] })).toThrow('%99');
  });

  it('gives exit 0 and shows no screen when the failed call is followed by `; true`', () => {
    const { log, runShell } = fakeTmux({ sessions: { demo: null } });
    expect(runShell(`${failing}; true`, '%0')).toBe(0);
    expect(log.modes()).toEqual({});
  });

  it('records the exit code of each run, and shows no screen in a pane that is gone', () => {
    const { log, run, runShell } = fakeTmux({ sessions: { demo: null } });
    run(['kill-pane', '-t', '%1']);
    expect(runShell(failing, '%1')).toBe(1);
    expect(runShell(working, '%0')).toBe(0);
    expect(log.modes()).toEqual({});
    expect(log.shellRuns()).toEqual([
      { text: failing, exitCode: 1 },
      { text: working, exitCode: 0 },
    ]);
  });
});

describe('the tmux fake: typed input and the screen of a pane', () => {
  const twoPanes = (extra: Partial<TmuxFixture> = {}): TmuxFixture => ({
    sessions: { demo: '/w/node' },
    panes: [
      { id: '%7', session: 'demo', screen: 'first\nsecond' },
      { id: '%8', session: 'demo' },
    ],
    ...extra,
  });

  it('TP-17: records the keys and the text of send-keys for each pane, in the order of the chain', () => {
    const { run, log } = fakeTmux(twoPanes());
    const result = run(['send-keys', '-t', '%7', 'C-u', ';', 'send-keys', '-t', '%8', '-l', '--', 'hi there', ';', 'send-keys', '-t', '%7', 'Enter']);
    expect(result.exitCode).toBe(0);
    expect(log.typed()).toEqual([
      { pane: '%7', literal: false, text: 'C-u' },
      { pane: '%8', literal: true, text: 'hi there' },
      { pane: '%7', literal: false, text: 'Enter' },
    ]);
    expect(log.typed().filter((item) => item.pane === '%8').map((item) => item.text)).toEqual(['hi there']);
  });

  it('TP-17: reads the words after -- as text, also a word with a leading hyphen', () => {
    const { run, log } = fakeTmux(twoPanes());
    expect(run(['send-keys', '-t', '%7', '-l', '--', '-t']).exitCode).toBe(0);
    expect(log.typed()).toEqual([{ pane: '%7', literal: true, text: '-t' }]);
  });

  it('TP-17: returns the screen text of the fixture for capture-pane, with a final new line', () => {
    const { run } = fakeTmux(twoPanes());
    expect(run(['capture-pane', '-p', '-t', '%7']).stdout).toBe('first\nsecond\n');
    expect(run(['capture-pane', '-p', '-t', '%8']).stdout).toBe('');
  });

  it('TP-17: keeps a screen that ends with a new line as it is', () => {
    const { run } = fakeTmux({ sessions: { demo: null }, panes: [{ id: '%7', session: 'demo', screen: 'a\n' }] });
    expect(run(['capture-pane', '-p', '-t', '%7']).stdout).toBe('a\n');
  });

  it('TP-17: fails send-keys and capture-pane for a pane that does not exist, names the pane and types nothing', () => {
    const { run, log } = fakeTmux(twoPanes());
    for (const args of [['send-keys', '-t', '%99', 'Enter'], ['capture-pane', '-p', '-t', '%99']]) {
      const result = run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('%99');
    }
    expect(log.typed()).toEqual([]);
  });

  it('TP-17: stops a chain at the first failed command, and keeps what the earlier commands typed', () => {
    const { run, log } = fakeTmux(twoPanes());
    expect(run(['send-keys', '-t', '%7', 'C-u', ';', 'send-keys', '-t', '%99', 'Enter']).exitCode).toBe(1);
    expect(log.typed()).toEqual([{ pane: '%7', literal: false, text: 'C-u' }]);
  });

  it('TP-17: types nothing when the fixture fails send-keys', () => {
    const { run, log } = fakeTmux(twoPanes({ failing: 'send-keys' }));
    expect(run(['send-keys', '-t', '%7', 'Enter']).exitCode).toBe(1);
    expect(log.typed()).toEqual([]);
  });

  it('TP-17: refuses a capture that does not print, and a flag that it does not know, without typing', () => {
    const { run, log } = fakeTmux(twoPanes());
    expect(run(['capture-pane', '-t', '%7']).exitCode).toBe(1);
    expect(run(['send-keys', '-X', '-t', '%7', 'Enter']).exitCode).toBe(1);
    expect(log.typed()).toEqual([]);
  });
});

describe('the tmux fake: calls that fail', () => {
  it('fails a pane call for a pane that does not exist, and names the pane', () => {
    const { run } = fakeTmux({ sessions: { demo: null } });
    for (const args of [
      must(killPaneArgs('%99')),
      must(setPaneOptionArgs('%99', '@worker', 'a')),
      must(swapPaneArgs('%99', '%1')),
      must(swapPaneArgs('%1', '%99')),
    ]) {
      const result = run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('%99');
    }
  });

  it('fails a list or a split for a session or a window that does not exist', () => {
    const { run } = fakeTmux({ sessions: { demo: null } });
    expect(run(paneListArgs('other')).exitCode).toBe(1);
    expect(run(must(splitWorkerPaneArgs({ id: 'other', cwd: '/w', command: ['claude'] }))).exitCode).toBe(1);
    expect(run(['split-window', '-d', '-t', '=demo:nowhere']).exitCode).toBe(1);
  });

  it('fails a second window with the same name', () => {
    const { run } = fakeTmux({ sessions: { demo: null } });
    expect(run(['new-window', '-d', '-t', '=demo:', '-n', 'workers']).exitCode).toBe(1);
    expect(run(['new-window', '-d', '-t', '=demo:', '-n', 'extra']).exitCode).toBe(0);
  });

  it('fails the command that the fixture names', () => {
    const { run } = fakeTmux({ sessions: { demo: null }, failing: 'list-panes' });
    expect(run(paneListArgs('demo')).exitCode).toBe(1);
  });

  it('refuses a fixture pane for a session that is not in the fixture, and the same id twice', () => {
    expect(() => tmuxHandler({ panes: [{ session: 'demo' }] })).toThrow('not in the fixture');
    expect(() => tmuxHandler({ sessions: { demo: null }, panes: [{ id: '%4', session: 'demo' }, { id: '%4', session: 'demo' }] })).toThrow(
      'twice',
    );
    expect(() => tmuxHandler({ sessions: { demo: null }, panes: [{ id: '4', session: 'demo' }] })).toThrow('not a pane id');
  });

  it('drops the panes of a session that is killed', () => {
    const { log, run } = fakeTmux({ sessions: { demo: null, other: null } });
    run(['kill-session', '-t', '=demo']);
    expect(log.panes().map((pane) => pane.session)).toEqual(['other', 'other', 'other']);
  });
});
