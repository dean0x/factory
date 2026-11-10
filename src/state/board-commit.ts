import { isAbsolute, join, normalize } from 'node:path';
import { failure, safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { commitPaths, GIT_ENTRY, requireStateRepoCommit, stateHeadOf, unstagePaths, type RepoPaths } from '../core/git.js';
import { err, ok, type Err, type Result } from '../core/result.js';
import { LINK_REMEDY, namedItems, shownPath } from '../core/root-paths.js';
import { commandText, commands, dirs, files, maxFileBytes, type CommandName } from '../names.js';
import { readCheckedFile, type NamedPath } from '../workers/registry.js';
import { requireGuardOn } from './guard.js';
import { BOARD_RESTORE_COMMAND, boardAtHead } from './head-board.js';
import { lostItemIds } from './item-ids.js';
import type { Layout } from './layout.js';
import { withStateLock } from './state-lock.js';

/**
 * The board commit helper: the one way that a command changes files of the state repo that hold the board. It checks that the delete
 * guard is on, runs the change of the caller on the text that it commits, checks that each new text is within the size cap and that
 * no item id is lost, writes the files and makes exactly one commit of them. The caller does not write or commit these files by
 * itself. A reader of these files uses `readBoardFiles`, which takes no lock.
 */

/** The text of each file of a change, by its path relative to the state folder. A file that is not there has the text null. */
export type BoardTexts = ReadonlyMap<string, string | null>;

export interface BoardChange {
  /** The files that the change may write, relative to the state folder. The ready check covers exactly these files. */
  readonly touched: readonly string[];
  /** The command that the person runs again after a stop. */
  readonly command: CommandName;
  /** The message of the commit. */
  readonly message: string;
  /**
   * The change of the caller. It runs inside the state lock, on the text of each touched file as the file is now, so a check of
   * the caller and a side write of the caller see the same text that the commit holds. It gives the new text of each file that
   * changes (null removes the file); a file that it leaves out stays as it is. It writes no touched file itself. A failure stops the
   * helper before any write.
   */
  readonly change: (texts: BoardTexts) => Promise<CliResult<BoardTexts>>;
  /**
   * A step that runs inside the state lock, after every check of the helper (the size of each new text and the item ids) and before the
   * first file write. It gets the files that really change. A failure stops the helper before any file write, and the error reaches the
   * caller as it is, with no outcome field. The step does not run when no file changes. It calls no step that takes the state lock.
   */
  readonly beforeWrite?: (updates: BoardTexts) => Promise<CliResult<void>>;
}

export interface BoardCommit {
  /** True when the helper made a commit. False when the change left every file as it was. */
  readonly committed: boolean;
}

/**
 * Where the files stand after a failure that follows the first file write:
 * - `restored`: no commit was made, and every written file is back as it was, with the staged changes cleared;
 * - `committed`: the commit was made although git reported an error, so the files stay changed;
 * - `unknown`: the helper can not tell, because the last commit is not readable or a file did not go back.
 */
export type CommitOutcome = 'restored' | 'committed' | 'unknown';

/** The error of the helper. A failure after the first file write has `commitOutcome`; a failure before it has none. */
export type BoardCommitError = CliError & { readonly commitOutcome?: CommitOutcome };

export type BoardCommitResult = Result<BoardCommit, BoardCommitError>;

const BOARD = files.board;

/**
 * A path in the change is a plain path below the state folder: no folder above it, no empty or dotted part, and no part that is
 * a git folder. The git folder is compared in lower case, because a disk that ignores case gives `.GIT` the same folder as `.git`.
 */
export const isPlainPath = (path: string): boolean => {
  const parts = path.split('/');
  return (
    path !== '' &&
    !isAbsolute(path) &&
    normalize(path) === path &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== GIT_ENTRY)
  );
};

const requirePlainPaths = (paths: readonly string[]): CliResult<readonly string[]> => {
  if (paths.length === 0) return failure('a board change names no file');
  const bad = paths.find((path) => !isPlainPath(path));
  if (bad !== undefined) return failure(`a board change names ${JSON.stringify(bad)}, which is not a plain path below ${dirs.state}`);
  return ok([...new Set(paths)]);
};

