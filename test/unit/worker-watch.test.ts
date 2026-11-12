import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import { schemaIds, watchPoll, watchWords, type HookEvent, type WatchKind } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { branchOf, workCopyOf, writeWorkerRecord } from '../../src/workers/registry.js';
import { watchOutput, watchWorkers, type WatchOutcome } from '../../src/workers/watch.js';
import { createFakeDeps, exited, missingProgram, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { tmuxHandler, type TmuxLog } from '../helpers/tmux-fake.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { atWait, withProgram, type Program } from '../helpers/worker-program.js';

const ALPHA = 'alpha';
const BETA = 'beta';
const SESSION_OF: Readonly<Record<string, string>> = {
  [ALPHA]: 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc',
  [BETA]: 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd',
};
/** The panes of the workers: the first pane after the three panes that a session of the fixture holds. */
const PANE_OF: Readonly<Record<string, string>> = { [ALPHA]: '%3', [BETA]: '%4' };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The tmux verbs that only read. */
const READ_VERBS = ['has-session', 'show-options', 'list-panes', 'display-message'];

interface Setup {
  /** The ids of the recorded workers. Default: alpha. */
  readonly workers?: readonly string[];
  /** The workers that have no pane. */
  readonly noPane?: readonly string[];
  /** The first event of the line of each worker. `null`: no line. Default: `Stop`, a session that waits at its prompt. */
  readonly events?: Readonly<Record<string, HookEvent | null>>;
  /** The home in the option of the tmux session. Default: the home of the node. `null`: no session. */
  readonly sessionHome?: string | null;
  /** The start command of the pane of a worker, in place of the launch of the worker. */
  readonly commands?: Readonly<Record<string, readonly string[]>>;
  /** The panes that are ended at the start. */
  readonly dead?: readonly string[];
  /** A record with a work copy that the program did not write. */
  readonly foreignRecords?: readonly string[];
  /** The list of the panes fails. */
  readonly listFails?: boolean;
  /**
   * When the process of every pane started, in milliseconds after the time of the first lines of the workers. Default: one day before,
   * so every line is later than the start. A positive value is a pane that a resume or a restart started after the line.
   */
  readonly paneStartsAfterLineMs?: number;
  /** The `ps` call that reads the start of a pane process fails. */
  readonly psFails?: boolean;
}

interface World {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** Ends the program of the pane: the pane stays, as with remain-on-exit. */
  readonly end: (paneId: string) => void;
  /** Makes the pane run another program than the launch of its worker. */
  readonly foreign: (paneId: string) => void;
  /** The tmux server removes the pane. */
  readonly kill: (paneId: string) => void;
  /** From now on, the read of a pane fails: tmux does not answer. */
  readonly breakReads: () => void;
  /** From now on, the read of a last-seen line file fails: the file system does not answer. */
  readonly breakLineReads: () => void;
  /** From now on, the `ps` call that reads the start of a pane process works. */
  readonly fixPs: () => void;
  readonly watch: (ids?: readonly string[], program?: Program, readyIds?: readonly string[]) => Promise<CliResult<WatchOutcome>>;
}

const BIND_FACTS = 7;
const fieldsOf = (stdout: string): string[] => stdout.replace(/\n$/, '').split('|');
const withEndedFlag = (stdout: string): string => `${fieldsOf(stdout).map((field, index) => (index === 2 ? '1' : field)).join('|')}\n`;
const withStartCommand = (stdout: string, command: string): string => `${[...fieldsOf(stdout).slice(0, BIND_FACTS), command].join('|')}\n`;

const two = (value: number): string => String(value).padStart(2, '0');

/** An elapsed time as `ps` prints it: whole seconds, with the days in front when there are any. */
const etimeOf = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const days = Math.floor(seconds / 86_400);
  const clock = `${two(Math.floor((seconds % 86_400) / 3600))}:${two(Math.floor((seconds % 3600) / 60))}:${two(seconds % 60)}`;
  return days === 0 ? clock : `${days}-${clock}`;
};

