import { failure, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import {
  blobTextOf,
  headEntriesAt,
  headOf,
  isFileMode,
  stateIndexEntryAt,
  type IndexEntry,
  type TreeEntry,
} from '../core/git.js';
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
} from '../names.js';
import { lostItemIds } from '../state/item-ids.js';

const BOARD = files.board;

/** Where a fault is: in the board of the last commit, in the board of this commit, or in a read of git. */
type FaultSide = 'before' | 'after';

const SIDE_WORDS: Readonly<Record<FaultSide, string>> = { before: 'the last commit', after: 'this commit' };

const SIDE_REMEDY: Readonly<Record<FaultSide, string>> = {
  before: `Repair ${BOARD}, then commit the repair with "git commit --no-verify". The guard can not compare with a file that it can not read.`,
  after: `Repair ${BOARD}, or put it back, then commit again.`,
};

/** A board that can not be read: the check fails closed, and the commit stops. */
const contentFault = (side: FaultSide, reason: string): CliResult<never> =>
  failure(`cannot read ${BOARD} of ${SIDE_WORDS[side]}: ${reason}`, SIDE_REMEDY[side]);

/** A read of git that failed: the check fails closed, and the commit stops. */
const gitFault = (message: string): CliResult<never> =>
  failure(message, `Run "git status" in ${dirs.state}, then commit again.`);

const NOT_PLAIN = 'it is not a plain file';
const TOO_LARGE = `it is larger than ${maxFileBytes} bytes`;

/** The text of the board at the last commit. The kind, the mode and the size of the entry are checked before the file is read. */
const headBoardText = async (deps: Deps, dir: string, entry: TreeEntry): Promise<CliResult<string>> => {
  if (entry.kind !== 'blob' || !isFileMode(entry.mode)) return contentFault('before', NOT_PLAIN);
  if (entry.size === null || entry.size > maxFileBytes) return contentFault('before', TOO_LARGE);
  const text = await blobTextOf(deps, dir, entry.id);
  return text.ok ? text : gitFault(text.error.message);
};

/** The text of the board in the index. The mode is checked before the file is read, and the size after it. */
const indexBoardText = async (deps: Deps, dir: string, entry: IndexEntry): Promise<CliResult<string>> => {
  if (!isFileMode(entry.mode)) return contentFault('after', NOT_PLAIN);
  const text = await blobTextOf(deps, dir, entry.id);
  if (!text.ok) return gitFault(text.error.message);
  return Buffer.byteLength(text.value, 'utf8') > maxFileBytes ? contentFault('after', TOO_LARGE) : text;
};

/**
 * Check the commit that git is making in the state repo `dir`: it must not remove an item id from the board. Git gives the index
 * of the commit through `GIT_INDEX_FILE`, so a commit of all files (`-a`) and a commit of a list of paths are read as they are made.
 * - The board in the index and the board at the last commit are the same file (same id): nothing changed, and the check passes.
 *   That holds also for a board that can not be read, so a commit of other files is not held back.
 * - A repo with no commit, or a last commit with no board, has no id that can be lost.
 * - Any other case compares the ids (`lostItemIds`). A board that can not be read, on either side, or a read of git that fails,
 *   stops the commit: the check fails closed.
 * The check reads and writes nothing.
 */
const checkBoardChange = async (deps: Deps, dir: string): Promise<CliResult<void>> => {
  const index = await stateIndexEntryAt(deps, dir, BOARD);
  if (!index.ok) return gitFault(index.error.message);
  const head = await headOf(deps, dir);
  if (!head.ok) return gitFault(head.error.message);
  const listed = head.value === null ? ok<readonly TreeEntry[]>([]) : await headEntriesAt(deps, dir, BOARD);
  if (!listed.ok) return gitFault(listed.error.message);
  if (listed.value.length > 1) return gitFault(`cannot read ${BOARD} of the last commit: git listed more than one entry`);
  const [headEntry] = listed.value;
  if (headEntry === undefined && index.value === null) return ok(undefined);
  if (headEntry !== undefined && index.value !== null && headEntry.id === index.value.id) return ok(undefined);

  const before = headEntry === undefined ? ok(null) : await headBoardText(deps, dir, headEntry);
  if (!before.ok) return before;
  const after = index.value === null ? ok(null) : await indexBoardText(deps, dir, index.value);
  if (!after.ok) return after;

  const lost = lostItemIds(before.value, after.value);
  if (!lost.ok) return contentFault(lost.error.side, lost.error.reason);
  if (lost.value.length === 0) return ok(undefined);
  return failure(
    `this commit removes ${lost.value.length === 1 ? 'the item id' : 'the item ids'} ${namedItems(lost.value)} from ${BOARD}. Mark an item closed, never remove it.`,
  );
};

const GUARD_LINE = commandText(commandLines.stateGuard);

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
