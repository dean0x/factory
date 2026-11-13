import { failure, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { inFactorySession } from '../core/factory-session.js';
import { readPrivateText } from '../core/private-file.js';
import { ok } from '../core/result.js';
import { writeInFolder, type FolderTarget } from '../core/safe-write.js';
import type { PaneRow } from '../launch/tmux.js';
import { requireSession } from '../launch/tmux-run.js';
import {
  commandLines,
  commandText,
  files,
  lastSeen,
  privateFile,
  schemaIds,
  watchPoll,
  watchRun,
  watchWords,
  type WatchKind,
} from '../names.js';
import { layoutOf } from '../state/layout.js';
import { promptStateOf, readOwnLastSeen, type LastSeen, type OwnSessionRead } from './last-seen.js';
import { listPanes, readPaneLife, requireCoordinatorCaller, type PaneLife } from './panes.js';
import { listWorkerRecords, requireRecord } from './registry.js';
import { paneProcessStart, requireLineAfterStart } from './session-checks.js';

/**
 * `worker watch [ID...]` (design 4.12): the coordinator runs it in the background and learns when a worker needs it. The watch reads
 * the panes and the last-seen lines. It never types and never sends a signal. It writes only its own run marker, and its output holds
 * fixed words, worker ids and times only. In order:
 *  1. the tmux session of the node runs and belongs to this factory folder (exit 3, exit 4). Inside a factory session, the caller is the
 *     pane of the coordinator (exit 2); a shell outside the factory sessions, as the owner runs it, may also watch;
 *  2. the workers: each id of the command line has a valid record that the program wrote (exit 2, exit 4), or, with no id, every
 *     recorded worker. The ids of `--ready` are watched too, and each has such a record;
 *  3. one list of the panes. A worker with no pane is not checked, and it is not a change. With no worker to check, the watch ends
 *     at once with `no-worker`;
 *  4. the run marker: a fresh token goes to the marker file of the node, so a run that started earlier ends at its next check. A write
 *     fault is exit 1, before any check;
 *  5. a check of every checked worker at the baseline, and then at most `watchPoll.attempts` checks, each after a wait of
 *     `watchPoll.intervalMs`. So the watch lasts at most `watchPoll.capMs`. A check ends the watch at the first check that finds a
 *     change, and the report names every worker that changed at that check. The baseline is a check too, so a change at the baseline
 *     ends the watch with no wait. Every check reads the run marker first, and the watch ends with `replaced` when the marker holds the
 *     token of a newer run. A marker that is missing, that can not be read or that holds no token is exit 1, never `replaced`. The watch
 *     ends with `parent-gone` at the first wait after which the parent process is not the one at the start. A terminal is no condition:
 *     a background watch has none. Each end but `no-worker` gives the time of the last check, in the form that `--since` takes;
 *  6. a fault of a read (tmux, a file) is exit 1.
 * The panes that a worker has at the baseline are the panes that the later checks read, each by its id. A change of a worker is the
 * first of: a pane that ended, is gone or runs another program than the launch of the worker; a last-seen line that is not valid or
 * does not belong to the worker; a dialog that waits for an answer; a session that works and was silent for more than
 * `watchPoll.stalledAfterMs`; a finish.
 * A finish is a last-seen line with the event `watchPoll.finishEvent` that is newer than the baseline of the worker. The baseline is the
 * event time of the line at the first check, or the `--since` time when that is older, and none when the worker has no line and no
 * `--since` is given. So a finish between two runs shows at once at the baseline of the next run, when that run gets the time of the
 * last check of the earlier run as `--since`. A line of the event `SessionStart` is no finish, and a worker of `--ready` has no finish.
 * A worker that is new has no line yet, so a missing line is not a change in the first `watchPoll.lineGraceChecks` checks, the
 * baseline included. A missing line is a change from that check on, and at once for a worker whose valid line was seen at an
 * earlier check. A line that does not belong to the worker is a change at once.
 * A worker of `--ready ID` waits out a block, for example a dialog that only the owner answers. It is watched with the other workers,
 * and its pane changes and a line that does not belong to it stay changes. Its other change is `ready`: a valid line of its own at the
 * prompt or busy, later than the start of the pane process. A line from before that start is the line of the session that a resume
 * or a restart replaced, so it is no change. A missing line, a line that is not valid and a dialog that waits are no change for it
 * either. The start is read with `ps` (a read) for each pane of the worker, only at a check where the line says `ready`, so the reads
 * have the bound of the checks times the panes of the worker. A start that can not be read is no change at that check, and the next
 * check reads it again. The bound of the checks is the same.
 */

/** The command that a person runs again after a fix, with the program name. */
const AGAIN = commandText(commandLines.workerWatch);

const keys = lastSeen.keys;

export interface WatchRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
  /** The ids of the workers to watch. Empty: every recorded worker. */
  readonly workerIds: readonly string[];
  /**
   * The ids of the workers that wait to be ready after a block (`--ready ID`). They are watched too. For each of them, a block (a dialog
   * that waits, or no valid line yet) is no change, and a valid line of its own at the prompt or busy is the change `ready`.
   */
  readonly readyIds: readonly string[];
  /**
   * The time of `--since`: an ISO time in UTC that the command has checked. A finish newer than this time is a finish even when it came
   * before the first check. Null: no `--since`.
   */
  readonly since: string | null;
}