/**
 * The text of one touched file as it is on disk, or null when the file is not there. A link is a security stop (exit 4). A folder, a
 * large file and a file that is not UTF-8 are failures. The decode is strict: the helper writes the text back, so a byte that a lenient
 * decode would change must stop the call instead of changing the file.
 */
const currentTextOf = async (deps: Deps, layout: Layout, path: string): Promise<CliResult<string | null>> => {
  const parts = path.split('/');
  const folders: NamedPath[] = [{ path: layout.stateDir, what: dirs.state }];
  for (let at = 1; at < parts.length; at += 1) {
    const folder = parts.slice(0, at).join('/');
    folders.push({ path: join(layout.stateDir, folder), what: folder });
  }
  const read = await readCheckedFile(deps, folders, { path: join(layout.stateDir, path), what: path }, maxFileBytes, 'fatal');
  if (!read.ok) return read;
  if (read.value.state === 'absent') return ok(null);
  if (read.value.state === 'invalid') {
    return read.value.cause === 'link'
      ? safetyRefusal(`cannot read ${path}: ${read.value.reason}`, LINK_REMEDY)
      : failure(`cannot read ${path}: ${read.value.reason}`);
  }
  return ok(read.value.text);
};

const currentTexts = async (deps: Deps, layout: Layout, paths: readonly string[]): Promise<CliResult<BoardTexts>> => {
  const texts = new Map<string, string | null>();
  for (const path of paths) {
    const text = await currentTextOf(deps, layout, path);
    if (!text.ok) return text;
    texts.set(path, text.value);
  }
  return ok(texts);
};

/**
 * Read the files of the work tree that hold the board, with no lock. The state lock is not re-entrant, so a reader never takes it:
 * a read does not wait for a writer, and it can mix the files of two commits (a writer replaces each file whole). The paths are plain
 * paths below the state folder. A file that is not there has the text null. A link is a security stop (exit 4). A folder, a file above
 * `maxFileBytes` and a file that is not UTF-8 are failures that name the file.
 */
export const readBoardFiles = async (deps: Deps, layout: Layout, paths: readonly string[]): Promise<CliResult<BoardTexts>> => {
  const plain = requirePlainPaths(paths);
  if (!plain.ok) return plain;
  return currentTexts(deps, layout, plain.value);
};

const SIZE_REMEDY = `Move old text out of the file. "${commandText(commands.doctor)}" shows how full the board files are.`;

/**
 * Every new text is within `maxFileBytes`, counted in bytes: the reader refuses a larger file, so a write must never make one. A file
 * that the change removes has no text. The check is private: the helper is the one writer, so no caller needs it alone.
 */
const requireWithinCap = (updates: BoardTexts): CliResult<void> => {
  for (const [path, text] of updates) {
    if (text !== null && Buffer.byteLength(text, 'utf8') > maxFileBytes) {
      return failure(`cannot commit ${path}: the new text is larger than ${maxFileBytes} bytes`, SIZE_REMEDY);
    }
  }
  return ok(undefined);
};

/**
 * The files that really change: the new text differs from the text now. A path outside the touched list is a fault of the caller,
 * and nothing is written for it.
 */
const updatesOf = (now: BoardTexts, changed: BoardTexts): CliResult<BoardTexts> => {
  const updates = new Map<string, string | null>();
  for (const [path, text] of changed) {
    if (!now.has(path)) return failure(`the board change names ${JSON.stringify(path)}, which is not one of the files it may write`);
    if (text !== now.get(path)) updates.set(path, text);
  }
  return ok(updates);
};

/**
 * No item id of the board at the last commit may be missing from the new board text. A closed item keeps its id. A board that can
 * not be read, on either side, stops the change: the check fails closed. The remedy for a board at the last commit that can not be
 * read is a normal commit of a repair: the delete guard accepts a repair that keeps every item id of the last board that it can read.
 * `upgrade` calls this check itself, because it holds the state lock already and so can not call `commitBoardChange`.
 */
