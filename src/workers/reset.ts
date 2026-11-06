import { join } from 'node:path';
import { failure, notReady, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { typeLine } from '../comms/typing.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import {
  capitalize,
  commandLines,
  commands,
  commandText,
  files,
  flags,
  flagText,
  lastSeen,
  resetKinds,
  roles,
  schemaIds,
  sessionNames,
  tmuxNames,
  type ResetKind,
} from '../names.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { confirmReset } from './confirm.js';
import { fetchClone, planDismiss, unpushedReasons } from './dismiss.js';
import { promptStateOf, readOwnLastSeen } from './last-seen.js';
import { requireBoundPane, requireCoordinatorCaller, type BoundPane } from './panes.js';
import { requireRecord, type WorkerRecord } from './registry.js';
import {
  paneProcessStart,
  requireLineAfterStart,
  requireOwnHooks,
  requireResumeFile,
  requireSettingsOlderThan,
} from './session-checks.js';
import { readWorkerPanes } from './slot.js';
import { requireOneLivePane } from './stop.js';

/**
 * `worker reset ID --clear|--compact` (design 4.12): the coordinator clears or compacts the session of a worker that waits at its
 * prompt. The command types one fixed line into the pane of the worker, so it checks everything first, in a fixed order, and a
 * refusal types nothing. After the keys it waits for the hook line that proves the reset. The order, with the exit code of each
 * refusal:
 *  1. the words of the command line: one worker id and one flag (exit 2), in `parseReset`;
 *  2. the caller rule (`requireCoordinatorCaller`): the env of the caller (exit 2), the tmux session (exit 3, exit 4), the
 *     coordinator pane and the caller pane (exit 3, exit 4, exit 2);
 *  3. the record of the worker (exit 2, exit 4);
 *  4. the one live pane of the worker, which a summon does not show in the view window (exit 2, exit 3);
 *  5. the start of the pane process, then the hook events of the settings of the work copy, then the age of that settings file
 *     (exit 3);
 *  6. the work is pushed after one fetch (exit 1);
 *  7. the resume notes of the worker (exit 3, exit 4);
 *  8. the pane is read and bound again, and it has the same process (exit 4, exit 3);
 *  9. the last-seen line of the worker, read after the bind: it is owned and has an event (exit 3), the session waits at its prompt
 *     (exit 1), and the line is later than the start of the pane process (exit 3);
 * 10. `typeLine`: the mode of the pane is read (exit 1 for a failed read, exit 3 for a pane in a mode of tmux), then the capture of the
 *     screen, which is the last read before the keys (exit 3 for a numbered list of choices);
 * 11. the confirm (`confirmReset`).
 * A mode or a dialog that opens after its read and before the keys is not seen.
 */

const KINDS = Object.keys(resetKinds) as readonly ResetKind[];

/** The command of a reset with its program name, for the words of a usage error. */
const BASE_LINE = commandText(commandLines.workerReset);

/** The words of the command line of a reset: the positional words, and for each kind of reset whether its flag is set. */
export type ResetWords = { readonly words: readonly string[] } & Readonly<Record<ResetKind, boolean>>;

/** The command that a person runs for a reset, without the program name. */
const resetLine = (workerId: string, kind: ResetKind): string => `${commandLines.workerReset} ${workerId} ${flagText(resetKinds[kind].flag)}`;

/** The command that a person runs for the worker with a subcommand, without the program name. */
const lineFor = (line: string, workerId: string): string => `${line} ${workerId}`;

/** The first check: one worker id and exactly one flag. Anything else is exit 2, and nothing else runs. */
export const parseReset = (input: ResetWords): CliResult<{ readonly workerId: string; readonly kind: ResetKind }> => {
  const [workerId, ...more] = input.words;
  if (workerId === undefined || more.length > 0) {
    return usageError(
      `${BASE_LINE} takes one argument: the id of the ${roles.worker}`,
      `Run "${BASE_LINE} ID ${flagText(flags.clear)}" or "${BASE_LINE} ID ${flagText(flags.compact)}".`,
    );
  }
  const chosen = KINDS.filter((kind) => input[kind]);
  const [kind] = chosen;
  if (kind === undefined || chosen.length > 1) {
    return usageError(
      `${BASE_LINE} needs one of ${flagText(flags.clear)} and ${flagText(flags.compact)}, and not both`,
      `Run "${BASE_LINE} ${workerId} ${flagText(flags.clear)}" or "${BASE_LINE} ${workerId} ${flagText(flags.compact)}".`,
    );
  }
  return ok({ workerId, kind });
};

