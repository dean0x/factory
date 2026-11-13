import type { PaneRow } from '../launch/tmux.js';
import { keys, lastSeen, roles, statusWords, workerListWords, type HookState } from '../names.js';
import { promptStateOf, type LastSeen } from './last-seen.js';
import type { MachineLimits } from './machine.js';
import type { WorkerRecord } from './registry.js';
import { unknownItem, type WorkItem } from './work-items.js';

/**
 * The one builder of the worker table (design 4.6, 4.11). `status` and `worker list` read their facts, give them to `buildStatus`,
 * and print what it returns. The builder makes no call: the records, the panes, the last-seen lines, the work items and the time
 * come in as data.
 */

export type WorkerState = (typeof workerListWords.states)[keyof typeof workerListWords.states];
export type Mark = (typeof workerListWords.marks)[keyof typeof workerListWords.marks];
/** The state that a person reads: the state of the worker, or `stopped`. */
export type ShownState = WorkerState | typeof statusWords.stopped;

const MS_PER_MINUTE = 60_000;

/**
 * What a read of the last-seen line of one worker found: a line that the worker owns (`readOwnLastSeen`), no line that it may use
 * (absent, not valid or not owned: the line says nothing), or a fault of the file system with its reason.
 */
export type LineRead =
  | { readonly kind: 'line'; readonly line: LastSeen }
  | { readonly kind: 'none' }
  | { readonly kind: 'fault'; readonly reason: string };

/** One worker of the table: its record, its pane, what its last-seen line says, its work item and whether it is idle. */
export interface WorkerStatus {
  readonly id: string;
  readonly project: string;
  /** The pane that carries the mark of the worker, or null for no pane. */
  readonly pane: string | null;
  readonly dead: boolean;
  /** True when the worker has a pane whose program has not ended. With no session, no worker runs. */
  readonly running: boolean;
  /** What the last event of the last-seen line says. It is `unknown` for a worker with no line that it owns. */
  readonly state: WorkerState;
  readonly contextPct: number | null;
  readonly mark: Mark | null;
  /** The newer of the event time and the percent time of the line, as the line holds it, or null when the worker has no line. */
  readonly activityAt: string | null;
  readonly workItem: WorkItem;
  /** True when the pane lives, the session waits at the prompt and its last event is older than `idle_after`. It says nothing of the work item. */
  readonly idle: boolean;
  /** True when the board knows the work item of the worker and the worker has no open item. */
  readonly noOpenWork: boolean;
}

export interface StatusInput {
  readonly records: readonly WorkerRecord[];
  /** The panes of the session from one list call, or null when no session of this factory runs. */
  readonly panes: readonly PaneRow[] | null;
  /** The read of the last-seen line of each worker, by id. A worker with no entry has no line. */
  readonly lines: ReadonlyMap<string, LineRead>;
  /** The work item of each worker, by id. A worker with no entry has an unknown work item. */
  readonly workItems: ReadonlyMap<string, WorkItem>;
  readonly now: Date;
  /** The minutes of `limits.idle_after`. */
  readonly idleAfterMinutes: number;
  readonly limits: MachineLimits;
}

export interface BuiltStatus {
  /** One entry for each record, in the order of the records. */
  readonly entries: readonly WorkerStatus[];
  readonly warnings: readonly string[];
}

/** The mark of a context percent: the max mark above the max limit, the prepare mark from the prepare limit up to it. */
const markOf = (percent: number | null, limits: MachineLimits): Mark | null => {
  if (percent === null) return null;
  if (percent > limits[keys.limits.contextMaxPct]) return workerListWords.marks.max;
  return percent >= limits[keys.limits.contextPreparePct] ? workerListWords.marks.prepare : null;
};

const stateWords: Readonly<Record<HookState, WorkerState>> = {
  prompt: workerListWords.states.prompt,
  busy: workerListWords.states.busy,
  waits: workerListWords.states.waits,
};

