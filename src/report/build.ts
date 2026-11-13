import type { BoardItem, BoardRequest, LocalBoard } from '../board/contract.js';
import { declaredFields, itemTarget } from '../board/fields.js';
import { failure, type CliResult } from '../cli/errors.js';
import { displayLine, renderJson } from '../cli/output.js';
import { MAX_ADDRESS_LENGTH } from '../comms/address.js';
import { probeChildren, type ChildRow } from '../comms/children.js';
import { isOverCallCap } from '../comms/report-read.js';
import {
  parseReport,
  type NodeReport,
  type ReportBoard,
  type ReportChild,
  type ReportCounts,
  type ReportItem,
  type ReportRequest,
  type ReportWorker,
  type ReportWorkItem,
} from '../comms/report-schema.js';
import type { Transport } from '../comms/transport.js';
import type { BoardConfig, FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import {
  childReasons,
  commands,
  commandText,
  places,
  reportKeys,
  reportLimits,
  reportWords,
  requestWords,
  schemaIds,
} from '../names.js';
import { FACTORY_VERSION } from '../version.js';
import { readStatus, type StatusReport } from '../workers/status-read.js';
import { shownStateOf, type WorkerStatus } from '../workers/status.js';
import type { WorkItem, WorkItemPort } from '../workers/work-items.js';

/**
 * The one builder of the report of a node (design 5.4). `status` and `report` both read the facts with `readNodeFacts` and make the
 * document with `reportDocOf`, so there is one code path. The document holds only the fields that the schema of the report lists:
 * `reportDocOf` copies each field by name, and the schema check refuses any other key. Every text from a file goes through
 * `displayLine` first, so a line break or a hidden character of a stored text never reaches the document.
 *
 * This module reads files and asks the ping of the transport. It also reads the report file of each child that answers the ping,
 * through the transport. It knows no recipe: the caller gives the board connector, the work item port and the transport.
 */

const doc = reportKeys.doc;
const workerKeys = reportKeys.worker;
const workItemKeys = reportKeys.workItem;
const workItemStates = reportWords.workItemStates;
const boardKeys = reportKeys.board;
const tallyKeys = reportKeys.tally;
const fieldKeys = reportKeys.field;
const itemKeys = reportKeys.item;
const requestKeys = reportKeys.request;
const childKeys = reportKeys.child;
const countKeys = reportKeys.counts;
const childStates = reportWords.childStates;

/** What the builder reads from the board: every item (closed ones too) and the requests that wait for the owner. */
interface BoardFacts {
  readonly items: readonly BoardItem[];
  readonly requests: readonly BoardRequest[];
}

/**
 * One direct child: the row of the ping, and what its report file gives. `counts` and `age` are null for a child that does not
 * pass the ping and for a report file that cannot be read. A report file that was read and shows another id gives its age and no counts.
 */
export interface ChildFacts {
  readonly row: ChildRow;
  readonly counts: ReportCounts | null;
  /** The age of the report file in whole seconds. */
  readonly age: number | null;
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
  /** The direct children, in the order of the config. A child of a child has no entry. */
  readonly children: readonly ChildFacts[];
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

const countsOf = (report: NodeReport): ReportCounts => ({
  [countKeys.workers]: report.workers.length,
  [countKeys.inProgress]: report.inProgress.length,
  [countKeys.requests]: report.requests.length,
  [countKeys.children]: report.children.length,
});

const withoutFacts = (row: ChildRow): ChildFacts => ({ row, counts: null, age: null });

/**
 * Read the report file of each child that the ping found, in the order of the config. The reads run one after the other, because each
 * read needs the part of `reportLimits.maxBuildBytes` that the reads before it left. A child that did not pass the ping gets no read.
 * A report file with another id than the config lists gives a `mismatch`, and a file that cannot be read gives `unknown` with its
 * fixed reason: neither shows text of the child. When nothing of the budget is left, the child is `unknown` with the reason of the
 * byte cap, and no read happens. A file that is larger than the part of the budget that is left gives the reason of the byte cap too.
 */
const readChildFacts = async (transport: Transport, rows: readonly ChildRow[]): Promise<readonly ChildFacts[]> => {
  const facts: ChildFacts[] = [];
  let left: number = reportLimits.maxBuildBytes;
  for (const row of rows) {
    if (row.status !== childStates.ok) {
      facts.push(withoutFacts(row));
    } else if (left <= 0) {
      facts.push(withoutFacts({ ...row, layer: null, status: childStates.unknown, reason: childReasons.buildByteCap }));
    } else {
      const read = await transport.report(row.address, left);
      const overCap = isOverCallCap(read, left);
      left = Math.max(0, left - read.bytes);
      if (read.state === 'unknown') {
        const reason = overCap ? childReasons.buildByteCap : read.reason;
        facts.push({ row: { ...row, layer: null, status: childStates.unknown, reason }, counts: null, age: read.age });
      } else if (read.report.id !== row.id) {
        facts.push({ row: { ...row, layer: null, status: childStates.mismatch, reason: childReasons.otherId }, counts: null, age: read.age });
      } else {
        facts.push({ row, counts: countsOf(read.report), age: read.age });
      }
    }
  }
  return facts;
};

/**
 * Read the facts of the node: the workers (one call of `readStatus`, which makes the one list of the panes), the board and the
 * children. One run reads `board.json` two times: once for the work item port, which `readStatus` calls (`readBoard`), and once for
 * the list of the items (`listItems`, in `readBoardFacts`). Each child is pinged once, and each child that answers the ping is asked
 * for its report file once (`readChildFacts`). The call fails only when the facts of the workers fail, with the error of
 * `readStatus`. A fault of the board is a value of `NodeFacts.board`, and a child that does not answer is a row with the state
 * `unknown`.
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
    children: await readChildFacts(transport, await probeChildren(transport, config.core.children)),
  });
};

const lineOf = (text: string): string => displayLine(text, reportLimits.maxTextChars);

const lineOrNull = (text: string | null): string | null => (text === null ? null : lineOf(text));

/** A work item that the board gave, with a clean item or null for no open work; or a work item that it did not give. */
const workItemOf = (workItem: WorkItem): ReportWorkItem =>
  workItem.state === 'known'
    ? { [workItemKeys.state]: workItemStates.known, [workItemKeys.item]: lineOrNull(workItem.item) }
    : { [workItemKeys.state]: workItemStates.unknown };

const workerOf = (entry: WorkerStatus): ReportWorker => ({
  [workerKeys.id]: entry.id,
  [workerKeys.project]: lineOf(entry.project),
  [workerKeys.state]: shownStateOf(entry),
  [workerKeys.contextPct]: entry.contextPct,
  [workerKeys.activityAt]: entry.activityAt,
  [workerKeys.workItem]: workItemOf(entry.workItem),
  [workerKeys.idle]: entry.idle,
});

type Tally = ReportBoard[typeof boardKeys.states][number];

/** A list of counts: at most `maxCountRows` rows, and the number of the different names that the list left out. */
interface Tallies {
  readonly rows: Tally[];
  readonly omitted: number;
}

/**
 * The count of each name that is not empty after the clean-up. The rows come with the highest count first, and equal counts in the
 * order of the names (by code unit), so the order never depends on the board. A list keeps at most `maxCountRows` rows, the first ones
 * of that order, and `omitted` is the exact number of the other names. A long list is never a failure.
 */
const talliesOf = (names: readonly string[]): Tallies => {
  const counts = new Map<string, number>();
  for (const name of names.map(lineOf)) {
    if (name !== '') counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const ordered = [...counts].sort(
    ([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || Number(leftName > rightName) - Number(leftName < rightName),
  );
  return {
    rows: ordered.slice(0, reportLimits.maxCountRows).map(([name, count]) => ({ [tallyKeys.name]: name, [tallyKeys.count]: count })),
    omitted: Math.max(0, ordered.length - reportLimits.maxCountRows),
  };
};

/** The value of an owner field of an item as text, or null when the item has none. A flag counts as `true` or `false`. */
const fieldValueOf = (item: BoardItem, field: string): string | null => {
  const stored = Object.hasOwn(item.record, field) ? item.record[field] : undefined;
  if (typeof stored === 'string') return stored;
  return typeof stored === 'boolean' ? String(stored) : null;
};

/**
 * The board counts. The states count all the items, because the setup caps the states. The values of an owner field count the open
 * items only: a closed item keeps its values and the board never removes an item, so a count over all items would only grow.
 */
const boardOf = (setup: BoardConfig | undefined, items: readonly BoardItem[]): ReportBoard => {
  const closed = setup?.closed;
  const open = closed === undefined ? items : items.filter((item) => item.status !== closed);
  const states = talliesOf(items.map((item) => item.status));
  return {
    [boardKeys.states]: states.rows,
    [boardKeys.statesOmitted]: states.omitted,
    [boardKeys.fields]: declaredFields(setup, itemTarget).map((field) => {
      const values = talliesOf(open.flatMap((item) => fieldValueOf(item, field.name) ?? []));
      return { [fieldKeys.field]: lineOf(field.name), [fieldKeys.values]: values.rows, [fieldKeys.valuesOmitted]: values.omitted };
    }),
  };
};

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

const childOf = ({ row, counts, age }: ChildFacts): ReportChild => ({
  [childKeys.id]: row.id,
  [childKeys.address]: displayLine(row.address, MAX_ADDRESS_LENGTH),
  [childKeys.state]: row.status,
  [childKeys.reason]: lineOrNull(row.reason),
  [childKeys.counts]: counts,
  [childKeys.age]: age,
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
    return failure(
      `the report is not valid: ${parsed.error}`,
      `If a list is over its cap, move items out of the state in progress, or answer the ${requestWords.requests} that wait. Else run "${commandText(commands.doctor)}" to check the ${places.folder}. Then ${again}.`,
    );
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
