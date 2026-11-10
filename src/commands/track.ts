import type { BoardConnector, BoardTrack, TrackAddInput } from '../board/contract.js';
import type { CliResult } from '../cli/errors.js';
import { displayLine, tableLines, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commandLines, commands, commandText, flags, flagText, itemWords, schemaIds, trackCommands } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { openBoard } from './board-open.js';
import { shown, usageFor } from './board-words.js';

export interface TrackOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its argument. */
  readonly words: readonly string[];
  readonly name: string | undefined;
  readonly roadmap: boolean;
}

type Subcommand = (typeof trackCommands)[keyof typeof trackCommands];

const SUBCOMMANDS = Object.values(trackCommands).join(', ');

const needsUsage = usageFor(commands.track);

const subcommandOf = (word: string): Subcommand | undefined => Object.values(trackCommands).find((candidate) => candidate === word);

const textLine = (line: string): OutLine => ({ level: 'text', text: line });

const trackJson = (track: BoardTrack): JsonDoc => ({
  schema: schemaIds.track,
  action: trackCommands.add,
  track: { id: track.id, name: track.name, roadmap: track.roadmap },
});

const addAnswer = (track: BoardTrack): CommandOutput => ({
  lines: [textLine(`Added the track ${displayLine(track.id)}: ${displayLine(track.name, itemWords.maxCellChars)}${track.roadmap ? ' (roadmap)' : ''}`)],
  json: trackJson(track),
  warnings: [],
  failed: false,
});

const listAnswer = (tracks: readonly BoardTrack[]): CommandOutput => {
  const rows = tracks.map((track) => [
    displayLine(track.id, itemWords.maxCellChars),
    displayLine(track.name, itemWords.maxCellChars),
    track.roadmap ? itemWords.roadmapYes : itemWords.roadmapNo,
  ]);
  return {
    lines: tracks.length === 0 ? [textLine('No tracks yet.')] : tableLines(Object.values(itemWords.trackListColumns), rows),
    json: { schema: schemaIds.trackList, tracks: tracks.map((track) => ({ id: track.id, name: track.name, roadmap: track.roadmap })) },
    warnings: [],
    failed: false,
  };
};

type Action = { readonly kind: typeof trackCommands.add; readonly input: TrackAddInput } | { readonly kind: typeof trackCommands.list };

/** The flags that `list` does not take are usage errors, so a flag that a person mistypes never goes unnoticed. */
const refuseStrayFlags = (options: TrackOptions): CliResult<void> => {
  const [stray] = [...(options.name === undefined ? [] : [flags.name]), ...(options.roadmap ? [flags.roadmap] : [])];
  return stray === undefined
    ? ok(undefined)
    : needsUsage(`the flag ${flagText(stray)} is not for ${commandText(commandLines.trackList)}`);
};

/** Check the words and the flags. A usage error (exit 2) from here comes before the node is found and before any lock. */
const parseAction = (options: TrackOptions): CliResult<Action> => {
  const [word, ...args] = options.words;
  if (word === undefined) return needsUsage(`${commandText(commands.track)} needs a subcommand: ${SUBCOMMANDS}`);
  const subcommand = subcommandOf(word);
  if (subcommand === undefined) return needsUsage(`unknown subcommand ${shown(word)}. The subcommands are: ${SUBCOMMANDS}`);
  if (subcommand === trackCommands.list) {
    if (args.length > 0) return needsUsage(`${subcommand} takes no argument`);
    const stray = refuseStrayFlags(options);
    return stray.ok ? ok({ kind: subcommand }) : stray;
  }
  const [id, ...rest] = args;
  if (id === undefined || rest.length > 0) return needsUsage(`${subcommand} takes one argument: the id of the track`);
  if (options.name === undefined) return needsUsage(`${subcommand} needs ${flagText(flags.name)} TEXT`);
  return ok({ kind: subcommand, input: { id, name: options.name, roadmap: options.roadmap } });
};

const execute = async (connector: BoardConnector, action: Action): Promise<CliResult<CommandOutput>> => {
  if (action.kind === trackCommands.list) {
    const tracks = await connector.listTracks();
    return tracks.ok ? ok(listAnswer(tracks.value)) : tracks;
  }
  const added = await connector.addTrack(action.input);
  return added.ok ? ok(addAnswer(added.value)) : added;
};

/**
 * `track`: add a track to the board, or list the tracks. There is no remove subcommand. The words and the flags are checked first
 * (exit 2), then the node is found. An add is one state commit through the connector, and the connector refuses it for a hosted
 * tracker kind. The connector checks the id and the name of a new track.
 */
export const runTrack = async (deps: Deps, options: TrackOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const action = parseAction(options);
  if (!action.ok) return action;
  const board = await openBoard(deps, options.home, registry, commands.track);
  if (!board.ok) return board;
  return execute(board.value.connector, action.value);
};
