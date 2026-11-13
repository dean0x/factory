import type { BoardItem, BoardRequest, LocalBoard } from '../board/contract.js';
import { declaredFields, itemTarget } from '../board/fields.js';
import { failure, type CliResult } from '../cli/errors.js';
import { displayLine, renderJson } from '../cli/output.js';
import { MAX_ADDRESS_LENGTH } from '../comms/address.js';
import { probeChildren, type ChildRow } from '../comms/children.js';
import {
  parseReport,
  type NodeReport,
  type ReportBoard,
  type ReportChild,
  type ReportItem,
  type ReportRequest,
  type ReportWorker,
} from '../comms/report-schema.js';
import type { Transport } from '../comms/transport.js';
import type { BoardConfig, FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commands, commandText, places, reportKeys, reportLimits, reportWords, schemaIds } from '../names.js';
import { FACTORY_VERSION } from '../version.js';
import { readStatus, type StatusReport } from '../workers/status-read.js';
import { shownStateOf, type WorkerStatus } from '../workers/status.js';
import type { WorkItemPort } from '../workers/work-items.js';

/**
 * The one builder of the report of a node (design 5.4). `status` and `report` both read the facts with `readNodeFacts` and make the
 * document with `reportDocOf`, so there is one code path. The document holds only the fields that the schema of the report lists:
 * `reportDocOf` copies each field by name, and the schema check refuses any other key. Every text from a file goes through
 * `displayLine` first, so a line break or a hidden character of a stored text never reaches the document.
 *
 * This module reads files and asks the ping of the transport. It knows no recipe: the caller gives the board connector, the work
 * item port and the transport.
 */

const doc = reportKeys.doc;
const workerKeys = reportKeys.worker;
const boardKeys = reportKeys.board;
const tallyKeys = reportKeys.tally;
const fieldKeys = reportKeys.field;
const itemKeys = reportKeys.item;
const requestKeys = reportKeys.request;
const childKeys = reportKeys.child;

/** What the builder reads from the board: every item (closed ones too) and the requests that wait for the owner. */
interface BoardFacts {
  readonly items: readonly BoardItem[];
  readonly requests: readonly BoardRequest[];
}

/**
 * What one build reads. The workers come with their notes for the caller (`status`). The board is a result of its own: a board that
 * cannot be read stops the report (`reportDocOf`), and it never stops the facts of the workers.
 */
export interface NodeFacts {
  readonly id: string;
  readonly layer: number;
  /** The `board` block of the setup: its states and its owner fields. */
  readonly setup: BoardConfig | undefined;
  readonly status: StatusReport;
  readonly board: CliResult<BoardFacts>;
  readonly children: readonly ChildRow[];
}

export interface FactsRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
  /** The reader of the items and the requests of the board. */
  readonly board: LocalBoard;
  readonly workItems: WorkItemPort;
  /** The way to reach the children. Each child is asked once. */
  readonly transport: Transport;
}

const readBoardFacts = async (board: LocalBoard): Promise<CliResult<BoardFacts>> => {
  const items = await board.listItems({ all: true });
  if (!items.ok) return items;
  const requests = await board.listRequests();
  return requests.ok ? ok({ items: items.value, requests: requests.value }) : requests;
};

/**
 * Read the facts of the node once: the workers (one call of `readStatus`, which makes the one list of the panes), the board and the
 * children. The call fails only when the facts of the workers fail, with the error of `readStatus`. A fault of the board is a value
 * of `NodeFacts.board`, and a child that does not answer is a row with the state `unknown`.
 */
export const readNodeFacts = async (deps: Deps, request: FactsRequest): Promise<CliResult<NodeFacts>> => {
  const { home, config, board, workItems, transport } = request;
  const status = await readStatus(deps, { home, config, workItems });
  if (!status.ok) return status;
  return ok({
    id: config.core.node.id,
    layer: config.core.node.layer,
    setup: config.core.board,
    status: status.value,
    board: await readBoardFacts(board),
    children: await probeChildren(transport, config.core.children),
  });
};

const lineOf = (text: string): string => displayLine(text, reportLimits.maxTextChars);

const lineOrNull = (text: string | null): string | null => (text === null ? null : lineOf(text));

const workerOf = (entry: WorkerStatus): ReportWorker => ({
  [workerKeys.id]: entry.id,
  [workerKeys.project]: lineOf(entry.project),
  [workerKeys.state]: shownStateOf(entry),
  [workerKeys.contextPct]: entry.contextPct,
  [workerKeys.activityAt]: entry.activityAt,
  [workerKeys.workItem]: entry.workItem.state === 'known' ? lineOrNull(entry.workItem.item) : null,
  [workerKeys.idle]: entry.idle,
});

type Tally = ReportBoard[typeof boardKeys.states][number];

