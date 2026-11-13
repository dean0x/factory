import type { CliError, CliResult } from '../cli/errors.js';
import { displayLine, tableLines, type CommandOutput, type OutLine } from '../cli/output.js';
import { fileTransport } from '../comms/transport.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commands, roles, schemaIds, statusWords } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { readNodeFacts, reportDocOf, type NodeFacts } from '../report/build.js';
import { writeReportFile } from '../report/outbox.js';
import { shownStateOf, type WorkerStatus } from '../workers/status.js';
import type { WorkItem, WorkItemPort } from '../workers/work-items.js';
import { openBoard } from './board-open.js';

export interface StatusOptions {
  readonly home: string | undefined;
}

const text = (line: string): OutLine => ({ level: 'text', text: line });

const workItemText = (workItem: WorkItem): string =>
  workItem.state === 'unknown' ? statusWords.workItem.unknown : (workItem.item ?? statusWords.workItem.none);

const cellsOf = (entry: WorkerStatus): readonly string[] =>
  [
    entry.id,
    entry.project,
    shownStateOf(entry),
    workItemText(entry.workItem),
    entry.idle ? statusWords.idle.yes : statusWords.idle.no,
  ].map((cell) => displayLine(cell));

/** A fault of the report file that does not stop `status`: one warning line, with the reason as one clean line. */
const notWritten = (error: CliError): CliResult<readonly string[]> =>
  ok([`the report file was not written: ${displayLine(error.message)}`]);

/**
 * Write the report file from the facts that this run read, so `status` and `report` give one picture. The writer makes no file and
 * no folder for a node with no factory folder, and that is no fault. A link at the file, at its folder or at the factory folder is a
 * security stop (exit 4), the only error here. Any other fault gives a warning line: a board that cannot be read (the report would
 * hold a wrong picture), a document over a cap and a write that fails. A warning never changes the exit code or the text of `status`.
 */
const refreshReport = async (deps: Deps, home: string, facts: NodeFacts): Promise<CliResult<readonly string[]>> => {
  const document = reportDocOf(facts);
  if (!document.ok) return notWritten(document.error);
  const written = await writeReportFile(deps, home, document.value);
  if (written.ok) return ok([]);
  return written.error.kind === 'safety' ? written : notWritten(written.error);
};

/**
 * `status`: each worker with its state, its work item and its idle state. It reads the facts of the node with the one builder of the
 * report (`readNodeFacts`), which reads what `worker list` reads (the registry, one list of the panes and the last-seen line of each
 * worker) and asks the work item port for the work items. Its one change is the report file, which it writes from the same facts as
 * `report` does (`refreshReport`). With no tmux session of this factory, every worker is stopped. A worker is idle only when its
 * activity is older than `limits.idle_after` and the port says that it has no open work. A work item that the port does not give is
 * unknown, and an unknown work item is never idle. The port is a required parameter, so no caller can leave the work items out. Each
 * cell of the table is one clean line.
 */
export const runStatus = async (
  deps: Deps,
  options: StatusOptions,
  registry: RecipeRegistry,
  workItems: WorkItemPort,
): Promise<CliResult<CommandOutput>> => {
  const opened = await openBoard(deps, options.home, registry, commands.status);
  if (!opened.ok) return opened;
  const { home, config, connector } = opened.value;
  const read = await readNodeFacts(deps, { home, config, board: connector, workItems, transport: fileTransport(deps, registry) });
  if (!read.ok) return read;
  const refreshed = await refreshReport(deps, home, read.value);
  if (!refreshed.ok) return refreshed;
  const { entries, invalid, running, warnings } = read.value.status;
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
        state: shownStateOf(entry),
        contextPct: entry.contextPct,
        mark: entry.mark,
        activityAt: entry.activityAt,
        workItem: entry.workItem,
        idle: entry.idle,
      })),
      invalid,
    },
    warnings: [...warnings, ...refreshed.value],
    failed: false,
  });
};
