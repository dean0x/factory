import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import type { WorkerOptions } from '../../src/commands/worker.js';
import { schemaIds } from '../../src/names.js';
import { runWorker } from '../helpers/package-registry.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { HOME, NODE, makeSlot, workerPane, type SlotMade, type SlotSetup } from '../helpers/slot-fixture.js';
import { captureSink } from '../helpers/sink.js';
import { tmuxCallOfShellText } from '../helpers/tmux-fake.js';
import { launchWordsOf } from '../helpers/worker-launch-words.js';

/** The panes of the session `demo` that the fixture makes: the coordinator, the board pane (the slot) and the shell of the workers window. */
const COORDINATOR = '%0';
const BOARD = '%1';
const ALPHA = '%3';
const BETA = '%4';
const ALPHA_ONLY: SlotSetup = { workers: ['alpha'], panes: [workerPane('alpha')] };
const TWO_WORKERS: SlotSetup = { workers: ['alpha', 'beta'], panes: [workerPane('alpha'), workerPane('beta')] };

const options = (change: Partial<WorkerOptions> = {}): WorkerOptions => ({
  home: HOME,
  words: ['summon', 'alpha'],
  project: undefined,
  yes: false,
  duration: undefined,
  ...change,
});

const summon = (made: SlotMade, change: Partial<WorkerOptions> = {}) => runWorker(made.deps, options(change));

const summoned = async (made: SlotMade, change: Partial<WorkerOptions> = {}): Promise<CommandOutput> => {
  const result = await summon(made, change);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const failedWith = async (made: SlotMade, change: Partial<WorkerOptions> = {}): Promise<CliError> => {
  const result = await summon(made, change);
  if (result.ok) throw new Error('the summon should have failed');
  return result.error;
};

/** The window of each pane, by pane id. */
const windowsOf = (made: SlotMade): Record<string, string> =>
  Object.fromEntries(made.tmux.panes().map((pane) => [pane.id, pane.window]));

const optionsOf = (made: SlotMade, pane: string): Readonly<Record<string, string>> =>
  made.tmux.panes().find((candidate) => candidate.id === pane)?.options ?? {};

/** The shell texts of the timers that the summons started, in order. */
const timers = (made: SlotMade): string[] =>
  made.tmux.calls.filter((call) => call.command === 'tmux' && call.args[0] === 'run-shell').map((call) => call.args.at(-1) ?? '');

/** Runs the tmux call of a timer at once, as the shell of the timer runs it after the wait. */
const fire = (made: SlotMade, text: string | undefined): void => {
  if (text === undefined) throw new Error('there is no timer');
  const result = made.serverCall(tmuxCallOfShellText(text));
  expect(result.exitCode).toBe(0);
};

const swaps = (made: SlotMade): string[] => made.tmux.commands().filter((command) => command.startsWith('swap-pane'));

const TOKEN_PATTERN = /^%[0-9]+:[0-9a-f]{32}$/;

describe('worker summon: a record that is not the record of its worker', () => {
  it('stops with exit 4, names the record file, and moves no pane', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const file = '/w/node/.factory/workers/alpha/worker.json';
    const record = JSON.parse(made.deps.files.get(file) ?? 'null') as Record<string, unknown>;
    made.deps.seed(file, `${JSON.stringify({ ...record, work_copy: HOME })}\n`);
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(file);
    expect(swaps(made)).toEqual([]);
  });
});

