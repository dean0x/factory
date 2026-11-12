import { resolve } from 'node:path';
import type { BoardConnector, BoardItem, ItemAddInput, ItemMove, ItemMoved, ItemPatch, ItemQuery, ItemRecorded } from '../board/contract.js';
import { checkItemId, checkRecordSetup } from '../board/edit.js';
import { declaredFields, itemTarget } from '../board/fields.js';
import { followBoard } from '../board/follow.js';
import { boardView, trackView } from '../board/list-view.js';
import { requireLocalKind } from '../board/local.js';
import { stageShown } from '../board/stages.js';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commandLines, commands, commandText, files, flags, flagText, itemCommands, itemWords, roles, schemaIds } from '../names.js';
import type { CheckedRecord, RecordCheck, RecordCheckInput } from '../recipes/entry.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { requireCoordinatorCaller } from '../workers/panes.js';
import { branchOf, readWorkerRecord, type WorkerRecord } from '../workers/registry.js';
import { openBoard, type OpenBoard } from './board-open.js';
import { parseFieldWords, shown, usageFor } from './board-words.js';

export interface ItemOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its argument. */
  readonly words: readonly string[];
  readonly title: string | undefined;
  readonly text: string | undefined;
  readonly track: string | undefined;
  /** The `NAME=VALUE` words of the field flag, in order. */
  readonly fields: readonly string[];
  readonly state: string | undefined;
  readonly stage: string | undefined;
  readonly all: boolean;
  /** Draw the list again at each change of the board, until the reader goes. Only `list` takes it. */
  readonly follow: boolean;
  /** The reference for the record check of the recipe, as typed. Only `record` takes it. */
  readonly ref: string | undefined;
  /** The id of the project of the record. Only `record` takes it. */
  readonly project: string | undefined;
  readonly json: boolean;
}

type Subcommand = (typeof itemCommands)[keyof typeof itemCommands];

/** The record of a passed check: the item, the reference as typed, and the project when the person names it. */
interface RecordAction {
  readonly kind: typeof itemCommands.record;
  readonly id: string;
  readonly ref: string;
  readonly project: string | undefined;
}

type Action =
  | { readonly kind: typeof itemCommands.add; readonly input: ItemAddInput }
  | { readonly kind: typeof itemCommands.update; readonly id: string; readonly patch: ItemPatch }
  | { readonly kind: typeof itemCommands.move; readonly id: string; readonly move: ItemMove }
  | { readonly kind: typeof itemCommands.close; readonly id: string }
  | { readonly kind: typeof itemCommands.list; readonly query: ItemQuery; readonly follow: boolean }
  | RecordAction
  | { readonly kind: typeof itemCommands.unassign; readonly id: string };

const SUBCOMMANDS = Object.values(itemCommands).join(', ');

/** The flags that each subcommand takes, besides the flags that every command takes. A flag of another subcommand is a usage error. */
const TAKES: Readonly<Record<Subcommand, readonly string[]>> = {
  [itemCommands.add]: [flags.title, flags.text, flags.track, flags.field],
  [itemCommands.update]: [flags.title, flags.text, flags.track, flags.field],
  [itemCommands.move]: [flags.state, flags.stage],
  [itemCommands.close]: [],
  [itemCommands.list]: [flags.all, flags.track, flags.follow],
  [itemCommands.record]: [flags.ref, flags.project],
  [itemCommands.unassign]: [],
};

const needsUsage = usageFor(commands.item);

const subcommandOf = (word: string): Subcommand | undefined => Object.values(itemCommands).find((candidate) => candidate === word);

const refuseStrayFlags = (subcommand: Subcommand, options: ItemOptions): CliResult<void> => {
  const given: readonly (readonly [string, boolean])[] = [
    [flags.title, options.title !== undefined],
    [flags.text, options.text !== undefined],
    [flags.track, options.track !== undefined],
    [flags.field, options.fields.length > 0],
    [flags.state, options.state !== undefined],
    [flags.stage, options.stage !== undefined],
    [flags.all, options.all],
    [flags.follow, options.follow],
    [flags.ref, options.ref !== undefined],
    [flags.project, options.project !== undefined],
  ];
  const stray = given.find(([flag, present]) => present && !TAKES[subcommand].includes(flag));
  return stray === undefined ? ok(undefined) : needsUsage(`the flag ${flagText(stray[0])} is not for ${commandText(`${commands.item} ${subcommand}`)}`);
};

