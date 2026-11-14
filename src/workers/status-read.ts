import { failure, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import { durationMinutes } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import type { PaneRow } from '../launch/tmux.js';
import { durationBounds, keys, roles } from '../names.js';
import { readHold, type HoldRead } from './hold.js';
import { readOwnLastSeen } from './last-seen.js';
import { readPanes } from './panes.js';
import { listWorkerRecords, type InvalidWorker, type WorkerRecord } from './registry.js';
import { buildStatus, type LineRead, type WorkerStatus } from './status.js';
import type { WorkItem, WorkItemPort } from './work-items.js';

export interface StatusRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
  readonly workItems: WorkItemPort;
  /**
   * The list of the panes that the caller read already, or null when no session of this factory runs. A caller that must act on
   * the same list gives it here, so one list call serves both. Without it, the read makes the call.
   */
  readonly panes?: readonly PaneRow[] | null;
}

export interface StatusReport {
  readonly entries: readonly WorkerStatus[];
  /** The folders of the registry that hold no valid record, each with its reason. */
  readonly invalid: readonly InvalidWorker[];
  /** True when a tmux session of this factory runs. */
  readonly running: boolean;
  readonly warnings: readonly string[];
}

/**
 * What the last-seen line of the worker says. The line counts only when it belongs to this worker (`readOwnLastSeen`), as for
 * stop and resume. A line that is absent, not valid or not owned says nothing, and a line that cannot be read is a fault.
 */
const lineOf = async (deps: Deps, home: string, id: string): Promise<LineRead> => {
  const read = await readOwnLastSeen(deps, home, id);
  if (!read.ok) return { kind: 'fault', reason: read.error.message };
  return read.value.state === 'valid' ? { kind: 'line', line: read.value.line } : { kind: 'none' };
};

const linesOf = async (deps: Deps, home: string, records: readonly WorkerRecord[]): Promise<ReadonlyMap<string, LineRead>> => {
  const lines = new Map<string, LineRead>();
  for (const record of records) lines.set(record.id, await lineOf(deps, home, record.id));
  return lines;
};

/** The read of the hold file of each worker, by id (`readHold`). */
const holdsOf = async (deps: Deps, home: string, records: readonly WorkerRecord[]): Promise<ReadonlyMap<string, HoldRead>> => {
  const holds = new Map<string, HoldRead>();
  for (const record of records) holds.set(record.id, await readHold(deps, home, record.id));
  return holds;
};

/**
 * The work items of the workers from the port. A port that fails gives a warning and no work item, so each one is unknown. With
 * no worker, the port is not asked.
 */
const itemsOf = async (
  deps: Deps,
  home: string,
  records: readonly WorkerRecord[],
  port: WorkItemPort,
): Promise<{ readonly items: ReadonlyMap<string, WorkItem>; readonly warning: string | null }> => {
  if (records.length === 0) return { items: new Map(), warning: null };
  const read = await port.itemsOf(
    deps,
    home,
    records.map((record) => record.id),
  );
  return read.ok
    ? { items: read.value, warning: null }
    : { items: new Map(), warning: `cannot read the work items of the ${roles.worker}s: ${read.error.message}` };
};

/**
 * The facts of the worker table, read once for `status` and `worker list`: the registry, one list of the panes (none when no
 * session of this factory runs), the last-seen line and the hold file of each worker, and the work items from the port. The builder (`buildStatus`)
 * makes the entries. Nothing is changed. A folder of the registry with no valid record is named in a warning and in `invalid`,
 * and the other workers are listed.
 */
export const readStatus = async (deps: Deps, request: StatusRequest): Promise<CliResult<StatusReport>> => {
  const { home, config, workItems } = request;
  const idleAfter = config.core.limits[keys.limits.idleAfter];
  const idleAfterMinutes = durationMinutes(idleAfter, durationBounds.minMinutes, durationBounds.maxMinutes);
  if (idleAfterMinutes === null) return failure(`the setting ${keys.limits.idleAfter} is not a duration: ${idleAfter}`);
  const records = await listWorkerRecords(deps, home);
  if (!records.ok) return records;
  const panes = request.panes === undefined ? await readPanes(deps, config.core.node.id, home) : ok(request.panes);
  if (!panes.ok) return panes;

  const workers = records.value.workers;
  const lines = await linesOf(deps, home, workers);
  const holds = await holdsOf(deps, home, workers);
  const items = await itemsOf(deps, home, workers, workItems);
  const built = buildStatus({
    records: workers,
    panes: panes.value,
    lines,
    workItems: items.items,
    holds,
    now: deps.now(),
    idleAfterMinutes,
    limits: config.core.limits,
  });
  const invalid = records.value.invalid.map(
    (item) => `cannot use the folder ${displayLine(item.name)} of the ${roles.worker}s: ${item.reason}`,
  );
  return ok({
    entries: built.entries,
    invalid: records.value.invalid,
    running: panes.value !== null,
    warnings: [...invalid, ...built.warnings, ...(items.warning === null ? [] : [items.warning])],
  });
};
