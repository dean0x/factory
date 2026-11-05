import { failure, notReady, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import type { PaneRow } from '../launch/tmux.js';
import {
  commandLines,
  commandText,
  env,
  roles,
  stopCaseOfState,
  stopFallback,
  stopPoll,
  stopWay,
  stopWays,
  type StopCase,
  type StopWay,
} from '../names.js';
import { promptStateOf, readOwnLastSeen, type OwnSessionRead } from './last-seen.js';
import { requireBoundPane, type BoundPane } from './panes.js';
import { closeWorkerPane, readWorkerPanes } from './slot.js';

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
  /**
   * The list of the panes of the session, from the one list call of a caller that stops more than one worker. The caller has
   * checked that the session runs and belongs to this folder. A call with no list reads the session and the list by itself.
   */
  readonly panes?: readonly PaneRow[];
  /**
   * The cases of the session in which the stop may end the process, read from the last-seen line right before the signal. A session
   * in another case is a failure (exit 1), and nothing is sent. Default: every case of the table. A state that is not known is exit 3
   * for any value.
   */
  readonly allowed?: readonly StopCase[];
  /** The command that a person runs again after a refusal by `allowed`, without the program name. Default: the stop command of the worker. */
  readonly again?: string;
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

/**
 * The case of the session for the table of ways to stop: `idle` for a session that waits at the prompt and `busy` for a session
 * that works. A session whose state is not known, a line with no event, and a line that does not belong to the worker give null:
 * the stop does not guess.
 */
export const stopCaseOf = (read: OwnSessionRead): StopCase | null => {
  if (read.state !== 'valid') return null;
  const state = promptStateOf(read.line);
  return state === null ? null : stopCaseOfState[state];
};

/** The way to stop a session of this case: the safe way of the table, else the fallback of the table. */
export const wayFor = (stopCase: StopCase, ways: Readonly<Record<StopCase, StopWay | null>> = stopWays): StopWay =>
  ways[stopCase] ?? stopFallback;

/** The command that stops the worker, without the program name. */
const stopWords = (workerId: string): string => `${commandLines.workerStop} ${workerId}`;

const stopLine = (workerId: string): string => commandText(stopWords(workerId));

/**
 * The case of the session, or a stop with exit 3 that names the pane and its process: a state that is not known is never guessed.
 * `stopWorker` and the commands that check every worker before the first stop use this one rule.
 */
export const requireStopCase = (
  workerId: string,
  seen: OwnSessionRead,
  pane: { readonly paneId: string; readonly pid: number },
): CliResult<StopCase> => {
  const stopCase = stopCaseOf(seen);
  if (stopCase !== null) return ok(stopCase);
  const reason = seen.state === 'unknown' ? seen.reason : 'the last-seen line holds no event';
  return notReady(
    `cannot tell if the ${roles.worker} ${workerId} waits at its prompt or works: ${reason}. The pane ${pane.paneId} runs the process ${pane.pid}`,
    `Look at the pane. When the ${roles.worker} waits at its prompt, run "${stopLine(workerId)}" again after its next hook event. ` +
      `To stop it now, run "${stopWay.term} ${pane.pid}" yourself.`,
  );
};

/** What the session of a worker is doing in a case of the table, and what the person waits for before the command runs again. */
const sessionWords: Readonly<Record<StopCase, { readonly now: string; readonly wait: string }>> = {
  idle: { now: 'waits at its prompt', wait: 'waits at its prompt' },
  busy: { now: 'is busy: its session works now', wait: 'works' },
};

/** A failure (exit 1) for a case that the caller does not allow, so the stop sends nothing. */
const requireAllowedCase = (workerId: string, stopCase: StopCase, allowed: readonly StopCase[] | undefined, again: string): CliResult<void> =>
  allowed === undefined || allowed.includes(stopCase)
    ? ok(undefined)
    : failure(
        `the ${roles.worker} ${workerId} ${sessionWords[stopCase].now}`,
        `Wait until it ${allowed.map((allowedCase) => sessionWords[allowedCase].wait).join(' or ')}. Run "${commandText(again)}" again.`,
      );

/** Closes panes whose program has ended, by their ids (`closeWorkerPane`). With no pane there is nothing to close. */
const closeEnded = async (deps: Deps, session: string, paneIds: readonly string[]): Promise<CliResult<StopOutcome>> => {
  for (const paneId of paneIds) {
    const closed = await closeWorkerPane(deps, session, paneId);
    if (!closed.ok) return closed;
  }
  return ok(paneIds.length === 0 ? { kind: 'no-pane' } : { kind: 'closed-dead', paneIds });
};

/** Ends the process with the way, and waits for its end for at most `stopPoll.attempts` checks. A process that stays is a failure. */
const endProcess = async (deps: Deps, row: BoundPane, way: StopWay, workerId: string): Promise<CliResult<void>> => {
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
 * 1. one list of the panes of the session finds the panes that carry the mark of the worker, and each of them is read by its id
 *    and bound to the worker (`readWorkerPanes`). The mark is text that a program can set on any pane, so a pane counts only when
 *    tmux says that the launch of this worker made it. A pane with the mark that the launch did not make, the coordinator pane
 *    and the board pane included, is a security stop (exit 4), and nothing is sent to it. Two live panes of the worker are a
 *    stop (exit 2);
 * 2. the pane of the caller is never the target (exit 2), and no pane is signalled then;
 * 3. the last-seen line of the worker says if the session is idle or busy. Any state that is not known is exit 3 and names the
 *    pane and the process, and nothing is sent. A case that the request does not allow (`allowed`) is exit 1, and nothing is sent;
 * 4. the pane is read and bound again right before the signal: the pane id and the pid come from this read, and a read that
 *    fails the binding is a security stop (exit 4);
 * 5. the way of the table for the case ends the process, and the command waits for its end. A pane that ended already gets no signal;
 * 6. the pane is closed by its id. When a summon put the pane in the slot of the view window, the board goes back into the slot
 *    first (`closeWorkerPane`), so the view window keeps its slot.
 * A worker with no pane gives `no-pane` and changes nothing.
 */
export const stopWorker = async (deps: Deps, request: StopRequest): Promise<CliResult<StopOutcome>> => {
  const { home, session, workerId, panes: listed } = request;
  const again = stopWords(workerId);
  const panes = await readWorkerPanes(deps, { home, session, workerId, again, ...(listed === undefined ? {} : { panes: listed }) });
  if (!panes.ok) return panes;
  const { live, dead } = panes.value;
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
  const read = await requireBoundPane(deps, { home, paneId: target.paneId, workerId, again });
  if (!read.ok) return read;
  const row = read.value;
  if (row.dead) return closeEnded(deps, session, [row.paneId]);

  const known = requireStopCase(workerId, seen.value, row);
  if (!known.ok) return known;
  const stopCase = known.value;
  const allowed = requireAllowedCase(workerId, stopCase, request.allowed, request.again ?? again);
  if (!allowed.ok) return allowed;
  const way = wayFor(stopCase);
  const ended = await endProcess(deps, row, way, workerId);
  if (!ended.ok) return ended;
  const closed = await closeWorkerPane(deps, session, row.paneId);
  if (!closed.ok) return closed;
  return ok({ kind: 'stopped', paneId: row.paneId, pid: row.pid, way, state: stopCase, pane: closed.value });
};