const idArgument = (subcommand: Subcommand, args: readonly string[]): CliResult<string> => {
  const [id, ...rest] = args;
  return id !== undefined && rest.length === 0 ? ok(id) : needsUsage(`${subcommand} takes one argument: the id of an item`);
};

const withText = (options: ItemOptions): { readonly text?: string } => (options.text === undefined ? {} : { text: options.text });

const withTrack = (options: ItemOptions): { readonly track?: string } => (options.track === undefined ? {} : { track: options.track });

/** Check the words and the flags. A usage error (exit 2) from here comes before the node is found and before any lock. */
const parseAction = (options: ItemOptions): CliResult<Action> => {
  const [word, ...args] = options.words;
  if (word === undefined) return needsUsage(`${commandText(commands.item)} needs a subcommand: ${SUBCOMMANDS}`);
  const subcommand = subcommandOf(word);
  if (subcommand === undefined) return needsUsage(`unknown subcommand ${shown(word)}. The subcommands are: ${SUBCOMMANDS}`);
  const stray = refuseStrayFlags(subcommand, options);
  if (!stray.ok) return stray;
  const fields = parseFieldWords(needsUsage, options.fields);
  if (!fields.ok) return fields;
  switch (subcommand) {
    case itemCommands.add: {
      if (args.length > 0) return needsUsage(`${subcommand} takes no argument: the board gives the id`);
      if (options.title === undefined) return needsUsage(`${subcommand} needs ${flagText(flags.title)} TEXT`);
      return ok({ kind: subcommand, input: { title: options.title, fields: fields.value, ...withText(options), ...withTrack(options) } });
    }
    case itemCommands.update: {
      const id = idArgument(subcommand, args);
      if (!id.ok) return id;
      if (options.title === undefined && options.text === undefined && options.track === undefined && options.fields.length === 0) {
        return needsUsage(
          `${subcommand} needs at least one of ${[flags.title, flags.text, flags.track, flags.field].map(flagText).join(', ')}`,
        );
      }
      const title = options.title === undefined ? {} : { title: options.title };
      return ok({ kind: subcommand, id: id.value, patch: { fields: fields.value, ...title, ...withText(options), ...withTrack(options) } });
    }
    case itemCommands.move: {
      const id = idArgument(subcommand, args);
      if (!id.ok) return id;
      const both = `${flagText(flags.state)} and ${flagText(flags.stage)}`;
      if (options.state !== undefined && options.stage !== undefined) return needsUsage(`${subcommand} takes one of ${both}, not both`);
      if (options.state !== undefined) return ok({ kind: subcommand, id: id.value, move: { state: options.state } });
      if (options.stage !== undefined) return ok({ kind: subcommand, id: id.value, move: { stage: options.stage } });
      return needsUsage(`${subcommand} needs one of ${both}`);
    }
    case itemCommands.close: {
      const id = idArgument(subcommand, args);
      return id.ok ? ok({ kind: subcommand, id: id.value }) : id;
    }
    case itemCommands.list: {
      if (args.length > 0) return needsUsage(`${subcommand} takes no argument`);
      if (options.json) {
        return usageError(
          `${commandText(commandLines.itemList)} has no ${flagText(flags.json)} output`,
          `Run "${commandText(commandLines.itemList)}" for the text output.`,
        );
      }
      return ok({ kind: subcommand, query: { all: options.all, ...withTrack(options) }, follow: options.follow });
    }
    case itemCommands.record: {
      const id = idArgument(subcommand, args);
      if (!id.ok) return id;
      if (options.ref === undefined) return needsUsage(`${subcommand} needs ${flagText(flags.ref)} REF`);
      return ok({ kind: subcommand, id: id.value, ref: options.ref, project: options.project });
    }
    case itemCommands.unassign: {
      const id = idArgument(subcommand, args);
      return id.ok ? ok({ kind: subcommand, id: id.value }) : id;
    }
    default: {
      const unreachable: never = subcommand;
      return unreachable;
    }
  }
};

