import { failure, notReady, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';
import { paneReadArgs, parsePaneList, type PaneRow } from '../launch/tmux.js';
import { tmuxStep } from '../launch/tmux-run.js';
import {
  commandLines,
  commandText,
  env,
  roles,
  stopFallback,
  stopPoll,
  stopWay,
  stopWays,
  type StopCase,
  type StopWay,
} from '../names.js';
import { promptStateOf, readOwnLastSeen, type OwnSessionRead } from './last-seen.js';
import { readPanes } from './panes.js';
import { closeWorkerPane } from './slot.js';

/**
 * The stop of one worker (design 4.11, docs/session-stop.md): `worker stop` and, later, shutdown, restart, reboot and dismiss
 * call `stopWorker`. It ends the program of the pane of the worker with the way that the table of docs/session-stop.md gives
 * for the case of the session, waits for the process to end, and closes the pane. It never sends KILL, and it never ends the
 * pane that it runs in.
 */

export interface StopRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  /** The tmux session of the node: the id of the node. */
  readonly session: string;
  /** The id of the worker: a slug. The caller has checked that the worker has a record. */
  readonly workerId: string;
}

export type StopOutcome =
  /** The worker has no pane: nothing runs, and nothing was changed. */
  | { readonly kind: 'no-pane' }
  /** The program of the pane had ended already. The pane is closed, and no signal was sent. */
  | { readonly kind: 'closed-dead'; readonly paneIds: readonly string[] }
  | {
      readonly kind: 'stopped';
      readonly paneId: string;
      /** The pid that tmux gave when the pane was read again, right before the signal. */
      readonly pid: number;
      readonly way: StopWay;
      readonly state: StopCase;
      /** `closed`: this call closed the pane. `gone`: tmux had removed it when the process ended. */
      readonly pane: 'closed' | 'gone';
    };

const CASE_OF_STATE = { prompt: 'idle', busy: 'busy' } as const satisfies Readonly<Record<'prompt' | 'busy', StopCase>>;

/**
 * The case of the session for the table of ways to stop: `idle` for a session that waits at the prompt and `busy` for a session
 * that works. A session whose state is not known, a line with no event, and a line that does not belong to the worker give null:
 * the stop does not guess.
 */
export const stopCaseOf = (read: OwnSessionRead): StopCase | null => {
  if (read.state !== 'valid') return null;
  const state = promptStateOf(read.line);
  return state === null ? null : CASE_OF_STATE[state];
};

/** The way to stop a session of this case: the safe way of the table, else the fallback of the table. */
export const wayFor = (stopCase: StopCase, ways: Readonly<Record<StopCase, StopWay | null>> = stopWays): StopWay =>
  ways[stopCase] ?? stopFallback;

/**
 * Checks the output of `paneReadArgs`: it must be the one line of the pane that the caller means, with the mark of the worker. The
 * output of a pane whose mark holds a new line has more than one line, and the output with the separator in the mark does not
 * parse, so a mark that a program in the pane wrote can never pass for a line of another pane. The error holds no text of the output.
 */
export const confirmPane = (output: string, paneId: string, workerId: string): Result<PaneRow, string> => {
  const rows = parsePaneList(output);
  const [row, ...rest] = rows.ok ? rows.value : [];
  if (row === undefined || rest.length > 0) return err('the read gives text that is not the line of one pane');
  if (row.paneId !== paneId) return err('the read gives another pane');
  if (row.worker !== workerId) return err(`the mark of the pane is not the id of the ${roles.worker}`);
  return ok(row);
};

const stopLine = (workerId: string): string => `${commandText(commandLines.workerStop)} ${workerId}`;

/** The live panes and the ended panes that carry the mark of the worker. */
const marked = (rows: readonly PaneRow[], workerId: string): { readonly live: readonly PaneRow[]; readonly dead: readonly PaneRow[] } => {
  const own = rows.filter((row) => row.worker === workerId);
  return { live: own.filter((row) => !row.dead), dead: own.filter((row) => row.dead) };
};

/** Closes panes whose program has ended, by their ids (`closeWorkerPane`). With no pane there is nothing to close. */
const closeEnded = async (deps: Deps, session: string, paneIds: readonly string[]): Promise<CliResult<StopOutcome>> => {
  for (const paneId of paneIds) {
    const closed = await closeWorkerPane(deps, session, paneId);
    if (!closed.ok) return closed;
  }
  return ok(paneIds.length === 0 ? { kind: 'no-pane' } : { kind: 'closed-dead', paneIds });
};

/**
 * Reads the one pane again. The list that found the pane can hold a forged line, because the worker mark is text that a program
 * in a pane can set. The pane id, the mark and the pid that this read gives are the ones that the stop uses.
 */