describe('worker summon: a pane that the launch of the worker did not make', () => {
  const SHELL = '%2';
  /** The pane of alpha after a program in it removed its own mark: the launch made it, and it has no mark. */
  const unmarked = (): SlotSetup => ({ workers: ['alpha'], panes: [workerPane('alpha', { options: {} })] });

  /** The summon must stop with exit 4, move no pane, and set no mark and no timer. */
  const refused = async (made: SlotMade): Promise<CliError> => {
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(swaps(made)).toEqual([]);
    expect(timers(made)).toEqual([]);
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
    return error;
  };

  it.each([
    ['the coordinator pane', COORDINATOR],
    ['the board pane', BOARD],
    ['a pane of the workers window that runs the shell', SHELL],
  ])('refuses %s that carries the mark of the worker', async (_name, pane) => {
    const made = await makeSlot(unmarked());
    made.serverCall(['set-option', '-p', '-t', pane, '@worker', 'alpha']);
    const error = await refused(made);
    expect(error.message).toContain(pane);
  });

  it('refuses the coordinator pane as the exit 4 that it is, and not as two live panes of the worker (exit 2), when the pane of the worker keeps its mark', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    made.serverCall(['set-option', '-p', '-t', COORDINATOR, '@worker', 'alpha']);
    const error = await refused(made);
    expect(error.message).not.toContain('live panes');
  });

  it('refuses a pane that the launch of another worker made', async () => {
    const made = await makeSlot({ workers: ['alpha', 'beta'], panes: [workerPane('alpha', { command: launchWordsOf(HOME, 'beta') })] });
    await refused(made);
  });

  it('refuses a pane that has the mark and runs another program than the launch', async () => {
    const made = await makeSlot({ workers: ['alpha'], panes: [workerPane('alpha', { command: ['sleep', '3000'] })] });
    await refused(made);
  });

  it('refuses a pane that the launch made, in the window view, when no summon names it', async () => {
    const made = await makeSlot({ workers: ['alpha'], panes: [workerPane('alpha', { window: 'view' })] });
    const error = await refused(made);
    expect(error.message).toContain('view');
  });

  it('names the tmux command that clears the mark', async () => {
    const made = await makeSlot(unmarked());
    made.serverCall(['set-option', '-p', '-t', COORDINATOR, '@worker', 'alpha']);
    const error = await refused(made);
    expect(error.hint).toContain(`set-option -p -u -t ${COORDINATOR} @worker`);
  });

  it('does not check a pane of another worker', async () => {
    const made = await makeSlot({ workers: ['alpha', 'beta'], panes: [workerPane('alpha'), workerPane('beta', { command: [] })] });
    expect(await summoned(made)).toMatchObject({ failed: false });
    expect(swaps(made)).toEqual([`swap-pane -d -s ${ALPHA} -t ${BOARD}`]);
  });
});

