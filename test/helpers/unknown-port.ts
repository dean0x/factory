import { ok } from '../../src/core/result.js';
import { unknownItem, type WorkItemPort } from '../../src/workers/work-items.js';

/** A port that gives no worker a known work item, so no worker is idle. A test that does not care for the board passes it. */
export const unknownPort: WorkItemPort = {
  itemsOf: async (_deps, _home, workerIds) => ok(new Map(workerIds.map((id) => [id, unknownItem]))),
};
