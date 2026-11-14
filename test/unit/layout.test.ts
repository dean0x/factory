import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import type { WorkerOptions } from '../../src/commands/worker.js';
import type { RunOptions } from '../../src/core/deps.js';
import { startSteps } from '../../src/launch/tmux.js';
import { schemaIds } from '../../src/names.js';
import { exited } from '../helpers/fake-deps.js';
import { runLayout, runWorker } from '../helpers/package-registry.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { HOME, NODE, makeSlot, workerPane, type SlotMade, type SlotSetup } from '../helpers/slot-fixture.js';
import { captureSink } from '../helpers/sink.js';
import { tmuxCallOfShellText } from '../helpers/tmux-fake.js';

const COORDINATOR = '%0';
const BOARD = '%1';
const WORKERS_SHELL = '%2';
const ALPHA = '%3';
const COORDINATOR_DIR = '/w/node/coordinator';
const ALPHA_ONLY: SlotSetup = { workers: ['alpha'], panes: [workerPane('alpha')] };

const layout = (made: SlotMade, home: string | undefined = HOME) => runLayout(made.deps, { home });

const laidOut = async (made: SlotMade): Promise<CommandOutput> => {
  const result = await layout(made);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const failedWith = async (made: SlotMade): Promise<CliError> => {
  const result = await layout(made);
  if (result.ok) throw new Error('the layout should have failed');
  return result.error;
};

const summonOptions = (change: Partial<WorkerOptions> = {}): WorkerOptions => ({
  home: HOME,
  words: ['summon', 'alpha'],
  project: undefined,
  yes: false,
  duration: undefined,
  ...change,
});

/** Summons the pane of alpha, and gives the shell text of the timer that the summon started. */
const summonAlpha = async (made: SlotMade): Promise<string> => {
  const result = await runWorker(made.deps, summonOptions());
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  const timer = made.tmux.calls.filter((call) => call.args[0] === 'run-shell').at(-1);
  return timer?.args.at(-1) ?? '';
};

const windowsOf = (made: SlotMade): Record<string, string> =>
  Object.fromEntries(made.tmux.panes().map((pane) => [pane.id, pane.window]));

const windowNames = (made: SlotMade): string[] => [...new Set(made.tmux.panes().map((pane) => pane.window))];

const optionsOf = (made: SlotMade, pane: string): Readonly<Record<string, string>> =>
  made.tmux.panes().find((candidate) => candidate.id === pane)?.options ?? {};

const callsOf = (made: SlotMade, word: string): string[] => made.tmux.commands().filter((command) => command.startsWith(word));

/** The session that only has the window view: the program of the workers window ended, and its pane is gone. */
const viewOnly = async (setup: SlotSetup = {}): Promise<SlotMade> => {
  const made = await makeSlot(setup);
  made.serverCall(['kill-pane', '-t', WORKERS_SHELL]);
  return made;
};

describe('layout: the windows', () => {
  it('makes the window workers on a session that has only the window view, and tiles it', async () => {
    const made = await viewOnly();
    expect(windowNames(made)).toEqual(['view']);
    await laidOut(made);
    expect(windowNames(made)).toEqual(['view', 'workers']);
    expect(made.tmux.layouts()).toEqual({ [`${NODE}:workers`]: 'tiled' });
  });

  it('makes the window in the folder of the coordinator, in the background, before it tiles', async () => {
    const made = await viewOnly();
    await laidOut(made);
    const commands = made.tmux.commands();
    const created = commands.indexOf(`new-window -d -t =${NODE}: -n workers -c ${COORDINATOR_DIR}`);
    const tiled = commands.indexOf(`select-layout -t =${NODE}:workers tiled`);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(tiled).toBeGreaterThan(created);
  });

  it('makes the same two windows as start: a session that start made keeps both, and its workers window is tiled', async () => {
    const made = await makeSlot({ tmux: { sessions: {} } });
    const program = ['/opt/bin/node', '/opt/lib/factory.js'] as const;
    for (const step of startSteps({ id: NODE, home: HOME, coordinatorDir: COORDINATOR_DIR, launch: ['claude'], program })) {
      expect(made.serverCall(step).exitCode).toBe(0);
    }
    expect(windowNames(made)).toEqual(['view', 'workers']);
    expect(made.tmux.panes().filter((pane) => pane.window === 'view')).toHaveLength(2);
    await laidOut(made);
    expect(callsOf(made, 'new-window')).toHaveLength(1);
    expect(windowNames(made)).toEqual(['view', 'workers']);
    expect(made.tmux.layouts()).toEqual({ [`${NODE}:workers`]: 'tiled' });
  });

  it('makes no window and keeps the panes when the window workers exists, and tiles it again', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const output = await laidOut(made);
    expect(callsOf(made, 'new-window')).toEqual([]);
    expect(made.tmux.layouts()).toEqual({ [`${NODE}:workers`]: 'tiled' });
    expect(windowsOf(made)).toEqual({ [COORDINATOR]: 'view', [BOARD]: 'view', [WORKERS_SHELL]: 'workers', [ALPHA]: 'workers' });
    expect(output.json).toMatchObject({ workers: 'present' });
  });

  it('warns that the window view is missing, and still makes the window workers', async () => {
    const made = await makeSlot();
    made.serverCall(['kill-pane', '-t', COORDINATOR]);
    made.serverCall(['kill-pane', '-t', BOARD]);
    const output = await laidOut(made);
    expect(output.warnings.join('\n')).toContain('window view');
    expect(output.failed).toBe(false);
    expect(output.json).toMatchObject({ view: 'missing', workers: 'present' });
  });

  it('keeps the window workers that a person made with another name apart: it makes a window workers beside it', async () => {
    const made = await makeSlot();
    made.serverCall(['kill-pane', '-t', WORKERS_SHELL]);
    made.serverCall(['new-window', '-d', '-t', `=${NODE}:`, '-n', 'bench']);
    await laidOut(made);
    expect(windowNames(made)).toEqual(['view', 'bench', 'workers']);
  });

  it('writes no file', async () => {
    const made = await viewOnly();
    const files = new Map(made.deps.files);
    await laidOut(made);
    expect(new Map(made.deps.files)).toEqual(files);
  });
});