describe('worker summon: the pane goes into the slot of the view window', () => {
  it('swaps the pane of the worker with the board pane, and keeps the other panes where they are', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    expect(swaps(made)).toEqual([`swap-pane -d -s ${ALPHA} -t ${BOARD}`]);
    expect(windowsOf(made)).toEqual({ [COORDINATOR]: 'view', [ALPHA]: 'view', [BOARD]: 'workers', '%2': 'workers' });
  });

  it('keeps the focus on the coordinator pane: the summon and the restore of the timer move no focus', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
    await summoned(made);
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
    fire(made, timers(made)[0]);
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
  });

  it('keeps the focus on the coordinator pane for a second summon, which swaps with the pane of the first summon', async () => {
    const made = await makeSlot(TWO_WORKERS);
    await summoned(made);
    await summoned(made, { words: ['summon', 'beta'] });
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
  });

  it('stores a new random token with the pane id in the summon mark of the board pane', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    expect(optionsOf(made, BOARD)['@slot_summon']).toMatch(TOKEN_PATTERN);
    expect(optionsOf(made, BOARD)['@slot_summon']?.startsWith(`${ALPHA}:`)).toBe(true);
    expect(made.deps.randomTexts).toHaveLength(1);
    expect(optionsOf(made, BOARD)['@slot']).toBe('board');
  });

  it('starts one timer in the background, after the swap and the mark', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    const commands = made.tmux.commands();
    const [swapAt, markAt, timerAt] = ['swap-pane', 'set-option -p', 'run-shell'].map((word) => commands.findIndex((c) => c.startsWith(word)));
    expect(timers(made)).toHaveLength(1);
    expect(swapAt).toBeLessThan(markAt ?? -1);
    expect(markAt).toBeLessThan(timerAt ?? -1);
  });

  it('returns the board to the slot when the restore step runs, and unsets the mark', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    fire(made, timers(made)[0]);
    expect(windowsOf(made)).toEqual({ [COORDINATOR]: 'view', [BOARD]: 'view', [ALPHA]: 'workers', '%2': 'workers' });
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
    expect(optionsOf(made, ALPHA)['@worker']).toBe('alpha');
  });

  it('does nothing when the restore step runs a second time', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    fire(made, timers(made)[0]);
    const before = JSON.stringify(made.tmux.panes());
    fire(made, timers(made)[0]);
    expect(JSON.stringify(made.tmux.panes())).toBe(before);
    expect(windowsOf(made)[BOARD]).toBe('view');
  });

  it.each([
    [undefined, 900],
    ['15m', 900],
    ['1m', 60],
    ['90m', 5400],
    ['2h', 7200],
    ['120m', 7200],
    ['1h', 3600],
  ])('waits for the time %j, which is %d seconds', async (duration, seconds) => {
    const made = await makeSlot(ALPHA_ONLY);
    const output = await summoned(made, { duration });
    expect(timers(made)[0]?.startsWith(`sleep ${seconds}; `)).toBe(true);
    expect(output.json).toMatchObject({ minutes: seconds / 60 });
  });

  it('says what it did in a short output, and gives a JSON document', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const output = await summoned(made, { duration: '30m' });
    const text = plainText(output);
    expect(text).toContain('The worker alpha shows in the slot of the window view');
    expect(text).toContain('30m');
    expectShortOutput(text);
    expect(output.failed).toBe(false);
    expect(output.json).toEqual({
      schema: schemaIds.workerSummon,
      id: 'alpha',
      pane: ALPHA,
      board: BOARD,
      minutes: 30,
      until: new Date(made.deps.now().getTime() + 30 * 60_000).toISOString(),
      swapped: true,
    });
  });

  it('writes no file', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const files = new Map(made.deps.files);
    await summoned(made);
    expect(new Map(made.deps.files)).toEqual(files);
  });
});