export const requireNoLostIds = async (
  deps: Deps,
  stateDir: string,
  hasCommit: boolean,
  newBoard: string | null,
  command: CommandName,
): Promise<CliResult<void>> => {
  const head = await boardAtHead(deps, stateDir, hasCommit);
  if (!head.ok) return head;
  const again = `then run "${commandText(command)}" again.`;
  const repair = `Repair ${BOARD}, or restore it from an older commit with "${BOARD_RESTORE_COMMAND}", commit it, ${again}`;
  if (head.value.kind === 'unreadable') {
    return failure(`cannot read ${BOARD} of the last commit: ${head.value.reason}`, repair);
  }
  const lost = lostItemIds(head.value.kind === 'text' ? head.value.text : null, newBoard);
  if (!lost.ok) {
    return lost.error.side === 'before'
      ? failure(`cannot read ${BOARD} of the last commit: ${lost.error.reason}`, repair)
      : failure(`cannot commit ${BOARD}: ${lost.error.reason}`, `Fix the change, ${again}`);
  }
  if (lost.value.length === 0) return ok(undefined);
  const many = lost.value.length > 1;
  return safetyRefusal(
    `this change removes ${many ? 'the item ids' : 'the item id'} ${namedItems(lost.value.map(shownPath))} from ${BOARD}`,
    `Mark ${many ? 'the items' : 'the item'} closed, never remove ${many ? 'them' : 'it'}, ${again}`,
  );
};

/** Write each update. A failed write stops the loop; the value names the paths that were written, so the caller puts them back. */
const writeUpdates = async (
  deps: Deps,
  layout: Layout,
  updates: BoardTexts,
  written: string[],
): Promise<CliResult<void>> => {
  for (const [path, text] of updates) {
    const file = join(layout.stateDir, path);
    const result = text === null ? await deps.fs.remove(file) : await deps.fs.writeTextAtomic(file, text, layout.stateDir);
    if (!result.ok) return result;
    written.push(path);
  }
  return ok(undefined);
};

/** The result of a put back: the reasons that a step failed, as text for the end of a message (empty when none failed), and whether every file is back. */
interface PutBack {
  readonly note: string;
  readonly complete: boolean;
}

/** The outcome of a failure with no commit: restored when every file is back, else unknown. */
const outcomeOfPutBack = (back: PutBack): CommitOutcome => (back.complete ? 'restored' : 'unknown');

/** A failure (exit 1) after the first file write. The caller reads `commitOutcome`, never the text. */
const failedAfterWrite = (message: string, commitOutcome: CommitOutcome): Err<BoardCommitError> =>
  err({ kind: 'failure', message, commitOutcome });

/**
 * Put the written files back as they were, and clear their staged changes when a commit was tried. The value holds the reasons that a
 * step failed, and whether every file is back: a file that did not go back, or a staged change that stayed, makes the put back partial.
 */
const putBack = async (
  deps: Deps,
  layout: Layout,
  written: readonly string[],
  before: BoardTexts,
  staged: RepoPaths | null,
): Promise<PutBack> => {
  const notes: string[] = [];
  for (const path of written) {
    const file = join(layout.stateDir, path);
    const previous = before.get(path) ?? null;
    const restored = previous === null ? await deps.fs.remove(file) : await deps.fs.writeTextAtomic(file, previous, layout.stateDir);
    if (!restored.ok) notes.push(restored.error.message);
  }
  if (staged !== null) {
    const unstaged = await unstagePaths(deps, layout.stateDir, staged);
    if (!unstaged.ok) notes.push(unstaged.error.message);
  }
  return { note: notes.length === 0 ? '' : `. ${notes.join('; ')}`, complete: notes.length === 0 };
};