const lineFile = (sessionId: string): string => `${layoutOf(HOME).heartbeatDir}/${sessionId}`;

/** The hook of the session of a worker writes a line: the event at the time of the fake clock, with the marker of the worker or another. */
const writesEvent = async (deps: FakeDeps, id: string, event: HookEvent, marker: string = id): Promise<void> => {
  const sessionId = SESSION_OF[id] ?? '';
  const pointer = await writeWorkerSession(deps, HOME, id, sessionId);
  if (!pointer.ok) throw new Error(pointer.error.message);
  const line = await writeLastSeen(deps, HOME, sessionId, { kind: 'event', event }, marker);
  if (!line.ok) throw new Error(line.error.message);
};

/** The text of a line for the session of alpha that records the marker of another session, as a program in a pane could write it. */
const foreignLineText = (deps: FakeDeps): string =>
  `${JSON.stringify({
    schema: schemaIds.lastSeen,
    session_id: SESSION_OF[ALPHA],
    event: 'Stop',
    event_at: deps.now().toISOString(),
    context_pct: null,
    pct_at: null,
    session_marker: BETA,
  })}\n`;

/** The status line of the session of a worker writes the context percent at the time of the fake clock. */
const writesPercent = async (deps: FakeDeps, id: string): Promise<void> => {
  const line = await writeLastSeen(deps, HOME, SESSION_OF[id] ?? '', { kind: 'percent', percent: 40 }, id);
  if (!line.ok) throw new Error(line.error.message);
};