/** What changed for one worker. */
export interface WatchChange {
  readonly workerId: string;
  readonly kind: WatchKind;
}

/**
 * What a watch gives back: nothing to watch, the changes of the first check that found any, no change in every check, a newer watch
 * run that took the run marker, or a parent process that changed. Each outcome but the first holds `checkedAt`, the time of the start of
 * the last check, as an ISO time in UTC.
 */
export type WatchOutcome =
  | { readonly kind: 'no-worker' }
  | {
      readonly kind: 'changed';
      readonly changes: readonly WatchChange[];
      /** The count of waits before the check that found the changes. 0: the baseline. */
      readonly checks: number;
      readonly checkedAt: string;
    }
  | { readonly kind: 'no-change'; readonly workerIds: readonly string[]; readonly checks: number; readonly checkedAt: string }
  | { readonly kind: 'replaced'; readonly checkedAt: string }
  | { readonly kind: 'parent-gone'; readonly checkedAt: string };

/** A worker that the watch checks, with the panes that it had at the baseline. */
interface Target {
  readonly workerId: string;
  readonly paneIds: readonly string[];
  /** The process ids of the panes at the baseline, in the order of `paneIds`. */
  readonly pids: readonly number[];
  /** True for a worker of `--ready`: the watch waits until it is ready. */
  readonly waitsForReady: boolean;
}

/** The first pane that does not run the launch of its worker. */
const paneChange = (lives: readonly PaneLife[]): WatchKind | null =>
  lives.find((life): life is Exclude<PaneLife, 'running'> => life !== 'running') ?? null;

/** The time of the newest write of the line, in milliseconds: the event time or the percent time, whichever is newer. */
const newestWriteMs = (line: LastSeen): number =>
  Math.max(
    ...[line[keys.eventAt], line[keys.pctAt]]
      .filter((time): time is string => time !== null)
      .map((time) => Date.parse(time)),
  );

/** A session that works is stalled when its newest write is older than `watchPoll.stalledAfterMs`. */
const isStalled = (line: LastSeen, nowMs: number): boolean => nowMs - newestWriteMs(line) > watchPoll.stalledAfterMs;

/**
 * What the last-seen line says. A line that is not owned is a change: the watch can not tell what the session does. So is a line that
 * is absent or not valid, unless `missingIsChange` is false: a new worker may have no line yet. A line with no event, which holds only
 * a percent, says nothing, as does a session that waits at its prompt.
 */
