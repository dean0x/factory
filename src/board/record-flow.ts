import { resolve } from 'node:path';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import { isSlug } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { guardReadOf } from '../core/guard-source.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import { guardValuesFor, isGuardOn } from '../guards/effective.js';
import {
  boardKeys, commandLines, commands, commandText, decisionKeys, decisionLogKeys, files, flags, flagText,
  guardIds, guardValues, itemCommands, requestWords, roles, values, waitingKeys,
} from '../names.js';
import type { ApprovalMode, CheckedRecord, RecordCheck, RecordCheckInput } from '../recipes/entry.js';
import { branchOf, readWorkerRecord, type WorkerRecord } from '../workers/registry.js';
import type { BoardItem, ItemRecorded, LocalBoard, RequestLink } from './contract.js';
import { checkItemId, checkRecordSetup, formerWorkersOf, shown } from './edit.js';
import type { DecisionLogDoc, DecisionRow, WaitingDoc, WaitingItem } from './files.js';
import { requireLocalKind } from './local.js';
import { answeredRequestOf, approvalLinkRemedy, linkOfFields, linkOfRow, type RequestLinkRules } from './requests.js';

export interface BranchRemedy {
  readonly command: string;
  readonly rest: string;
}

export interface WorkItemQuery {
  readonly point: string;
  readonly ref: string;
  readonly branch: string;
  readonly closed: string | undefined;
  readonly workerField: string | undefined;
  readonly remedy: BranchRemedy;
}

export type WorkItemLookup =
  | { readonly kind: 'found'; readonly item: BoardItem }
  | { readonly kind: 'lookup'; readonly cause: string };

const invalidLink = (id: string | null): CliResult<never> => failure(
  id === null ? `a linked row has no ${requestWords.request} id` : `the link of ${requestWords.request} ${shown(id)} is invalid`,
  approvalLinkRemedy,
);

const waitingLinkOf = ({ id, record }: WaitingItem, rules: RequestLinkRules): CliResult<RequestLink | null> => {
  const link = linkOfFields(record[decisionKeys.fields], rules);
  return link.ok ? link : invalidLink(id);
};

/** Take the link of an answer from its request text, not from display fields. A link is no approval proof. */
const settledLinkOf = ({ id, record }: DecisionRow, rules: RequestLinkRules): CliResult<RequestLink | null> => {
  if (!Object.hasOwn(record, decisionLogKeys.by)) {
    const link = linkOfRow(record, rules);
    return !link.ok || (link.value !== null && id === null) ? invalidLink(id) : link;
  }
  const text = record[decisionLogKeys.request];
  if (typeof text !== 'string') return invalidLink(id);
  const request = answeredRequestOf(text);
  if (!request.ok) return invalidLink(id);
  const link = linkOfFields(request.value[decisionKeys.fields], rules);
  if (!link.ok || (link.value !== null && (id === null || request.value[waitingKeys.id] !== id))) return invalidLink(id);
  return link;
};

/** Read all waiting and settled links. The board file size limits bound the scans. */
const linkedIdsOf = (
  waiting: WaitingDoc, log: DecisionLogDoc, rules: RequestLinkRules, point: string, ref: string,
): CliResult<ReadonlySet<string>> => {
  const ids = new Set<string>();
  for (const row of waiting.items) {
    const link = waitingLinkOf(row, rules);
    if (!link.ok) return link;
    if (link.value?.point === point && link.value.ref === ref) ids.add(link.value.item);
  }
  for (const row of log.rows) {
    const link = settledLinkOf(row, rules);
    if (!link.ok) return link;
    if (link.value?.point === point && link.value.ref === ref) ids.add(link.value.item);
  }
  return ok(ids);
};

const branchItemsOf = (items: readonly BoardItem[], query: WorkItemQuery): CliResult<readonly BoardItem[]> => {
  const matches: BoardItem[] = [];
  for (const item of items) {
    if (item.status === query.closed) continue;
    const worker = workerOf(item, query.workerField);
    if (!worker.ok) return worker;
    const branches = branchesOf(item, worker.value, query.remedy);
    if (!branches.ok) return branches;
    if (branches.value?.includes(query.branch)) matches.push(item);
  }
  return ok(matches);
};

const lookupRefusal = (cause: string): CliResult<WorkItemLookup> => ok({ kind: 'lookup', cause });

