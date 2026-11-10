import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';

/**
 * What the board says of the work of one worker: nothing (`unknown`), or the work item in progress that is assigned to the worker
 * (`item`), where null means that the worker has no open work. Only a known work item with no open work lets a worker count as idle,
 * so every fault of a reader, and every worker that a reader does not know, must stay `unknown`.
 */
export type WorkItem =
  | { readonly state: 'unknown' }
  | { readonly state: 'known'; readonly item: string | null };

/**
 * The port of the work items. The reader of the local board (`boardWorkItems`) is the one real implementation. It answers for the
 * workers of one factory folder in one call, and a worker with no entry in the answer is `unknown`. A failure is a fault that the
 * caller reports as a warning; the work items are then unknown. Each caller takes the port as a required parameter.
 */
export interface WorkItemPort {
  itemsOf(deps: Deps, home: string, workerIds: readonly string[]): Promise<CliResult<ReadonlyMap<string, WorkItem>>>;
}

export const unknownItem: WorkItem = { state: 'unknown' };
