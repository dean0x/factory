import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { stopFallback, stopPoll, stopWay, stopWays, schemaIds, type HookEvent, type StopCase } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeWorkerSession, type OwnSessionRead } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { stopCaseOf, stopWorker, wayFor, type StopOutcome } from '../../src/workers/stop.js';
import { paneListArgs, type PaneRow } from '../../src/launch/tmux.js';
import { listPanes } from '../../src/workers/panes.js';
import { createFakeDeps, exited, missingProgram, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { launchWordsOf } from '../helpers/worker-launch-words.js';

const HOME = '/w/node';
const NODE = 'demo';
const SESSION = 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc';
const PANE = '%3';
const PID = 4777;
const AT = '2030-01-02T03:04:05.678Z';

/** The pane of alpha: the launch of alpha made it, so its start command is the launch words. */
const alphaPane = (change: Partial<PaneFixture> = {}): PaneFixture => ({
  id: PANE,
  session: NODE,
  options: { '@worker': 'alpha' },
  pid: PID,
  command: launchWordsOf(HOME, 'alpha'),
  ...change,
});

interface Setup {
  readonly panes?: readonly PaneFixture[];
  readonly tmux?: TmuxFixture;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly termEndsAfterChecks?: number;
  readonly terminateFails?: string;
  /** Changes the text that the read of one pane prints. */
  readonly rewriteRead?: (stdout: string) => string;
  /** True: tmux removes the pane when its process ends, as it does with no remain-on-exit. */
  readonly paneVanishes?: boolean;
  /** True: the pane ends between the list and the read of the pane, and tmux removes it. */
  readonly paneGoneAtRead?: boolean;
  /** A summon before the stop: the pane is swapped with the board pane, and the board pane gets the summon mark. */
  readonly summoned?: { readonly pane: string; readonly mark: string };
  /** Pane options that a program in a pane sets before the stop, on any pane: the pane, the option and the value. */
  readonly marks?: readonly (readonly [pane: string, option: string, value: string])[];
}

/** The board pane of the fixture: the three panes of the session come after the pane %3, so the board pane is %5. */
const BOARD = '%5';

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** What happened, in order: the tmux commands and the `terminate` calls. */
  readonly events: string[];
}

const make = (setup: Setup = {}): Made => {
  const { handler, log } = tmuxHandler({ sessions: { demo: HOME }, panes: setup.panes ?? [alphaPane()], ...setup.tmux });
  if (setup.summoned !== undefined) {
    handler({ command: 'tmux', args: ['swap-pane', '-d', '-s', setup.summoned.pane, '-t', BOARD], cwd: undefined });
    handler({ command: 'tmux', args: ['set-option', '-p', '-t', BOARD, '@slot_summon', setup.summoned.mark], cwd: undefined });
  }
  for (const [pane, option, value] of setup.marks ?? []) {
    handler({ command: 'tmux', args: ['set-option', '-p', '-t', pane, option, value], cwd: undefined });
  }
  const events: string[] = [];
  const base = createFakeDeps({
    cwd: '/w',
    env: { ...setup.env },
    run: (call: RunCall) => {
      if (call.command !== 'tmux') return missingProgram(call.command);
      events.push(`tmux ${call.args[0]}`);
      if (call.args[0] === 'display-message' && setup.paneGoneAtRead === true) {
        handler({ command: 'tmux', args: ['kill-pane', '-t', PANE], cwd: undefined });
      }
      const result = handler(call);
      if (!result.ok || call.args[0] !== 'display-message' || setup.rewriteRead === undefined) return result;
      return exited(result.value.exitCode, setup.rewriteRead(result.value.stdout), result.value.stderr);
    },
    ...(setup.termEndsAfterChecks === undefined ? {} : { termEndsAfterChecks: setup.termEndsAfterChecks }),
    ...(setup.terminateFails === undefined ? {} : { terminateFails: setup.terminateFails }),
  });
  const deps: FakeDeps = {
    ...base,
    terminate: (pid) => {
      events.push(`terminate ${pid}`);
      const sent = base.terminate(pid);
      if (setup.paneVanishes === true) handler({ command: 'tmux', args: ['kill-pane', '-t', PANE], cwd: undefined });
      return sent;
    },
  };
  return { deps, tmux: log, events };
};

interface Seed {
  readonly event?: HookEvent | null;
  /** The session marker of the line. Null: the line has none. Default: alpha. */
  readonly marker?: string | null;
  /** False: the worker has no pointer. */
  readonly pointer?: boolean;
  /** The text of the line file, in place of the line that the other fields make. Null: the session has no line file. */
  readonly text?: string | null;
  /** True: the other worker has a pointer to the same session. */
  readonly shared?: boolean;
}