/** Find one work item. If both sources match, they must name the same item. */
export const findWorkItem = (
  items: readonly BoardItem[], waiting: WaitingDoc, log: DecisionLogDoc, rules: RequestLinkRules, query: WorkItemQuery,
): CliResult<WorkItemLookup> => {
  const ref = rules.parseRef(query.ref);
  if (!ref.ok) return ref;
  const ids = linkedIdsOf(waiting, log, rules, query.point, ref.value);
  if (!ids.ok) return ids;
  // Match ids exactly. Do not fall back to the branch if a link names no exact item.
  const linked = items.filter((item) => ids.value.has(item.id));
  if (linked.length < ids.value.size) return failure(`a linked ${requestWords.request} names an item that is not on the board`, approvalLinkRemedy);
  if (linked.length > 1) return lookupRefusal('several items link to the reference');

  const branches = branchItemsOf(items, query);
  if (!branches.ok) return branches;
  if (branches.value.length > 1) return lookupRefusal('several items match the head branch');
  const fromLink = linked[0];
  const fromBranch = branches.value[0];
  if (fromLink !== undefined && fromBranch !== undefined && fromLink.id !== fromBranch.id) {
    return lookupRefusal('the linked item and the head branch match different items');
  }
  const item = fromLink ?? fromBranch;
  return item === undefined ? lookupRefusal('no item matches the reference or head branch') : ok({ kind: 'found', item });
};

/** List ids of open requests that name the item or link the reference. A link fault stops the read. */
export const openRequestsOf = (
  waiting: WaitingDoc, rules: RequestLinkRules, target: { readonly item: string; readonly ref: string },
): CliResult<readonly string[]> => {
  const ref = rules.parseRef(target.ref);
  if (!ref.ok) return ref;
  const ids: string[] = [];
  for (const row of waiting.items) {
    const link = waitingLinkOf(row, rules);
    if (!link.ok) return link;
    if (link.value !== null && (link.value.item === target.item || link.value.ref === ref.value)) ids.push(row.id);
  }
  return ok(ids);
};

export interface RecordedWork {
  readonly checked: CheckedRecord;
  readonly recorded: ItemRecorded;
  readonly offGuards: readonly string[];
}

/** The record of a passed check: the item, the reference as typed, and the project when the person names it. */
export interface RecordWorkInput {
  readonly id: string;
  readonly ref: string;
  readonly project: string | undefined;
}

export interface RecordBoard {
  readonly home: string;
  readonly config: FactoryConfig;
  readonly connector: Pick<LocalBoard, 'listItems' | 'checkApproval' | 'recordChecked'>;
}

type RecordContext = Pick<RecordBoard, 'home' | 'config'>;

/** An off guard gives the record point the same rules as delegated mode. The delegation check acts on the same guard read. */
export const recordApprovalMode = async (deps: Deps, { home, config }: RecordContext, point: string): Promise<ApprovalMode | undefined> => {
  const guard = config.entry.approvalPoints.find((entry) => entry.id === point)?.guard;
  const read = await guardReadOf(deps, home, config, 'when-off');
  if (guard !== undefined && read.state.values[guard] === guardValues.off) return values.approvalModes[1];
  const modes = await effectiveModes(read.deps, home, config);
  return modes[point];
};

/**
 * The worker that an item names in the worker field of the setup, or null for none. A value that is not text names no branch and no
 * record, so it is a failure (exit 1) and nothing is read from the network.
 */
export const workerOf = (item: BoardItem, field: string | undefined): CliResult<string | null> => {
  if (field === undefined || !Object.hasOwn(item.record, field)) return ok(null);
  const stored = item.record[field];
  return typeof stored === 'string'
    ? ok(stored)
    : failure(`the ${roles.worker} field of ${displayLine(item.id)} does not hold text`, `Check the item in ${files.board}.`);
};

/**
 * The branches that the work of an item may come from, for the record check. An item with a worker has the branch of that worker.
 * An item with no worker and a list of former workers (`unassigned_from`) has the branch of each former worker that is a worker id.
 * That list fails closed: a list that is not a list of text, and a list that gives no branch, are a failure (exit 1) and nothing is
 * read from the network, because the work could not be tied to a worker. An item that never had a worker (no list, or an empty
 * one) has no branches, so the check tests none.
 */
export const branchesOf = (item: BoardItem, worker: string | null, { command, rest }: BranchRemedy): CliResult<readonly string[] | undefined> => {
  if (worker !== null) return ok([branchOf(worker)]);
  const former = formerWorkersOf(item.record, item.id, command, rest);
  if (!former.ok) return former;
  if (former.value.length === 0) return ok(undefined);
  const branches = former.value.filter(isSlug).map(branchOf);
  if (branches.length > 0) return ok(branches);
  return failure(
    `the item ${item.id} names former ${roles.worker}s, but none has a branch to test`,
    `Check the "${boardKeys.unassignedFrom}" of the item in ${files.board}, then run "${commandText(command)}${rest}" again.`,
  );
};