const textLine = (line: string): OutLine => ({ level: 'text', text: line });

const answer = (line: string, json: JsonDoc): CommandOutput => ({ lines: [textLine(line)], json, warnings: [], failed: false });

const titleText = (item: BoardItem): string => displayLine(item.title, itemWords.maxCellChars);

const itemJson = (action: Subcommand, item: BoardItem): JsonDoc => ({
  schema: schemaIds.item,
  action,
  item: { id: item.id, title: item.title, status: item.status, stage: item.stage, track: item.track },
});

const itemAnswer = (verb: string, action: Subcommand, item: BoardItem): CommandOutput =>
  answer(`${verb} ${displayLine(item.id)}: ${titleText(item)}`, itemJson(action, item));

/** The one line of a move: the id, the part that moved, and its old and new value. A move to the same value says that nothing changed. */
const moveAnswer = (config: FactoryConfig, move: ItemMove, moved: ItemMoved): CommandOutput => {
  const stage = 'stage' in move;
  const show = (value: string | null): string =>
    value === null ? itemWords.noStage : stage ? stageShown(config.entry.board, value) : displayLine(value, itemWords.maxStatusChars);
  const part = stage ? flags.stage : flags.state;
  const line = moved.changed
    ? `${displayLine(moved.id)} ${part}: ${show(moved.from)} -> ${show(moved.to)}`
    : `${displayLine(moved.id)} ${part}: ${show(moved.to)} (no change)`;
  return answer(line, { schema: schemaIds.item, action: itemCommands.move, id: moved.id, part, from: moved.from, to: moved.to, changed: moved.changed });
};

/** The list: the whole board by track, or the items of one track. It reads the local files and takes no lock. */
const listAnswer = async (connector: BoardConnector, config: FactoryConfig, query: ItemQuery): Promise<CliResult<CommandOutput>> => {
  const items = await connector.listItems(query);
  if (!items.ok) return items;
  const tracks = await connector.listTracks();
  if (!tracks.ok) return tracks;
  const view = { items: items.value, tracks: tracks.value, board: config.entry.board, fields: declaredFields(config.core.board, itemTarget), all: query.all };
  const json: JsonDoc = { schema: schemaIds.itemList };
  if (query.track === undefined) return ok({ lines: boardView(view), json, warnings: [], failed: false });
  const track = tracks.value.find((candidate) => candidate.id === query.track);
  if (track === undefined) return failure(`${files.board}: the track ${shown(query.track)} is not on the board`);
  return ok({ lines: trackView({ ...view, track }), json, warnings: [], failed: false });
};

/** The output of a follow that has ended: the frames went to stdout as they were drawn, so nothing is left to print. */
const followed = (): CommandOutput => ({ lines: [], json: { schema: schemaIds.itemList }, warnings: [], failed: false });

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
 * a project that the person names must be that one. An item with no worker record needs the project flag. The branch is the branch of
 * the worker, and an item with no worker leaves it out. The recipe reads the rest of the project itself.
 */
const checkInputOf = async (
  deps: Deps,
  board: OpenBoard,
  action: RecordAction,
  ref: string,
  worker: string | null,
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
  return ok({ ref, project, cloneDir: resolve(home, project.path), branch: worker === null ? undefined : branchOf(worker) });
};

const recordedAnswer = (checked: CheckedRecord, recorded: ItemRecorded): CommandOutput => {
  const id = displayLine(recorded.item.id);
  const summary = displayLine(checked.summary);
  return answer(recorded.changed ? `Recorded ${id}: ${summary}` : `${id}: ${summary} already recorded`, {
    schema: schemaIds.item,
    action: itemCommands.record,
    id: recorded.item.id,
    stage: checked.stage,
    ref: checked.ref,
    head: checked.head,
    summary: checked.summary,
    changed: recorded.changed,
  });
};

/**
 * `item record`: the record check of the recipe of the node runs, and only a result that passed is written. A recipe with no record
 * check makes this a usage error (exit 2) with no write. The reference is checked first, so a bad one is a usage error before the item
 * is read and before the check reaches the network. The local checks come next (the item id, the tracker kind, the stage of the check
 * in the recipe, the closed state, the item), so the check makes no call for a request that the board refuses. The worker that the
 * item names at the time of the check goes to the write, which tests it again under the lock.
 */