describe('worker summon: the timer and the token', () => {
  it('holds only digits, a hex token and pane ids, besides the fixed words of the restore', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    const text = timers(made)[0] ?? '';
    const token = text.match(/[0-9a-f]{32}/)?.[0] ?? '';
    expect(token).toBe(made.deps.randomTexts[0]);
    const fixed = text.replace(token, 'TOKEN').replace(/%[0-9]+/g, 'PANE').replace(/^sleep [0-9]+/, 'sleep SECONDS');
    expect(fixed).toBe(
      "sleep SECONDS; tmux if-shell -F -t PANE '##{==:##{@slot_summon},PANE:TOKEN}' 'swap-pane -d -s PANE -t PANE ; set-option -p -u -t PANE @slot_summon'; true",
    );
    expect(text).toMatch(/^[A-Za-z0-9 %#{}=:,@;'_-]+$/);
  });

  it('holds no text of the person: the id of the worker, the home and the time text are not in it', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made, { duration: '20m' });
    const text = timers(made)[0] ?? '';
    for (const word of ['alpha', HOME, NODE, '20m']) expect(text).not.toContain(word);
  });

  it('replaces the token for a summon of another worker, so that the older timer does nothing', async () => {
    const made = await makeSlot(TWO_WORKERS);
    await summoned(made);
    const first = optionsOf(made, BOARD)['@slot_summon'];
    await summoned(made, { words: ['summon', 'beta'] });
    const second = optionsOf(made, BOARD)['@slot_summon'];
    expect(second).toMatch(TOKEN_PATTERN);
    expect(second).not.toBe(first);
    expect(second?.startsWith(`${BETA}:`)).toBe(true);
    expect(timers(made)).toHaveLength(2);

    // The older timer finds another mark: it changes nothing.
    const before = JSON.stringify(made.tmux.panes());
    fire(made, timers(made)[0]);
    expect(JSON.stringify(made.tmux.panes())).toBe(before);
    expect(windowsOf(made)[BETA]).toBe('view');

    // The newer timer returns the board, and the other worker is back in its window.
    fire(made, timers(made)[1]);
    expect(windowsOf(made)).toMatchObject({ [BOARD]: 'view', [BETA]: 'workers', [ALPHA]: 'workers' });
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
  });

  it('swaps the new pane with the pane in the slot, and so needs one swap for the second summon', async () => {
    const made = await makeSlot(TWO_WORKERS);
    await summoned(made);
    await summoned(made, { words: ['summon', 'beta'] });
    expect(swaps(made)).toEqual([`swap-pane -d -s ${ALPHA} -t ${BOARD}`, `swap-pane -d -s ${BETA} -t ${ALPHA}`]);
    expect(windowsOf(made)).toMatchObject({ [BETA]: 'view', [ALPHA]: 'workers', [BOARD]: 'workers' });
  });

  it('makes a new token and a new timer for a second summon of the same worker, and swaps nothing again', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made, { duration: '1m' });
    const first = optionsOf(made, BOARD)['@slot_summon'];
    const output = await summoned(made, { duration: '2h' });
    expect(swaps(made)).toHaveLength(1);
    expect(output.json).toMatchObject({ swapped: false, minutes: 120 });
    expect(optionsOf(made, BOARD)['@slot_summon']).not.toBe(first);
    expect(timers(made)).toHaveLength(2);
    expect(timers(made)[1]?.startsWith('sleep 7200; ')).toBe(true);

    fire(made, timers(made)[0]);
    expect(windowsOf(made)[ALPHA]).toBe('view');
    fire(made, timers(made)[1]);
    expect(windowsOf(made)).toMatchObject({ [BOARD]: 'view', [ALPHA]: 'workers' });
  });

  it.each(['0m', '0h', '121m', '3h', '2h1m', '15', '15s', '1d', '-5m', '1.5h', '05m', ' 15m', '15m ', '', 'm', 'h', '15 m', '1e1m'])(
    'exits 2 for the time %j, names the flag and the bounds, and changes nothing',
    async (duration) => {
      const made = await makeSlot(ALPHA_ONLY);
      const error = await failedWith(made, { duration });
      expect(exitCodeOf[error.kind]).toBe(2);
      expect(error.message).toContain('--for');
      expect(`${error.message} ${error.hint}`).toMatch(/1m.*2h/);
      expect(made.tmux.calls).toEqual([]);
      expect(made.deps.randomTexts).toEqual([]);
    },
  );
});

describe('worker summon: a timer that fires when a pane is gone', () => {
  it('ends the shell with exit 0, and shows no error screen in any pane, when the summoned pane was closed during the wait', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    made.serverCall(['kill-pane', '-t', ALPHA]);
    const before = JSON.stringify(made.tmux.panes());
    expect(made.runShell(timers(made)[0] ?? '')).toBe(0);
    expect(made.tmux.modes()).toEqual({});
    // The swap failed, so no pane moved and the summon mark stays for `layout` to clear.
    expect(JSON.stringify(made.tmux.panes())).toBe(before);
    expect(optionsOf(made, BOARD)['@slot_summon']).toMatch(TOKEN_PATTERN);
  });

  it('ends the shell with exit 0, and shows no error screen in any pane, when the board pane was closed during the wait', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    made.serverCall(['kill-pane', '-t', BOARD]);
    const before = JSON.stringify(made.tmux.panes());
    expect(made.runShell(timers(made)[0] ?? '')).toBe(0);
    expect(made.tmux.modes()).toEqual({});
    expect(JSON.stringify(made.tmux.panes())).toBe(before);
  });

  it('ends the shell with exit 0 when the timer works, and the board is back in the slot', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    await summoned(made);
    expect(made.runShell(timers(made)[0] ?? '')).toBe(0);
    expect(made.tmux.modes()).toEqual({});
    expect(windowsOf(made)).toMatchObject({ [BOARD]: 'view', [ALPHA]: 'workers' });
  });
});

