import { declaredFields, itemTarget } from '../board/fields.js';
import type { BoardConnector, BoardItem, ItemAddInput, ItemMove, ItemMoved, ItemPatch, ItemQuery } from '../board/contract.js';
import { boardView, trackView } from '../board/list-view.js';
import { stageShown } from '../board/stages.js';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commandLines, commands, commandText, files, flags, flagText, itemCommands, itemWords, schemaIds } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { openBoard } from './board-open.js';
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
  readonly json: boolean;
}

type Subcommand = (typeof itemCommands)[keyof typeof itemCommands];

type Action =
  | { readonly kind: typeof itemCommands.add; readonly input: ItemAddInput }
  | { readonly kind: typeof itemCommands.update; readonly id: string; readonly patch: ItemPatch }
  | { readonly kind: typeof itemCommands.move; readonly id: string; readonly move: ItemMove }
  | { readonly kind: typeof itemCommands.close; readonly id: string }
  | { readonly kind: typeof itemCommands.list; readonly query: ItemQuery };

const SUBCOMMANDS = Object.values(itemCommands).join(', ');

/** The flags that each subcommand takes, besides the flags that every command takes. A flag of another subcommand is a usage error. */
const TAKES: Readonly<Record<Subcommand, readonly string[]>> = {
  [itemCommands.add]: [flags.title, flags.text, flags.track, flags.field],
  [itemCommands.update]: [flags.title, flags.text, flags.track, flags.field],
  [itemCommands.move]: [flags.state, flags.stage],
  [itemCommands.close]: [],
  [itemCommands.list]: [flags.all, flags.track],
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
      return ok({ kind: subcommand, query: { all: options.all, ...withTrack(options) } });
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

const execute = async (connector: BoardConnector, config: FactoryConfig, action: Action): Promise<CliResult<CommandOutput>> => {
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
    case itemCommands.list:
      return listAnswer(connector, config, action.query);
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
};

/**
 * `item`: add, update, move, close and list the items of the board. The words and the flags are checked first (exit 2), then the node
 * is found and the connector runs the action. A write is one state commit through the connector, and the connector refuses it for a
 * hosted tracker kind. `list` reads the local files with no lock and has no JSON output.
 */
export const runItem = async (deps: Deps, options: ItemOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const action = parseAction(options);
  if (!action.ok) return action;
  const board = await openBoard(deps, options.home, registry, commands.item);
  if (!board.ok) return board;
  return execute(board.value.connector, board.value.config, action.value);
};
