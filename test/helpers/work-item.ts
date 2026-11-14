import type { KnownWorkItem, WorkItem, WorkItemDisplay } from '../../src/workers/work-items.js';

/** A known work item: the open item, or null, and no closed, parked or recorded-head evidence unless the test names it. */
export const knownItem = (item: string | null, evidence: Partial<Omit<KnownWorkItem, 'state' | 'item'>> = {}): WorkItem => ({
  state: 'known',
  item,
  closed: [],
  parked: [],
  mergedPrHeads: [],
  ...evidence,
});

/** A worker that the board knows, with no open work and no other evidence. */
export const NONE: WorkItem = knownItem(null);

/** A worker that the board says nothing about. */
export const UNKNOWN: WorkItem = { state: 'unknown' };

/** A worker that the board knows, with the open item `item`. */
export const busyWith = (item: string): WorkItem => knownItem(item);

/** The display data of an item that `itemRecord` makes: its title `Item <id>` and its status, with no stage unless the test names it. */
export const sampleDisplay = (id: string, status: string, change: Partial<WorkItemDisplay> = {}): WorkItemDisplay => ({
  title: `Item ${id}`,
  stage: null,
  stageAt: null,
  status,
  ...change,
});
