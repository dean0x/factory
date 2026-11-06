import { failure, notReady, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { shellWord } from '../core/shell-word.js';
import {
  commandLines,
  commandText,
  lastSeen,
  launchConfirm,
  resetConfirm,
  resetKinds,
  roles,
  type HookEvent,
  type ResetKind,
} from '../names.js';
import { workerPathsOf } from '../state/layout.js';
import { readOwnLastSeen } from './last-seen.js';
import { readPaneLife, type PaneLife } from './panes.js';

/**
 * The check after the pane of a worker started (design 4.11, "The launch of a worker"). The program of a pane needs time to start,
 * and a `--resume` of a session that can not be loaded ends the program at once, so one read of the pane right after the start
 * proves nothing. The check waits and reads again, at most `launchConfirm.attempts` times. At each check the pane must still be
 * there and still run the launch of the worker. A launch with a session to resume also needs the last-seen line of the worker:
 * the line that the hook of the new session writes, and no older line, confirms that the session loaded.
 */

const keys = lastSeen.keys;

/** What the failure of a pane of a launch needs to know. */
export interface PaneFailureRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  /** The id of the pane that the launch made. */
  readonly paneId: string;
  readonly workerId: string;
  /** True for a launch with `--resume`. The pane and the last-seen line must confirm it. False: one check of the pane only. */
  readonly resuming: boolean;
}

export interface LaunchConfirmRequest extends PaneFailureRequest {
  /** The time before the pane was made. A hook event counts only when it is after this time. */
  readonly launchedAt: Date;
}

/** The command that a person runs for the worker: a command line of `commandLines` and the id. */
const commandFor = (line: string, workerId: string): string => commandText(`${line} ${workerId}`);

/** The ending of the message for a pane that does not run the launch any more. */
const ENDINGS: Readonly<Record<Exclude<PaneLife, 'running'>, string>> = {
  ended: 'ended after the start',
  gone: 'is gone after the start',
  other: `no longer runs the launch of the ${roles.worker}`,
};

const MS_PER_SECOND = 1000;
/** The longest wait, in seconds, for the message of a launch that is not confirmed. */
const SECONDS = (launchConfirm.attempts * launchConfirm.intervalMs) / MS_PER_SECOND;

/** The file that points to the newest session of the worker, as a shell word: a person deletes it to start a new conversation. */
const pointerFile = (home: string, workerId: string): string => shellWord(workerPathsOf(home, workerId).lastSessionFile);

/**
 * The failure of a pane that is gone, ended, or not the launch of the worker. A failed resume names the usual cause, a pointer to a
 * session with no transcript, and the manual step that starts a new conversation. That step is a delete by hand: no command does it.
 * The launch uses it too for a pane that tmux removed before the launch could mark it: a program that ends at once is the same
 * failure at any step.
 */
export const paneFailure = (request: PaneFailureRequest, life: Exclude<PaneLife, 'running'>): CliResult<never> => {
  const { home, paneId, workerId, resuming } = request;
  const message = `the pane ${paneId} of the ${roles.worker} ${workerId} ${ENDINGS[life]}`;
  const again = commandFor(commandLines.workerResume, workerId);
  return resuming
    ? failure(
        `resume failed: ${message}`,
        `A usual cause is a pointer to a session that has no transcript. To start a new conversation, delete the file ${pointerFile(home, workerId)}. ` +
          `Then run "${again}".`,
      )
    : failure(message, `Run "${again}" to try again.`);
};

/**
 * The pane runs, but the line of the new session did not come. This is a check verdict (exit 3), not a fault: the command can not
 * tell if the session loaded. It never says that the worker resumed.
 */
const notConfirmed = (request: LaunchConfirmRequest, reason: string): CliResult<never> => {
  const { home, paneId, workerId } = request;
  return notReady(
    `resume not confirmed: the pane ${paneId} of the ${roles.worker} ${workerId} runs, but its session wrote no ${launchConfirm.event} line ` +
      `within ${SECONDS} seconds (${reason})`,
    `Run "${commandFor(commandLines.workerSummon, workerId)}" to look at the pane ${paneId}. ` +
      `If the earlier conversation did not load, run "${commandFor(commandLines.workerStop, workerId)}", ` +
      `delete the file ${pointerFile(home, workerId)}, and run "${commandFor(commandLines.workerResume, workerId)}" to start a new conversation.`,
  );
};

/** What a confirm waits for in the last-seen line of the worker. */
interface Expected {
  /** The line must hold one of these events. */
  readonly events: readonly HookEvent[];
  /** The event of the line must be later than this time. */
  readonly after: Date;
  /** The words for that time, for the reason: for example `the start of the pane`. */
  readonly afterWords: string;
  /** When set, the line must belong to another session than this one: the pointer of the worker names a new session. */
  readonly newSessionOf?: string;
}

/**
 * Null when the last-seen line of the worker confirms what is expected, else the reason that it does not. The line must belong to
 * the worker (`readOwnLastSeen` checks the session marker), hold one of the expected events, have a time after the given time, and
 * for `newSessionOf` hold the id of another session. A line that is not valid, and a line that can not be read, count as not
 * confirmed.
 */
const unconfirmedReason = async (deps: Deps, home: string, workerId: string, expected: Expected): Promise<string | null> => {
  const seen = await readOwnLastSeen(deps, home, workerId);
  if (!seen.ok) return `the last-seen line can not be read: ${seen.error.message}`;
  if (seen.value.state === 'unknown') return seen.value.reason;
  const { line } = seen.value;
  const event = line[keys.event];
  if (event === null || !expected.events.includes(event)) {
    return `the last event is ${event ?? 'none'}, not ${expected.events.join(' or ')}`;
  }
  const at = Date.parse(line[keys.eventAt] ?? '');
  if (!(at > expected.after.getTime())) return `the last ${event} came before ${expected.afterWords}`;
  if (expected.newSessionOf !== undefined && line[keys.sessionId] === expected.newSessionOf) {
    return `the pointer of the ${roles.worker} still names the earlier session`;
  }
  return null;
};

