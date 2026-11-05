import type { CliResult } from '../cli/errors.js';
import { tableLines, type CommandOutput, type OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { commands, roles, schemaIds, statusWords } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { readStatus } from '../workers/status-read.js';
import type { WorkerStatus } from '../workers/status.js';
import { unknownWorkItems, type WorkItem, type WorkItemPort } from '../workers/work-items.js';

export interface StatusOptions {
  readonly home: string | undefined;
}

const text = (line: string): OutLine => ({ level: 'text', text: line });

/** What a person reads as the state: a worker with no live pane is stopped, whatever its last line says. */
const stateText = (entry: WorkerStatus): string => (entry.running ? entry.state : statusWords.stopped);

const workItemText = (workItem: WorkItem): string =>
  workItem.state === 'unknown' ? statusWords.workItem.unknown : (workItem.item ?? statusWords.workItem.none);

const cellsOf = (entry: WorkerStatus): readonly string[] => [
  entry.id,
  entry.project,
  stateText(entry),
  workItemText(entry.workItem),
  entry.idle ? statusWords.idle.yes : statusWords.idle.no,
];

/**
 * `status`: each worker with its state, its work item and its idle state. It reads what `worker list` reads (the registry, one list of
 * the panes and the last-seen line of each worker) and asks the work item port for the work items. It changes nothing. With no tmux
 * session of this factory, every worker is stopped. A worker is idle only when its activity is older than `limits.idle_after` and
 * the port says that it has no open work. A work item that the port does not give is unknown, and an unknown work item is never
 * idle. The default port knows no work item, so no worker is idle until the board reader of FAC-M5 is the port.
 */
export const runStatus = async (
  deps: Deps,
  options: StatusOptions,
  registry: RecipeRegistry,
  workItems: WorkItemPort = unknownWorkItems,
): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.status,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const read = await readStatus(deps, { home, config: loaded.value, workItems });
  if (!read.ok) return read;
  const { entries, invalid, running, warnings } = read.value;
  return ok({
    lines: entries.length === 0 ? [text(`No ${roles.worker}s yet.`)] : tableLines(Object.values(statusWords.columns), entries.map(cellsOf)),
    json: {
      schema: schemaIds.status,
      home,
      running,
      workers: entries.map((entry) => ({
        id: entry.id,
        project: entry.project,
        pane: entry.pane,
        dead: entry.dead,
        state: stateText(entry),
        contextPct: entry.contextPct,
        mark: entry.mark,
        activityAt: entry.activityAt,
        workItem: entry.workItem,
        idle: entry.idle,
      })),
      invalid,
    },
    warnings,
    failed: false,
  });
};
