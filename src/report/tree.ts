import { checkFileAddress } from '../comms/address.js';
import { isOverCallCap, type ChildReportRead } from '../comms/report-read.js';
import type { NodeReport, ReportCounts, ReportRequest } from '../comms/report-schema.js';
import type { Transport } from '../comms/transport.js';
import { isSlug } from '../config/primitives.js';
import type { Deps } from '../core/deps.js';
import { childReasons, reportKeys, reportLimits, reportWords, treeLimits, treeWords } from '../names.js';

/**
 * The walk over the report files of the child nodes. It starts at the `children` of the own config and goes down through the child
 * entries that each report lists. It reads files only, through the transport and the real path of a folder: it starts no process,
 * asks no multiplexer and sets no timer, so it needs no other node to run.
 *
 * Every report is data to check. A row holds the text of a child (an id, an address, a path) in `report` only, and its `reason` is
 * fixed text of this program, so text of a child can not reach a reason.
 */

const states = reportWords.childStates;
const countKeys = reportKeys.counts;

/** The text between the node ids of an origin that a node forwarded: `a/b#1` is request 1 of node `b`, as node `a` reports it. */
const ORIGIN_NODE_SEPARATOR = '/';

/** One entry that the walk reads: the id and the `file://` address of a node, as a config or the report of its parent lists them. */
export interface TreeEntry {
  readonly id: string;
  readonly address: string;
}

export interface TreeRequest {
  /** The home of the own node: an absolute path. */
  readonly home: string;
  /** The id of the own node. */
  readonly id: string;
  /** The `children` of the own config, in order. The walk starts here. */
  readonly children: readonly TreeEntry[];
  readonly transport: Transport;
}

/** The state of a row: one of the states of a child row for a node, or `warning` for a row that tells of the walk. */
export type TreeState = (typeof states)[keyof typeof states] | typeof treeWords.warning;

/**
 * The data of a row. All text here may come from a file of a child: an output must clean it first. `source` is the path of the report
 * file, or null when no file was read. `reportedBy` is the id of the node whose report listed this entry, or null for an entry of the
 * own config.
 */
export interface TreeReport {
  readonly source: string | null;
  readonly id: string;
  readonly address: string;
  readonly layer: number | null;
  readonly counts: ReportCounts | null;
  /** The age of the report file in whole seconds. */
  readonly age: number | null;
  readonly reportedBy: string | null;
}

/**
 * One row of the walk. `depth` is the depth of the entry that the row tells of: 1 for an entry of the own config. A row that tells of
 * the walk (`warning`) has the depth of the node that it tells of, and follows the row of that node. `reason` is fixed text, or null for
 * a node that is `ok`.
 */
export interface TreeRow {
  readonly depth: number;
  readonly state: TreeState;
  readonly reason: string | null;
  readonly report: TreeReport;
}

/** The rows in the order of the walk, at most `treeLimits.maxLines`, and the count of the rows that the line cap left out. */
export interface TreeWalk {
  readonly rows: readonly TreeRow[];
  readonly omitted: number;
}

interface Pending {
  readonly entry: TreeEntry;
  readonly depth: number;
  readonly reportedBy: string | null;
}

/** What the walk knows while it runs. The sets and the counters are of this run only. */
interface Run {
  readonly rows: TreeRow[];
  omitted: number;
  readonly paths: Set<string>;
  readonly ids: Set<string>;
  readonly stack: Pending[];
  reads: number;
  bytes: number;
}

const reportOf = (pending: Pending, parts: Partial<TreeReport> = {}): TreeReport => ({
  source: null,
  id: pending.entry.id,
  address: pending.entry.address,
  layer: null,
  counts: null,
  age: null,
  reportedBy: pending.reportedBy,
  ...parts,
});

const rowOf = (pending: Pending, state: TreeState, reason: string | null, parts: Partial<TreeReport> = {}): TreeRow => ({
  depth: pending.depth,
  state,
  reason,
  report: reportOf(pending, parts),
});

const emit = (run: Run, row: TreeRow): void => {
  if (run.rows.length < treeLimits.maxLines) run.rows.push(row);
  else run.omitted += 1;
};

/** The real path of a folder. A folder that cannot be resolved keeps its own path: the read of its report then gives the answer. */
const realPathOf = async (deps: Deps, path: string): Promise<string> => {
  const real = await deps.fs.realpath(path);
  return real.ok ? real.value : path;
};

/**
 * True when the origin of a request names the node that reports it, by whole segments: `<node id>#<request id>`, with the ids of
 * deeper nodes after the node id and a slash between the ids. The node id is the first segment, every segment is a slug, and the text
 * after the first hash is the id of the request. A string prefix of the node id does not pass.
 */
const originPasses = (node: string, request: ReportRequest): boolean => {
  const at = request.origin.indexOf(reportWords.originSeparator);
  if (at < 0 || request.origin.slice(at + 1) !== request.id) return false;
  const segments = request.origin.slice(0, at).split(ORIGIN_NODE_SEPARATOR);
  return segments[0] === node && segments.every((segment) => isSlug(segment));
};