const recordChecked = async (deps: Deps, board: OpenBoard, action: RecordAction): Promise<CliResult<CommandOutput>> => {
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
  const local = requireLocalKind(config.core.tracker.kind, commands.item);
  if (!local.ok) return local;
  const ready = checkRecordSetup({ recipe: config.entry.board, config: config.core.board }, hook.stage);
  if (!ready.ok) return ready;
  const items = await connector.listItems({ all: true });
  if (!items.ok) return items;
  const item = items.value.find((candidate) => candidate.id === action.id);
  if (item === undefined) return usageError(`${files.board} has no item ${shown(action.id)}`);
  const worker = workerOf(item, config.core.board?.worker_field);
  if (!worker.ok) return worker;
  const input = await checkInputOf(deps, board, action, ref.value, worker.value);
  if (!input.ok) return input;
  const checked = await hook.check(deps, input.value);
  if (!checked.ok) return checked;
  const recorded = await connector.recordChecked(action.id, checked.value, worker.value);
  return recorded.ok ? ok(recordedAnswer(checked.value, recorded.value)) : recorded;
};

/**
 * `item unassign`: only the coordinator pane runs it, and the caller rule runs before the board is read. The id is checked first, so
 * the line that the rule prints never repeats text that is not an item id.
 */
const unassign = async (deps: Deps, board: OpenBoard, id: string): Promise<CliResult<CommandOutput>> => {
  const valid = checkItemId(id);
  if (!valid.ok) return valid;
  const caller = await requireCoordinatorCaller(deps, board.home, board.config, `${commandLines.itemUnassign} ${id}`);
  if (!caller.ok) return caller;
  const freed = await board.connector.unassignItem(id);
  if (!freed.ok) return freed;
  const { item, worker } = freed.value;
  return ok(
    answer(`Took ${displayLine(worker)} off ${displayLine(item.id)}: ${titleText(item)}`, {
      ...itemJson(itemCommands.unassign, item),
      worker,
    }),
  );
};

const execute = async (deps: Deps, board: OpenBoard, action: Action): Promise<CliResult<CommandOutput>> => {
  const { connector, config } = board;
  switch (action.kind) {
    case itemCommands.add: {
      const added = await connector.addItem(action.input);
      return added.ok ? ok(itemAnswer('Added', action.kind, added.value)) : added;
    }
    case itemCommands.update: {
      const saved = await connector.updateItem(action.id, action.patch);
      return saved.ok ? ok(itemAnswer('Saved', action.kind, saved.value)) : saved;
    }
    case itemCommands.move: {
      const moved = await connector.moveItem(action.id, action.move);
      return moved.ok ? ok(moveAnswer(config, action.move, moved.value)) : moved;
    }
    case itemCommands.close: {
      const closed = await connector.closeItem(action.id);
      return closed.ok ? ok(itemAnswer('Closed', action.kind, closed.value)) : closed;
    }
    case itemCommands.list: {
      if (!action.follow) return listAnswer(connector, config, action.query);
      const ended = await followBoard(deps, { layout: layoutOf(board.home), draw: () => listAnswer(connector, config, action.query) });
      return ended.ok ? ok(followed()) : ended;
    }
    case itemCommands.record:
      return recordChecked(deps, board, action);
    case itemCommands.unassign:
      return unassign(deps, board, action.id);
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
};

/**
 * `item`: add, update, move, close and list the items of the board, record a passed check of the recipe, and take the worker off an
 * item. The words and the flags are checked first (exit 2), then the node is found and the connector runs the action. A write is one
 * state commit through the connector, and the connector refuses it for a hosted tracker kind. `list` reads the local files with no
 * lock and has no JSON output. With the follow flag, `list` draws the list again at each change of the board, until its reader goes
 * (`followBoard`).
 */
export const runItem = async (deps: Deps, options: ItemOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const action = parseAction(options);
  if (!action.ok) return action;
  const board = await openBoard(deps, options.home, registry, commands.item);
  if (!board.ok) return board;
  return execute(deps, board.value, action.value);
};