const record = (id: string) => ({ id, project: 'web', workCopy: `/w/node/work-copies/web/${id}`, branch: `worker/${id}` });

const seed = async (deps: FakeDeps, change: Seed = {}): Promise<void> => {
  for (const id of ['alpha', 'beta']) {
    const written = await writeWorkerRecord(deps, HOME, record(id));
    if (!written.ok) throw new Error(written.error.message);
  }
  if (change.pointer !== false) await writeWorkerSession(deps, HOME, 'alpha', SESSION);
  if (change.shared === true) await writeWorkerSession(deps, HOME, 'beta', SESSION);
  const event = change.event === undefined ? 'Stop' : change.event;
  const marker = change.marker === undefined ? 'alpha' : change.marker;
  const line = {
    schema: schemaIds.lastSeen,
    session_id: SESSION,
    event,
    event_at: event === null ? null : AT,
    context_pct: event === null ? 40 : null,
    pct_at: event === null ? AT : null,
    ...(marker === null ? {} : { session_marker: marker }),
  };
  if (change.text !== null) deps.seed(`${layoutOf(HOME).heartbeatDir}/${SESSION}`, change.text ?? `${JSON.stringify(line)}\n`);
};

const run = (made: Made) => stopWorker(made.deps, { home: HOME, session: NODE, workerId: 'alpha' });