const readPaneAgain = async (deps: Deps, paneId: string, workerId: string): Promise<CliResult<PaneRow>> => {
  const args = paneReadArgs(paneId);
  if (!args.ok) return failure(args.error);
  const read = await tmuxStep(deps, args.value);
  if (!read.ok) {
    return failure(`cannot read the pane ${paneId}: ${read.error.message}`, `The pane may have ended. Run "${stopLine(workerId)}" again.`);
  }
  const confirmed = confirmPane(read.value, paneId, workerId);
  return confirmed.ok
    ? ok(confirmed.value)
    : safetyRefusal(
        `the pane ${paneId} does not show the mark of the ${roles.worker} ${workerId} when it is read again: ${confirmed.error}`,
        `Look at the panes in tmux, and close a pane that carries a wrong mark. Then run "${stopLine(workerId)}" again.`,
      );
};

/** Ends the process with the way, and waits for its end for at most `stopPoll.attempts` checks. A process that stays is a failure. */
const endProcess = async (deps: Deps, row: PaneRow, way: StopWay, workerId: string): Promise<CliResult<void>> => {
  switch (way) {
    case stopWay.term: {
      const sent = deps.terminate(row.pid);
      if (!sent.ok) {
        return failure(sent.error.message, `Look at the pane ${row.paneId}. The command sent no other signal.`);
      }
      if (sent.value === 'gone') return ok(undefined);
      for (let attempt = 0; attempt < stopPoll.attempts; attempt += 1) {
        await deps.sleep(stopPoll.intervalMs);
        const running = deps.isRunning(row.pid);
        if (!running.ok) return running;
        if (!running.value) return ok(undefined);
      }
      const seconds = (stopPoll.attempts * stopPoll.intervalMs) / 1000;
      return failure(
        `the process ${row.pid} of the pane ${row.paneId} did not end within ${seconds} seconds after the signal TERM`,
        `The command never sends KILL. Look at the pane ${row.paneId}. Run "${stopLine(workerId)}" again, or end the process yourself.`,
      );
    }
    default: {
      const unreachable: never = way;
      return unreachable;
    }
  }
};

/**
 * Stops the worker. In order:
 * 1. one list of the panes of the session finds the pane of the worker. Two live panes with the mark are a stop (exit 2): the
 *    mark is text that a program can set, so the command does not choose between them;
 * 2. the pane of the caller is never the target (exit 2), and no pane is read or signalled then;
 * 3. the last-seen line of the worker says if the session is idle or busy. Any state that is not known is exit 3 and names the
 *    pane and the process, and nothing is sent;
 * 4. the pane is read again by its id: the pane id, the mark and the pid come from this read, and a read that differs from the
 *    list is a security stop (exit 4);
 * 5. the way of the table for the case ends the process, and the command waits for its end. A pane that ended already gets no signal;
 * 6. the pane is closed by its id. When a summon put the pane in the slot of the view window, the board goes back into the slot
 *    first (`closeWorkerPane`), so the view window keeps its slot.
 * A worker with no pane gives `no-pane` and changes nothing.
 */
export const stopWorker = async (deps: Deps, request: StopRequest): Promise<CliResult<StopOutcome>> => {
  const { home, session, workerId } = request;
  const panes = await readPanes(deps, session, home);
  if (!panes.ok) return panes;
  const { live, dead } = marked(panes.value ?? [], workerId);
  if (live.length > 1) {
    return usageError(
      `the ${roles.worker} ${workerId} has ${live.length} live panes: ${live.map((row) => row.paneId).join(', ')}`,
      `Close all but one of these panes in tmux. Then run "${stopLine(workerId)}" again.`,
    );
  }
  const [target] = live;
  if (target === undefined) return closeEnded(deps, session, dead.map((row) => row.paneId));
  if (deps.env[env.tmuxPane] === target.paneId) {
    return usageError(
      `cannot stop the ${roles.worker} ${workerId} from its own pane ${target.paneId}`,
      `Run "${stopLine(workerId)}" in another pane or in another terminal window.`,
    );
  }

  const seen = await readOwnLastSeen(deps, home, workerId);
  if (!seen.ok) return seen;
  const read = await readPaneAgain(deps, target.paneId, workerId);
  if (!read.ok) return read;
  const row = read.value;
  if (row.dead) return closeEnded(deps, session, [row.paneId]);

  const stopCase = stopCaseOf(seen.value);
  if (stopCase === null) {
    const reason = seen.value.state === 'unknown' ? seen.value.reason : 'the last-seen line holds no event';
    return notReady(
      `cannot tell if the ${roles.worker} ${workerId} waits at its prompt or works: ${reason}. The pane ${row.paneId} runs the process ${row.pid}`,
      `Look at the pane. When the ${roles.worker} waits at its prompt, run "${stopLine(workerId)}" again after its next hook event. ` +
        `To stop it now, run "${stopWay.term} ${row.pid}" yourself.`,
    );
  }
  const way = wayFor(stopCase);
  const ended = await endProcess(deps, row, way, workerId);
  if (!ended.ok) return ended;
  const closed = await closeWorkerPane(deps, session, row.paneId);
  if (!closed.ok) return closed;
  return ok({ kind: 'stopped', paneId: row.paneId, pid: row.pid, way, state: stopCase, pane: closed.value });
};
