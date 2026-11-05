import type { CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import type { PaneRow } from '../launch/tmux.js';
import { commands, hookNames, keys, lastSeen, roles, schemaIds, workerListWords } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { promptStateOf, readOwnLastSeen } from '../workers/last-seen.js';
import type { MachineLimits } from '../workers/machine.js';
import { readPanes } from '../workers/panes.js';
import { listWorkerRecords, type WorkerRecord } from '../workers/registry.js';

export interface WorkerListOptions {
  readonly home: string | undefined;
}

type WorkerState = (typeof workerListWords.states)[keyof typeof workerListWords.states];
type Mark = (typeof workerListWords.marks)[keyof typeof workerListWords.marks];

/** One worker of the list: its record, its pane, and what its last-seen line says. */
interface WorkerEntry {
  readonly id: string;
  readonly project: string;
  /** The pane that carries the mark of the worker, or null for no pane. */
  readonly pane: string | null;
  readonly dead: boolean;
  readonly state: WorkerState;
  readonly contextPct: number | null;
  readonly mark: Mark | null;
}

const text = (line: string): OutLine => ({ level: 'text', text: line });

/** The mark of a context percent: the max mark above the max limit, the prepare mark from the prepare limit up to it. */
const markOf = (percent: number | null, limits: MachineLimits): Mark | null => {
  if (percent === null) return null;
  if (percent > limits[keys.limits.contextMaxPct]) return workerListWords.marks.max;
  return percent >= limits[keys.limits.contextPreparePct] ? workerListWords.marks.prepare : null;
};

const stateWords: Readonly<Record<'prompt' | 'busy', WorkerState>> = {
  prompt: workerListWords.states.prompt,
  busy: workerListWords.states.busy,
};

/**
 * What the last-seen line of the worker says. The line counts only when it belongs to this worker (`readOwnLastSeen`), as for
 * stop and resume. A line that is absent, not valid or not owned says nothing, and a line that cannot be read gives a warning.
 */
const lastSeenOf = async (
  deps: Deps,
  home: string,
  id: string,
): Promise<{ readonly state: WorkerState; readonly contextPct: number | null; readonly warning: string | null }> => {
  const unknown = { state: workerListWords.states.unknown, contextPct: null, warning: null };
  const read = await readOwnLastSeen(deps, home, id);
  if (!read.ok) return { ...unknown, warning: `cannot read the last-seen line of the ${roles.worker} ${id}: ${read.error.message}` };
  if (read.value.state !== 'valid') return unknown;
  const state = promptStateOf(read.value.line);
  return {
    state: state === null ? workerListWords.states.unknown : stateWords[state],
    contextPct: read.value.line[lastSeen.keys.contextPct],
    warning: null,
  };
};

/** The pane of a worker: its first live pane, else its first pane. More than one pane with the mark is named in a warning. */
const paneOf = (panes: readonly PaneRow[], id: string): { readonly row: PaneRow | null; readonly warning: string | null } => {
  const marked = panes.filter((pane) => pane.worker === id);
  const row = marked.find((pane) => !pane.dead) ?? marked[0] ?? null;
  const warning =
    marked.length > 1 ? `the ${roles.worker} ${id} has ${marked.length} panes: ${marked.map((pane) => pane.paneId).join(', ')}` : null;
  return { row, warning };
};

const entryOf = async (
  deps: Deps,
  home: string,
  record: WorkerRecord,
  panes: readonly PaneRow[],
  limits: MachineLimits,
): Promise<{ readonly entry: WorkerEntry; readonly warnings: readonly string[] }> => {
  const pane = paneOf(panes, record.id);
  const seen = await lastSeenOf(deps, home, record.id);
  const entry: WorkerEntry = {
    id: record.id,
    project: record.project,
    pane: pane.row?.paneId ?? null,
    dead: pane.row?.dead ?? false,
    state: seen.state,
    contextPct: seen.contextPct,
    mark: markOf(seen.contextPct, limits),
  };
  return { entry, warnings: [pane.warning, seen.warning].filter((warning): warning is string => warning !== null) };
};

const paneText = (entry: WorkerEntry): string => {
  if (entry.pane === null) return workerListWords.pane.none;
  return entry.dead ? workerListWords.pane.dead : entry.pane;
};

const cellsOf = (entry: WorkerEntry): readonly string[] => [
  entry.id,
  entry.project,
  paneText(entry),
  entry.state,
  entry.contextPct === null ? hookNames.unknownPercent : `${entry.contextPct}%`,
  entry.mark ?? '',
];

/** The title line, then one line for each worker. A column is as wide as its widest cell, and two spaces part the columns. */
const tableLines = (entries: readonly WorkerEntry[]): readonly OutLine[] => {
  const title = Object.values(workerListWords.columns);
  const rows = [title, ...entries.map(cellsOf)];
  const widths = title.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  const lineOf = (row: readonly string[]): string => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
  return [{ level: 'heading', text: lineOf(title) }, ...entries.map((entry) => text(lineOf(cellsOf(entry))))];
};

/**
 * `worker list`: each worker of the registry with its pane, its state, its context percent and its mark. It reads the registry,
 * one list of the panes and the last-seen line of each worker, and it changes nothing. With no tmux session of this factory,
 * every pane is none. A folder with no valid record is named in a warning and in the JSON, and the other workers are listed.
 */
export const runWorkerList = async (
  deps: Deps,
  options: WorkerListOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.worker,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const config = loaded.value;
  const records = await listWorkerRecords(deps, home);
  if (!records.ok) return records;
  const panes = await readPanes(deps, config.core.node.id, home);
  if (!panes.ok) return panes;

  const entries: WorkerEntry[] = [];
  const warnings = records.value.invalid.map((item) => `cannot use the folder ${item.name} of the ${roles.worker}s: ${item.reason}`);
  for (const record of records.value.workers) {
    const made = await entryOf(deps, home, record, panes.value ?? [], config.core.limits);
    entries.push(made.entry);
    warnings.push(...made.warnings);
  }
  return ok({
    lines: entries.length === 0 ? [text(`No ${roles.worker}s yet.`)] : tableLines(entries),
    json: {
      schema: schemaIds.workerList,
      home,
      running: panes.value !== null,
      workers: entries.map((entry) => ({
        id: entry.id,
        project: entry.project,
        pane: entry.pane,
        dead: entry.dead,
        state: entry.state,
        contextPct: entry.contextPct,
        mark: entry.mark,
      })),
      invalid: records.value.invalid,
    },
    warnings,
    failed: false,
  });
};