export interface ResetRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
  /** The id of the worker: a slug, from `parseReset`. */
  readonly workerId: string;
  readonly kind: ResetKind;
}

/** What a reset that the hook line confirmed gives back. */
export interface ResetOutcome {
  readonly workerId: string;
  readonly kind: ResetKind;
  readonly paneId: string;
  /** The name of the session in the session list of the agent program. */
  readonly name: string;
  /** How long ago the resume notes changed, in milliseconds. */
  readonly resumeAgeMs: number;
}

/** The clause that ends a remedy line: `run "<command>" again.` It follows `Then`, and at the start of a sentence it follows `capitalize`. */
const runAgain = (again: string): string => `run "${commandText(again)}" again.`;

/** The one live pane of the worker. No live pane (none, or only an ended one) is exit 3, and two live panes are exit 2. */
const requireLivePane = async (deps: Deps, request: ResetRequest, again: string): Promise<CliResult<BoundPane>> => {
  const { home, config, workerId } = request;
  const panes = await readWorkerPanes(deps, { home, session: config.core.node.id, workerId, again });
  if (!panes.ok) return panes;
  const single = requireOneLivePane(workerId, panes.value.live, again);
  if (!single.ok) return single;
  if (single.value !== null) return ok(single.value);
  const [ended] = panes.value.dead;
  return notReady(
    ended === undefined
      ? `the ${roles.worker} ${workerId} has no pane`
      : `the pane ${ended.paneId} of the ${roles.worker} ${workerId} ended`,
    `Run "${commandText(lineFor(commandLines.workerResume, workerId))}" to start the ${roles.worker} again. Then ${runAgain(again)}`,
  );
};

/** A pane that a summon shows in the view window is refused: the person looks at it, and a typed line could meet a typed answer. */
const requireOutOfView = (pane: BoundPane, workerId: string, again: string): CliResult<void> =>
  pane.inView
    ? notReady(
        `the pane ${pane.paneId} of the ${roles.worker} ${workerId} is in the window ${tmuxNames.windowView}: a summon shows it there`,
        `Wait until the summon ends, or run "${commandText(commands.layout)}" to show the board again. Then ${runAgain(again)}`,
      )
    : ok(undefined);

/** The checks of the process of the pane and of the settings of the work copy. The value is the start of the pane process. */
const requireFreshSession = async (
  deps: Deps,
  record: WorkerRecord,
  pane: BoundPane,
  again: string,
): Promise<CliResult<number>> => {
  const start = await paneProcessStart(deps, pane.pid, again);
  if (!start.ok) return start;
  const then = lineFor(commands.restart, record.id);
  const hooks = await requireOwnHooks(deps, { folder: record.workCopy, then });
  if (!hooks.ok) return hooks;
  const older = await requireSettingsOlderThan(deps, { folder: record.workCopy, then, start: start.value });
  return older.ok ? start : older;
};

/** The work of the worker is pushed after one fetch: the plan of the path checks of `dismiss` gives the clone and the work copy. */
const requirePushed = async (
  deps: Deps,
  request: ResetRequest,
  record: WorkerRecord,
  again: string,
): Promise<CliResult<void>> => {
  const { home, config, workerId } = request;
  const plan = await planDismiss(
    deps,
    home,
    config,
    { id: workerId, project: record.project },
    { again, command: commandLines.workerReset, verb: 'use' },
  );
  if (!plan.ok) return plan;
  const fetched = await fetchClone(deps, plan.value);
  if (!fetched.ok) return failure(fetched.error.message, `Check the network and the remote of the clone. Then ${runAgain(again)}`);
  const reasons = await unpushedReasons(deps, plan.value);
  if (!reasons.ok) return reasons;
  if (reasons.value.length === 0) return ok(undefined);
  return failure(
    `the work of the ${roles.worker} ${workerId} is not pushed: ${reasons.value.join('; ')}`,
    `Push the work of the ${roles.worker} ${workerId}. Then ${runAgain(again)}`,
  );
};

