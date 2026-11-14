import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';

/**
 * What the board shows of the item in progress of a worker, for a view outside the core: the title, the stage as stored, the time of
 * the last stage change (an exact stored time, else null) and the status. The text is stored owner text. It is display data and never
 * proof: no check of a worker reads it, and a dismiss never does.
 */
export interface WorkItemDisplay {
  readonly title: string;
  readonly stage: string | null;
  readonly stageAt: string | null;
  readonly status: string;
}

/**
 * What the board proves of the work of a worker that it knows: the work item in progress that is assigned to the worker (`item`),
 * where null means that the worker has no open work, and the evidence that a dismiss reads. `closed` holds the closed items whose
 * worker field holds the id of the worker. `parked` holds the items that are not closed and whose list of former workers holds the
 * id. `mergedPrHeads` holds the recorded heads of the closed items of the worker that are a full commit id. Each list is in the
 * order of the board, and only a fact that the board proves fills one. `display` is the display data of the item in progress, and it is
 * there only when the worker has one. It is never proof: a check of a worker, and a dismiss, read the evidence and never `display`.
 */
export interface KnownWorkItem {
  readonly state: 'known';
  readonly item: string | null;
  readonly closed: readonly string[];
  readonly parked: readonly string[];
  readonly mergedPrHeads: readonly string[];
  readonly display?: WorkItemDisplay;
}

/**
 * What the board says of the work of one worker: nothing (`unknown`), or the facts of a known worker. Only a known work item with
 * no open work lets a worker count as free of work, so every fault of a reader, and every worker that a reader does not know, must
 * stay `unknown`.
 */
export type WorkItem = { readonly state: 'unknown' } | KnownWorkItem;

/**
 * The port of the work items. The reader of the local board (`boardWorkItems`) is the one real implementation. It answers for the
 * workers of one factory folder in one call, and a worker with no entry in the answer is `unknown`. A failure is a fault that the
 * caller reports as a warning; the work items are then unknown. Each caller takes the port as a required parameter.
 */
export interface WorkItemPort {
  itemsOf(deps: Deps, home: string, workerIds: readonly string[]): Promise<CliResult<ReadonlyMap<string, WorkItem>>>;
}

export const unknownItem: WorkItem = { state: 'unknown' };
