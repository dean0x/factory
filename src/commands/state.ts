import { failure, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { headOf, isFileMode, stateBlobTextOf, stateIndexEntryAt, type IndexEntry } from '../core/git.js';
import { ok } from '../core/result.js';
import { namedItems } from '../core/root-paths.js';
import {
  commands,
  commandLines,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  maxFileBytes,
  schemaIds,
  stateCommands,
  stateGuard,
} from '../names.js';
import {
  BOARD_NOT_PLAIN,
  BOARD_RESTORE_COMMAND,
  BOARD_TOO_LARGE,
  boardOfEntry,
  earlierReadableBoard,
  headBoardEntry,
  type BoardAtCommit,
} from '../state/head-board.js';
import { itemIdsOf, lostItemIds } from '../state/item-ids.js';

const BOARD = files.board;

/** Where a fault is: in the board of the last commit, in the board of this commit, or in a read of git. */
type FaultSide = 'before' | 'after';

const SIDE_WORDS: Readonly<Record<FaultSide, string>> = { before: 'the last commit', after: 'this commit' };

const GUARD_LINE = commandText(commandLines.stateGuard);

/** The remedy lines name the command that stopped the commit, because git runs it and a person does not. */
const GIT_RUNS_GUARD = `Git runs "${GUARD_LINE}" before each commit.`;

const SIDE_REMEDY: Readonly<Record<FaultSide, string>> = {
  before: `Restore ${BOARD} from an older commit with "${BOARD_RESTORE_COMMAND}", then commit. ${GIT_RUNS_GUARD}`,
  after: `Repair ${BOARD}, or put it back, then commit again. ${GIT_RUNS_GUARD}`,
};

/** A board that can not be read: the check fails closed, and the commit stops. */
const contentFault = (side: FaultSide, reason: string): CliResult<never> =>
  failure(`cannot read ${BOARD} of ${SIDE_WORDS[side]}: ${reason}`, SIDE_REMEDY[side]);

/** A read of git that failed: the check fails closed, and the commit stops. */
const gitFault = (message: string): CliResult<never> =>
  failure(message, `Run "git status" in ${dirs.state}, then commit again. ${GIT_RUNS_GUARD}`);

/** The text of the board in the index. The mode is checked before the file is read, and the size after it. */
const indexBoardText = async (deps: Deps, dir: string, entry: IndexEntry): Promise<CliResult<string>> => {
  if (!isFileMode(entry.mode)) return contentFault('after', BOARD_NOT_PLAIN);
  const text = await stateBlobTextOf(deps, dir, entry.id);
  if (!text.ok) return gitFault(text.error.message);
  return Buffer.byteLength(text.value, 'utf8') > maxFileBytes ? contentFault('after', BOARD_TOO_LARGE) : text;
};

/** The board that the new board is compared with: its text, or null when there is nothing to compare with. */
interface Comparison {
  readonly text: string | null;
  /** True when the board at the last commit can not be read and the text is from an older commit. */
  readonly older: boolean;
}

/** Why the board at the last commit can not be read, or null when it can be read. */
const unreadableWhy = (head: Exclude<BoardAtCommit, { readonly kind: 'absent' }>): string | null => {
  if (head.kind === 'unreadable') return head.reason;
  const ids = itemIdsOf(head.text);
  return ids.ok ? null : ids.error;
};

/**
 * The board to compare the new board with. A board at the last commit that can be read is the one. A board that can not be read (bad
 * JSON, another shape, not a plain file, too large) sends the walk back through the history of the file to the last board that can
 * be read. When the history starts first, there is nothing to compare with. When the bound ends the walk first, the check stops
 * (fail closed).
 */
const comparisonOf = async (deps: Deps, dir: string, head: BoardAtCommit): Promise<CliResult<Comparison>> => {
  if (head.kind === 'absent') return ok({ text: null, older: false });
  const why = unreadableWhy(head);
  if (why === null && head.kind === 'text') return ok({ text: head.text, older: false });
  const earlier = await earlierReadableBoard(deps, dir);
  if (!earlier.ok) return gitFault(earlier.error.message);
  if (earlier.value.kind === 'bound') {
    return contentFault('before', `${why}, and none of the ${stateGuard.historyBound} older commits of the file holds a board that can be read`);
  }
  return ok({ text: earlier.value.kind === 'text' ? earlier.value.text : null, older: true });
};

const OLDER_NOTE = 'The last commit holds a board that can not be read, so the check compared with an older commit.';

/**
 * Check the commit that git is making in the state repo `dir`: it must not remove an item id from the board. Git gives the index
 * of the commit through `GIT_INDEX_FILE`, so a commit of all files (`-a`) and a commit of a list of paths are read as they are made.
 * - The board in the index and the board at the last commit are the same file (same id): nothing changed, and the check passes.
 *   That holds also for a board that can not be read, so a commit of other files is not held back.
 * - A repo with no commit, or a last commit with no board, has no id that can be lost.
 * - A board at the last commit that can not be read is compared through `comparisonOf`: a repair keeps every id of the last board
 *   that can be read, and it is a normal commit.
 * - Any other case compares the ids (`lostItemIds`). A new board that can not be read, or a read of git that fails, stops the
 *   commit: the check fails closed.
 * The check reads and writes nothing.
 */
const checkBoardChange = async (deps: Deps, dir: string): Promise<CliResult<void>> => {
  const index = await stateIndexEntryAt(deps, dir, BOARD);
  if (!index.ok) return gitFault(index.error.message);
  const head = await headOf(deps, dir);
  if (!head.ok) return gitFault(head.error.message);
  const headEntry = await headBoardEntry(deps, dir, head.value !== null);
  if (!headEntry.ok) return gitFault(headEntry.error.message);
  if (headEntry.value === null && index.value === null) return ok(undefined);
  if (headEntry.value !== null && index.value !== null && headEntry.value.id === index.value.id) return ok(undefined);

  const before = await boardOfEntry(deps, dir, headEntry.value);
  if (!before.ok) return gitFault(before.error.message);
  const after = index.value === null ? ok(null) : await indexBoardText(deps, dir, index.value);
  if (!after.ok) return after;
  const compared = await comparisonOf(deps, dir, before.value);
  if (!compared.ok) return compared;

  const lost = lostItemIds(compared.value.text, after.value);
  if (!lost.ok) return contentFault(lost.error.side, lost.error.reason);
  if (lost.value.length === 0) return ok(undefined);
  const removed = `this commit removes ${lost.value.length === 1 ? 'the item id' : 'the item ids'} ${namedItems(lost.value)} from ${BOARD}.`;
  return failure(`${removed} ${compared.value.older ? `${OLDER_NOTE} ` : ''}Mark an item closed, never remove it.`);
};

/** `state guard`: git runs it as the hook of the state repo. It takes no word. */
export const runStateGuard = async (deps: Deps, words: readonly string[]): Promise<CliResult<CommandOutput>> => {
  if (words.length > 0) return usageError(`${GUARD_LINE} takes no argument`, `Git runs "${GUARD_LINE}", not a person.`);
  const checked = await checkBoardChange(deps, deps.cwd);
  if (!checked.ok) return checked;
  return ok({ lines: [], json: { schema: schemaIds.stateGuard, passed: true }, warnings: [], failed: false });
};

export interface StateOptions {
  /** The words after the command: the subcommand, then its arguments. */
  readonly words: readonly string[];
}

const SUBCOMMANDS = Object.values(stateCommands).join(', ');

const needsUsage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.state)} ${flagText(flags.help)}".`);

/** `state <subcommand>`: the commands that git runs in the state folder. */
export const runState = async (deps: Deps, options: StateOptions): Promise<CliResult<CommandOutput>> => {
  const [subcommand, ...args] = options.words;
  switch (subcommand) {
    case undefined:
      return needsUsage(`${commandText(commands.state)} needs a subcommand: ${SUBCOMMANDS}`);
    case stateCommands.guard:
      return runStateGuard(deps, args);
    default:
      return needsUsage(`unknown subcommand ${JSON.stringify(subcommand)}. The subcommands are: ${SUBCOMMANDS}`);
  }
};