/** The count of each name that is not empty after the clean-up, in the order of the names (by code unit), so the order never depends on the board. */
const talliesOf = (names: readonly string[]): Tally[] => {
  const counts = new Map<string, number>();
  for (const name of names.map(lineOf)) {
    if (name !== '') counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => Number(left > right) - Number(left < right))
    .map(([name, count]) => ({ [tallyKeys.name]: name, [tallyKeys.count]: count }));
};

/** The value of an owner field of an item as text, or null when the item has none. A flag counts as `true` or `false`. */
const fieldValueOf = (item: BoardItem, field: string): string | null => {
  const stored = Object.hasOwn(item.record, field) ? item.record[field] : undefined;
  if (typeof stored === 'string') return stored;
  return typeof stored === 'boolean' ? String(stored) : null;
};

const boardOf = (setup: BoardConfig | undefined, items: readonly BoardItem[]): ReportBoard => ({
  [boardKeys.states]: talliesOf(items.map((item) => item.status)),
  [boardKeys.fields]: declaredFields(setup, itemTarget).map((field) => ({
    [fieldKeys.field]: lineOf(field.name),
    [fieldKeys.values]: talliesOf(items.flatMap((item) => fieldValueOf(item, field.name) ?? [])),
  })),
});

const inProgressOf = (setup: BoardConfig | undefined, items: readonly BoardItem[]): ReportItem[] => {
  const state = setup?.in_progress;
  if (state === undefined) return [];
  return items
    .filter((item) => item.status === state)
    .map((item) => ({
      [itemKeys.id]: lineOf(item.id),
      [itemKeys.title]: lineOf(item.title),
      [itemKeys.state]: lineOf(item.status),
      [itemKeys.track]: lineOrNull(item.track),
      [itemKeys.stage]: lineOrNull(item.stage),
    }));
};

const requestsOf = (node: string, requests: readonly BoardRequest[]): ReportRequest[] =>
  requests.map((request) => ({
    [requestKeys.id]: lineOf(request.id),
    [requestKeys.title]: lineOrNull(request.title),
    [requestKeys.origin]: lineOf(`${node}${reportWords.originSeparator}${request.id}`),
  }));

const childOf = (row: ChildRow): ReportChild => ({
  [childKeys.id]: row.id,
  [childKeys.address]: displayLine(row.address, MAX_ADDRESS_LENGTH),
  [childKeys.state]: row.status,
  [childKeys.reason]: lineOrNull(row.reason),
  [childKeys.counts]: null,
  [childKeys.age]: null,
});

/**
 * The text of a report: the text of `report --json`, and the text of the report file. Both are the same text, so the file holds
 * the same document that the command prints.
 */
export const reportTextOf = (report: NodeReport): string => renderJson(report);

/**
 * Check a document before it leaves the node, for the command and for the file: it must pass the schema, which is the list of the
 * allowed fields with a cap for every text and every list, and its text must fit in `reportLimits.maxBytes`. The schema does not
 * count bytes, so this step does. A document over a cap is a failure (exit 1): the report is never cut, because a cut report would
 * give a wrong picture to a reader.
 */
export const checkReport = (input: unknown): CliResult<NodeReport> => {
  const again = `run "${commandText(commands.report)}" again`;
  const parsed = parseReport(input);
  if (!parsed.ok) {
    return failure(`the report is not valid: ${parsed.error}`, `Run "${commandText(commands.doctor)}" to check the ${places.folder}, then ${again}.`);
  }
  const bytes = Buffer.byteLength(reportTextOf(parsed.value), 'utf8');
  if (bytes > reportLimits.maxBytes) {
    return failure(
      `the report has ${bytes} bytes, more than the limit of ${reportLimits.maxBytes} bytes`,
      `Close the items that are done and remove the children that you do not use, then ${again}.`,
    );
  }
  return ok(parsed.value);
};

/**
 * The report document of the facts. A board that could not be read gives its error and no document: the report never shows an empty
 * board in place of a board that it could not read.
 */
export const reportDocOf = (facts: NodeFacts): CliResult<NodeReport> => {
  if (!facts.board.ok) return facts.board;
  const { items, requests } = facts.board.value;
  const report: NodeReport = {
    [doc.schema]: schemaIds.report,
    [doc.schemaVersion]: reportLimits.schemaVersion,
    [doc.id]: facts.id,
    [doc.layer]: facts.layer,
    [doc.factoryVersion]: FACTORY_VERSION,
    [doc.cursor]: null,
    [doc.workers]: facts.status.entries.map(workerOf),
    [doc.board]: boardOf(facts.setup, items),
    [doc.inProgress]: inProgressOf(facts.setup, items),
    [doc.requests]: requestsOf(facts.id, requests),
    [doc.events]: [],
    [doc.children]: facts.children.map(childOf),
  };
  return checkReport(report);
};