const countsOf = (report: NodeReport, requests: number): ReportCounts => ({
  [countKeys.workers]: report.workers.length,
  [countKeys.inProgress]: report.inProgress.length,
  [countKeys.requests]: requests,
  [countKeys.children]: report.children.length,
});

/** Put the entries of a list on the stack so that the first one comes off first. */
const push = (run: Run, entries: readonly TreeEntry[], depth: number, reportedBy: string | null): void => {
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at];
    if (entry !== undefined) run.stack.push({ entry, depth, reportedBy });
  }
};

/**
 * The rows of a node whose report file was read and holds the id of its entry: the row of the node, a warning row for the requests
 * that were dropped, and the depth cap row when the node lists children below the cap. The children of the report go on the stack.
 */
const takeReport = (run: Run, pending: Pending, read: Extract<ChildReportRead, { state: 'read' }>): void => {
  const { report } = read;
  run.ids.add(pending.entry.id);
  const passing = report.requests.filter((item) => originPasses(report.id, item)).length;
  emit(
    run,
    rowOf(pending, states.ok, null, {
      source: read.source,
      layer: report.layer,
      counts: countsOf(report, passing),
      age: read.age,
    }),
  );
  const dropped = report.requests.length - passing;
  if (dropped > 0) {
    emit(run, rowOf(pending, treeWords.warning, `${treeWords.requestsDropped}: ${dropped}`, { source: read.source }));
  }
  if (report.children.length === 0) return;
  if (pending.depth >= treeLimits.maxDepth) {
    emit(run, rowOf(pending, treeWords.warning, childReasons.depthCap, { source: read.source }));
    return;
  }
  push(run, report.children, pending.depth + 1, report.id);
};

/**
 * Take the entry that came off the stack. The value is true when a cap stops the whole walk. The order of the checks: the address, the
 * real path (a folder that the walk saw is a cycle), the id (a new folder with an id that the walk saw), the caps of nodes and of
 * bytes, then the read. A file that is larger than the bytes that are left of the walk cap stops the walk with the row of the byte
 * cap. A row that is not `ok` stops the walk below it.
 */
const visit = async (deps: Deps, request: TreeRequest, run: Run, pending: Pending): Promise<boolean> => {
  const { entry } = pending;
  const checked = checkFileAddress(entry.address);
  if (!checked.ok) {
    emit(run, rowOf(pending, states.unknown, childReasons.addressInvalid));
    return false;
  }
  const real = await realPathOf(deps, checked.value);
  if (run.paths.has(real)) {
    emit(run, rowOf(pending, treeWords.warning, childReasons.cycle));
    return false;
  }
  run.paths.add(real);
  if (run.ids.has(entry.id)) {
    emit(run, rowOf(pending, treeWords.warning, childReasons.duplicateId));
    return false;
  }
  if (run.reads >= treeLimits.maxNodes) {
    emit(run, rowOf(pending, treeWords.warning, childReasons.nodeCap));
    return true;
  }
  const left = treeLimits.maxWalkBytes - run.bytes;
  if (left <= 0) {
    emit(run, rowOf(pending, treeWords.warning, childReasons.byteCap));
    return true;
  }

  run.reads += 1;
  const cap = Math.min(left, reportLimits.maxBytes);
  const read = await request.transport.report(entry.address, cap);
  run.bytes += read.bytes;
  if (isOverCallCap(read, cap)) {
    emit(run, rowOf(pending, treeWords.warning, childReasons.byteCap, { source: read.source, age: read.age }));
    return true;
  }
  if (read.state === 'unknown') {
    emit(run, rowOf(pending, states.unknown, read.reason, { source: read.source, age: read.age }));
    return false;
  }
  if (read.report.id !== entry.id) {
    emit(run, rowOf(pending, states.mismatch, childReasons.otherId, { source: read.source, age: read.age }));
    return false;
  }
  takeReport(run, pending, read);
  return false;
};

/**
 * Walk the tree under the own node. The rows come in depth-first order, each list in its own order. An explicit stack holds the entries
 * that wait, so there is no recursion. Each report that is read adds at most `reportLimits.maxChildren` entries, and the node cap stops
 * the reads, so the number of steps has a fixed upper bound. The caps are in `treeLimits`: a cap that stops the walk gives one row with
 * its fixed reason, and a row past the line cap is counted in `omitted`. The call never throws: a node that cannot be read is a row.
 */
export const walkTree = async (deps: Deps, request: TreeRequest): Promise<TreeWalk> => {
  const run: Run = {
    rows: [],
    omitted: 0,
    paths: new Set([await realPathOf(deps, request.home)]),
    ids: new Set([request.id]),
    stack: [],
    reads: 0,
    bytes: 0,
  };
  push(run, request.children, 1, null);
  const maxSteps = request.children.length + treeLimits.maxNodes * reportLimits.maxChildren;
  for (let step = 0; step < maxSteps; step += 1) {
    const pending = run.stack.pop();
    if (pending === undefined) break;
    if (await visit(deps, request, run, pending)) break;
  }
  return { rows: run.rows, omitted: run.omitted };
};