const succeeded = async (made: Made): Promise<StopOutcome> => {
  const result = await run(made);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const failed = async (made: Made): Promise<CliError> => {
  const result = await run(made);
  if (result.ok) throw new Error(`the stop should have failed, it gave ${JSON.stringify(result.value)}`);
  return result.error;
};

const killed = (made: Made): string[] => made.tmux.commands().filter((command) => command.startsWith('kill-pane'));

describe('the way to stop a session in the code and in the table of docs/session-stop.md (TP-27)', () => {
  const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'session-stop.md'), 'utf8');
  const sectionOf = (heading: string): string => {
    const start = doc.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`the doc has no section ${heading}`);
    const rest = doc.slice(start + heading.length + 3);
    const next = rest.indexOf('\n## ');
    return next < 0 ? rest : rest.slice(0, next);
  };
  const firstWayOf = (section: string, label: string): string => {
    const found = new RegExp(`^- ${label}: \`([^\`]+)\``, 'm').exec(section);
    if (found?.[1] === undefined) throw new Error(`the section names no way for ${label}`);
    return found[1];
  };
  /** The ways of the rows of the table that have the verdict safe, by case. */
  const safeRows = (): Record<string, string[]> => {
    const result: Record<string, string[]> = { idle: [], busy: [] };
    for (const row of sectionOf('The table').split('\n')) {
      const cells = row.split('|').map((cell) => cell.trim());
      const [, way, kase, , , , , verdict] = cells;
      if (way === undefined || kase === undefined || verdict !== 'safe') continue;
      result[kase]?.push(way.replaceAll('`', ''));
    }
    return result;
  };
  const safeSection = sectionOf('The safe way for each case');

  it('has the safe way of the idle case in the code', () => {
    expect(stopWays.idle).toBe(firstWayOf(safeSection, 'Idle'));
  });

  it('has the safe way of the busy case in the code', () => {
    expect(stopWays.busy).toBe(firstWayOf(safeSection, 'Busy'));
  });

  it('has the prompt fallback of the doc in the code', () => {
    const found = /the stop code uses `([^`]+)` as the prompt fallback/.exec(safeSection);
    expect(found?.[1]).toBe(stopFallback);
  });

  it('uses, for each case, a way that has the verdict safe in the table', () => {
    const rows = safeRows();
    expect(rows['idle']).toContain(stopWays.idle);
    expect(rows['busy']).toContain(stopWays.busy);
  });

  it('knows no way but TERM, because the table has no other way that the code runs', () => {
    expect(Object.values(stopWay)).toEqual(['kill -TERM']);
  });

  it('uses the fallback for a case that has no safe way', () => {
    expect(wayFor('busy', { idle: null, busy: null })).toBe(stopFallback);
    expect(wayFor('idle', { idle: null, busy: stopWay.term })).toBe(stopFallback);
  });

  it('uses the safe way of the case when it has one', () => {
    expect(wayFor('idle')).toBe(stopWays.idle);
    expect(wayFor('busy')).toBe(stopWays.busy);
  });
});

describe('stopCaseOf', () => {
  const line = (event: HookEvent | null) => ({
    schema: schemaIds.lastSeen,
    session_id: SESSION,
    event,
    event_at: event === null ? null : AT,
    context_pct: null,
    pct_at: null,
  });

  it.each([
    ['SessionStart', 'idle'],
    ['Stop', 'idle'],
    ['UserPromptSubmit', 'busy'],
    ['PreCompact', 'busy'],
  ] as const)('reads %s as the case %s', (event, expected) => {
    expect(stopCaseOf({ state: 'valid', line: line(event) })).toBe(expected);
  });

  it('says nothing for a line with no event', () => {
    expect(stopCaseOf({ state: 'valid', line: { ...line(null), context_pct: 5, pct_at: AT } })).toBeNull();
  });

  it.each(['no-line', 'not-owned'] as const)('says nothing for the unknown state %s', (why) => {
    const read: OwnSessionRead = { state: 'unknown', why, reason: 'x' };
    expect(stopCaseOf(read)).toBeNull();
  });
});

describe('worker stop: a session at the prompt (TP-26)', () => {
  it('sends TERM to the pane pid, and closes the pane by its id after the process ends', async () => {
    const made = make();
    await seed(made.deps);
    expect(await succeeded(made)).toEqual({
      kind: 'stopped',
      paneId: PANE,
      pid: PID,
      way: stopWay.term,
      state: 'idle',
      pane: 'closed',
    });
    expect(made.deps.terminated).toEqual([PID]);
    expect(killed(made)).toEqual([`kill-pane -t ${PANE}`]);
    expect(made.events.indexOf(`terminate ${PID}`)).toBeLessThan(made.events.lastIndexOf('tmux kill-pane'));
  });

  it('takes the pid from the read of the pane at stop time, not from the list', async () => {
    const made = make({ rewriteRead: (stdout) => stdout.replace(`|${PID}|`, '|4888|') });
    await seed(made.deps);
    const outcome = await succeeded(made);
    expect(made.deps.terminated).toEqual([4888]);
    expect(outcome).toMatchObject({ kind: 'stopped', pid: 4888 });
  });

  it('lists the panes once, and reads the one pane right before the signal', async () => {
    const made = make();
    await seed(made.deps);
    await succeeded(made);
    const paneList = JSON.stringify(paneListArgs(NODE));
    expect(made.deps.calls.filter((call) => JSON.stringify(call.args) === paneList)).toHaveLength(1);
    expect(made.events.slice(made.events.lastIndexOf('tmux display-message'), made.events.indexOf(`terminate ${PID}`) + 1)).toEqual([
      'tmux display-message',
      `terminate ${PID}`,
    ]);
  });

  it('reads the pane to bind it to the worker before the last-seen file is read, and again right before the signal', async () => {
    const made = make();
    await seed(made.deps);
    await succeeded(made);
    expect(made.events.filter((event) => event === 'tmux display-message')).toHaveLength(2);
    expect(made.events.indexOf('tmux display-message')).toBeLessThan(made.events.indexOf(`terminate ${PID}`));
  });

  it.each(['UserPromptSubmit', 'PreCompact'] as const)('sends TERM to a busy session too (the last event is %s)', async (event) => {
    const made = make();
    await seed(made.deps, { event });
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', way: stopWay.term, state: 'busy' });
    expect(made.deps.terminated).toEqual([PID]);
  });

  it.each(['SessionStart', 'Stop'] as const)('names the case idle for the last event %s', async (event) => {
    const made = make();
    await seed(made.deps, { event });
    expect(await succeeded(made)).toMatchObject({ state: 'idle' });
  });

  it('sends no signal but TERM, and starts no program but tmux', async () => {
    const made = make();
    await seed(made.deps);
    await succeeded(made);
    expect(made.deps.calls.every((call) => call.command === 'tmux')).toBe(true);
    expect(made.deps.terminated).toEqual([PID]);
  });

  it('is done when tmux has removed the pane already', async () => {
    const made = make({ paneVanishes: true });
    await seed(made.deps);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', pane: 'gone' });
  });

  it('fails when the pane stays and cannot be closed, and says that the process ended', async () => {
    const made = make({ tmux: { failing: 'kill-pane' } });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(PANE);
    expect(made.deps.terminated).toEqual([PID]);
  });

  it('does not wait when no process has the pid any more at the signal', async () => {
    const made = make();
    await seed(made.deps);
    made.deps.terminate(PID);
    made.deps.isRunning(PID);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', pane: 'closed' });
    expect(made.deps.sleeps).toEqual([]);
  });
});

describe('worker stop: a state that is not known (TP-28)', () => {
  it.each<[string, Seed]>([
    ['no pointer', { pointer: false }],
    ['a pointer to a session with no line', { text: null }],
    ['a line that is not valid', { text: 'not json\n' }],
    ['a line with no session marker', { marker: null }],
    ['a line that belongs to the node', { marker: NODE }],
    ['a line that belongs to another worker', { marker: 'beta' }],
    ['a line with no event', { event: null }],
    ['a session that the pointer of another worker names too', { shared: true }],
  ])('exits 3 for %s, names the pane and the process, and sends nothing', async (_name, change) => {
    const made = make();
    await seed(made.deps, change);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(PANE);
    expect(error.message).toContain(String(PID));
    expect(error.hint).toContain(`${stopWay.term} ${PID}`);
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('names the process of the second read in the message', async () => {
    const made = make({ rewriteRead: (stdout) => stdout.replace(`|${PID}|`, '|4888|') });
    await seed(made.deps, { pointer: false });
    expect((await failed(made)).message).toContain('4888');
  });
});

describe('worker stop: only the cases that the caller allows', () => {
  const runOnly = (made: Made, allowed: readonly StopCase[]) =>
    stopWorker(made.deps, { home: HOME, session: NODE, workerId: 'alpha', allowed, again: 'dismiss alpha' });

  it.each(['UserPromptSubmit', 'PreCompact'] as const)(
    'refuses a busy session when only the idle case is allowed (the last event is %s): exit 1, the command to run again, and nothing is sent or closed',
    async (event) => {
      const made = make();
      await seed(made.deps, { event });
      const result = await runOnly(made, ['idle']);
      if (result.ok) throw new Error(`the stop should have failed, it gave ${JSON.stringify(result.value)}`);
      expect(exitCodeOf[result.error.kind]).toBe(1);
      expect(result.error.message).toContain('busy');
      expect(result.error.hint).toContain('dismiss alpha');
      expect(made.deps.terminated).toEqual([]);
      expect(killed(made)).toEqual([]);
    },
  );

  it('stops an idle session when only the idle case is allowed', async () => {
    const made = make();
    await seed(made.deps);
    const result = await runOnly(made, ['idle']);
    expect(result).toMatchObject({ ok: true, value: { kind: 'stopped', state: 'idle' } });
    expect(made.deps.terminated).toEqual([PID]);
  });

  it('stops a busy session when the busy case is allowed', async () => {
    const made = make();
    await seed(made.deps, { event: 'UserPromptSubmit' });
    expect(await runOnly(made, ['idle', 'busy'])).toMatchObject({ ok: true, value: { kind: 'stopped', state: 'busy' } });
  });

  it('keeps exit 3 for a state that is not known, whatever the caller allows, and sends nothing', async () => {
    const made = make();
    await seed(made.deps, { event: null });
    const result = await runOnly(made, ['idle']);
    if (result.ok) throw new Error('the stop should have failed');
    expect(exitCodeOf[result.error.kind]).toBe(3);
    expect(made.deps.terminated).toEqual([]);
  });
});

describe('worker stop: the wait for the end of the process (TP-29)', () => {
  it('exits 1 with the pid when the process does not end in the bound, sends TERM once and never KILL', async () => {
    const made = make({ termEndsAfterChecks: Number.POSITIVE_INFINITY });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(String(PID));
    expect(error.message).toContain(PANE);
    expect(made.deps.terminated).toEqual([PID]);
    expect(made.deps.sleeps).toEqual(Array.from({ length: stopPoll.attempts }, () => stopPoll.intervalMs));
    expect(made.deps.checked).toHaveLength(stopPoll.attempts);
    expect(killed(made)).toEqual([]);
    expect(made.deps.calls.every((call) => call.command === 'tmux')).toBe(true);
  });

  it('says that the command never sends KILL in the remedy', async () => {
    const made = make({ termEndsAfterChecks: Number.POSITIVE_INFINITY });
    await seed(made.deps);
    expect((await failed(made)).hint).toContain('KILL');
  });

  it('stops waiting at the first check that finds no process, and then closes the pane', async () => {
    const made = make({ termEndsAfterChecks: 2 });
    await seed(made.deps);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', pane: 'closed' });
    expect(made.deps.checked).toHaveLength(3);
    expect(made.deps.sleeps).toEqual([stopPoll.intervalMs, stopPoll.intervalMs, stopPoll.intervalMs]);
  });

  it('exits 1 and closes no pane when the signal call fails', async () => {
    const made = make({ terminateFails: 'EPERM' });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('EPERM');
    expect(killed(made)).toEqual([]);
  });

  it('has a bound that is a number of whole checks with a wait between them', () => {
    expect(Number.isInteger(stopPoll.attempts)).toBe(true);
    expect(stopPoll.attempts).toBeGreaterThan(0);
    expect(stopPoll.intervalMs).toBeGreaterThan(0);
  });
});

describe('worker stop: a forged line in the pane list', () => {
  // The fixture has an explicit pane %5, so the panes that the session starts with get the ids %6, %7 and %8.
  const FORGED_MARK = `x\n%6|9999|0|alpha`;

  it('does not signal the pid of a forged line, and stops with a security refusal', async () => {
    // The pane %5 has a worker mark with a new line. The list then holds the line "%6|9999|0|alpha" for the pane %6 of the coordinator.
    const made = make({ panes: [{ id: '%5', session: NODE, options: { '@worker': FORGED_MARK }, pid: 5005 }] });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('does not signal a pane that carries the mark of another worker at the second read', async () => {
    const made = make({
      panes: [
        { id: '%5', session: NODE, options: { '@worker': 'x\n%3|9999|0|alpha' }, pid: 5005 },
        { id: PANE, session: NODE, options: { '@worker': 'beta' }, pid: PID },
      ],
    });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
  });

  it('refuses a forged line for the very pane that holds the mark with the new line', async () => {
    // The pane %3 holds the mark "x\n%3|9999|0|alpha": its own line is for the worker x, and the forged line is for alpha.
    const made = make({ panes: [alphaPane({ options: { '@worker': `x\n${PANE}|9999|0|alpha` } })] });
    await seed(made.deps);
    expect(exitCodeOf[(await failed(made)).kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
  });

  it('refuses the pane when the second read gives text that is not its line', async () => {
    const made = make({ rewriteRead: () => `${PANE}|9999|0|alpha\n%9|1|0|alpha\n` });
    await seed(made.deps);
    expect(exitCodeOf[(await failed(made)).kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
  });

  it('refuses the pane when the second read gives no text', async () => {
    const made = make({ rewriteRead: () => '' });
    await seed(made.deps);
    expect(exitCodeOf[(await failed(made)).kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
  });

  it('exits 1 and signals nothing when the pane is gone at the second read', async () => {
    const made = make({ paneGoneAtRead: true });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(PANE);
    expect(made.deps.terminated).toEqual([]);
  });

  it('exits 2 and signals nothing when two live panes carry the mark of the worker', async () => {
    const made = make({ panes: [alphaPane(), alphaPane({ id: '%4', pid: 4888 })] });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(PANE);
    expect(error.message).toContain('%4');
    expect(made.deps.terminated).toEqual([]);
  });

  it('does not count a dead pane against a live pane of the worker', async () => {
    const made = make({ panes: [alphaPane({ id: '%4', pid: 4888, dead: true }), alphaPane()] });
    await seed(made.deps);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', paneId: PANE });
    expect(made.deps.terminated).toEqual([PID]);
  });
});

describe('worker stop: a pane that the launch of the worker did not make', () => {
  // The fixture has the explicit pane %3, so the panes that the session starts with are: the coordinator %4, the board %5, the shell %6.
  const COORDINATOR = '%4';
  const SHELL = '%6';
  /** The pane of the worker after a program in it removed its own mark: the launch made it, and it has no mark. */
  const unmarked = (): PaneFixture => alphaPane({ options: {} });

  /** The stop must refuse with exit 4, send no signal, close no pane and start no other program than tmux. */
  const refused = async (made: Made): Promise<CliError> => {
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
    expect(made.deps.calls.every((call) => call.command === 'tmux')).toBe(true);
    return error;
  };

  it('refuses the coordinator pane that carries the mark of the worker, and sends nothing to its process', async () => {
    const error = await refused(make({ panes: [unmarked()], marks: [[COORDINATOR, '@worker', 'alpha']] }));
    expect(error.message).toContain(COORDINATOR);
  });

  it('refuses the board pane that carries the mark of the worker', async () => {
    const error = await refused(make({ panes: [unmarked()], marks: [[BOARD, '@worker', 'alpha']] }));
    expect(error.message).toContain(BOARD);
  });

  it('refuses a pane of the workers window that runs the shell and carries the mark of the worker', async () => {
    const error = await refused(make({ panes: [unmarked()], marks: [[SHELL, '@worker', 'alpha']] }));
    expect(error.message).toContain(SHELL);
  });

  it('refuses the coordinator pane as the exit 4 that it is, and not as two live panes of the worker (exit 2), when the pane of the worker keeps its mark', async () => {
    const error = await refused(make({ panes: [alphaPane()], marks: [[COORDINATOR, '@worker', 'alpha']] }));
    expect(error.message).toContain(COORDINATOR);
    expect(error.message).not.toContain('live panes');
  });

  it('refuses a pane that the launch of another worker made', async () => {
    await refused(make({ panes: [alphaPane({ command: launchWordsOf(HOME, 'beta') })] }));
  });

  it('refuses a pane that the launch of the worker made in another factory folder', async () => {
    await refused(make({ panes: [alphaPane({ command: launchWordsOf('/other/node', 'alpha') })] }));
  });

  it('refuses a pane that has the mark and runs another program than the launch', async () => {
    await refused(make({ panes: [alphaPane({ command: ['sleep', '3000'] })] }));
  });

  it('refuses a pane that has the mark and the words of the launch inside one quoted word', async () => {
    await refused(make({ panes: [alphaPane({ command: ['env', launchWordsOf(HOME, 'alpha').join(' ')] })] }));
  });

  it('refuses a coordinator pane whose program ended, and closes nothing', async () => {
    const error = await refused(
      make({
        panes: [{ id: '%7', session: NODE, window: 'view', options: { '@node': NODE, '@worker': 'alpha' }, dead: true, command: ['claude'] }],
      }),
    );
    expect(error.message).toContain('%7');
  });

  it('refuses a pane that has the launch words of the worker and the node mark', async () => {
    const error = await refused(make({ panes: [alphaPane({ options: { '@worker': 'alpha', '@node': NODE } })] }));
    expect(error.message).toContain('coordinator');
  });

  it('refuses a pane that has the launch words of the worker and the board mark', async () => {
    const error = await refused(make({ panes: [alphaPane({ options: { '@worker': 'alpha', '@slot': 'board' } })] }));
    expect(error.message).toContain('board');
  });

  it('refuses a pane in the window view that no summon names, also when the launch of the worker made it', async () => {
    const error = await refused(make({ panes: [alphaPane({ window: 'view' })] }));
    expect(error.message).toContain('view');
  });

  it('names the tmux command that clears the mark, and the command to run again', async () => {
    const error = await refused(make({ panes: [unmarked()], marks: [[COORDINATOR, '@worker', 'alpha']] }));
    expect(error.hint).toContain(`set-option -p -u -t ${COORDINATOR} @worker`);
    expect(error.hint).toContain('worker stop alpha');
  });

  it('refuses at the second read when the pane has lost its mark by then, and sends nothing', async () => {
    let reads = 0;
    const made = make({ rewriteRead: (stdout) => (++reads === 2 ? stdout.replace(`|${PID}|0|1|`, `|${PID}|0|0|`) : stdout) });
    await refused(made);
    expect(reads).toBe(2);
  });

  it('refuses at the second read when the pane shows no start command by then, and sends nothing', async () => {
    let reads = 0;
    const made = make({ rewriteRead: (stdout) => (++reads === 2 ? `${stdout.split('|').slice(0, 7).join('|')}|\n` : stdout) });
    await refused(made);
    expect(reads).toBe(2);
  });

  it('stops the pane that the launch made, with the mark, in the workers window', async () => {
    const made = make({ panes: [alphaPane()], marks: [[COORDINATOR, '@worker', 'beta']] });
    await seed(made.deps);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', paneId: PANE, pid: PID });
    expect(made.deps.terminated).toEqual([PID]);
  });

  it('stops a pane that the launch made when the factory folder has a space in its path', async () => {
    const spaced = '/w/my node';
    const { handler } = tmuxHandler({
      sessions: { demo: spaced },
      panes: [{ id: PANE, session: NODE, options: { '@worker': 'alpha' }, pid: PID, command: launchWordsOf(spaced, 'alpha') }],
    });
    const deps = createFakeDeps({ cwd: '/w', run: handler });
    for (const id of ['alpha']) {
      const written = await writeWorkerRecord(deps, spaced, { ...record(id), workCopy: `${spaced}/work-copies/web/${id}` });
      if (!written.ok) throw new Error(written.error.message);
    }
    await writeWorkerSession(deps, spaced, 'alpha', SESSION);
    deps.seed(
      `${layoutOf(spaced).heartbeatDir}/${SESSION}`,
      `${JSON.stringify({ schema: schemaIds.lastSeen, session_id: SESSION, event: 'Stop', event_at: AT, context_pct: null, pct_at: null, session_marker: 'alpha' })}\n`,
    );
    const result = await stopWorker(deps, { home: spaced, session: NODE, workerId: 'alpha' });
    expect(result.ok).toBe(true);
    expect(deps.terminated).toEqual([PID]);
  });
});

describe('worker stop: never its own pane', () => {
  it('exits 2 when the pane of the caller is the pane of the worker, and signals and closes nothing', async () => {
    const made = make({ env: { TMUX_PANE: PANE } });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(PANE);
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('goes on when the caller runs in another pane', async () => {
    const made = make({ env: { TMUX_PANE: '%0' } });
    await seed(made.deps);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped' });
  });

  it('goes on when the caller runs outside tmux', async () => {
    const made = make({ env: { TMUX_PANE: undefined } });
    await seed(made.deps);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped' });
  });
});

describe('worker stop: a pane that a summon put in the slot of the view window', () => {
  const TOKEN = 'ab'.repeat(16);
  const SUMMONED = { pane: PANE, mark: `${PANE}:${TOKEN}` };
  const paneOf = (made: Made, pane: string) => made.tmux.panes().find((candidate) => candidate.id === pane);

  it('brings the board back into the slot after the process ends, and then closes the pane', async () => {
    const made = make({ summoned: SUMMONED });
    await seed(made.deps);
    expect(paneOf(made, PANE)?.window).toBe('view');
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', pid: PID, pane: 'closed' });
    expect(paneOf(made, BOARD)).toMatchObject({ window: 'view', options: { '@slot': 'board' } });
    expect(paneOf(made, BOARD)?.options['@slot_summon']).toBeUndefined();
    expect(paneOf(made, PANE)).toBeUndefined();
    const swapAt = made.events.indexOf('tmux swap-pane');
    expect(made.events.indexOf(`terminate ${PID}`)).toBeLessThan(swapAt);
    expect(swapAt).toBeLessThan(made.events.indexOf('tmux kill-pane'));
  });

  it('keeps the focus on the coordinator pane when it brings the board back', async () => {
    // The panes of the session come after the pane %3: the coordinator pane is %4.
    const COORDINATOR = '%4';
    const made = make({ summoned: SUMMONED });
    await seed(made.deps);
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', pane: 'closed' });
    expect(paneOf(made, BOARD)?.window).toBe('view');
    expect(made.tmux.activePane(NODE, 'view')).toBe(COORDINATOR);
  });

  it('brings the board back before it closes a pane that ended in the slot, and sends no signal', async () => {
    const made = make({ panes: [alphaPane({ dead: true })], summoned: SUMMONED });
    await seed(made.deps);
    expect(await succeeded(made)).toEqual({ kind: 'closed-dead', paneIds: [PANE] });
    expect(made.deps.terminated).toEqual([]);
    expect(paneOf(made, BOARD)?.window).toBe('view');
    expect(paneOf(made, PANE)).toBeUndefined();
  });

  it('moves no pane when the summon is of another worker', async () => {
    // The id %2 is below %3, so the panes of the session keep the ids %4 to %6, and the board pane stays %5.
    const beta = alphaPane({ id: '%2', options: { '@worker': 'beta' }, pid: 4888 });
    const made = make({ panes: [alphaPane(), beta], summoned: { pane: '%2', mark: `%2:${TOKEN}` } });
    await seed(made.deps);
    expect(paneOf(made, '%2')?.window).toBe('view');
    expect(await succeeded(made)).toMatchObject({ kind: 'stopped', pane: 'closed' });
    expect(made.events).not.toContain('tmux swap-pane');
    expect(paneOf(made, '%2')?.window).toBe('view');
    expect(paneOf(made, BOARD)?.options['@slot_summon']).toBe(`%2:${TOKEN}`);
  });

  it('refuses with exit 4 a pane in the window view when the summon mark is not one that factory wrote, and moves no pane', async () => {
    const made = make({ summoned: { pane: PANE, mark: `${PANE}:not-a-token` } });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
    expect(made.events).not.toContain('tmux swap-pane');
    expect(killed(made)).toEqual([]);
  });
});

describe('worker stop: a worker with no live pane', () => {
  it('says that there is no pane, and signals and closes nothing', async () => {
    const made = make({ panes: [] });
    await seed(made.deps);
    expect(await succeeded(made)).toEqual({ kind: 'no-pane' });
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('closes a pane that has ended, by its id, and signals nothing', async () => {
    const made = make({ panes: [alphaPane({ dead: true })] });
    await seed(made.deps);
    expect(await succeeded(made)).toEqual({ kind: 'closed-dead', paneIds: [PANE] });
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([`kill-pane -t ${PANE}`]);
  });

  it('closes a pane that ended between the list and the second read, and signals nothing', async () => {
    const made = make({ rewriteRead: (stdout) => stdout.replace(`|${PID}|0|`, `|${PID}|1|`) });
    await seed(made.deps);
    expect(await succeeded(made)).toEqual({ kind: 'closed-dead', paneIds: [PANE] });
    expect(made.deps.terminated).toEqual([]);
  });

  it('says that there is no pane when the tmux session does not run, and lists nothing', async () => {
    const made = make({ tmux: { sessions: {} }, panes: [] });
    await seed(made.deps);
    expect(await succeeded(made)).toEqual({ kind: 'no-pane' });
    expect(made.events).toEqual(['tmux has-session']);
  });

  it('refuses a tmux session of another factory folder, with exit 4', async () => {
    const made = make({ tmux: { sessions: { demo: '/other/node' } } });
    await seed(made.deps);
    expect(exitCodeOf[(await failed(made)).kind]).toBe(4);
    expect(made.deps.terminated).toEqual([]);
  });

  it('ignores the panes of other workers', async () => {
    const made = make({ panes: [alphaPane({ options: { '@worker': 'beta' } })] });
    await seed(made.deps);
    expect(await succeeded(made)).toEqual({ kind: 'no-pane' });
    expect(made.deps.terminated).toEqual([]);
  });
});

describe('worker stop: with the list of panes of a caller', () => {
  const runWith = async (made: Made, panes: readonly PaneRow[]) =>
    stopWorker(made.deps, { home: HOME, session: NODE, workerId: 'alpha', panes });

  const listed = async (made: Made): Promise<readonly PaneRow[]> => {
    const rows = await listPanes(made.deps, NODE);
    if (!rows.ok) throw new Error(rows.error.message);
    return rows.value;
  };

  it('stops the worker with no check of the session and no list of its own', async () => {
    const made = make();
    await seed(made.deps);
    const panes = await listed(made);
    const eventsBefore = made.events.length;
    const callsBefore = made.deps.calls.length;
    const result = await runWith(made, panes);
    expect(result).toMatchObject({ ok: true, value: { kind: 'stopped', paneId: PANE, pid: PID, state: 'idle' } });
    const events = made.events.slice(eventsBefore);
    expect(events).not.toContain('tmux has-session');
    expect(events).not.toContain('tmux show-options');
    expect(made.deps.calls.slice(callsBefore).some((call) => JSON.stringify(call.args) === JSON.stringify(paneListArgs(NODE)))).toBe(false);
    expect(made.deps.terminated).toEqual([PID]);
    expect(killed(made)).toEqual([`kill-pane -t ${PANE}`]);
  });

  it('reads the pane by its id before the signal, so a pane that changed after the list is not trusted', async () => {
    const made = make({ rewriteRead: (stdout) => stdout.replace(`|${PID}|`, '|4888|') });
    await seed(made.deps);
    const panes = await listed(made);
    await runWith(made, panes);
    expect(made.deps.terminated).toEqual([4888]);
  });

  it('says that there is no pane for a list with no pane of the worker, and calls no tmux command', async () => {
    const made = make();
    await seed(made.deps);
    const before = made.events.length;
    expect(await runWith(made, [])).toEqual({ ok: true, value: { kind: 'no-pane' } });
    expect(made.events.slice(before)).toEqual([]);
    expect(made.deps.terminated).toEqual([]);
  });

  it('closes a pane that has ended by its id, from the list', async () => {
    const made = make({ panes: [alphaPane({ dead: true })] });
    await seed(made.deps);
    const panes = await listed(made);
    expect(await runWith(made, panes)).toEqual({ ok: true, value: { kind: 'closed-dead', paneIds: [PANE] } });
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([`kill-pane -t ${PANE}`]);
  });
});

describe('the result type of a stop', () => {
  it('is a CliResult', async () => {
    const made = make();
    await seed(made.deps);
    const result: CliResult<StopOutcome> = await run(made);
    expect(result.ok).toBe(true);
  });
});