/** A node with a running tmux session, the records of the workers, a pane for each worker that has one, and the line of each session. */
const make = async (setup: Setup = {}): Promise<World> => {
  const ids = setup.workers ?? [ALPHA];
  const withPane = ids.filter((id) => !(setup.noPane ?? []).includes(id));
  const sessionHome = setup.sessionHome === undefined ? HOME : setup.sessionHome;
  const tmux = tmuxHandler({
    sessions: sessionHome === null ? {} : { [NODE]: sessionHome },
    // The panes belong to the session of the node, so a setup with no such session has no panes.
    panes: (sessionHome === null ? [] : withPane).map((id) => {
      const command = setup.commands?.[id];
      return workerPane(id, {
        id: PANE_OF[id] ?? '',
        ...(command === undefined ? {} : { command }),
        ...((setup.dead ?? []).includes(id) ? { dead: true } : {}),
      });
    }),
  });
  const ended = new Set<string>();
  const foreign = new Set<string>();
  let readsBroken = false;
  let psBroken = setup.psFails === true;
  const run: RunHandler = (call) => {
    if (call.command === 'ps') return psBroken ? exited(1, '', 'no such process') : exited(0, `${etimeOf(deps.now().getTime() - paneStartMs)}\n`);
    if (call.args[0] === 'list-panes' && setup.listFails === true) return exited(1, '', 'no server');
    const result = tmux.handler(call);
    if (call.args[0] !== 'display-message' || !result.ok || result.value.exitCode !== 0) return result;
    if (readsBroken) return missingProgram('tmux');
    const pane = call.args[call.args.indexOf('-t') + 1] ?? '';
    let stdout = result.value.stdout;
    if (ended.has(pane)) stdout = withEndedFlag(stdout);
    if (foreign.has(pane)) stdout = withStartCommand(stdout, 'zsh');
    return exited(0, stdout);
  };
  const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, run });
  const paneStartMs = deps.now().getTime() + (setup.paneStartsAfterLineMs ?? -DAY);
  for (const id of ids) {
    const workCopy = (setup.foreignRecords ?? []).includes(id) ? `${HOME}/elsewhere/${id}` : workCopyOf(HOME, 'web', id);
    const written = await writeWorkerRecord(deps, HOME, { id, project: 'web', workCopy, branch: branchOf(id) });
    if (!written.ok) throw new Error(written.error.message);
    const event = setup.events === undefined || !(id in setup.events) ? 'Stop' : setup.events[id];
    if (event !== null && event !== undefined) await writesEvent(deps, id, event);
  }
  let lineReadsBroken = false;
  const heartbeatDir = layoutOf(HOME).heartbeatDir;
  const watchDeps: FakeDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      readTextLimited: async (path, maxBytes) =>
        lineReadsBroken && path.startsWith(`${heartbeatDir}/`) ? failure(`cannot read ${path}: EIO`) : deps.fs.readTextLimited(path, maxBytes),
    },
  };
  return {
    deps,
    tmux: tmux.log,
    end: (paneId) => void ended.add(paneId),
    foreign: (paneId) => void foreign.add(paneId),
    kill: (paneId) => void tmux.handler({ command: 'tmux', args: ['kill-pane', '-t', paneId], cwd: undefined }),
    breakReads: () => {
      readsBroken = true;
    },
    breakLineReads: () => {
      lineReadsBroken = true;
    },
    fixPs: () => {
      psBroken = false;
    },
    watch: (workerIds = [], program, readyIds = []) =>
      watchWorkers(program === undefined ? watchDeps : withProgram(watchDeps, tmux.log, program), {
        home: HOME,
        config: sampleConfig(),
        workerIds,
        readyIds,
      }),
  };
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the watch passed');
  return result.error;
};

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`the watch failed: ${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const codeOf = (error: CliError): number => exitCodeOf[error.kind];
const textOf = (error: CliError): string => `${error.message} ${error.hint ?? ''}`;

const changedOf = (outcome: WatchOutcome) => {
  if (outcome.kind !== 'changed') throw new Error(`expected a change, but the outcome is ${outcome.kind}`);
  return outcome;
};

/** The files and the count of atomic writes of a world, to compare after a watch. */
const snapshotOf = (world: World) => ({ files: new Map(world.deps.files), atomicWrites: world.deps.atomicWrites.length });

/** The watch reads and never acts: every tmux call is a read, no process got a signal, and no file changed. */
const expectReadOnly = (world: World, before: ReturnType<typeof snapshotOf>): void => {
  const verbs = world.tmux.commands().map((command) => command.split(' ')[0] ?? '');
  expect(verbs.filter((verb) => !READ_VERBS.includes(verb))).toEqual([]);
  expect(world.tmux.typed()).toEqual([]);
  expect(world.deps.terminated).toEqual([]);
  expect(snapshotOf(world)).toEqual(before);
};

describe('TP-29: the checks of the watch', () => {
  it('TP-29: with no change it waits 40 times 30000 ms, and then says NO CHANGE', async () => {
    const world = await make();
    const outcome = valueOf(await world.watch());
    expect(outcome).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
    expect(world.deps.sleeps).toEqual(Array.from({ length: 40 }, () => 30_000));
    expect(watchPoll).toMatchObject({ attempts: 40, intervalMs: 30_000 });
  });

  it.each<[string, WatchKind, (world: World) => void | Promise<void>]>([
    ['the pane ended', 'ended', (world) => world.end(PANE_OF[ALPHA] ?? '')],
    ['the pane is gone', 'gone', (world) => world.kill(PANE_OF[ALPHA] ?? '')],
    ['the pane runs another program', 'other', (world) => world.foreign(PANE_OF[ALPHA] ?? '')],
    ['the line is not valid', 'lineNotValid', (world) => void world.deps.seed(lineFile(SESSION_OF[ALPHA] ?? ''), 'not json')],
    ['the line belongs to another session', 'lineNotOwned', (world) => void world.deps.seed(lineFile(SESSION_OF[ALPHA] ?? ''), foreignLineText(world.deps))],
    ['a dialog waits', 'waits', (world) => writesEvent(world.deps, ALPHA, 'Notification')],
  ])('TP-29: %s, and the watch ends at that check with the kind %s', async (_name, kind, change) => {
    const world = await make();
    const outcome = changedOf(valueOf(await world.watch([], atWait(3, () => change(world)))));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind }]);
    expect(outcome.checks).toBe(3);
    expect(world.deps.sleeps).toHaveLength(3);
  });

  it('TP-29: a session that works for more than 15 minutes with no event and no percent is stalled at the first check past 15 minutes', async () => {
    const world = await make({ events: { [ALPHA]: 'PreToolUse' } });
    const outcome = changedOf(valueOf(await world.watch()));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'stalled' }]);
    // 30 checks of 30 s make exactly 15 minutes, which is not more than 15 minutes.
    expect(outcome.checks).toBe((15 * MINUTE) / watchPoll.intervalMs + 1);
  });

  it('TP-29: a context percent that is newer than the event keeps a working session from being stalled', async () => {
    const world = await make({ events: { [ALPHA]: 'UserPromptSubmit' } });
    const outcome = valueOf(await world.watch([], atWait(20, () => writesPercent(world.deps, ALPHA))));
    expect(outcome.kind).toBe('no-change');
  });

  it('TP-29: a session at its prompt is never stalled', async () => {
    const world = await make({ events: { [ALPHA]: 'Stop' } });
    expect(valueOf(await world.watch()).kind).toBe('no-change');
  });

  it('TP-29: a change from busy to prompt and back is not a change', async () => {
    const world = await make({ events: { [ALPHA]: 'PreToolUse' } });
    const program: Program = async ({ count, deps }) => {
      await writesEvent(deps, ALPHA, count % 2 === 0 ? 'PreToolUse' : 'Stop');
    };
    const outcome = valueOf(await world.watch([], program));
    expect(outcome).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
  });

  it('TP-29: no tmux call types, signals or writes, in a watch with no change and in a watch with a change', async () => {
    const quiet = await make();
    const quietBefore = snapshotOf(quiet);
    valueOf(await quiet.watch());
    expectReadOnly(quiet, quietBefore);

    const changed = await make();
    const changedBefore = snapshotOf(changed);
    changedOf(valueOf(await changed.watch([], atWait(2, () => changed.end(PANE_OF[ALPHA] ?? '')))));
    expectReadOnly(changed, changedBefore);
  });

  it('TP-29: the watch never reads the screen of a pane', async () => {
    const world = await make();
    valueOf(await world.watch());
    expect(world.tmux.commands().filter((command) => command.startsWith('capture-pane'))).toEqual([]);
  });
});

describe('TP-30: the baseline of the watch', () => {
  it.each<[string, Setup, WatchKind]>([
    ['a dialog waits', { events: { [ALPHA]: 'Notification' } }, 'waits'],
    ['the pane ended', { dead: [ALPHA] }, 'ended'],
    ['the pane runs another program', { commands: { [ALPHA]: ['zsh'] } }, 'other'],
  ])('TP-30: when %s at the baseline, the watch ends with 0 sleeps', async (_name, setup, kind) => {
    const world = await make(setup);
    const outcome = changedOf(valueOf(await world.watch()));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind }]);
    expect(outcome.checks).toBe(0);
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-30: a line of another session at the baseline is a change at once, with no grace', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION_OF[ALPHA] ?? ''), foreignLineText(world.deps));
    const outcome = changedOf(valueOf(await world.watch()));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'lineNotOwned' }]);
    expect(outcome.checks).toBe(0);
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-30: a worker with no line yet is not a change at the baseline, and it is a change at check 2 when no line comes', async () => {
    const world = await make({ events: { [ALPHA]: null } });
    const outcome = changedOf(valueOf(await world.watch()));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'lineNotValid' }]);
    expect(outcome.checks).toBe(2);
    expect(world.deps.sleeps).toEqual([30_000, 30_000]);
    expect(watchPoll.lineGraceChecks).toBe(2);
  });

  it('TP-30: a worker with no line at the baseline and a valid line from check 1 stays quiet for all 40 checks', async () => {
    const world = await make({ events: { [ALPHA]: null } });
    const outcome = valueOf(await world.watch([], atWait(1, () => writesEvent(world.deps, ALPHA, 'Stop'))));
    expect(outcome).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
    expect(world.deps.sleeps).toHaveLength(40);
  });

  it.each([1, 3])('TP-30: a line that was valid at the baseline and is missing at check %i is a change at that check', async (count) => {
    const world = await make();
    const outcome = changedOf(valueOf(await world.watch([], atWait(count, () => void world.deps.files.delete(lineFile(SESSION_OF[ALPHA] ?? ''))))));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'lineNotValid' }]);
    expect(outcome.checks).toBe(count);
    expect(world.deps.sleeps).toHaveLength(count);
  });

  it('TP-30: a worker with no pane at the baseline is not checked, and it does not end the watch', async () => {
    const world = await make({ workers: [ALPHA, BETA], noPane: [BETA], events: { [BETA]: 'Notification' } });
    const outcome = valueOf(await world.watch());
    expect(outcome).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
    expect(world.deps.sleeps).toHaveLength(40);
  });

  it('TP-30: when no recorded worker has a pane, the watch ends with 0 sleeps and says NO WORKER', async () => {
    const world = await make({ noPane: [ALPHA] });
    expect(valueOf(await world.watch())).toEqual({ kind: 'no-worker' });
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-30: every worker that changed at the same check is in the report, in the order of the ids', async () => {
    const world = await make({ workers: [ALPHA, BETA], events: { [ALPHA]: 'Notification', [BETA]: 'Notification' } });
    const outcome = changedOf(valueOf(await world.watch([BETA, ALPHA])));
    expect(outcome.changes).toEqual([
      { workerId: BETA, kind: 'waits' },
      { workerId: ALPHA, kind: 'waits' },
    ]);
  });

  it('TP-30: the workers of the command line are the only ones that the watch checks', async () => {
    const world = await make({ workers: [ALPHA, BETA], events: { [BETA]: 'Notification' } });
    expect(valueOf(await world.watch([ALPHA]))).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
  });

  it('TP-30: an id that stands twice on the command line is checked once', async () => {
    const world = await make();
    expect(valueOf(await world.watch([ALPHA, ALPHA]))).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
  });
});

describe('TP-30: a worker of --ready waits out its block', () => {
  it('TP-30: a worker with no line that gets a line at its prompt at check 3 is ready at that check', async () => {
    const world = await make({ events: { [ALPHA]: null } });
    const outcome = changedOf(valueOf(await world.watch([], atWait(3, () => writesEvent(world.deps, ALPHA, 'SessionStart')), [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'readyAfterBlock' }]);
    expect(outcome.checks).toBe(3);
    expect(world.deps.sleeps).toHaveLength(3);
  });

  it('TP-30: a worker at a dialog that turns busy is ready, and the dialog is no change for it', async () => {
    const world = await make({ events: { [ALPHA]: 'Notification' } });
    const outcome = changedOf(valueOf(await world.watch([], atWait(2, () => writesEvent(world.deps, ALPHA, 'UserPromptSubmit')), [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'readyAfterBlock' }]);
    expect(outcome.checks).toBe(2);
  });

  it('TP-30: a worker that stays blocked gives no change after the 40 checks, also past the grace of a missing line', async () => {
    const world = await make({ events: { [ALPHA]: null } });
    expect(valueOf(await world.watch([], undefined, [ALPHA]))).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
    expect(world.deps.sleeps).toHaveLength(40);
  });

  it('TP-30: a worker that is already at its prompt is ready at the baseline, with no sleep', async () => {
    const world = await make();
    const outcome = changedOf(valueOf(await world.watch([], undefined, [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'readyAfterBlock' }]);
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-30: the end of the pane of a blocked worker stays a change', async () => {
    const world = await make({ events: { [ALPHA]: null } });
    const outcome = changedOf(valueOf(await world.watch([], atWait(2, () => world.end(PANE_OF[ALPHA] ?? '')), [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'ended' }]);
  });

  it('TP-30: a line of another session stays a change for a worker of --ready', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION_OF[ALPHA] ?? ''), foreignLineText(world.deps));
    const outcome = changedOf(valueOf(await world.watch([], undefined, [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'lineNotOwned' }]);
  });

  it('TP-30: the other workers keep their rules while one worker waits to be ready', async () => {
    const world = await make({ workers: [ALPHA, BETA], events: { [ALPHA]: null } });
    const outcome = changedOf(valueOf(await world.watch([], atWait(1, () => writesEvent(world.deps, BETA, 'Notification')), [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: BETA, kind: 'waits' }]);
  });

  it('TP-30: a worker of --ready is watched also when the command line names other workers only', async () => {
    const world = await make({ workers: [ALPHA, BETA], events: { [ALPHA]: null } });
    const outcome = changedOf(valueOf(await world.watch([BETA], atWait(1, () => writesEvent(world.deps, ALPHA, 'Stop')), [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'readyAfterBlock' }]);
  });

  it('TP-30: an id of --ready with no record is refused before any wait', async () => {
    const world = await make();
    const error = errorOf(await world.watch([], undefined, ['ghost']));
    expect(codeOf(error)).toBe(2);
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-30: the report of a ready worker is one line with fixed words and the id, and the JSON names the kind', () => {
    const output = watchOutput({ kind: 'changed', changes: [{ workerId: ALPHA, kind: 'readyAfterBlock' }], checks: 3 });
    expect(output.lines).toEqual([{ level: 'warn', text: 'CHANGED: alpha ready' }]);
    expect(output.json).toEqual({
      schema: schemaIds.workerWatch,
      result: 'changed',
      checks: 3,
      changes: [{ id: ALPHA, kind: 'readyAfterBlock' }],
    });
  });

  it('TP-30: a line that is not valid is no change for a worker of --ready, as an absent line is', async () => {
    const world = await make();
    world.deps.seed(lineFile(SESSION_OF[ALPHA] ?? ''), 'not json');
    expect(valueOf(await world.watch([], undefined, [ALPHA]))).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
  });
});

describe('TP-30: a worker of --ready is ready only for a line of the session that runs now', () => {
  const psCalls = (world: World) => world.deps.calls.filter((call) => call.command === 'ps');

  it('TP-30: a line at the prompt from before the start of the pane is no change, also after the 40 checks', async () => {
    // A resume or a restart started the pane process after the line, and the new session has written no line yet.
    const world = await make({ paneStartsAfterLineMs: 30_000 });
    world.deps.advance(MINUTE);
    expect(valueOf(await world.watch([], undefined, [ALPHA]))).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
  });

  it.each<[string, HookEvent]>([
    ['at its prompt', 'Stop'],
    ['busy', 'UserPromptSubmit'],
  ])('TP-30: a line %s from before the start of the pane is no change, and the first line of the new session is ready', async (_name, event) => {
    const world = await make({ events: { [ALPHA]: event }, paneStartsAfterLineMs: 30_000 });
    world.deps.advance(MINUTE);
    const outcome = changedOf(valueOf(await world.watch([], atWait(2, () => writesEvent(world.deps, ALPHA, 'SessionStart')), [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'readyAfterBlock' }]);
    expect(outcome.checks).toBe(2);
  });

  it('TP-30: a line that is not later than the start of the pane is no change', async () => {
    const world = await make({ paneStartsAfterLineMs: 0 });
    expect(valueOf(await world.watch([], undefined, [ALPHA])).kind).toBe('no-change');
  });

  it('TP-30: the start of the pane is read with ps for the pid of the pane', async () => {
    const world = await make();
    changedOf(valueOf(await world.watch([], undefined, [ALPHA])));
    const pid = world.tmux.panes().find((pane) => pane.id === PANE_OF[ALPHA])?.pid;
    expect(pid).toBeDefined();
    expect(psCalls(world)).toHaveLength(1);
    expect(psCalls(world)[0]).toMatchObject({ args: ['-o', 'etime=', '-p', String(pid)] });
  });

  it('TP-30: a start of the pane that can not be read is no change, and the next check reads it again', async () => {
    const world = await make({ psFails: true });
    const outcome = changedOf(valueOf(await world.watch([], atWait(2, () => world.fixPs()), [ALPHA])));
    expect(outcome.changes).toEqual([{ workerId: ALPHA, kind: 'readyAfterBlock' }]);
    expect(outcome.checks).toBe(2);
  });

  it('TP-30: a start of the pane that is never readable gives no change, with one ps call for each check', async () => {
    const world = await make({ psFails: true });
    expect(valueOf(await world.watch([], undefined, [ALPHA]))).toEqual({ kind: 'no-change', workerIds: [ALPHA], checks: 40 });
    expect(psCalls(world)).toHaveLength(watchPoll.attempts + 1);
  });

  it('TP-30: the pane of a worker that is not of --ready is never read with ps', async () => {
    const world = await make();
    valueOf(await world.watch());
    expect(psCalls(world)).toEqual([]);
  });

  it('TP-30: a worker of --ready that is not ready, for example at a dialog, needs no ps call', async () => {
    const world = await make({ events: { [ALPHA]: 'Notification' } });
    valueOf(await world.watch([], undefined, [ALPHA]));
    expect(psCalls(world)).toEqual([]);
  });
});

describe('TP-31: the exits of the watch', () => {
  it('TP-31: no tmux session is exit 3, and the remedy is start', async () => {
    const world = await make({ sessionHome: null });
    const error = errorOf(await world.watch());
    expect(codeOf(error)).toBe(3);
    expect(textOf(error)).toContain('factory start');
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-31: a tmux session of another factory folder is exit 4', async () => {
    const world = await make({ sessionHome: '/w/other' });
    expect(codeOf(errorOf(await world.watch()))).toBe(4);
  });

  it('TP-31: a list of panes that tmux does not give is exit 1', async () => {
    const world = await make({ listFails: true });
    const error = errorOf(await world.watch());
    expect(codeOf(error)).toBe(1);
    expect(textOf(error)).toContain('list-panes');
  });

  it('TP-31: a read of a pane that fails in a check is exit 1', async () => {
    const world = await make();
    const error = errorOf(await world.watch([], atWait(2, () => world.breakReads())));
    expect(codeOf(error)).toBe(1);
    expect(world.deps.sleeps).toHaveLength(2);
  });

  it('TP-31: a read of the line file that fails in a check is exit 1, and the watch makes no more waits', async () => {
    const world = await make();
    const error = errorOf(await world.watch([], atWait(1, () => world.breakLineReads())));
    expect(codeOf(error)).toBe(1);
    expect(textOf(error)).toContain('EIO');
    expect(world.deps.sleeps).toEqual([30_000]);
  });

  it.each([['a worker with no record', 'ghost'], ['an id that is not a slug', '../alpha']])('TP-31: %s is exit 2 and names the worker list', async (_name, id) => {
    const world = await make();
    const error = errorOf(await world.watch([ALPHA, id]));
    expect(codeOf(error)).toBe(2);
    expect(textOf(error)).toContain('factory worker list');
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-31: a record that the program did not write is exit 4', async () => {
    const world = await make({ foreignRecords: [ALPHA] });
    const error = errorOf(await world.watch([ALPHA]));
    expect(codeOf(error)).toBe(4);
    expect(world.deps.sleeps).toEqual([]);
  });

  it('TP-31: with no recorded worker the watch exits 0 with the one line NO WORKER', async () => {
    const world = await make({ workers: [] });
    const outcome = valueOf(await world.watch());
    expect(outcome).toEqual({ kind: 'no-worker' });
    expect(world.deps.sleeps).toEqual([]);
    expect(watchOutput(outcome)).toMatchObject({
      lines: [{ level: 'ok', text: `${watchWords.noWorker} ${watchWords.noPane}` }],
      failed: false,
    });
  });
});

describe('TP-31: the output of the watch', () => {
  it('TP-31: a change is one line for each worker with fixed words and the id, and the JSON object is the worker-watch object, version 1', () => {
    const output = watchOutput({
      kind: 'changed',
      checks: 3,
      changes: [
        { workerId: ALPHA, kind: 'waits' },
        { workerId: BETA, kind: 'stalled' },
      ],
    });
    expect(output.lines).toEqual([
      { level: 'warn', text: 'CHANGED: alpha waits' },
      { level: 'warn', text: 'CHANGED: beta stalled?' },
    ]);
    expect(output.json).toEqual({
      schema: schemaIds.workerWatch,
      result: 'changed',
      checks: 3,
      changes: [
        { id: ALPHA, kind: 'waits' },
        { id: BETA, kind: 'stalled' },
      ],
    });
    expect(output).toMatchObject({ warnings: [], failed: false });
    expect(schemaIds.workerWatch).toBe('factory.worker-watch/v1');
  });

  it('TP-31: no change is one line with the ids of the workers that were watched', () => {
    const output = watchOutput({ kind: 'no-change', workerIds: [ALPHA, BETA], checks: 40 });
    expect(output.lines).toEqual([{ level: 'ok', text: 'NO CHANGE: alpha beta' }]);
    expect(output.json).toEqual({ schema: schemaIds.workerWatch, result: 'no-change', checks: 40, workers: [ALPHA, BETA] });
    expect(output.failed).toBe(false);
  });

  it('TP-31: no worker is one line and a JSON object with no worker', () => {
    const output = watchOutput({ kind: 'no-worker' });
    expect(output.lines).toEqual([{ level: 'ok', text: 'NO WORKER: no worker has a pane to watch' }]);
    expect(output.json).toEqual({ schema: schemaIds.workerWatch, result: 'no-worker' });
    expect(output.failed).toBe(false);
  });

  it.each(Object.entries(watchWords.kinds))('TP-31: the kind %s has its own fixed words', (kind, words) => {
    const output = watchOutput({ kind: 'changed', checks: 1, changes: [{ workerId: ALPHA, kind: kind as WatchKind }] });
    expect(output.lines).toEqual([{ level: 'warn', text: `CHANGED: ${ALPHA} ${words}` }]);
  });
});

describe('TP-39: the output of the watch is short, and its size is in the token budget (row 14)', () => {
  const changed: WatchOutcome = {
    kind: 'changed',
    checks: 3,
    changes: [
      { workerId: ALPHA, kind: 'waits' },
      { workerId: BETA, kind: 'stalled' },
    ],
  };

  it.each<[string, WatchOutcome]>([
    ['a change', changed],
    ['no change', { kind: 'no-change', workerIds: [ALPHA, BETA], checks: 40 }],
    ['no worker', { kind: 'no-worker' }],
  ])('TP-39: the output of %s passes the short-output check', (_name, outcome) => {
    expectShortOutput(plainText(watchOutput(outcome)));
  });

  it('TP-39: the size of the output of two changes on this fixture is the value of the row 14', () => {
    const text = plainText(watchOutput(changed));
    const row = budgetRow(14);
    expect(row.command).toContain('`factory worker watch`');
    expect(row.measured).toBe(tokensOf(text));
    expect(tokensOf(text)).toBeLessThanOrEqual(row.budget);
  });
});