/** The notes of the worker for its next turn: the folders above the file and the file are plain, and the file has text. */
const requireResumeNotes = async (deps: Deps, home: string, workerId: string, again: string): Promise<CliResult<number>> => {
  const paths = workerPathsOf(home, workerId);
  const notes = await requireResumeFile(deps, {
    folders: [
      { path: layoutOf(home).workersDir, what: `the ${roles.worker}s folder` },
      { path: paths.dir, what: `the folder of the ${roles.worker}` },
      { path: paths.inboxDir, what: `the inbox folder of the ${roles.worker}` },
    ],
    file: { path: join(paths.inboxDir, files.resume), what: `the resume notes of the ${roles.worker} ${workerId}` },
    again,
  });
  return notes.ok ? ok(notes.value.ageMs) : notes;
};

/** The pane read again right before the keys: it must be bound to the worker, still alive, out of the view window, and the same process. */
const requireSamePane = async (deps: Deps, request: ResetRequest, pane: BoundPane, again: string): Promise<CliResult<BoundPane>> => {
  const { home, workerId } = request;
  const bound = await requireBoundPane(deps, { home, paneId: pane.paneId, workerId, again });
  if (!bound.ok) return bound;
  const now = bound.value;
  if (now.dead) {
    return notReady(
      `the pane ${now.paneId} of the ${roles.worker} ${workerId} ended while the checks ran`,
      `Run "${commandText(lineFor(commandLines.workerResume, workerId))}" to start the ${roles.worker} again. Then ${runAgain(again)}`,
    );
  }
  const visible = requireOutOfView(now, workerId, again);
  if (!visible.ok) return visible;
  if (now.pid !== pane.pid) {
    return notReady(
      `the process of the pane ${now.paneId} changed while the checks ran`,
      `Look at the pane ${now.paneId} in tmux. Then ${runAgain(again)}`,
    );
  }
  return ok(now);
};

/**
 * The last-seen line of the worker, read after the bind. The line must belong to the worker and hold an event. The session must wait
 * at its prompt: a session that works or waits at a dialog is exit 1. The line must be later than the start of the pane process, so a
 * line of an earlier process of a pid that tmux used again never passes. The value is the id of the session of the line.
 */