describe('layout: the board returns to the slot', () => {
  it('swaps a summoned pane back to the board and unsets the summon mark', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summonAlpha(made);
    expect(windowsOf(made)[ALPHA]).toBe('view');
    const output = await laidOut(made);
    expect(windowsOf(made)).toMatchObject({ [BOARD]: 'view', [ALPHA]: 'workers' });
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
    expect(optionsOf(made, BOARD)['@slot']).toBe('board');
    expect(output.json).toMatchObject({ slot: 'restored', board: BOARD, pane: ALPHA });
    expect(plainText(output)).toContain(`The board is in the slot of the window view again (pane ${BOARD}).`);
  });

  it('keeps the focus on the coordinator pane when it swaps the board back', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summonAlpha(made);
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
    await laidOut(made);
    expect(windowsOf(made)[BOARD]).toBe('view');
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
  });

  it('makes the timer of the summon do nothing afterwards', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const timer = await summonAlpha(made);
    await laidOut(made);
    const before = JSON.stringify(made.tmux.panes());
    expect(made.serverCall(tmuxCallOfShellText(timer)).exitCode).toBe(0);
    expect(JSON.stringify(made.tmux.panes())).toBe(before);
  });

  it('swaps a pane back that a newer summon put in the slot, with the board and not with the first pane', async () => {
    const made = await makeSlot({ workers: ['alpha', 'beta'], panes: [workerPane('alpha'), workerPane('beta')] });
    await summonAlpha(made);
    const second = await runWorker(made.deps, summonOptions({ words: ['summon', 'beta'] }));
    expect(second.ok).toBe(true);
    await laidOut(made);
    expect(windowsOf(made)).toMatchObject({ [BOARD]: 'view', [ALPHA]: 'workers', '%4': 'workers' });
  });

  it('changes nothing about the slot when no pane is summoned', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const output = await laidOut(made);
    expect(callsOf(made, 'swap-pane')).toEqual([]);
    expect(output.json).toMatchObject({ slot: 'none' });
    expect(plainText(output)).not.toContain('again');
  });

  it('clears a summon mark whose pane is gone, swaps nothing, and warns', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summonAlpha(made);
    made.serverCall(['kill-pane', '-t', ALPHA]);
    const output = await laidOut(made);
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
    expect(callsOf(made, 'swap-pane')).toHaveLength(1);
    expect(windowsOf(made)[BOARD]).toBe('workers');
    expect(output.json).toMatchObject({ slot: 'cleared' });
    expect(output.warnings.join('\n')).toContain(ALPHA);
    expect(output.warnings.join('\n')).toContain('the pane is gone');
  });

  it('does not touch the panes when the mark and the windows disagree: the board pane is in the view window already', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    made.serverCall(['set-option', '-p', '-t', BOARD, '@slot_summon', `${ALPHA}:${'a'.repeat(32)}`]);
    const output = await laidOut(made);
    expect(callsOf(made, 'swap-pane')).toEqual([]);
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
    expect(output.json).toMatchObject({ slot: 'cleared' });
    expect(windowsOf(made)).toMatchObject({ [BOARD]: 'view', [ALPHA]: 'workers' });
  });

  it('keeps the summon mark and the slot, and fails with exit 1, when the swap fails', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summonAlpha(made);
    const mark = optionsOf(made, BOARD)['@slot_summon'];
    const broken = {
      ...made.deps,
      run: (command: string, args: readonly string[], runOptions?: RunOptions) =>
        args[0] === 'swap-pane' ? Promise.resolve(exited(1, '', 'swap failed\n')) : made.deps.run(command, args, runOptions),
    };
    const result = await runLayout(broken, { home: HOME });
    expect(!result.ok && exitCodeOf[result.error.kind]).toBe(1);
    expect(!result.ok && result.error.message).toContain('swap-pane');
    expect(optionsOf(made, BOARD)['@slot_summon']).toBe(mark);
    expect(windowsOf(made)[ALPHA]).toBe('view');
  });
});

