import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { HEAD_REV, isFileMode, stateBlobTextOf, stateCommitsOf, stateEntriesAt, type TreeEntry } from '../core/git.js';
import { ok } from '../core/result.js';
import { dirs, files, maxFileBytes, stateGuard } from '../names.js';
import { itemIdsOf } from './item-ids.js';

const BOARD = files.board;

/** The git command that puts the board file of an older commit back, in the work tree and in the index. A commit then keeps it. */
export const BOARD_RESTORE_COMMAND = `git -C ${dirs.state} restore --source=<commit> --staged --worktree -- ${BOARD}`;

/** Why a board file can not be read: the reasons that a message shows. */
export const BOARD_NOT_PLAIN = 'it is not a plain file';
export const BOARD_TOO_LARGE = `it is larger than ${maxFileBytes} bytes`;

/** The board file at one commit of the state repo. */
export type BoardAtCommit =
  /** The commit holds no board file, or the repo has no commit. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'text'; readonly text: string }
  /** The entry is not a plain file, or it is too large. The file is not read. */
  | { readonly kind: 'unreadable'; readonly reason: string };

const ABSENT: BoardAtCommit = { kind: 'absent' };

/** The entry of the board file at the commit `rev` (`HEAD` or a commit id) of the state repo at `dir`, or null when it has none. */
const boardEntryAt = async (deps: Deps, dir: string, rev: string): Promise<CliResult<TreeEntry | null>> => {
  const listed = await stateEntriesAt(deps, dir, rev, BOARD);
  if (!listed.ok) return listed;
  const [entry, ...more] = listed.value;
  if (more.length > 0) return failure(`cannot read ${BOARD} of the last commit: git listed more than one entry`);
  return ok(entry ?? null);
};

/**
 * The entry of the board file at the last commit of the state repo at `dir`, or null when the file is not there. `hasCommit` is
 * false for a repo with no commit: it has no board. This read does not read the file, so a caller can compare ids first.
 */
export const headBoardEntry = (deps: Deps, dir: string, hasCommit: boolean): Promise<CliResult<TreeEntry | null>> =>
  hasCommit ? boardEntryAt(deps, dir, HEAD_REV) : Promise.resolve(ok(null));

/**
 * The board file of an entry. The kind, the mode and the size of the entry are checked before the file is read. A read of git that
 * fails is an error. The read runs with the hooks off.
 */
export const boardOfEntry = async (deps: Deps, dir: string, entry: TreeEntry | null): Promise<CliResult<BoardAtCommit>> => {
  if (entry === null) return ok(ABSENT);
  if (entry.kind !== 'blob' || !isFileMode(entry.mode)) return ok({ kind: 'unreadable', reason: BOARD_NOT_PLAIN });
  if (entry.size === null || entry.size > maxFileBytes) return ok({ kind: 'unreadable', reason: BOARD_TOO_LARGE });
  const text = await stateBlobTextOf(deps, dir, entry.id);
  return text.ok ? ok({ kind: 'text', text: text.value }) : text;
};

/** The board file at the last commit of the state repo at `dir`. This is the one reader of that file; see `headBoardEntry`. */
export const boardAtHead = async (deps: Deps, dir: string, hasCommit: boolean): Promise<CliResult<BoardAtCommit>> => {
  const entry = await headBoardEntry(deps, dir, hasCommit);
  return entry.ok ? boardOfEntry(deps, dir, entry.value) : entry;
};

/** The last board that can be read in the history of the file, older than the board at the last commit. */
export type EarlierBoard =
  | { readonly kind: 'text'; readonly text: string }
  /** The history starts, or a commit holds no board file, before any board that can be read: there is nothing to compare with. */
  | { readonly kind: 'nothing' }
  /**
   * The bound ended the walk before it found a board that can be read. `beyond` holds the commits after the bound, newest first, up to
   * `stateGuard.restoreBound` older commits in all: the walk did not read them.
   */
  | { readonly kind: 'bound'; readonly beyond: readonly string[] };

const NOTHING: EarlierBoard = { kind: 'nothing' };

/**
 * Walk back through the commits that changed the board file, on the line of first parents from the last commit, and give the first
 * board that can be read (`itemIdsOf` reads it). The walk reads at most `stateGuard.historyBound` older commits. A commit that holds
 * no board file ends the walk with nothing to compare with. At the bound, the result names the next commits of the file, so that a
 * caller can look for a board that was put back (`holdsBoardFile`). Call it when the board at the last commit can not be read. A read
 * of git that fails is an error, never "nothing". Every git call runs with the hooks off.
 */
export const earlierReadableBoard = async (deps: Deps, dir: string): Promise<CliResult<EarlierBoard>> => {
  const commits = await stateCommitsOf(deps, dir, BOARD, stateGuard.restoreBound + 1);
  if (!commits.ok) return commits;
  // The first commit is the one that made the board at the last commit.
  for (const commit of commits.value.slice(1, stateGuard.historyBound + 1)) {
    const entry = await boardEntryAt(deps, dir, commit);
    if (!entry.ok) return entry;
    const board = await boardOfEntry(deps, dir, entry.value);
    if (!board.ok) return board;
    if (board.value.kind === 'absent') return ok(NOTHING);
    if (board.value.kind === 'text' && itemIdsOf(board.value.text).ok) return ok({ kind: 'text', text: board.value.text });
  }
  if (commits.value.length <= stateGuard.historyBound) return ok(NOTHING);
  return ok({ kind: 'bound', beyond: commits.value.slice(stateGuard.historyBound + 1, stateGuard.restoreBound + 1) });
};

/**
 * True when the board file at one of `commits` is the plain file with the object id `id`. The commits are the `beyond` of a walk that
 * ended at the bound, and each one is read once. A commit with no board file, or with a board that is not a plain file, is not a match.
 * A read of git that fails is an error, never "no match". Every git call runs with the hooks off.
 */
export const holdsBoardFile = async (deps: Deps, dir: string, commits: readonly string[], id: string): Promise<CliResult<boolean>> => {
  for (const commit of commits.slice(0, stateGuard.restoreBound - stateGuard.historyBound)) {
    const entry = await boardEntryAt(deps, dir, commit);
    if (!entry.ok) return entry;
    const found = entry.value;
    if (found !== null && found.kind === 'blob' && isFileMode(found.mode) && found.id === id) return ok(true);
  }
  return ok(false);
};
