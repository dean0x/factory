import type {
  BoardConnector,
  BoardItem,
  DocLinked,
  ItemAddInput,
  ItemMove,
  ItemMoved,
  ItemPatch,
  ItemPlace,
  ItemQuery,
  ItemRanked,
} from '../board/contract.js';
import { checkItemId, checkNoteText, docPathIssue } from '../board/edit.js';
import { declaredFields, itemTarget } from '../board/fields.js';
import { followBoard } from '../board/follow.js';
import { boardView, trackView } from '../board/list-view.js';
import { requireLocalKind } from '../board/local.js';
import { recordWork, type RecordedWork, type RecordWorkInput } from '../board/record-flow.js';
import { stageShown } from '../board/stages.js';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { guardValuesFor } from '../guards/effective.js';
import type { GuardValues } from '../guards/types.js';
import {
  boardKeys,
  commandLines,
  commands,
  commandText,
  files,
  flags,
  flagText,
  guardIds,
  itemCommands,
  itemWords,
  places,
  requestWords,
  roles,
  schemaIds,
} from '../names.js';
import type { RecordGuard } from '../recipes/entry.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { hasOwnerPrefix } from '../safety/owner-prefix.js';
import { layoutOf } from '../state/layout.js';
import { requireCoordinatorCaller } from '../workers/panes.js';
import { openBoard, type OpenBoard } from './board-open.js';
import { parseFieldWords, shown, usageFor } from './board-words.js';

export interface ItemOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its argument. */
  readonly words: readonly string[];
  readonly title: string | undefined;
  readonly text: string | undefined;
  readonly track: string | undefined;
  /** The epic of the item. Only `add` and `update` take it. */
  readonly epic: string | undefined;
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
  /** The reason to close the item. Only `close` takes it. */
  readonly reason?: string | undefined;
  /** The id of the item that the ranked item goes directly after. Only `rank` takes it. An empty value counts as given. */
  readonly after?: string | undefined;
  /** Put the ranked item at the start of the board order. Only `rank` takes it. */
  readonly first?: boolean | undefined;
  /** Put the ranked item at the end of the board order. Only `rank` takes it. */
  readonly last?: boolean | undefined;
  readonly json: boolean;
}

type Subcommand = (typeof itemCommands)[keyof typeof itemCommands];

type Action =
  | { readonly kind: typeof itemCommands.add; readonly input: ItemAddInput }
  | { readonly kind: typeof itemCommands.update; readonly id: string; readonly patch: ItemPatch }
  | { readonly kind: typeof itemCommands.move; readonly id: string; readonly move: ItemMove }
  | { readonly kind: typeof itemCommands.close; readonly id: string; readonly reason: string | undefined }
  | { readonly kind: typeof itemCommands.list; readonly query: ItemQuery; readonly follow: boolean }
  | ({ readonly kind: typeof itemCommands.record } & RecordWorkInput)
  | { readonly kind: typeof itemCommands.unassign; readonly id: string }
  | { readonly kind: typeof itemCommands.doc; readonly id: string; readonly path: string }
  | { readonly kind: typeof itemCommands.note; readonly id: string; readonly text: string }
  | { readonly kind: typeof itemCommands.rank; readonly id: string; readonly place: ItemPlace };

const SUBCOMMANDS = Object.values(itemCommands).join(', ');

/** The flags that each subcommand takes, besides the flags that every command takes. A flag of another subcommand is a usage error. */
const TAKES: Readonly<Record<Subcommand, readonly string[]>> = {
  [itemCommands.add]: [flags.title, flags.text, flags.track, flags.epic, flags.field],
  [itemCommands.update]: [flags.title, flags.text, flags.track, flags.epic, flags.field],
  [itemCommands.move]: [flags.state, flags.stage],
  [itemCommands.close]: [flags.reason],
  [itemCommands.list]: [flags.all, flags.track, flags.follow],
  [itemCommands.record]: [flags.ref, flags.project],
  [itemCommands.unassign]: [],
  [itemCommands.doc]: [],
  [itemCommands.note]: [],
  [itemCommands.rank]: [flags.after, flags.first, flags.last],
};

const needsUsage = usageFor(commands.item);