describe('layout: a board pane that is not in the window view', () => {
  /** The command that brings the board pane back. It names the real pane and the real window, and it runs in a shell as it stands. */
  const JOIN_BOARD = `tmux join-pane -d -h -s ${BOARD} -t ${COORDINATOR}`;
  const warningsOf = (output: CommandOutput): string => output.warnings.join('\n');

  it('names the tmux command that joins the board pane back, when the summon mark named a pane that is gone', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summonAlpha(made);
    made.serverCall(['kill-pane', '-t', ALPHA]);
    const output = await laidOut(made);
    expect(output.json).toMatchObject({ slot: 'cleared' });
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
    expect(warningsOf(output)).toContain(`The board pane ${BOARD} is not in the window view`);
    expect(warningsOf(output)).toContain(`"${JOIN_BOARD}"`);
  });

  it('clears the mark that a timer left, when the worker pane was gone at the end of the wait, and names the command', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const timer = await summonAlpha(made);
    made.serverCall(['kill-pane', '-t', ALPHA]);
    expect(made.runShell(timer)).toBe(0);
    expect(made.tmux.modes()).toEqual({});
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeDefined();
    const output = await laidOut(made);
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
    expect(warningsOf(output)).toContain(`"${JOIN_BOARD}"`);
  });

  it('names the same command when no summon mark is set and the board pane is in the window workers', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    made.serverCall(['swap-pane', '-s', BOARD, '-t', WORKERS_SHELL]);
    expect(windowsOf(made)[BOARD]).toBe('workers');
    const output = await laidOut(made);
    expect(output.json).toMatchObject({ slot: 'none' });
    expect(warningsOf(output)).toContain(`The board pane ${BOARD} is not in the window view`);
    expect(warningsOf(output)).toContain(`"${JOIN_BOARD}"`);
    expect(callsOf(made, 'join-pane')).toEqual([]);
  });

  it('gives no hint for a board pane that is in the slot, or that layout swapped back', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    expect((await laidOut(made)).warnings).toEqual([]);
    await summonAlpha(made);
    const output = await laidOut(made);
    expect(output.json).toMatchObject({ slot: 'restored' });
    expect(output.warnings).toEqual([]);
  });

  it('gives no join-pane hint when the window view is gone, because no command can join a pane to it', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    made.serverCall(['swap-pane', '-s', BOARD, '-t', WORKERS_SHELL]);
    made.serverCall(['kill-pane', '-t', COORDINATOR]);
    made.serverCall(['kill-pane', '-t', WORKERS_SHELL]);
    const output = await laidOut(made);
    expect(output.json).toMatchObject({ view: 'missing', slot: 'none' });
    expect(warningsOf(output)).toContain('The window view does not exist');
    expect(warningsOf(output)).not.toContain('join-pane');
  });
});

