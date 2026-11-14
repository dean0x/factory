import { boardKeys, workItemDisplayKeys } from '../names.js';
import type { WorkItemDisplay } from '../workers/work-items.js';
import type { BoardItem } from './contract.js';
import { storedTimeOf } from './stored-time.js';

/**
 * The display data of one item: its title, its stage as stored, the time of its last stage change and its status. The stage time
 * is the stored text when it is an exact time, else null (`storedTimeOf`), so a hand edit never reaches a view as a time. The stage
 * is read here and in no other file of the work item port: the port gives display data and never proof.
 */
export const displayOf = (item: BoardItem): WorkItemDisplay => ({
  [workItemDisplayKeys.title]: item.title,
  [workItemDisplayKeys.stage]: item.stage,
  [workItemDisplayKeys.stageAt]: storedTimeOf(item.record[boardKeys.stageAt]),
  [workItemDisplayKeys.status]: item.status,
});
