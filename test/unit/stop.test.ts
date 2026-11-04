import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { ok } from '../../src/core/result.js';
import { stopFallback, stopPoll, stopWay, stopWays, schemaIds, type HookEvent } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeWorkerSession, type OwnSessionRead } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { confirmPane, stopCaseOf, stopWorker, wayFor, type StopOutcome } from '../../src/workers/stop.js';
import { createFakeDeps, exited, missingProgram, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const NODE = 'demo';
const SESSION = 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc';
const PANE = '%3';
const PID = 4777;
const AT = '2030-01-02T03:04:05.678Z';

const alphaPane = (change: Partial<PaneFixture> = {}): PaneFixture => ({
  id: PANE,
  session: NODE,
  options: { '@worker': 'alpha' },
  pid: PID,
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
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** What happened, in order: the tmux commands and the `terminate` calls. */
  readonly events: string[];
}

const make = (setup: Setup = {}): Made => {
  const { handler, log } = tmuxHandler({ sessions: { demo: HOME }, panes: setup.panes ?? [alphaPane()], ...setup.tmux });
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

describe('confirmPane: the pane that a second read gives', () => {
  const good = `${PANE}|${PID}|0|alpha\n`;

  it('gives the row of the pane when the id and the mark are the expected ones', () => {
    expect(confirmPane(good, PANE, 'alpha')).toEqual(ok({ paneId: PANE, pid: PID, dead: false, worker: 'alpha' }));
  });

  it('gives the row of a pane that has ended', () => {
    expect(confirmPane(`${PANE}|${PID}|1|alpha\n`, PANE, 'alpha')).toEqual(ok({ paneId: PANE, pid: PID, dead: true, worker: 'alpha' }));
  });

  it.each([
    ['another pane id', `%4|${PID}|0|alpha\n`],
    ['another worker mark', `${PANE}|${PID}|0|beta\n`],
    ['no worker mark', `${PANE}|${PID}|0|\n`],
    ['two lines, the second one forged', `${PANE}|${PID}|0|x\n${PANE}|9999|0|alpha\n`],
    ['a mark with a new line and a forged line behind it', `${PANE}|${PID}|0|alpha\n%9|9999|0|alpha\n`],
    ['a mark with the separator', `${PANE}|${PID}|0|alpha|1|0|alpha\n`],
    ['a trailing empty line', `${good}\n`],
    ['no text', ''],
    ['text that is not a pane line', 'no such pane\n'],
    ['a pid of 0', `${PANE}|0|0|alpha\n`],
  ])('refuses %s', (_name, output) => {
    expect(confirmPane(output, PANE, 'alpha').ok).toBe(false);
  });

  it('does not repeat the text of the read in the reason', () => {
    const result = confirmPane(`${PANE}|${PID}|0|alpha\nSECRET-TEXT\n`, PANE, 'alpha');
    if (result.ok) throw new Error('the read should have been refused');
    expect(result.error).not.toContain('SECRET-TEXT');
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
    const tmux = made.events.filter((event) => event.startsWith('tmux'));
    expect(tmux.filter((event) => event === 'tmux list-panes')).toHaveLength(1);
    expect(made.events.slice(made.events.indexOf('tmux display-message'), made.events.indexOf(`terminate ${PID}`) + 1)).toEqual([
      'tmux display-message',
      `terminate ${PID}`,
    ]);
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

describe('worker stop: never its own pane', () => {
  it('exits 2 when the pane of the caller is the pane of the worker, and reads and signals nothing', async () => {
    const made = make({ env: { TMUX_PANE: PANE } });
    await seed(made.deps);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(PANE);
    expect(made.deps.terminated).toEqual([]);
    expect(made.events).not.toContain('tmux display-message');
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

describe('the result type of a stop', () => {
  it('is a CliResult', async () => {
    const made = make();
    await seed(made.deps);
    const result: CliResult<StopOutcome> = await run(made);
    expect(result.ok).toBe(true);
  });
});
