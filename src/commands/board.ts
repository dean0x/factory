import { declaredFields, itemTarget, rowTarget } from '../board/fields.js';
import { displayOf } from '../board/item-display.js';
import { boardView, queueView, requestView } from '../board/list-view.js';
import { usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { boardDocKeys, boardWords, capitalize, commands, flags, flagText, maxDisplayWidth, schemaIds } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { gatherMachine } from '../workers/machine.js';
import { readPower } from '../workers/power.js';
import { readStatus } from '../workers/status-read.js';
import type { WorkItemPort } from '../workers/work-items.js';
import { openBoard, type OpenBoard } from './board-open.js';
import { epicOf } from './item.js';
import { machineFactsOf, machineOutput } from './machine.js';
import { queueRowsJsonOf } from './queue.js';
import { requestRowsOf } from './request.js';
import { workerListView, workerRowsOf } from './worker-list.js';

export interface BoardOptions {
  readonly home: string | undefined;
  readonly width: string | undefined;
  readonly json: boolean;
}

type SectionName = keyof typeof boardWords.headings;

interface SectionContent {
  readonly facts: unknown;
  readonly lines: readonly OutLine[];
  readonly warnings?: readonly string[];
}

interface Section extends SectionContent {
  readonly name: SectionName;
  readonly error: string | null;
}

const sectionOf = <T>(name: SectionName, read: CliResult<T>, build: (value: T) => SectionContent): Section => read.ok
  ? { name, error: null, ...build(read.value) }
  : { name, error: read.error.message, facts: null, lines: [{ level: 'text', text: `${boardWords.fault}: ${read.error.message}` }] };

const widthOf = (options: BoardOptions): CliResult<number> => {
  if (options.json || options.width === undefined) return ok(maxDisplayWidth);
  const width = Number(options.width);
  return boardWords.widthPattern.test(options.width) && Number.isInteger(width) && width >= boardWords.minWidth && width <= maxDisplayWidth
    ? ok(width)
    : usageError(`${flagText(flags.width)} takes a whole number from ${boardWords.minWidth} to ${maxDisplayWidth}`);
};

const readItems = async (board: OpenBoard) => {
  const items = await board.connector.listItems({ all: false });
  if (!items.ok) return items;
  const tracks = await board.connector.listTracks();
  return tracks.ok ? ok({ items: items.value, tracks: tracks.value }) : tracks;
};

/** Read each section without a lock. A fault hides that section, not the facts of the other sections. */
export const runBoard = async (
  deps: Deps,
  options: BoardOptions,
  registry: RecipeRegistry,
  workItems: WorkItemPort,
): Promise<CliResult<CommandOutput>> => {
  const width = widthOf(options);
  if (!width.ok) return width;
  const opened = await openBoard(deps, options.home, registry, commands.board);
  if (!opened.ok) return opened;
  const board = opened.value;
  const { home, config, connector } = board;
  const rowFields = declaredFields(config.core.board, rowTarget);
  const [requests, workers, items, queue, report, power] = await Promise.all([
    connector.listRequests(),
    readStatus(deps, { home, config, workItems }),
    readItems(board),
    connector.listQueue(),
    gatherMachine(deps, home, config.core.limits),
    readPower(deps),
  ]);
  const sections: readonly Section[] = [
    sectionOf(boardDocKeys.requests, requests, (rows) => ({ facts: requestRowsOf(rows), lines: requestView(rows) })),
    sectionOf(boardDocKeys.workers, workers, (status) => ({ facts: workerRowsOf(status.entries), lines: workerListView(status.entries), warnings: status.warnings })),
    sectionOf(boardDocKeys.items, items, (read) => ({
      facts: read.items.slice(0, boardWords.maxItems).map((item) => ({ id: item.id, ...displayOf(item), epic: epicOf(item) })),
      lines: boardView({ ...read, board: config.entry.board, fields: declaredFields(config.core.board, itemTarget), all: false }),
    })),
    sectionOf(boardDocKeys.queue, queue, (rows) => ({ facts: queueRowsJsonOf(rows, rowFields), lines: queueView({ rows, fields: rowFields }) })),
    sectionOf(boardDocKeys.machine, ok(report), (facts) => ({ facts: machineFactsOf(facts, power), lines: machineOutput(home, facts, power).lines })),
  ];
  const lines = sections.flatMap((section, index): readonly OutLine[] => [
    ...(index === 0 ? [] : [{ level: 'text' as const, text: '' }]),
    { level: 'heading', text: capitalize(boardWords.headings[section.name]) },
    ...section.lines,
  ]).map((line) => ({ ...line, text: displayLine(line.text, width.value) }));
  return ok({
    lines,
    width: width.value,
    json: {
      schema: schemaIds.board,
      [boardDocKeys.home]: home,
      ...Object.fromEntries(sections.map((section) => [section.name, section.facts])),
      [boardDocKeys.itemsMore]: items.ok ? Math.max(0, items.value.items.length - boardWords.maxItems) : 0,
      [boardDocKeys.faults]: sections.flatMap((section) => section.error === null ? [] : [{ [boardDocKeys.section]: section.name, [boardDocKeys.error]: section.error }]),
    },
    warnings: sections.flatMap((section) => section.warnings ?? []),
    failed: sections.every((section) => section.error !== null),
  });
};