const requireIdleSession = async (
  deps: Deps,
  request: ResetRequest,
  paneId: string,
  start: number,
  again: string,
): Promise<CliResult<string>> => {
  const { home, workerId } = request;
  const seen = await readOwnLastSeen(deps, home, workerId);
  if (!seen.ok) return seen;
  const wait = `Wait until the session reports, or look at the pane ${paneId} in tmux. Then ${runAgain(again)}`;
  if (seen.value.state !== 'valid') {
    return notReady(`cannot use the last-seen line of the ${roles.worker} ${workerId}: ${seen.value.reason}`, wait);
  }
  const { line } = seen.value;
  const state = promptStateOf(line);
  switch (state) {
    case null:
      return notReady(`the last-seen line of the ${roles.worker} ${workerId} holds no event`, wait);
    case 'busy':
      return failure(
        `the ${roles.worker} ${workerId} is busy: its session works now`,
        `Wait until it waits at its prompt. ${capitalize(runAgain(again))}`,
      );
    case 'waits':
      return failure(
        `the ${roles.worker} ${workerId} waits for an answer: a dialog is open in its session`,
        `Look at the pane ${paneId} and answer the dialog. Wait until the session waits at its prompt. ${capitalize(runAgain(again))}`,
      );
    case 'prompt': {
      const later = requireLineAfterStart(line[lastSeen.keys.eventAt] ?? '', start, again);
      return later.ok ? ok(line[lastSeen.keys.sessionId]) : later;
    }
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/** What the checks of steps 3 to 9 found. */
interface Checked {
  readonly pane: BoundPane;
  readonly sessionId: string;
  readonly resumeAgeMs: number;
  readonly name: string;
}

/** The checks from the record of the worker to the line of its session. Nothing is typed. */
const checkWorker = async (deps: Deps, request: ResetRequest, again: string): Promise<CliResult<Checked>> => {
  const { home, config, workerId, kind } = request;
  const record = await requireRecord(deps, home, workerId, commandText(commandLines.workerReset), flagText(resetKinds[kind].flag));
  if (!record.ok) return record;
  const name = sessionNames.worker(config.core.node.id, workerId);
  if (!name.ok) return failure(name.error);
  const live = await requireLivePane(deps, request, again);
  if (!live.ok) return live;
  const placed = requireOutOfView(live.value, workerId, again);
  if (!placed.ok) return placed;
  const start = await requireFreshSession(deps, record.value, live.value, again);
  if (!start.ok) return start;
  const pushed = await requirePushed(deps, request, record.value, again);
  if (!pushed.ok) return pushed;
  const resumeAgeMs = await requireResumeNotes(deps, home, workerId, again);
  if (!resumeAgeMs.ok) return resumeAgeMs;
  const pane = await requireSamePane(deps, request, live.value, again);
  if (!pane.ok) return pane;
  const sessionId = await requireIdleSession(deps, request, pane.value.paneId, start.value, again);
  if (!sessionId.ok) return sessionId;
  return ok({ pane: pane.value, sessionId: sessionId.value, resumeAgeMs: resumeAgeMs.value, name: name.value });
};

/**
 * Clears or compacts the session of a worker. Every check comes before the keys, and a refusal types nothing (see the order at the top
 * of the file). The line goes in with `typeLine`, whose capture of the screen is the last read before the keys, and the confirm waits for
 * the hook line of the reset. The value is the outcome of a reset that the hook line confirmed.
 */
export const resetWorker = async (deps: Deps, request: ResetRequest): Promise<CliResult<ResetOutcome>> => {
  const { home, config, workerId, kind } = request;
  const again = resetLine(workerId, kind);
  const caller = await requireCoordinatorCaller(deps, home, config, again);
  if (!caller.ok) return caller;
  const checked = await checkWorker(deps, request, again);
  if (!checked.ok) return checked;
  const { pane, sessionId, resumeAgeMs, name } = checked.value;
  const typedAt = deps.now();
  const typed = await typeLine(deps, pane.paneId, resetKinds[kind].line, `Then ${runAgain(again)}`);
  if (!typed.ok) return typed;
  const confirmed = await confirmReset(deps, { home, paneId: pane.paneId, workerId, kind, typedAt, sessionBefore: sessionId, again });
  if (!confirmed.ok) return confirmed;
  return ok({ workerId, kind, paneId: pane.paneId, name, resumeAgeMs });
};

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const countOf = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;

/** How long ago, in the largest whole unit: `less than a minute`, minutes, hours or days. */
const ageText = (ms: number): string => {
  if (ms < MS_PER_MINUTE) return 'less than a minute';
  if (ms < MS_PER_HOUR) return countOf(Math.floor(ms / MS_PER_MINUTE), 'minute');
  if (ms < MS_PER_DAY) return countOf(Math.floor(ms / MS_PER_HOUR), 'hour');
  return countOf(Math.floor(ms / MS_PER_DAY), 'day');
};

/** The output of a reset that the hook line confirmed: the verdict, the age of the resume notes, and the next step. */
export const resetOutput = (outcome: ResetOutcome): CommandOutput => {
  const { workerId, kind, paneId, name, resumeAgeMs } = outcome;
  const text = (line: string): OutLine => ({ level: 'text', text: line });
  const send = `send the next task with SendMessage to ${name}.`;
  const next =
    resetKinds[kind].newSession
      ? `Run ListAgents and look for the session ${name}. If it is not in the list, run "${commandText(lineFor(commands.restart, workerId))}". Then ${send}`
      : `Now ${send}`;
  return {
    lines: [
      { level: 'ok', text: `${capitalize(resetKinds[kind].done)} the session of the ${roles.worker} ${workerId} in the pane ${paneId}, and its session confirmed it.` },
      text(`The resume notes changed ${ageText(resumeAgeMs)} ago.`),
      text(next),
    ],
    json: {
      schema: schemaIds.workerReset,
      id: workerId,
      kind,
      pane: paneId,
      name,
      confirmed: true,
      resumeAgeSeconds: Math.floor(resumeAgeMs / MS_PER_SECOND),
    },
    warnings: [],
    failed: false,
  };
};