describe('worker summon: the session of the node', () => {
  it('exits 3 and names factory start when no tmux session of the node runs', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, tmux: { sessions: {} } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.hint).toContain('"factory start"');
    expect(error.hint).toContain('"factory worker summon alpha" again');
    expect(timers(made)).toEqual([]);
  });

  it('exits 3 and names factory start when tmux is not installed', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, tmux: { version: null } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.hint).toContain('"factory start"');
  });

  it('exits 4 for a session of that name that belongs to another factory folder', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, tmux: { sessions: { [NODE]: '/w/other' } } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(swaps(made)).toEqual([]);
  });
});

describe('worker summon: the worker and its pane', () => {
  it.each([[[] as string[]], [['alpha', 'beta']]])('needs exactly one id: %j', async (args) => {
    const made = await makeSlot(TWO_WORKERS);
    const error = await failedWith(made, { words: ['summon', ...args] });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('takes one argument');
    expect(made.tmux.calls).toEqual([]);
  });

  it('exits 2 for a worker that has no record, and swaps nothing', async () => {
    const made = await makeSlot({ workers: ['beta'], panes: [workerPane('alpha')] });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('alpha');
    expect(swaps(made)).toEqual([]);
  });

  it('exits 3 for a worker that has no pane, and names worker resume', async () => {
    const made = await makeSlot({ workers: ['alpha'] });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('alpha');
    expect(error.hint).toContain('"factory worker resume alpha"');
    expect(swaps(made)).toEqual([]);
  });

  it('exits 3 for a worker whose program has ended, and names worker resume', async () => {
    const made = await makeSlot({ workers: ['alpha'], panes: [workerPane('alpha', { dead: true })] });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.hint).toContain('"factory worker resume alpha"');
    expect(swaps(made)).toEqual([]);
  });

  it('exits 2 for two live panes of one worker, and names both', async () => {
    const made = await makeSlot({ workers: ['alpha'], panes: [workerPane('alpha'), workerPane('alpha')] });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(ALPHA);
    expect(error.message).toContain(BETA);
    expect(swaps(made)).toEqual([]);
  });

  it('uses the live pane when the worker has an old pane that ended too', async () => {
    const made = await makeSlot({ workers: ['alpha'], panes: [workerPane('alpha', { dead: true }), workerPane('alpha')] });
    const output = await summoned(made);
    expect(output.json).toMatchObject({ pane: BETA });
    expect(swaps(made)).toEqual([`swap-pane -d -s ${BETA} -t ${BOARD}`]);
  });

  it('can run in the pane that it summons', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, env: { TMUX_PANE: ALPHA } });
    await summoned(made);
    expect(windowsOf(made)[ALPHA]).toBe('view');
  });
});

describe('worker summon: the marks of the slot', () => {
  it('exits 1 when no pane carries the board mark', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    made.serverCall(['set-option', '-p', '-u', '-t', BOARD, '@slot']);
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('board');
    expect(swaps(made)).toEqual([]);
  });

  it('exits 4 for two panes that carry the board mark, and names both and the fix', async () => {
    const made = await makeSlot({ workers: ['alpha'], panes: [workerPane('alpha'), workerPane('rogue', { options: { '@slot': 'board' } })] });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(BOARD);
    expect(error.message).toContain(BETA);
    expect(error.hint).toContain('set-option -p -u');
    expect(swaps(made)).toEqual([]);
  });

  it('exits 4 when the pane of the worker carries the board mark', async () => {
    const made = await makeSlot({ workers: ['alpha'], panes: [workerPane('alpha', { options: { '@worker': 'alpha', '@slot': 'board' } })] });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(swaps(made)).toEqual([]);
  });

  it('exits 4 for a summon mark that is not a pane id and a token, and tells how to clear it', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    made.serverCall(['set-option', '-p', '-t', BOARD, '@slot_summon', 'anything']);
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain(`set-option -p -u -t ${BOARD} @slot_summon`);
    expect(swaps(made)).toEqual([]);
  });

  it('exits 1 when the board pane is not in the view window and no pane is summoned', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    made.serverCall(['swap-pane', '-s', BOARD, '-t', '%2']);
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(BOARD);
    expect(swaps(made)).toHaveLength(1);
  });

  it('exits 1 when the summon mark names a pane that is gone, and names layout', async () => {
    const made = await makeSlot(TWO_WORKERS);
    await summoned(made);
    made.serverCall(['kill-pane', '-t', ALPHA]);
    const error = await failedWith(made, { words: ['summon', 'beta'] });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(ALPHA);
    expect(error.hint).toContain('"factory layout"');
    expect(windowsOf(made)[BETA]).toBe('workers');
  });
});

