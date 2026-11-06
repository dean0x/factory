import type { CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import type { PaneRow } from '../launch/tmux.js';
import { requireSession } from '../launch/tmux-run.js';
import { commandLines, commandText, lastSeen, schemaIds, watchPoll, watchWords, type WatchKind } from '../names.js';
import { promptStateOf, readOwnLastSeen, type LastSeen, type OwnSessionRead } from './last-seen.js';
import { listPanes, readPaneLife, type PaneLife } from './panes.js';
import { listWorkerRecords, requireRecord } from './registry.js';

/**
 * `worker watch [ID...]` (design 4.12): the coordinator runs it in the background and learns when a worker needs it. The watch only
 * reads. It never types, never sends a signal and never writes, and its output holds fixed words and worker ids only. In order:
 *  1. the tmux session of the node runs and belongs to this factory folder (exit 3, exit 4);
 *  2. the workers: each id of the command line has a valid record that the program wrote (exit 2, exit 4), or, with no id, every
 *     recorded worker;
 *  3. one list of the panes. A worker with no pane is not checked, and it is not a change. With no worker to check, the watch ends
 *     at once with `no-worker`;
 *  4. a check of every checked worker at the baseline, and then at most `watchPoll.attempts` checks, each after a wait of
 *     `watchPoll.intervalMs`. A check ends the watch at the first check that finds a change, and the report names every worker that
 *     changed at that check. The baseline is a check too, so a change at the baseline ends the watch with no wait;
 *  5. a fault of a read (tmux, a file) is exit 1.
 * The panes that a worker has at the baseline are the panes that the later checks read, each by its id. A change of a worker is the
 * first of: a pane that ended, is gone or runs another program than the launch of the worker; a last-seen line that is not valid or
 * does not belong to the worker; a dialog that waits for an answer; a session that works and was silent for more than
 * `watchPoll.stalledAfterMs`. A change from busy to prompt, and back, is not a change.
 * A worker that is new has no line yet, so a missing line is not a change in the first `watchPoll.lineGraceChecks` checks, the
 * baseline included. A missing line is a change from that check on, and at once for a worker whose valid line was seen at an
 * earlier check. A line that does not belong to the worker is a change at once.
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
}

/** What changed for one worker. */
export interface WatchChange {
  readonly workerId: string;
  readonly kind: WatchKind;
}

/** What a watch gives back: nothing to watch, the changes of the first check that found any, or no change in every check. */
export type WatchOutcome =
  | { readonly kind: 'no-worker' }
  | {
      readonly kind: 'changed';
      readonly changes: readonly WatchChange[];
      /** The count of waits before the check that found the changes. 0: the baseline. */
      readonly checks: number;
    }
  | { readonly kind: 'no-change'; readonly workerIds: readonly string[]; readonly checks: number };

/** A worker that the watch checks, with the panes that it had at the baseline. */
interface Target {
  readonly workerId: string;
  readonly paneIds: readonly string[];
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

/** What a check found for one worker: its change, or null, and whether the check read a valid line of the worker. */
interface Finding {
  readonly change: WatchKind | null;
  readonly lineSeen: boolean;
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
  if (pane !== null) return ok({ change: pane, lineSeen: false });
  const line = await readOwnLastSeen(deps, home, target.workerId);
  if (!line.ok) return line;
  return ok({ change: lineChange(line.value, deps.now().getTime(), missingIsChange), lineSeen: line.value.state === 'valid' });
};

/** What one check of every target found: the change of each worker that changed, and the workers whose valid line has been seen so far. */
interface Checked {
  readonly changes: readonly WatchChange[];
  readonly seen: ReadonlySet<string>;
}

/**
 * One check of every target, in order. `index` is the count of waits before this check (0: the baseline), and `seen` holds the workers
 * whose valid line an earlier check read. A missing line is a change for a worker in `seen`, and for every worker from the check with
 * the index `watchPoll.lineGraceChecks` on.
 */
const check = async (
  deps: Deps,
  home: string,
  targets: readonly Target[],
  index: number,
  seen: ReadonlySet<string>,
): Promise<CliResult<Checked>> => {
  const changes: WatchChange[] = [];
  const seenNow = new Set(seen);
  for (const target of targets) {
    const missingIsChange = index >= watchPoll.lineGraceChecks || seen.has(target.workerId);
    const found = await changeOf(deps, home, target, missingIsChange);
    if (!found.ok) return found;
    if (found.value.change !== null) changes.push({ workerId: target.workerId, kind: found.value.change });
    if (found.value.lineSeen) seenNow.add(target.workerId);
  }
  return ok({ changes, seen: seenNow });
};

/** The ids to watch: the ids of the command line, each once and each with a record that the program wrote, or every recorded worker. */
const idsToWatch = async (deps: Deps, home: string, workerIds: readonly string[]): Promise<CliResult<readonly string[]>> => {
  if (workerIds.length === 0) {
    const listed = await listWorkerRecords(deps, home);
    return listed.ok ? ok(listed.value.workers.map((record) => record.id)) : listed;
  }
  const unique = [...new Set(workerIds)];
  for (const workerId of unique) {
    const record = await requireRecord(deps, home, workerId, AGAIN);
    if (!record.ok) return record;
  }
  return ok(unique);
};

/** The workers that have a pane, each with its panes. A worker with no pane is left out. */
const targetsOf = (workerIds: readonly string[], rows: readonly PaneRow[]): readonly Target[] =>
  workerIds.flatMap((workerId) => {
    const paneIds = rows.filter((row) => row.worker === workerId).map((row) => row.paneId);
    return paneIds.length === 0 ? [] : [{ workerId, paneIds }];
  });

/**
 * Watches the workers (see the order at the top of the file). The value is `changed` with the changes of the first check that found
 * any, `no-change` after `watchPoll.attempts` checks that found none, or `no-worker` when no recorded worker has a pane.
 */
export const watchWorkers = async (deps: Deps, request: WatchRequest): Promise<CliResult<WatchOutcome>> => {
  const { home, config, workerIds } = request;
  const nodeId = config.core.node.id;
  const session = await requireSession(deps, nodeId, home, AGAIN);
  if (!session.ok) return session;
  const ids = await idsToWatch(deps, home, workerIds);
  if (!ids.ok) return ids;
  const rows = await listPanes(deps, nodeId);
  if (!rows.ok) return rows;
  const targets = targetsOf(ids.value, rows.value);
  if (targets.length === 0) return ok({ kind: 'no-worker' });

  let seen: ReadonlySet<string> = new Set();
  for (let checks = 0; checks <= watchPoll.attempts; checks += 1) {
    if (checks > 0) await deps.sleep(watchPoll.intervalMs);
    const found = await check(deps, home, targets, checks, seen);
    if (!found.ok) return found;
    if (found.value.changes.length > 0) return ok({ kind: 'changed', changes: found.value.changes, checks });
    seen = found.value.seen;
  }
  return ok({ kind: 'no-change', workerIds: targets.map((target) => target.workerId), checks: watchPoll.attempts });
};

/** The output of a watch: fixed words and worker ids, one line for each change, or one line for no change or no worker. */
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
          text: `${watchWords.changed} ${change.workerId} ${watchWords.kinds[change.kind]}`,
        })),
        json: {
          schema: schemaIds.workerWatch,
          result: outcome.kind,
          checks: outcome.checks,
          changes: outcome.changes.map((change) => ({ id: change.workerId, kind: change.kind })),
        },
        warnings: [],
        failed: false,
      };
    case 'no-change':
      return {
        lines: [{ level: 'ok', text: `${watchWords.noChange} ${outcome.workerIds.join(' ')}` }],
        json: { schema: schemaIds.workerWatch, result: outcome.kind, checks: outcome.checks, workers: outcome.workerIds },
        warnings: [],
        failed: false,
      };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
};
