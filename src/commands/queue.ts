import { declaredFields, rowTarget } from '../board/fields.js';
import type { LocalBoard, QueueRow, QueueRowInput, QueueRowSet } from '../board/contract.js';
import { queueView } from '../board/list-view.js';
import type { BoardField } from '../config/schema.js';
import type { CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { capitalize, commands, commandText, flags, flagText, queueCommands, queueLimits, queueWords, schemaIds } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { openBoard } from './board-open.js';
import { parseFieldWords, shown, usageFor } from './board-words.js';

export interface QueueOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its argument. */
  readonly words: readonly string[];
  /** The item ids of the item flag, in order. */
  readonly items: readonly string[];
  readonly note: string | undefined;
  /** The `NAME=VALUE` words of the field flag, in order. */
  readonly fields: readonly string[];
  /** The position flag as typed. */
  readonly position: string | undefined;
}

type Subcommand = (typeof queueCommands)[keyof typeof queueCommands];

type Action =
  | { readonly kind: typeof queueCommands.set; readonly input: QueueRowInput }
  | { readonly kind: typeof queueCommands.show };

const SUBCOMMANDS = Object.values(queueCommands).join(', ');

/** The flags that each subcommand takes, besides the flags that every command takes. A flag of another subcommand is a usage error. */
const TAKES: Readonly<Record<Subcommand, readonly string[]>> = {
  [queueCommands.set]: [flags.item, flags.note, flags.field, flags.position],
  [queueCommands.show]: [],
};

const needsUsage = usageFor(commands.queue);

const subcommandOf = (word: string): Subcommand | undefined => Object.values(queueCommands).find((candidate) => candidate === word);

const refuseStrayFlags = (subcommand: Subcommand, options: QueueOptions): CliResult<void> => {
  const given: readonly (readonly [string, boolean])[] = [
    [flags.item, options.items.length > 0],
    [flags.note, options.note !== undefined],
    [flags.field, options.fields.length > 0],
    [flags.position, options.position !== undefined],
  ];
  const stray = given.find(([flag, present]) => present && !TAKES[subcommand].includes(flag));
  return stray === undefined ? ok(undefined) : needsUsage(`the flag ${flagText(stray[0])} is not for ${commandText(`${commands.queue} ${subcommand}`)}`);
};

const parsePosition = (position: string | undefined): CliResult<number | undefined> => {
  if (position === undefined) return ok(undefined);
  return queueLimits.positionPattern.test(position) ? ok(Number(position)) : needsUsage(`${flagText(flags.position)} takes a whole number from 1`);
};

/** Check the words and the flags. A usage error (exit 2) from here comes before the node is found and before any lock. */
const parseAction = (options: QueueOptions): CliResult<Action> => {
  const [word, ...args] = options.words;
  if (word === undefined) return needsUsage(`${commandText(commands.queue)} needs a subcommand: ${SUBCOMMANDS}`);
  const subcommand = subcommandOf(word);
  if (subcommand === undefined) return needsUsage(`unknown subcommand ${shown(word)}. The subcommands are: ${SUBCOMMANDS}`);
  const stray = refuseStrayFlags(subcommand, options);
  if (!stray.ok) return stray;
  switch (subcommand) {
    case queueCommands.set: {
      const [name, ...rest] = args;
      if (name === undefined || rest.length > 0) return needsUsage(`${subcommand} takes one argument: the name of a ${queueWords.row}`);
      const fields = parseFieldWords(needsUsage, options.fields);
      if (!fields.ok) return fields;
      const position = parsePosition(options.position);
      if (!position.ok) return position;
      return ok({
        kind: subcommand,
        input: {
          name,
          fields: fields.value,
          ...(options.items.length === 0 ? {} : { items: options.items }),
          ...(options.note === undefined ? {} : { note: options.note }),
          ...(position.value === undefined ? {} : { position: position.value }),
        },
      });
    }
    case queueCommands.show:
      return args.length > 0 ? needsUsage(`${subcommand} takes no argument`) : ok({ kind: subcommand });
    default: {
      const unreachable: never = subcommand;
      return unreachable;
    }
  }
};

const textLine = (line: string): OutLine => ({ level: 'text', text: line });

const answer = (line: string, json: JsonDoc): CommandOutput => ({ lines: [textLine(line)], json, warnings: [], failed: false });

/** The line of a write: a new row, a changed row, or a row that stays as it is. */
const setLine = (set: QueueRowSet): string => {
  const name = displayLine(set.name, queueWords.maxCellChars);
  if (set.created) return `Added ${queueWords.row} ${set.position} to the ${queueWords.queue}: ${name}`;
  return set.changed
    ? `Saved ${queueWords.row} ${set.position} of the ${queueWords.queue}: ${name}`
    : `${capitalize(queueWords.row)} ${set.position} of the ${queueWords.queue}: ${name} (no change)`;
};

const setAnswer = (set: QueueRowSet): CommandOutput =>
  answer(setLine(set), {
    schema: schemaIds.queue,
    action: queueCommands.set,
    row: { name: set.name, position: set.position, items: set.items, created: set.created, changed: set.changed },
  });

/** The owner fields that a row holds, by name. A field that the row lacks is left out. */
const fieldsOf = (row: QueueRow, declared: readonly BoardField[]): Record<string, string | boolean> =>
  Object.fromEntries(
    declared.flatMap((field): [string, string | boolean][] => {
      const value = row.record[field.name];
      return typeof value === 'string' || typeof value === 'boolean' ? [[field.name, value]] : [];
    }),
  );

const showAnswer = (rows: readonly QueueRow[], declared: readonly BoardField[]): CommandOutput => ({
  lines: queueView({ rows, fields: declared }),
  json: {
    schema: schemaIds.queueShow,
    rows: rows.map((row) => ({ position: row.position, name: row.name, items: row.items, note: row.note, fields: fieldsOf(row, declared) })),
  },
  warnings: [],
  failed: false,
});

const execute = async (connector: LocalBoard, declared: readonly BoardField[], action: Action): Promise<CliResult<CommandOutput>> => {
  if (action.kind === queueCommands.show) {
    const rows = await connector.listQueue();
    return rows.ok ? ok(showAnswer(rows.value, declared)) : rows;
  }
  const set = await connector.setQueueRow(action.input);
  return set.ok ? ok(setAnswer(set.value)) : set;
};

/**
 * `queue`: add a row to the queue, change or move a row, or show the rows. The words and the flags are checked first (exit 2), then
 * the node is found and the connector runs the action. A write is one state commit through the connector, and the connector
 * refuses it for a hosted tracker kind. `show` reads the local file with no lock.
 */
export const runQueue = async (deps: Deps, options: QueueOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const action = parseAction(options);
  if (!action.ok) return action;
  const board = await openBoard(deps, options.home, registry, commands.queue);
  if (!board.ok) return board;
  const { connector, config } = board.value;
  return execute(connector, declaredFields(config.core.board, rowTarget), action.value);
};