describe('worker summon: the command line', () => {
  it('reads the flag --for through runCli, and starts the timer with its time', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const sink = captureSink();
    expect(await runCli(['worker', 'summon', 'alpha', '--home', HOME, '--for', '45m'], made.deps, sink)).toBe(0);
    expect(timers(made)[0]?.startsWith('sleep 2700; ')).toBe(true);
    expect(sink.out.join('')).toContain('The worker alpha shows in the slot');
  });

  it('gives exit 2 through runCli for a bad time, and prints the flag and the bounds', async () => {
    const made = await makeSlot(ALPHA_ONLY);
    const sink = captureSink();
    expect(await runCli(['worker', 'summon', 'alpha', '--home', HOME, '--for', '3h'], made.deps, sink)).toBe(2);
    expect(sink.errors.join('')).toMatch(/--for.*1m.*2h/s);
    expect(made.tmux.calls).toEqual([]);
  });

  it('gives exit 3 through runCli when no session runs, and names factory start', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, tmux: { sessions: {} } });
    const sink = captureSink();
    expect(await runCli(['worker', 'summon', 'alpha', '--home', HOME], made.deps, sink)).toBe(3);
    expect(sink.errors.join('')).toContain('"factory start"');
  });

  it('is in the usage of the command, with the flag --for and its default', async () => {
    const made = await makeSlot();
    const sink = captureSink();
    expect(await runCli(['worker', '--help'], made.deps, sink)).toBe(0);
    const help = sink.out.join('');
    expect(help).toContain('worker summon ID [--for TIME]');
    expect(help).toMatch(/--for TIME\s+How long the slot shows the worker.*Default: 15m\./);
  });
});

describe('worker summon: a call that fails', () => {
  it('fails at the swap with nothing changed, and starts no timer', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, tmux: { failing: 'swap-pane' } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('swap-pane');
    expect(windowsOf(made)[ALPHA]).toBe('workers');
    expect(timers(made)).toEqual([]);
    expect(optionsOf(made, BOARD)['@slot_summon']).toBeUndefined();
  });

  it('swaps the panes back when the mark can not be set, and starts no timer', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, tmux: { failing: 'set-option' } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('set-option');
    expect(swaps(made)).toEqual([`swap-pane -d -s ${ALPHA} -t ${BOARD}`, `swap-pane -d -s ${ALPHA} -t ${BOARD}`]);
    expect(windowsOf(made)).toMatchObject({ [ALPHA]: 'workers', [BOARD]: 'view' });
    expect(timers(made)).toEqual([]);
  });

  it('keeps the slot and the mark when the timer can not start, and names layout', async () => {
    const made = await makeSlot({ ...ALPHA_ONLY, tmux: { failing: 'run-shell' } });
    const error = await failedWith(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('timer');
    expect(error.hint).toContain('"factory layout"');
    expect(windowsOf(made)[ALPHA]).toBe('view');
    expect(optionsOf(made, BOARD)['@slot_summon']).toMatch(TOKEN_PATTERN);
  });
});