const lineChange = (read: OwnSessionRead, nowMs: number, missingIsChange: boolean): WatchKind | null => {
  if (read.state === 'unknown') {
    if (read.why === 'not-owned') return 'lineNotOwned';
    return missingIsChange ? 'lineNotValid' : null;
  }
  const state = promptStateOf(read.line);
  switch (state) {
    case 'waits':
      return 'waits';
    case 'busy':
      return isStalled(read.line, nowMs) ? 'stalled' : null;
    case 'prompt':
    case null:
      return null;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/**
 * What the last-seen line says for a worker that waits to be ready, before the check against the start of the panes. A line that is
 * not owned stays a change. A valid line of its own at the prompt or busy is `readyAfterBlock`. Every other line is the block that the
 * worker waits out: no line yet, a line that is not valid, a dialog that waits, or a line with no event.
 */
const readyChange = (read: OwnSessionRead): WatchKind | null => {
  if (read.state === 'unknown') return read.why === 'not-owned' ? 'lineNotOwned' : null;
  const state = promptStateOf(read.line);
  switch (state) {
    case 'prompt':
    case 'busy':
      return 'readyAfterBlock';
    case 'waits':
    case null:
      return null;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/**
 * True when the line is later than the start of every pane process of the target: the line is then the line of the session that runs
 * now, not of a session that a resume or a restart replaced. A start that can not be read counts as not later, so the worker is not
 * ready at that check.
 */
const isLineFresh = async (deps: Deps, target: Target, line: LastSeen): Promise<boolean> => {
  for (const pid of target.pids) {
    const start = await paneProcessStart(deps, pid, commandLines.workerWatch);
    if (!start.ok) return false;
    if (!requireLineAfterStart(line[keys.eventAt] ?? '', start.value, commandLines.workerWatch).ok) return false;
  }
  return true;
};

/** The change of a worker of `--ready`: `readyChange`, and for `readyAfterBlock` also a line that is later than the panes started. */
const readyFinding = async (deps: Deps, target: Target, read: OwnSessionRead): Promise<WatchKind | null> => {
  const change = readyChange(read);
  if (change !== 'readyAfterBlock' || read.state !== 'valid') return change;
  return (await isLineFresh(deps, target, read.line)) ? change : null;
};

/**
 * What a check found for one worker: its change, or null, whether the check read a valid line of the worker, the event time of that line,
 * and the event time of that line when its event is the finish event. Both times are null when the check read no valid line.
 */
interface Finding {
  readonly change: WatchKind | null;
  readonly lineSeen: boolean;
  readonly eventAt: string | null;
  readonly finishedAt: string | null;
}

/**
 * The finding for one worker. The panes come first: a worker whose pane changed is reported without a read of its line, and the
 * finding then says that no line was seen.
 */
const changeOf = async (deps: Deps, home: string, target: Target, missingIsChange: boolean): Promise<CliResult<Finding>> => {
  const lives: PaneLife[] = [];
  for (const paneId of target.paneIds) {
    const life = await readPaneLife(deps, { home, paneId, workerId: target.workerId });
    if (!life.ok) return life;
    lives.push(life.value);
  }
  const pane = paneChange(lives);
  if (pane !== null) return ok({ change: pane, lineSeen: false, eventAt: null, finishedAt: null });
  const line = await readOwnLastSeen(deps, home, target.workerId);
  if (!line.ok) return line;
  const change = target.waitsForReady
    ? await readyFinding(deps, target, line.value)
    : lineChange(line.value, deps.now().getTime(), missingIsChange);
  const valid = line.value.state === 'valid' ? line.value.line : null;
  const eventAt = valid?.[keys.eventAt] ?? null;
  const finishedAt = valid?.[keys.event] === watchPoll.finishEvent ? eventAt : null;
  return ok({ change, lineSeen: valid !== null, eventAt, finishedAt });
};

/** The older of two times, or the one that is there. Both are ISO times in UTC that a schema has checked. */
const olderOf = (first: string | null, second: string | null): string | null => {
  if (first === null) return second;
  if (second === null) return first;
  return Date.parse(first) <= Date.parse(second) ? first : second;
};

/** True when the finish time is there and is newer than the baseline. A baseline of none is older than every time. */
const isFinishAfter = (finishedAt: string | null, baseline: string | null): boolean =>
  finishedAt !== null && (baseline === null || Date.parse(finishedAt) > Date.parse(baseline));

/**
 * What the checks remember: the workers whose valid line has been seen so far, and the baseline of each worker that an earlier check
 * has met. A baseline of none is a worker that had no valid line at its first check, with no `--since`.
 */
interface Memory {
  readonly seen: ReadonlySet<string>;
  readonly baselines: ReadonlyMap<string, string | null>;
}

/** What one check of every target found: the change of each worker that changed, and what the checks remember after this one. */
interface Checked {
  readonly changes: readonly WatchChange[];
  readonly memory: Memory;
}

/**
 * One check of every target, in order. `index` is the count of waits before this check (0: the baseline). A missing line is a change
 * for a worker in `memory.seen`, and for every worker from the check with the index `watchPoll.lineGraceChecks` on. The first check
 * that meets a worker sets its baseline: the event time of its line, or `since` when that is older. A line with the finish event that is
 * newer than the baseline is the change `finished`, unless the worker has another change or waits to be ready.
 */
const check = async (
  deps: Deps,
  home: string,
  targets: readonly Target[],
  index: number,
  since: string | null,
  memory: Memory,
): Promise<CliResult<Checked>> => {
  const changes: WatchChange[] = [];
  const seen = new Set(memory.seen);
  const baselines = new Map(memory.baselines);
  for (const target of targets) {
    const { workerId } = target;
    const missingIsChange = index >= watchPoll.lineGraceChecks || memory.seen.has(workerId);
    const found = await changeOf(deps, home, target, missingIsChange);
    if (!found.ok) return found;
    const { change, lineSeen, eventAt, finishedAt } = found.value;
    const baseline = baselines.has(workerId) ? (baselines.get(workerId) ?? null) : olderOf(eventAt, since);
    baselines.set(workerId, baseline);
    const finished = !target.waitsForReady && isFinishAfter(finishedAt, baseline);
    const kind = change ?? (finished ? 'finished' : null);
    if (kind !== null) changes.push({ workerId, kind });
    if (lineSeen) seen.add(workerId);
  }
  return ok({ changes, memory: { seen, baselines } });
};

/** Each id has a record that the program wrote (exit 2, exit 4 from `requireRecord`). */
const requireRecords = async (deps: Deps, home: string, ids: readonly string[]): Promise<CliResult<void>> => {
  for (const workerId of new Set(ids)) {
    const record = await requireRecord(deps, home, workerId, AGAIN);
    if (!record.ok) return record;
  }
  return ok(undefined);
};

/**
 * The ids to watch: the ids of the command line, or every recorded worker when it names none, and the ids of `--ready`. Each id is
 * once in the list, and each id that the command line names has a record that the program wrote.
 */
const idsToWatch = async (
  deps: Deps,
  home: string,
  workerIds: readonly string[],
  readyIds: readonly string[],
): Promise<CliResult<readonly string[]>> => {
  if (workerIds.length === 0) {
    const listed = await listWorkerRecords(deps, home);
    if (!listed.ok) return listed;
    const missing = await requireRecords(deps, home, readyIds);
    return missing.ok ? ok([...new Set([...listed.value.workers.map((record) => record.id), ...readyIds])]) : missing;
  }
  const unique = [...new Set([...workerIds, ...readyIds])];
  const checked = await requireRecords(deps, home, unique);
  return checked.ok ? ok(unique) : checked;
};

/** The workers that have a pane, each with its panes. A worker with no pane is left out. */
const targetsOf = (workerIds: readonly string[], readyIds: readonly string[], rows: readonly PaneRow[]): readonly Target[] =>
  workerIds.flatMap((workerId) => {
    const panes = rows.filter((row) => row.worker === workerId);
    if (panes.length === 0) return [];
    return [
      { workerId, paneIds: panes.map((row) => row.paneId), pids: panes.map((row) => row.pid), waitsForReady: readyIds.includes(workerId) },
    ];
  });

/**
 * Inside a factory session only the pane of the coordinator may run the watch (exit 2 for any other pane). A shell outside the factory
 * sessions, as the owner runs it, has no session marker and passes. It guards against a mistake, as `requireCoordinatorCaller` does.
 */
const requireWatchCaller = async (deps: Deps, home: string, config: FactoryConfig): Promise<CliResult<void>> => {
  if (!inFactorySession(deps)) return ok(undefined);
  const caller = await requireCoordinatorCaller(deps, home, config, commandLines.workerWatch);
  return caller.ok ? ok(undefined) : caller;
};

/** The place of the run marker: the file `files.watchRun` in the run-time folder, with the private modes. */
const markerTarget = (home: string): FolderTarget => {
  const layout = layoutOf(home);
  return {
    parent: layout.stateDir,
    folder: layout.runtimeDir,
    name: files.watchRun,
    mode: privateFile.fileMode,
    folderMode: privateFile.folderMode,
  };
};

/** Writes a fresh token to the run marker, so every older run ends at its next check. The value is the token. */
const takeMarker = async (deps: Deps, home: string): Promise<CliResult<string>> => {
  const token = deps.randomHex(watchRun.tokenBytes);
  if (!token.ok) return token;
  const written = await writeInFolder(deps, markerTarget(home), `${token.value}\n`);
  return written.ok ? ok(token.value) : written;
};

/** What the run marker says to a run: it holds the token of this run, the token of a newer run, or it is lost. */
type MarkerState = 'own' | 'replaced' | 'lost';

/**
 * Reads the run marker. A file that is missing, that can not be read, that is too large, or that holds no token is `lost`: it is no
 * sign of a newer run. Only another valid token is `replaced`.
 */
const markerState = async (deps: Deps, home: string, token: string): Promise<MarkerState> => {
  const read = await readPrivateText(deps, layoutOf(home).watchRunFile, watchRun.maxBytes);
  if (!read.ok || read.value === null) return 'lost';
  if (read.value === `${token}\n`) return 'own';
  return watchRun.tokenPattern.test(read.value) ? 'replaced' : 'lost';
};

/**
 * Watches the workers (see the order at the top of the file). The value is `changed` with the changes of the first check that found
 * any, `no-change` after `watchPoll.attempts` checks that found none, `replaced` when a newer run took the run marker, `parent-gone`
 * when the parent process changed, or `no-worker` when no recorded worker has a pane. A lost run marker is a failure (exit 1).
 */
export const watchWorkers = async (deps: Deps, request: WatchRequest): Promise<CliResult<WatchOutcome>> => {
  const { home, config, workerIds, readyIds, since } = request;
  const nodeId = config.core.node.id;
  const session = await requireSession(deps, nodeId, home, AGAIN);
  if (!session.ok) return session;
  const caller = await requireWatchCaller(deps, home, config);
  if (!caller.ok) return caller;
  const ids = await idsToWatch(deps, home, workerIds, readyIds);
  if (!ids.ok) return ids;
  const rows = await listPanes(deps, nodeId);
  if (!rows.ok) return rows;
  const targets = targetsOf(ids.value, readyIds, rows.value);
  if (targets.length === 0) return ok({ kind: 'no-worker' });
  const token = await takeMarker(deps, home);
  if (!token.ok) return token;

  const parent = deps.parentPid();
  let memory: Memory = { seen: new Set(), baselines: new Map() };
  let checkedAt = deps.now().toISOString();
  for (let checks = 0; checks <= watchPoll.attempts; checks += 1) {
    if (checks > 0) {
      await deps.sleep(watchPoll.intervalMs);
      if (deps.parentPid() !== parent) return ok({ kind: 'parent-gone', checkedAt });
    }
    const marker = await markerState(deps, home, token.value);
    if (marker === 'lost') return failure(watchWords.markerLost, `Run "${AGAIN}" again.`);
    if (marker === 'replaced') return ok({ kind: 'replaced', checkedAt });
    checkedAt = deps.now().toISOString();
    const found = await check(deps, home, targets, checks, since, memory);
    if (!found.ok) return found;
    if (found.value.changes.length > 0) return ok({ kind: 'changed', changes: found.value.changes, checks, checkedAt });
    memory = found.value.memory;
  }
  return ok({ kind: 'no-change', workerIds: targets.map((target) => target.workerId), checks: watchPoll.attempts, checkedAt });
};

/** The end of every line of a report: the words for the last check and its time. */
const lastCheckText = (checkedAt: string): string => `${watchWords.lastCheck} ${checkedAt}`;

/** The output of a watch: fixed words, worker ids and times, one line for each change, or one line for any other end. */
export const watchOutput = (outcome: WatchOutcome): CommandOutput => {
  switch (outcome.kind) {
    case 'no-worker':
      return {
        lines: [{ level: 'ok', text: `${watchWords.noWorker} ${watchWords.noPane}` }],
        json: { schema: schemaIds.workerWatch, result: outcome.kind },
        warnings: [],
        failed: false,
      };
    case 'changed':
      return {
        lines: outcome.changes.map((change): OutLine => ({
          level: 'warn',
          text: `${watchWords.changed} ${change.workerId} ${watchWords.kinds[change.kind]} ${lastCheckText(outcome.checkedAt)}`,
        })),
        json: {
          schema: schemaIds.workerWatch,
          result: outcome.kind,
          checks: outcome.checks,
          checkedAt: outcome.checkedAt,
          changes: outcome.changes.map((change) => ({ id: change.workerId, kind: change.kind })),
        },
        warnings: [],
        failed: false,
      };
    case 'no-change':
      return {
        lines: [{ level: 'ok', text: `${watchWords.noChange} ${outcome.workerIds.join(' ')} ${lastCheckText(outcome.checkedAt)}` }],
        json: {
          schema: schemaIds.workerWatch,
          result: outcome.kind,
          checks: outcome.checks,
          checkedAt: outcome.checkedAt,
          workers: outcome.workerIds,
        },
        warnings: [],
        failed: false,
      };
    case 'replaced':
      return {
        lines: [{ level: 'warn', text: `${watchWords.replaced} ${watchWords.replacedBy} ${lastCheckText(outcome.checkedAt)}` }],
        json: { schema: schemaIds.workerWatch, result: outcome.kind, checkedAt: outcome.checkedAt },
        warnings: [],
        failed: false,
      };
    case 'parent-gone':
      return {
        lines: [{ level: 'warn', text: `${watchWords.parentGone} ${watchWords.parentGoneWhy} ${lastCheckText(outcome.checkedAt)}` }],
        json: { schema: schemaIds.workerWatch, result: outcome.kind, checkedAt: outcome.checkedAt },
        warnings: [],
        failed: false,
      };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
};
