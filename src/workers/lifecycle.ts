import { err, ok } from '../core/result.js';
import { failure, notReady, usageError, type CliError, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { killSessionArgs, type PaneRow } from '../launch/tmux.js';
import { tmuxStep } from '../launch/tmux-run.js';
import { commandLines, commands, commandText, env, lastSeen, roles, type CommandName } from '../names.js';
import { clearActiveMark, type ClearOutcome } from '../state/active-machine.js';
import { readOwnLastSeen, type OwnSessionRead } from './last-seen.js';
import { chooseProxy, requireCleanSettings, requireWorkCopy, type ProxyAnswers, type ProxyWish } from './launch.js';
import type { BoundPane } from './panes.js';
import type { WorkerRecord } from './registry.js';
import { readWorkerPanes } from './slot.js';
import { requireStopCase, stopWorker } from './stop.js';

/**
 * The shared steps of `shutdown`, `restart` and `reboot` (design 4.11, "The lifecycle verbs"). A command reads the list of the
 * panes of its session once. It checks every worker that it will stop or start again (`checkTargets`) before the first stop, so a
 * failed check leaves everything as it was. The check reads the panes of each worker as the stop reads them, so a pane that the
 * launch did not make, a pane in the view window that no summon put there and two live panes are faults of the check. Then each
 * worker stops one at a time with the list (`stopWorkers`), and the stop reads its panes again right before the signal. After the
 * checks, a stop can still fail (a process that does not end, a pane that changed since the check): the error then names the
 * workers that stopped before it (`withStopped`).
 */

const keys = lastSeen.keys;

/** The ids of the workers that have a pane in the list, live or ended, in order of the ids. */
export const workersWithPanes = (panes: readonly PaneRow[]): readonly string[] =>
  [...new Set(panes.flatMap((row) => (row.worker === null ? [] : [row.worker])))].sort();

/** True when the pane of the caller (`TMUX_PANE`) is a pane of the list: the caller runs inside this session. */
export const runsInside = (deps: Deps, panes: readonly PaneRow[]): boolean => {
  const own = deps.env[env.tmuxPane];
  return own !== undefined && panes.some((row) => row.paneId === own);
};

/** The id of the session that a worker resumes: only an id that passed the owner check (exit 3 for any other state). */
const resumeIdOf = (id: string, seen: OwnSessionRead): CliResult<string> =>
  seen.state === 'valid'
    ? ok(seen.line[keys.sessionId])
    : notReady(
        `the ${roles.worker} ${id} has no session id that it may resume: ${seen.reason}`,
        `To start it with a new conversation, end its pane. Then run "${commandText(commandLines.workerResume)} ${id}".`,
      );

/** A command never ends the pane that it runs in (exit 2): the stop would end the command with it. */
export const requireOtherPane = (deps: Deps, id: string, pane: { readonly paneId: string }, again: string): CliResult<void> =>
  deps.env[env.tmuxPane] === pane.paneId
    ? usageError(
        `cannot end the ${roles.worker} ${id} from its own pane ${pane.paneId}`,
        `Run "${commandText(again)}" in another pane or in another terminal window.`,
      )
    : ok(undefined);

/** The deps of a check that prints no warning: the launch that follows prints the warnings of the work copy. */
const withoutWarnings = (deps: Deps): Deps => ({ ...deps, warn: () => undefined });

/** The work copy and its settings files, checked before a stop so that the launch after the stop has no reason to fail. */
const requireLaunchable = async (deps: Deps, home: string, record: WorkerRecord): Promise<CliResult<void>> => {
  const folder = await requireWorkCopy(deps, home, record.id, record.workCopy);
  if (!folder.ok) return folder;
  return requireCleanSettings(withoutWarnings(deps), home, record.workCopy);
};

export interface TargetCheck {
  /** The factory folder: an absolute path. */
  readonly home: string;
  /** The tmux session of the node: the id of the node. */
  readonly session: string;
  /** The command that a person runs in another pane, without the program name (`commandText` adds it). */
  readonly again: string;
  /** The list of the panes of the session. Empty when no session runs. */
  readonly panes: readonly PaneRow[];
  /** The workers that start again after the stop. Their ids and work copies are checked too. */
  readonly launches: readonly WorkerRecord[];
}

/**
 * The live pane that a stop of the worker would end, or null for none. Every pane of the worker is read and bound to its launch
 * as the stop reads it (`readWorkerPanes`): a pane that the launch did not make is exit 4, and so is a pane in the view window
 * that no summon put there. Two live panes are exit 2.
 */
const requireLivePane = async (deps: Deps, request: TargetCheck, id: string): Promise<CliResult<BoundPane | null>> => {
  const { home, session, again, panes } = request;
  const read = await readWorkerPanes(deps, { home, session, workerId: id, again, panes });
  if (!read.ok) return read;
  const { live } = read.value;
  if (live.length > 1) {
    return usageError(
      `the ${roles.worker} ${id} has ${live.length} live panes: ${live.map((row) => row.paneId).join(', ')}`,
      `Close all but one of these panes in tmux. Then run "${commandText(again)}" again.`,
    );
  }
  return ok(live[0] ?? null);
};

/**
 * The checks of one worker, in this order: the panes of the worker (exit 4 or exit 2), the session id that it resumes (exit 3),
 * the pane that it must not stop (exit 2) and the case of its session (exit 3), then the work copy and its settings (exit 4 for
 * a settings file). The value is the id to resume, or null for a worker that does not start again.
 */
const checkWorker = async (
  deps: Deps,
  request: TargetCheck,
  id: string,
  record: WorkerRecord | undefined,
): Promise<CliResult<string | null>> => {
  const { home, again } = request;
  const live = await requireLivePane(deps, request, id);
  if (!live.ok) return live;
  const pane = live.value;
  if (pane === null && record === undefined) return ok(null);
  const seen = await readOwnLastSeen(deps, home, id);
  if (!seen.ok) return seen;
  const resume = record === undefined ? ok(null) : resumeIdOf(id, seen.value);
  if (!resume.ok) return resume;
  if (pane !== null) {
    const other = requireOtherPane(deps, id, pane, again);
    if (!other.ok) return other;
    const known = requireStopCase(id, seen.value, pane);
    if (!known.ok) return known;
  }
  if (record !== undefined) {
    const launchable = await requireLaunchable(deps, home, record);
    if (!launchable.ok) return launchable;
  }
  return ok(resume.value);
};

/**
 * Checks every worker that will stop or start again, before the first stop, and changes nothing. Every pane that carries the mark
 * of a worker must be a pane that the launch made, and a worker has at most one live pane. A worker with a live pane needs a
 * known case of its session. A worker that starts again needs a session id that passed the owner check, a work copy that is its
 * folder, and settings files that pass the check. The first fault is the result. The value is the id to resume for each worker that
 * starts again.
 */
export const checkTargets = async (deps: Deps, request: TargetCheck): Promise<CliResult<ReadonlyMap<string, string>>> => {
  const records = new Map(request.launches.map((record) => [record.id, record] as const));
  const ids = [...new Set([...workersWithPanes(request.panes), ...records.keys()])].sort();
  const resumeIds = new Map<string, string>();
  for (const id of ids) {
    const checked = await checkWorker(deps, request, id, records.get(id));
    if (!checked.ok) return checked;
    if (checked.value !== null) resumeIds.set(id, checked.value);
  }
  return ok(resumeIds);
};

/**
 * Asks the proxy of each launch that comes after the stop, before the first stop. A proxy that does not answer, and that the config
 * does not let go direct, would stop the launch after the stop: the check fails first (exit 1), and nothing stops. The answers go
 * into `answers`, so each proxy is asked once for the run, and the launches use the same answer.
 */
export const requireProxies = async (
  deps: Deps,
  config: FactoryConfig,
  wishes: readonly ProxyWish[],
  answers: ProxyAnswers,
): Promise<CliResult<void>> => {
  for (const wish of wishes) {
    const chosen = await chooseProxy(deps, config, wish, answers);
    if (!chosen.ok) return chosen;
  }
  return ok(undefined);
};

export interface StopAllRequest {
  readonly home: string;
  /** The tmux session of the node: the id of the node. */
  readonly session: string;
  /** The list of the panes of the session, from the one list call of the command. */
  readonly panes: readonly PaneRow[];
}

/** The workers that stopped, and the error that ended the run, or null when every worker stopped. */
export interface StopRun {
  readonly stopped: readonly string[];
  readonly fault: CliError | null;
}

/**
 * Stops each worker that has a pane, one at a time, in order of the ids (`stopWorker` with the list of the command). The run ends
 * at the first fault. A worker with no pane to end is not in `stopped`.
 */
export const stopWorkers = async (deps: Deps, request: StopAllRequest): Promise<StopRun> => {
  const { home, session, panes } = request;
  const stopped: string[] = [];
  for (const workerId of workersWithPanes(panes)) {
    const result = await stopWorker(deps, { home, session, workerId, panes });
    if (!result.ok) return { stopped, fault: result.error };
    if (result.value.kind !== 'no-pane') stopped.push(workerId);
  }
  return { stopped, fault: null };
};

/** The same error, with the workers that stopped before it: a person then knows what runs and what does not. */
export const withStopped = (error: CliError, stopped: readonly string[]): CliError => ({
  ...error,
  message: `${error.message}. ${
    stopped.length === 0 ? `No ${roles.worker} was stopped` : `Stopped before this fault: ${stopped.join(', ')}`
  }`,
});

/** What `clearMark` did: the outcome of `clearActiveMark`, or `failed` for a mark that could not be cleared (a warning was printed). */
export type MarkOutcome = ClearOutcome | 'failed';

/**
 * Clears the mark of the active machine of this machine. A fault is a warning: the mark is advice, and the command goes on.
 * `command` is the command that the caller runs, and the warning names it as the command to run again after a fix.
 */
export const clearMark = async (deps: Deps, home: string, command: CommandName): Promise<MarkOutcome> => {
  const cleared = await clearActiveMark(deps, home, command);
  if (cleared.ok) return cleared.value;
  deps.warn(`The mark of the active machine is not cleared: ${cleared.error.message}. ${cleared.error.hint ?? ''}`.trimEnd());
  return 'failed';
};

/**
 * What a reboot tells a person to do after a fault that comes after its first stop. While the session runs, `reboot` run again
 * stops what is left and starts the stopped workers. After the session ended, `start` makes the session again and resumes the workers.
 */
const rebootRemedy = (sessionEnded: boolean): string =>
  sessionEnded
    ? `The session is ended. Fix the fault, then run "${commandText(commands.start)}": ` +
      `it starts the session and resumes the ${roles.worker}s.`
    : `Fix the fault. Then run "${commandText(commands.reboot)}" again: it starts the stopped ${roles.worker}s again.`;

/** The error of a reboot after its first stop: the workers that stopped before it, and the remedy that finishes the reboot (`rebootRemedy`). */
export const rebootFault = (error: CliError, stopped: readonly string[], sessionEnded: boolean): CliError => ({
  ...withStopped(error, stopped),
  hint: rebootRemedy(sessionEnded),
});

/**
 * A fault before the session ends. A reboot gives its own remedy (`rebootFault`). Another command keeps the hint of the fault,
 * and the error names the workers that stopped before it.
 */
const faultBeforeEnd = (command: CommandName, error: CliError, stopped: readonly string[]): CliError =>
  command === commands.reboot ? rebootFault(error, stopped, false) : withStopped(error, stopped);

export interface EndedSession {
  readonly stopped: readonly string[];
  readonly mark: MarkOutcome;
}

export interface EndRequest extends StopAllRequest {
  /** The command that ends the session. A fault names it in the remedy, and a mark that is not cleared names it as the command to run again. */
  readonly command: CommandName;
  /**
   * Called with what is done, right before the session ends. A command that runs in a pane of the session needs it: the end of
   * the session ends the command, so the command can not report after the end.
   */
  readonly beforeEnd?: (done: EndedSession) => void;
}

/**
 * Ends the session of the node after the checks: each worker stops (`stopWorkers`), the mark of the active machine is cleared, and
 * the session ends by its exact name. The mark is cleared before the session ends, so a fault of the end leaves a session with no
 * worker and no mark, and the command run again ends it. A fault at any step names the workers that stopped before it.
 */
export const endSession = async (deps: Deps, request: EndRequest): Promise<CliResult<EndedSession>> => {
  const { home, session, command, beforeEnd } = request;
  const run = await stopWorkers(deps, request);
  if (run.fault !== null) return err(faultBeforeEnd(command, run.fault, run.stopped));
  const done: EndedSession = { stopped: run.stopped, mark: await clearMark(deps, home, command) };
  beforeEnd?.(done);
  const ended = await tmuxStep(deps, killSessionArgs(session));
  if (!ended.ok) {
    const fault = failure(ended.error.message, `Run "${commandText(command)}" again.`);
    return err(faultBeforeEnd(command, fault.error, run.stopped));
  }
  return ok(done);
};