/** The record of a worker, or null when it has none. A record that is not valid is a failure (exit 1). */
const recordOf = async (deps: Deps, home: string, worker: string): Promise<CliResult<WorkerRecord | null>> => {
  const read = await readWorkerRecord(deps, home, worker);
  if (!read.ok) return read;
  if (read.value.state === 'absent') return ok(null);
  if (read.value.state === 'valid') return ok(read.value.record);
  return failure(
    `the record of the ${roles.worker} ${shown(worker)} is not valid: ${read.value.reason}`,
    `Run "${commandText(commandLines.workerList)}" to see the records that are not valid.`,
  );
};

/**
 * What the record check of the recipe gets, from the config. The project comes from the record of the worker that the item names, and
 * a project that the person names must be that one. An item with no worker record needs the project flag. The branches come from the
 * worker and the former workers of the item (`branchesOf`). The recipe reads the rest of the project itself.
 */
export const checkInputOf = async (
  deps: Deps,
  { home, config }: RecordContext,
  action: RecordWorkInput,
  ref: string,
  worker: string | null,
  branches: readonly string[] | undefined,
): Promise<CliResult<RecordCheckInput>> => {
  const record = worker === null ? ok(null) : await recordOf(deps, home, worker);
  if (!record.ok) return record;
  if (record.value !== null && action.project !== undefined && action.project !== record.value.project) {
    return usageError(`${flagText(flags.project)} ${shown(action.project)} is not the project of the ${roles.worker} ${record.value.id}`);
  }
  const projectId = record.value?.project ?? action.project;
  if (projectId === undefined) {
    return usageError(`the item ${action.id} names no ${roles.worker} with a record, so ${itemCommands.record} needs ${flagText(flags.project)} PROJECT`);
  }
  const project = config.recipe.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return usageError(`the project ${shown(projectId)} is not in the config of this ${roles.node}`, `Check the projects in ${files.config}.`);
  }
  return ok({ ref, project, cloneDir: resolve(home, project.path), branches });
};

/**
 * `item record`: the record check of the recipe of the node runs, and only a result that passed is written. A recipe with no record
 * check makes this a usage error (exit 2) with no write. The reference is checked first, so a bad one is a usage error before the item
 * is read and before the check reaches the network. The local checks come next (the item id, the tracker kind, the stage of the check
 * in the recipe, the closed state, the item). The approval check runs before the recipe check and again under the lock.
 * The write also checks the worker again under the lock. The result lists the guards that were off.
 */
export const recordWork = async (
  deps: Deps,
  board: RecordBoard,
  action: RecordWorkInput,
): Promise<CliResult<RecordedWork>> => {
  const { connector, config } = board;
  const hook: RecordCheck | undefined = config.entry.recordCheck;
  if (hook === undefined) {
    return usageError(
      `the ${roles.recipe} ${config.entry.id} of this ${roles.node} has no check for ${commandText(commandLines.itemRecord)}`,
      `Run "${commandText(commands.item)} ${flagText(flags.help)}" to see the commands that you can use.`,
    );
  }
  const ref = hook.parseRef(action.ref);
  if (!ref.ok) return ref;
  const valid = checkItemId(action.id);
  if (!valid.ok) return valid;
  const guards = await guardValuesFor(deps, board.home);
  const local = requireLocalKind(config.core.tracker.kind, commands.item, guards);
  if (!local.ok) return local;
  const ready = checkRecordSetup({ recipe: config.entry.board, config: config.core.board }, hook.stage);
  if (!ready.ok) return ready;
  const items = await connector.listItems({ all: true });
  if (!items.ok) return items;
  const item = items.value.find((candidate) => candidate.id === action.id);
  if (item === undefined) return usageError(`${files.board} has no item ${shown(action.id)}`);
  const worker = workerOf(item, config.core.board?.worker_field);
  if (!worker.ok) return worker;
  const branches = branchesOf(item, worker.value, { command: commandLines.itemRecord, rest: ` ${item.id} ${flagText(flags.ref)} REF` });
  if (!branches.ok) return branches;
  const input = await checkInputOf(deps, board, action, ref.value, worker.value, branches.value);
  if (!input.ok) return input;
  const mode = await recordApprovalMode(deps, board, hook.point);
  const approval = { point: hook.point, mode: mode ?? roles.owner };
  const approved = await connector.checkApproval(action.id, approval, ref.value);
  if (!approved.ok) return approved;
  const checked = await hook.check(deps, { ...input.value, guards });
  if (!checked.ok) return checked;
  const recorded = await connector.recordChecked(action.id, checked.value, worker.value, approval);
  if (!recorded.ok) return recorded;
  const offGuards: string[] = [];
  if (hook.guard !== undefined && !isGuardOn(guards, hook.guard.id)) offGuards.push(hook.guard.id);
  if (!isGuardOn(guards, guardIds.ownerGo)) offGuards.push(guardIds.ownerGo);
  return ok({ checked: checked.value, recorded: recorded.value, offGuards });
};
