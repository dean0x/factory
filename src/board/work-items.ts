import { loadConfig } from '../config/load.js';
import type { BoardConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { queueKeyOf, type RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { unknownItem, type WorkItem, type WorkItemPort } from '../workers/work-items.js';
import type { BoardItem } from './contract.js';
import { readBoard } from './files.js';

/**
 * The work item port of the local board (design 4.10): what the board says of the work of each worker. The setup names the state
 * of an item that is in progress, the state that closes an item and the owner field that holds the id of a worker. An item is
 * assigned to the worker whose id its worker field holds. The status alone decides open and closed, and the status that the setup
 * names as in progress decides which open item a worker shows. A stage and a track are display data and never proof, so the port
 * reads neither.
 *
 * The answer fails closed. A setup that does not name the two roles and the worker field gives every worker an unknown item (the
 * config check holds each role to a declared state). A fault of the config or of the board file is a failure that the caller reports as a warning, and every worker is
 * then unknown. Only a board that was read makes a worker known, and only a known worker with no open item can count as idle. The
 * read takes no lock: it does not wait for a writer, and it changes no file.
 */

/** What the setup says of the work of a worker. */
interface WorkRules {
  readonly inProgress: string;
  readonly closed: string;
  readonly workerField: string;
}

/** The rules of the setup, or null when the block does not name the two roles and the worker field. */
const rulesOf = (board: BoardConfig | undefined): WorkRules | null => {
  if (board === undefined) return null;
  const { in_progress: inProgress, closed, worker_field: workerField } = board;
  return inProgress === undefined || closed === undefined || workerField === undefined ? null : { inProgress, closed, workerField };
};

/** The items of the board by the worker id that their worker field holds, each list in the order of the board. */
const assignedTo = (items: readonly BoardItem[], workerField: string): ReadonlyMap<string, readonly BoardItem[]> => {
  const assigned = new Map<string, BoardItem[]>();
  for (const item of items) {
    const worker = Object.hasOwn(item.record, workerField) ? item.record[workerField] : undefined;
    if (typeof worker !== 'string') continue;
    assigned.set(worker, [...(assigned.get(worker) ?? []), item]);
  }
  return assigned;
};

/**
 * The work item of one worker: its open item in progress, else its first other open item, else none. An item with a status that
 * is not the closed state is open, also when the setup does not declare the status, so the worker is not idle.
 */
const workItemOf = (assigned: readonly BoardItem[], rules: WorkRules): WorkItem => {
  const open = assigned.filter((item) => item.status !== rules.closed);
  const current = open.find((item) => item.status === rules.inProgress) ?? open[0];
  return { state: 'known', item: current?.id ?? null };
};

/** The port of the board. The registry gives the recipe of the factory, which names the queue key that the board file needs. */
export const boardWorkItems = (registry: RecipeRegistry): WorkItemPort => ({
  itemsOf: async (deps: Deps, home, workerIds) => {
    const loaded = await loadConfig(deps, home, registry);
    if (!loaded.ok) return loaded;
    const config = loaded.value;
    const rules = rulesOf(config.core.board);
    if (rules === null) return ok(new Map(workerIds.map((id) => [id, unknownItem])));
    const read = await readBoard(deps, layoutOf(home), queueKeyOf(config.entry));
    if (!read.ok) return read;
    const assigned = assignedTo(read.value.items, rules.workerField);
    return ok(new Map(workerIds.map((id) => [id, workItemOf(assigned.get(id) ?? [], rules)])));
  },
});
