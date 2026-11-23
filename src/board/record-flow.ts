import { resolve } from 'node:path';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type OutLine } from '../cli/output.js';
import type { OpenBoard } from '../commands/board-open.js';
import { isSlug } from '../config/primitives.js';
import type { Deps } from '../core/deps.js';
import { guardReadOf } from '../core/guard-source.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import { guardValuesFor, isGuardOn } from '../guards/effective.js';
import type { GuardValues } from '../guards/types.js';
import { boardKeys, commandLines, commands, commandText, files, flags, flagText, guardValues, itemCommands, roles, values } from '../names.js';
import type { ApprovalMode, CheckedRecord, RecordCheck, RecordCheckInput } from '../recipes/entry.js';
import { branchOf, readWorkerRecord, type WorkerRecord } from '../workers/registry.js';
import type { BoardItem, ItemRecorded } from './contract.js';
import { checkItemId, checkRecordSetup, formerWorkersOf, shown } from './edit.js';
import { requireLocalKind } from './local.js';

/** The record of a passed check: the item, the reference as typed, and the project when the person names it. */
export interface RecordAction {
  readonly kind: typeof itemCommands.record;
  readonly id: string;
  readonly ref: string;
  readonly project: string | undefined;
}

/** An off guard gives the record point the same rules as delegated mode. The delegation check acts on the same guard read. */
export const recordApprovalMode = async (deps: Deps, { home, config }: OpenBoard, point: string): Promise<ApprovalMode | undefined> => {
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
const workerOf = (item: BoardItem, field: string | undefined): CliResult<string | null> => {
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
const branchesOf = (item: BoardItem, worker: string | null): CliResult<readonly string[] | undefined> => {
  if (worker !== null) return ok([branchOf(worker)]);
  const rest = ` ${item.id} ${flagText(flags.ref)} REF`;
  const again = `${commandText(commandLines.itemRecord)}${rest}`;
  const former = formerWorkersOf(item.record, item.id, commandLines.itemRecord, rest);
  if (!former.ok) return former;
  if (former.value.length === 0) return ok(undefined);
  const branches = former.value.filter(isSlug).map(branchOf);
  if (branches.length > 0) return ok(branches);
  return failure(
    `the item ${item.id} names former ${roles.worker}s, but none has a branch to test`,
    `Check the "${boardKeys.unassignedFrom}" of the item in ${files.board}, then run "${again}" again.`,
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
const checkInputOf = async (
  deps: Deps,
  board: OpenBoard,
  action: RecordAction,
  ref: string,
  worker: string | null,
  branches: readonly string[] | undefined,
): Promise<CliResult<RecordCheckInput>> => {
  const { home, config } = board;
  const record = worker === null ? ok(null) : await recordOf(deps, home, worker);
  if (!record.ok) return record;
  if (record.value !== null && action.project !== undefined && action.project !== record.value.project) {
    return usageError(`${flagText(flags.project)} ${shown(action.project)} is not the project of the ${roles.worker} ${record.value.id}`);
  }
  const projectId = record.value?.project ?? action.project;
  if (projectId === undefined) {
    return usageError(`the item ${action.id} names no ${roles.worker} with a record, so ${action.kind} needs ${flagText(flags.project)} PROJECT`);
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
 * The write also checks the worker again under the lock. The output names the checks that the guard of the recipe turns off.
 */
export const recordWork = async <T>(
  deps: Deps,
  board: OpenBoard,
  action: RecordAction,
  recordedAnswer: (checked: CheckedRecord, recorded: ItemRecorded, guards: GuardValues, offLines: readonly OutLine[]) => T,
  textLine: (text: string) => OutLine,
): Promise<CliResult<T>> => {
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
  const branches = branchesOf(item, worker.value);
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
  const offLines = hook.guard !== undefined && !isGuardOn(guards, hook.guard.id) ? [textLine(hook.guard.offLine)] : [];
  return recorded.ok ? ok(recordedAnswer(checked.value, recorded.value, guards, offLines)) : recorded;
};