describe('layout: the session of the node', () => {
  it('exits 3 and names factory start when no tmux session of the node runs', async () => {
    const made = await makeSlot({ tmux: { sessions: {} } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.hint).toContain('"factory start"');
    expect(error.hint).toContain('"factory layout" again');
    expect(callsOf(made, 'new-window')).toEqual([]);
  });

  it('exits 3 when tmux is not installed', async () => {
    const made = await makeSlot({ tmux: { version: null } });
    expect(exitCodeOf[(await failedWith(made)).kind]).toBe(3);
  });

  it('exits 4 for a session of that name that belongs to another factory folder, and changes nothing', async () => {
    const made = await makeSlot({ tmux: { sessions: { [NODE]: '/w/other' } } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(callsOf(made, 'new-window')).toEqual([]);
    expect(made.tmux.layouts()).toEqual({});
  });
});

describe('layout: the marks of the slot', () => {
  it('exits 4 for two panes that carry the board mark, and still makes the window workers first', async () => {
    const made = await viewOnly({ panes: [workerPane('rogue', { window: 'view', options: { '@slot': 'board' } })] });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('"factory layout"');
    expect(windowNames(made)).toEqual(['view', 'workers']);
  });

  it('exits 4 for a summon mark that is not a pane id and a token', async () => {
    const made = await makeSlot();
    made.serverCall(['set-option', '-p', '-t', BOARD, '@slot_summon', 'anything']);
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain(`set-option -p -u -t ${BOARD} @slot_summon`);
  });

  it('makes the windows when no pane carries the board mark, and has nothing to restore', async () => {
    const made = await viewOnly();
    made.serverCall(['set-option', '-p', '-u', '-t', BOARD, '@slot']);
    const output = await laidOut(made);
    expect(output.json).toMatchObject({ workers: 'made', slot: 'none' });
  });
});

describe('layout: the command line', () => {
  it('runs through runCli with --home, and prints what it made', async () => {
    const made = await viewOnly();
    const sink = captureSink();
    expect(await runCli(['layout', '--home', HOME], made.deps, sink)).toBe(0);
    expect(sink.out.join('')).toContain('Made the window workers.');
    expect(made.tmux.layouts()).toEqual({ [`${NODE}:workers`]: 'tiled' });
  });

  it('prints one JSON document with the flag --json', async () => {
    const made = await viewOnly();
    const sink = captureSink();
    expect(await runCli(['layout', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toEqual({ schema: schemaIds.layout, workers: 'made', view: 'present', slot: 'none' });
  });

  it('exits 3 through runCli with no session, and names factory start', async () => {
    const made = await makeSlot({ tmux: { sessions: {} } });
    const sink = captureSink();
    expect(await runCli(['layout', '--home', HOME], made.deps, sink)).toBe(3);
    expect(sink.errors.join('')).toContain('"factory start"');
  });

  it('is in the list of commands, with its usage', async () => {
    const made = await makeSlot();
    const sink = captureSink();
    expect(await runCli(['layout', '--help'], made.deps, sink)).toBe(0);
    expect(sink.out.join('')).toContain('Usage: factory layout [--home DIR]');
    const listing = captureSink();
    expect(await runCli(['--help'], made.deps, listing)).toBe(0);
    expect(listing.out.join('')).toMatch(/\n {2}layout\s+Make the windows/);
  });
});

describe('layout: the output', () => {
  it('is short, and says what it made and what it restored', async () => {
    const made = await viewOnly();
    const text = plainText(await laidOut(made));
    expect(text).toContain('Made the window workers.');
    expect(text).toContain('Tiled the panes of the window workers.');
    expectShortOutput(text);
  });

  it('gives a JSON document', async () => {
    const made = await viewOnly();
    const output = await laidOut(made);
    expect(output.failed).toBe(false);
    expect(output.json).toEqual({ schema: schemaIds.layout, workers: 'made', view: 'present', slot: 'none' });
  });
});