/** The pane of a worker: its first live pane, else its first pane. More than one pane with the mark is named in a warning. */
const paneOf = (panes: readonly PaneRow[], id: string): { readonly row: PaneRow | null; readonly warning: string | null } => {
  const marked = panes.filter((pane) => pane.worker === id);
  const row = marked.find((pane) => !pane.dead) ?? marked[0] ?? null;
  const warning =
    marked.length > 1 ? `the ${roles.worker} ${id} has ${marked.length} panes: ${marked.map((pane) => pane.paneId).join(', ')}` : null;
  return { row, warning };
};

/** The newer of the two times of a line, as the line holds it, or null for a line with no time. */
const activityOf = (line: LastSeen): string | null =>
  [line[lastSeen.keys.eventAt], line[lastSeen.keys.pctAt]]
    .filter((time): time is string => time !== null)
    .reduce<string | null>((newest, time) => (newest === null || Date.parse(time) > Date.parse(newest) ? time : newest), null);

/**
 * A worker is idle when its pane lives, its session waits at the prompt and its last event is older than `idle_after`. The event
 * time counts, not the percent time: a percent line alone does not show that the session works. A worker with no pane, a dead pane,
 * no line, a session that works or waits, and a time that is not a time are never idle: an unknown fact fails closed. Idle says
 * nothing of the work item. A dismiss reads `noOpenWork` too.
 */
const isIdle = (running: boolean, state: WorkerState, eventAt: string | null, now: Date, idleAfterMinutes: number): boolean => {
  if (!running || state !== workerListWords.states.prompt || eventAt === null) return false;
  return now.getTime() - Date.parse(eventAt) > idleAfterMinutes * MS_PER_MINUTE;
};

/** True when the board knows the work of the worker and the worker has no open item. An unknown work item is never free of work. */
const hasNoOpenWork = (workItem: WorkItem): boolean => workItem.state === 'known' && workItem.item === null;

const entryOf = (
  record: WorkerRecord,
  input: StatusInput,
): { readonly entry: WorkerStatus; readonly warnings: readonly string[] } => {
  const pane = paneOf(input.panes ?? [], record.id);
  const read = input.lines.get(record.id);
  const line = read?.kind === 'line' ? read.line : null;
  const promptState = line === null ? null : promptStateOf(line);
  const contextPct = line === null ? null : line[lastSeen.keys.contextPct];
  const activityAt = line === null ? null : activityOf(line);
  const workItem = input.workItems.get(record.id) ?? unknownItem;
  const fault =
    read?.kind === 'fault' ? `cannot read the last-seen line of the ${roles.worker} ${record.id}: ${read.reason}` : null;
  const running = pane.row !== null && !pane.row.dead;
  const state = promptState === null ? workerListWords.states.unknown : stateWords[promptState];
  const eventAt = line === null ? null : line[lastSeen.keys.eventAt];
  const entry: WorkerStatus = {
    id: record.id,
    project: record.project,
    pane: pane.row?.paneId ?? null,
    dead: pane.row?.dead ?? false,
    running,
    state,
    contextPct,
    mark: markOf(contextPct, input.limits),
    activityAt,
    workItem,
    idle: isIdle(running, state, eventAt, input.now, input.idleAfterMinutes),
    noOpenWork: hasNoOpenWork(workItem),
  };
  return { entry, warnings: [pane.warning, fault].filter((warning): warning is string => warning !== null) };
};

/** The table of the workers from the facts that the caller read. It makes no call and changes none of its inputs. */
export const buildStatus = (input: StatusInput): BuiltStatus => {
  const built = input.records.map((record) => entryOf(record, input));
  return { entries: built.map(({ entry }) => entry), warnings: built.flatMap(({ warnings }) => warnings) };
};

/** What a person reads as the state: a worker with no live pane is stopped, whatever its last line says. */
export const shownStateOf = (entry: WorkerStatus): ShownState => (entry.running ? entry.state : statusWords.stopped);
