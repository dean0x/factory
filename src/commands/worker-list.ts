import type { CliResult } from '../cli/errors.js';
import { displayLine, tableLines, type CommandOutput, type OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { commands, hookNames, roles, schemaIds, workerListWords } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { readStatus } from '../workers/status-read.js';
import type { WorkerStatus } from '../workers/status.js';
import type { WorkItemPort } from '../workers/work-items.js';

export interface WorkerListOptions {
  readonly home: string | undefined;
}

const text = (line: string): OutLine => ({ level: 'text', text: line });

const paneText = (entry: WorkerStatus): string => {
  if (entry.pane === null) return workerListWords.pane.none;
  return entry.dead ? workerListWords.pane.dead : entry.pane;
};

const cellsOf = (entry: WorkerStatus): readonly string[] =>
  [
    entry.id,
    entry.project,
    paneText(entry),
    entry.state,
    entry.contextPct === null ? hookNames.unknownPercent : `${entry.contextPct}%`,
    entry.mark ?? '',
  ].map((cell) => displayLine(cell));

/**
 * `worker list`: each worker of the registry with its pane, its state, its context percent and its mark. It reads the registry,
 * one list of the panes and the last-seen line of each worker, and it changes nothing. With no tmux session of this factory,
 * every pane is none. A folder with no valid record is named in a warning and in the JSON, and the other workers are listed.
 * The facts come from the builder of `status`, which asks the work item port. The list shows no work item, but a fault of the port
 * is a warning here as in `status`. The port is a required parameter. Each cell of the table is one clean line.
 */
export const runWorkerList = async (
  deps: Deps,
  options: WorkerListOptions,
  registry: RecipeRegistry,
  workItems: WorkItemPort,
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
  const read = await readStatus(deps, { home, config: loaded.value, workItems });
  if (!read.ok) return read;
  const { entries, invalid, running, warnings } = read.value;
  return ok({
    lines: entries.length === 0 ? [text(`No ${roles.worker}s yet.`)] : tableLines(Object.values(workerListWords.columns), entries.map(cellsOf)),
    json: {
      schema: schemaIds.workerList,
      home,
      running,
      workers: entries.map((entry) => ({
        id: entry.id,
        project: entry.project,
        pane: entry.pane,
        dead: entry.dead,
        state: entry.state,
        contextPct: entry.contextPct,
        mark: entry.mark,
      })),
      invalid,
    },
    warnings,
    failed: false,
  });
};