const subcommandOf = (word: string): Subcommand | undefined => Object.values(itemCommands).find((candidate) => candidate === word);

const refuseStrayFlags = (subcommand: Subcommand, options: ItemOptions): CliResult<void> => {
  const given: readonly (readonly [string, boolean])[] = [
    [flags.title, options.title !== undefined],
    [flags.text, options.text !== undefined],
    [flags.track, options.track !== undefined],
    [flags.epic, options.epic !== undefined],
    [flags.field, options.fields.length > 0],
    [flags.state, options.state !== undefined],
    [flags.stage, options.stage !== undefined],
    [flags.all, options.all],
    [flags.follow, options.follow],
    [flags.ref, options.ref !== undefined],
    [flags.project, options.project !== undefined],
    [flags.reason, options.reason !== undefined],
    [flags.after, options.after !== undefined],
    [flags.first, options.first === true],
    [flags.last, options.last === true],
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

const withEpic = (options: ItemOptions): { readonly epic?: string } => (options.epic === undefined ? {} : { epic: options.epic });

/** The id of an item and the path of a file, and nothing more. The path is checked by the connector. */
const docArguments = (subcommand: Subcommand, args: readonly string[]): CliResult<{ readonly id: string; readonly path: string }> => {
  const [id, path, ...rest] = args;
  return id !== undefined && path !== undefined && rest.length === 0
    ? ok({ id, path })
    : needsUsage(`${subcommand} takes two arguments: the id of an item and the path of a file of the ${places.folder}`);
};

const noteArguments = (args: readonly string[]): CliResult<{ readonly id: string; readonly text: string }> => {
  const [id, text, ...rest] = args;
  return id !== undefined && text !== undefined && rest.length === 0
    ? ok({ id, text })
    : needsUsage(`${itemCommands.note} takes two arguments: the id of an item and the text of the note in quotes`);
};

const PLACE_FLAGS = `${flagText(flags.after)}, ${flagText(flags.first)} and ${flagText(flags.last)}`;

/**
 * The one place of a rank. This checks only how many place flags are given: an empty after value counts as given. The connector
 * checks the id of the target after the check of the tracker kind, so a hosted kind refuses the rank first.
 */
const placeOf = (options: ItemOptions): CliResult<ItemPlace> => {
  const given: readonly ItemPlace[] = [
    ...(options.after === undefined ? [] : [{ after: options.after }]),
    ...(options.first === true ? [{ edge: flags.first }] : []),
    ...(options.last === true ? [{ edge: flags.last }] : []),
  ];
  const [place, ...more] = given;
  if (place === undefined) return needsUsage(`${itemCommands.rank} needs one of ${PLACE_FLAGS}`);
  return more.length === 0 ? ok(place) : needsUsage(`${itemCommands.rank} takes one of ${PLACE_FLAGS}, not more than one`);
};

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
      return ok({
        kind: subcommand,
        input: { title: options.title, fields: fields.value, ...withText(options), ...withTrack(options), ...withEpic(options) },
      });
    }
    case itemCommands.update: {
      const id = idArgument(subcommand, args);
      if (!id.ok) return id;
      if (
        options.title === undefined &&
        options.text === undefined &&
        options.track === undefined &&
        options.epic === undefined &&
        options.fields.length === 0
      ) {
        return needsUsage(
          `${subcommand} needs at least one of ${[flags.title, flags.text, flags.track, flags.epic, flags.field].map(flagText).join(', ')}`,
        );
      }
      const title = options.title === undefined ? {} : { title: options.title };
      return ok({
        kind: subcommand,
        id: id.value,
        patch: { fields: fields.value, ...title, ...withText(options), ...withTrack(options), ...withEpic(options) },
      });
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
      return id.ok ? ok({ kind: subcommand, id: id.value, reason: options.reason }) : id;
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
    case itemCommands.doc: {
      const given = docArguments(subcommand, args);
      return given.ok ? ok({ kind: subcommand, id: given.value.id, path: given.value.path }) : given;
    }
    case itemCommands.note: {
      const given = noteArguments(args);
      return given.ok ? ok({ kind: subcommand, ...given.value }) : given;
    }
    case itemCommands.rank: {
      const id = idArgument(subcommand, args);
      if (!id.ok) return id;
      const place = placeOf(options);
      return place.ok ? ok({ kind: subcommand, id: id.value, place: place.value }) : place;
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

const isTextList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** The stored epic of an item, or null when the item has none or the key holds other than text. */
export const epicOf = (item: BoardItem): string | null => {
  const stored = item.record[boardKeys.epic];
  return typeof stored === 'string' ? stored : null;
};

/** The stored copy of the stage list, or null for an item from before the key and for a key that is not a list of text. */
const stageCopyOf = (item: BoardItem): readonly string[] | null => {
  const stored = item.record[boardKeys.stages];
  return isTextList(stored) ? stored : null;
};

/**
 * The docs of an item, in the stored order. Only a stored entry that is text and passes the doc name check is kept. This repeats the
 * name check of the write only, with the same guard values: the checks of the file itself (no link, a plain file, the size limit) are
 * the job of the reader of the path. A key that is not a list gives an empty list.
 */
const docsOf = (item: BoardItem, guards: GuardValues): readonly string[] => {
  const stored = item.record[boardKeys.docs];
  return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string' && docPathIssue(entry, guards) === null) : [];
};

const itemJson = (action: Subcommand, item: BoardItem, guards: GuardValues): JsonDoc => ({
  schema: schemaIds.item,
  action,
  item: {
    id: item.id,
    title: item.title,
    status: item.status,
    stage: item.stage,
    track: item.track,
    epic: epicOf(item),
    stages: stageCopyOf(item),
    docs: docsOf(item, guards),
  },
});

const itemAnswer = (verb: string, action: Subcommand, item: BoardItem, guards: GuardValues): CommandOutput =>
  answer(`${verb} ${displayLine(item.id)}: ${titleText(item)}`, itemJson(action, item, guards));

/** The line of a doc link: the item as for any write, or one line that says the item held the path already. */
const linkAnswer = (path: string, linked: DocLinked, guards: GuardValues): CommandOutput =>
  linked.changed
    ? itemAnswer('Linked', itemCommands.doc, linked.item, guards)
    : answer(`Already linked ${displayLine(path)} to ${displayLine(linked.item.id)}.`, itemJson(itemCommands.doc, linked.item, guards));

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

/**
 * The one line of a rank: the id and the place that it asked for. A rank to the place that the item has says that nothing changed.
 * The JSON holds only ids, the place and the change mark: `after` is the target id, or null for an edge.
 */
const rankAnswer = (ranked: ItemRanked): CommandOutput => {
  const after = 'after' in ranked.place ? ranked.place.after : null;
  const place = 'after' in ranked.place ? flags.after : ranked.place.edge;
  const where = after === null ? place : `${place} ${displayLine(after)}`;
  const line = `${displayLine(ranked.id)} ${itemCommands.rank}: ${where}${ranked.changed ? '' : ' (no change)'}`;
  return answer(line, { schema: schemaIds.item, action: itemCommands.rank, id: ranked.id, after, place, changed: ranked.changed });
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

/** The line of a record while the owner-go guard is off: no check of the linked approval requests ran. */
const UNAPPROVED_LINE = textLine(
  `The guard ${guardIds.ownerGo} is off, so this record did not check the linked approval ${requestWords.requests} of the item.`,
);

const recordedAnswer = ({ checked, recorded, offGuards }: RecordedWork, guard: RecordGuard | undefined): CommandOutput => {
  const id = displayLine(recorded.item.id);
  const summary = displayLine(checked.summary);
  const done = answer(recorded.changed ? `Recorded ${id}: ${summary}` : `${id}: ${summary} already recorded`, {
    schema: schemaIds.item,
    action: itemCommands.record,
    id: recorded.item.id,
    stage: checked.stage,
    ref: checked.ref,
    head: checked.head,
    summary: checked.summary,
    changed: recorded.changed,
  });
  const lines: OutLine[] = [];
  if (guard !== undefined && offGuards.includes(guard.id)) lines.push(textLine(guard.offLine));
  if (offGuards.includes(guardIds.ownerGo)) lines.push(UNAPPROVED_LINE);
  return lines.length === 0 ? done : { ...done, lines: [...done.lines, ...lines] };
};

const recordChecked = async (deps: Deps, board: OpenBoard, action: RecordWorkInput): Promise<CliResult<CommandOutput>> => {
  const result = await recordWork(deps, board, action);
  return result.ok ? ok(recordedAnswer(result.value, board.config.entry.recordCheck?.guard)) : result;
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
      ...itemJson(itemCommands.unassign, item, await guardValuesFor(deps, board.home)),
      worker,
    }),
  );
};

const noteTextFor = async (
  deps: Deps,
  board: OpenBoard,
  id: string,
  what: typeof itemWords.note | typeof itemWords.reason,
  text: string,
): Promise<CliResult<string>> => {
  const valid = checkItemId(id);
  if (!valid.ok) return valid;
  const guards = await guardValuesFor(deps, board.home);
  const local = requireLocalKind(board.config.core.tracker.kind, commands.item, guards);
  if (!local.ok) return local;
  const checked = checkNoteText(what, text);
  if (!checked.ok) return checked;
  const { prefix, display } = board.config.core.owner;
  return hasOwnerPrefix(text, prefix, display) ? needsUsage(`the ${what} must not include the ${roles.owner} prefix`) : checked;
};

const execute = async (deps: Deps, board: OpenBoard, action: Action): Promise<CliResult<CommandOutput>> => {
  const { connector, config } = board;
  /** The guard values of the node, for the doc view of an item in the output. */
  const guards = (): Promise<GuardValues> => guardValuesFor(deps, board.home);
  switch (action.kind) {
    case itemCommands.add: {
      const added = await connector.addItem(action.input);
      return added.ok ? ok(itemAnswer('Added', action.kind, added.value, await guards())) : added;
    }
    case itemCommands.update: {
      const saved = await connector.updateItem(action.id, action.patch);
      return saved.ok ? ok(itemAnswer('Saved', action.kind, saved.value, await guards())) : saved;
    }
    case itemCommands.move: {
      const moved = await connector.moveItem(action.id, action.move);
      return moved.ok ? ok(moveAnswer(config, action.move, moved.value)) : moved;
    }
    case itemCommands.close: {
      let reason = action.reason;
      if (reason !== undefined) {
        const checked = await noteTextFor(deps, board, action.id, itemWords.reason, reason);
        if (!checked.ok) return checked;
        reason = checked.value;
      }
      const closed = await connector.closeItem(action.id, reason);
      return closed.ok ? ok(itemAnswer('Closed', action.kind, closed.value, await guards())) : closed;
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
    case itemCommands.doc: {
      const linked = await connector.linkDoc({ id: action.id, path: action.path });
      return linked.ok ? ok(linkAnswer(action.path, linked.value, await guards())) : linked;
    }
    case itemCommands.note: {
      const checked = await noteTextFor(deps, board, action.id, itemWords.note, action.text);
      if (!checked.ok) return checked;
      const noted = await connector.noteItem(action.id, checked.value);
      if (!noted.ok) return noted;
      const { item, note } = noted.value;
      return ok(answer(`Noted ${displayLine(item.id)}: ${titleText(item)}`, { ...itemJson(action.kind, item, await guards()), note }));
    }
    case itemCommands.rank: {
      const ranked = await connector.rankItem(action.id, action.place);
      return ranked.ok ? ok(rankAnswer(ranked.value)) : ranked;
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
};

/**
 * `item`: add, update, move, rank, close and list the items of the board. Add a note, link a file, record a passed check of the
 * recipe, or take a worker off an item. A close with a reason adds the reason as a note. `rank` moves an open item to a new place in
 * the board order: the order of the items in the board file, one list for each board. The command checks its words and flags first
 * (exit 2). Then it finds the node and uses the connector. A write makes one state commit, and a rank with no change makes none. For
 * a hosted tracker kind, the board edit guard can refuse the write. `list` reads the local files with no lock and has no JSON
 * output. With the follow flag, `list` draws the list again at each change of the board until its reader goes (`followBoard`).
 */
export const runItem = async (deps: Deps, options: ItemOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const action = parseAction(options);
  if (!action.ok) return action;
  const board = await openBoard(deps, options.home, registry, commands.item);
  if (!board.ok) return board;
  return execute(deps, board.value, action.value);
};