/**
 * Waits for the pane to prove itself. Each check comes after a wait of `launchConfirm.intervalMs`. A pane that is gone, that
 * ended, or that does not run the launch is a failure (exit 1). A launch with no session to resume is confirmed by the first check
 * of the pane. A launch with a session to resume is confirmed when a check finds the pane and the line of the new session, and
 * it is "not confirmed" (exit 3) when no check does within `launchConfirm.attempts` checks. Nothing is closed or undone.
 */
export const confirmLaunch = async (deps: Deps, request: LaunchConfirmRequest): Promise<CliResult<void>> => {
  const { home, paneId, workerId, launchedAt, resuming } = request;
  const checks = resuming ? launchConfirm.attempts : 1;
  let reason = '';
  for (let check = 1; check <= checks; check += 1) {
    await deps.sleep(launchConfirm.intervalMs);
    const life = await readPaneLife(deps, { home, paneId, workerId });
    if (!life.ok) {
      return failure(life.error.message, `Run "${commandText(commandLines.workerList)}" to see if the ${roles.worker} ${workerId} has a live pane.`);
    }
    if (life.value !== 'running') return paneFailure(request, life.value);
    if (!resuming) return ok(undefined);
    const missing = await unconfirmedReason(deps, home, workerId, {
      events: [launchConfirm.event],
      after: launchedAt,
      afterWords: 'the start of the pane',
    });
    if (missing === null) return ok(undefined);
    reason = missing;
  }
  return notConfirmed(request, reason);
};

/** What the confirm of a reset needs to know. */
export interface ResetConfirmRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  /** The pane that took the typed line. */
  readonly paneId: string;
  readonly workerId: string;
  readonly kind: ResetKind;
  /** The time before the line was typed. A hook event counts only when it is after this time. */
  readonly typedAt: Date;
  /** The id of the session that the pointer of the worker named before the line was typed. */
  readonly sessionBefore: string;
  /** The command that a person runs again, without the program name. */
  readonly again: string;
}

/** The ending of the message for a pane that does not run the launch of the worker any more. */
const RESET_ENDINGS: Readonly<Record<Exclude<PaneLife, 'running'>, string>> = {
  ended: 'ended during the reset',
  gone: 'is gone after the reset line was typed',
  other: `no longer runs the launch of the ${roles.worker}`,
};

/** The pane ended, is gone, or is not the launch of the worker any more: a failure (exit 1). The worker needs a new pane. */
const resetPaneFailure = (request: ResetConfirmRequest, life: Exclude<PaneLife, 'running'>): CliResult<never> =>
  failure(
    `the pane ${request.paneId} of the ${roles.worker} ${request.workerId} ${RESET_ENDINGS[life]}`,
    `Run "${commandFor(commandLines.workerResume, request.workerId)}" to start the ${roles.worker} again.`,
  );

const RESET_SECONDS = (resetConfirm.attempts * resetConfirm.intervalMs) / MS_PER_SECOND;

/** The line was typed, but the hook line of the reset did not come: a check verdict (exit 3), not a fault. It never says that the reset worked. */
const resetNotConfirmed = (request: ResetConfirmRequest, reason: string): CliResult<never> => {
  const { paneId, workerId, kind, again } = request;
  const { events, line } = resetKinds[kind];
  return notReady(
    `the line ${line} was typed into the pane ${paneId} of the ${roles.worker} ${workerId}, but its session wrote no ${events.join(' or ')} line ` +
      `within ${RESET_SECONDS} seconds (${reason}); look at the pane ${paneId}`,
    `Run "${commandFor(commandLines.workerSummon, workerId)}" to look at the pane ${paneId}. Then run "${commandText(again)}" again.`,
  );
};

/**
 * Waits for the session of a worker to show that a reset line took effect. Each check comes after a wait of
 * `resetConfirm.intervalMs`, and there are at most `resetConfirm.attempts` checks. At each check the pane must still run the launch of
 * the worker: a pane that ended, is gone, or is another program is a failure (exit 1). A clear is confirmed by a `SessionStart` line of
 * a new session. A compact is confirmed by a `PreCompact` or `SessionStart` line with a time after the typing, and the session id is not
 * compared. No such line within the checks is "not confirmed" (exit 3). Nothing is typed, closed or undone.
 */
export const confirmReset = async (deps: Deps, request: ResetConfirmRequest): Promise<CliResult<void>> => {
  const { home, paneId, workerId, kind, typedAt, sessionBefore } = request;
  const words = resetKinds[kind];
  let reason = '';
  for (let check = 1; check <= resetConfirm.attempts; check += 1) {
    await deps.sleep(resetConfirm.intervalMs);
    const life = await readPaneLife(deps, { home, paneId, workerId });
    if (!life.ok) {
      return failure(life.error.message, `Run "${commandText(commandLines.workerList)}" to see if the ${roles.worker} ${workerId} has a live pane.`);
    }
    if (life.value !== 'running') return resetPaneFailure(request, life.value);
    const missing = await unconfirmedReason(deps, home, workerId, {
      events: words.events,
      after: typedAt,
      afterWords: 'the typed line',
      ...(words.newSession ? { newSessionOf: sessionBefore } : {}),
    });
    if (missing === null) return ok(undefined);
    reason = missing;
  }
  return resetNotConfirmed(request, reason);
};