const commitLocked = async (
  deps: Deps,
  layout: Layout,
  request: BoardChange,
  touched: readonly string[],
): Promise<BoardCommitResult> => {
  const { command, message } = request;
  const ready = await requireStateRepoCommit(deps, layout.stateDir, touched, 'the board change', command);
  if (!ready.ok) return ready;
  // The refusal for a guard that is off comes before any write, and before the change of the caller runs.
  const guarded = await requireGuardOn(deps, layout.stateDir);
  if (!guarded.ok) return guarded;
  const head = await stateHeadOf(deps, layout.stateDir);
  if (!head.ok) return head;
  const now = await currentTexts(deps, layout, touched);
  if (!now.ok) return now;

  const changed = await request.change(now.value);
  if (!changed.ok) return changed;
  const updates = updatesOf(now.value, changed.value);
  if (!updates.ok) return updates;
  if (updates.value.size === 0) return ok({ committed: false });
  const sized = requireWithinCap(updates.value);
  if (!sized.ok) return sized;
  if (updates.value.has(BOARD)) {
    const kept = await requireNoLostIds(deps, layout.stateDir, head.value !== null, updates.value.get(BOARD) ?? null, command);
    if (!kept.ok) return kept;
  }
  if (request.beforeWrite !== undefined) {
    const prepared = await request.beforeWrite(updates.value);
    if (!prepared.ok) return prepared;
  }

  const written: string[] = [];
  const wrote = await writeUpdates(deps, layout, updates.value, written);
  if (!wrote.ok) {
    const back = await putBack(deps, layout, written, now.value, null);
    // The error keeps its kind, so a refused path keeps its exit code.
    return err({ ...wrote.error, message: `${wrote.error.message}${back.note}`, commitOutcome: outcomeOfPutBack(back) });
  }

  const paths: RepoPaths = {
    present: [...updates.value].filter(([, text]) => text !== null).map(([path]) => path),
    gone: [...updates.value].filter(([, text]) => text === null).map(([path]) => path),
  };
  const committed = await commitPaths(deps, layout.stateDir, paths, message);
  if (committed.ok) return ok({ committed: true });

  // The commit may have landed although git reported an error, for example when the time limit stopped git.
  const error = committed.error.message;
  const headAfter = await stateHeadOf(deps, layout.stateDir);
  if (!headAfter.ok) {
    return failedAfterWrite(
      `${error}. ${headAfter.error.message}, so the files are not put back. ` +
        `Run "git log -1 --stat" in ${dirs.state} to see whether the commit is there.`,
      'unknown',
    );
  }
  if (headAfter.value !== head.value) {
    return failedAfterWrite(
      `${error}. The commit was made in ${dirs.state}, so the files stay changed. Run "git log -1 --stat" in ${dirs.state} to check it.`,
      'committed',
    );
  }
  const back = await putBack(deps, layout, written, now.value, paths);
  return failedAfterWrite(`${error}${back.note}`, outcomeOfPutBack(back));
};

/**
 * Change files of the state repo that hold the board, and commit them (design 4.3). One call holds the state lock once, and does these
 * steps in order:
 * 1. The state repo is ready for the commit, as for any other command that commits there.
 * 2. The delete guard is on, else the call stops with exit 4 and writes nothing. This refusal is only here: the other commands that
 *    commit to the state repo keep working in a repo whose guard is off.
 * 3. The change of the caller runs on the text of the touched files, as they are now.
 * 4. Each file that changes has a new text of at most `maxFileBytes` bytes, else the call stops with exit 1 and writes nothing.
 * 5. No item id of the board at the last commit is missing from the new board text (exit 4), and a board that can not be read stops
 *    the call (exit 1).
 * 6. The `beforeWrite` step of the caller runs, when there is one. A failure stops the call with that error and writes nothing.
 * 7. The files are written, and one commit holds exactly the files that changed.
 * A failed write or commit puts the files back and clears the staged changes. A commit that landed although git reported an error
 * stays, and the failure says so. Each failure of step 7 has a typed `commitOutcome` (`restored`, `committed` or `unknown`), so a
 * caller never reads the message text to tell them apart. The change and the step of the caller run inside the lock, which is not
 * re-entrant, so they call no step that takes the lock.
 */
export const commitBoardChange = async (deps: Deps, layout: Layout, request: BoardChange): Promise<BoardCommitResult> => {
  const touched = requirePlainPaths(request.touched);
  if (!touched.ok) return touched;
  return withStateLock(deps, layout, () => commitLocked(deps, layout, request, touched.value));
};
