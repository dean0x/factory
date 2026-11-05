import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';

/**
 * What the board says of the work of one worker: nothing (`unknown`), or the work item in progress that is assigned to the worker
 * (`item`), where null means that the worker has no open work. Only a known work item with no open work lets a worker count as idle,
 * so every fault of a reader, and every worker that a reader does not know, must stay `unknown`.
 */
export type WorkItem =
  | { readonly state: 'unknown' }
  | { readonly state: 'known'; readonly item: string | null };

/**
 * The port of the work items. The board reader of FAC-M5 is the one real implementation. It answers for the workers of one factory
 * folder in one call, and a worker with no entry in the answer is `unknown`. A failure is a fault that the caller reports as a
 * warning; the work items are then unknown.
 */
export interface WorkItemPort {
  itemsOf(deps: Deps, home: string, workerIds: readonly string[]): Promise<CliResult<ReadonlyMap<string, WorkItem>>>;
}

export const unknownItem: WorkItem = { state: 'unknown' };

/** The port until the board reader exists: no worker has a known work item, so none is idle. */
export const unknownWorkItems: WorkItemPort = {
  itemsOf: async (_deps, _home, workerIds) => ok(new Map(workerIds.map((id) => [id, unknownItem]))),
};
