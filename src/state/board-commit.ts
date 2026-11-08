import { isAbsolute, join, normalize } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import {
  blobTextOf,
  commitPaths,
  GIT_ENTRY,
  headEntriesAt,
  headOf,
  isFileMode,
  requireStateRepoCommit,
  unstagePaths,
  type RepoPaths,
} from '../core/git.js';
import { err, ok } from '../core/result.js';
import { namedItems, shownPath } from '../core/root-paths.js';
import { commandText, dirs, files, maxFileBytes, type CommandName } from '../names.js';
import { readCheckedFile, type NamedPath } from '../workers/registry.js';
import { requireGuardOn } from './guard.js';
import { lostItemIds } from './item-ids.js';
import type { Layout } from './layout.js';
import { withStateLock } from './state-lock.js';

/**
 * The board commit helper: the one way that a command changes files of the state repo that hold the board. It checks that the delete
 * guard is on, runs the change of the caller on the text that it commits, checks in the process that no item id is lost, writes the
 * files and makes exactly one commit of them. The caller does not write or commit these files by itself.
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
}

export interface BoardCommit {
  /** True when the helper made a commit. False when the change left every file as it was. */
  readonly committed: boolean;
}

const BOARD = files.board;

/** A path in the change is a plain path below the state folder: no folder above it, no empty or dotted part, and not the git folder. */
const isPlainPath = (path: string): boolean => {
  const parts = path.split('/');
  return (
    path !== '' &&
    !isAbsolute(path) &&
    normalize(path) === path &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..') &&
    parts[0] !== GIT_ENTRY
  );
};

const requirePlainPaths = (paths: readonly string[]): CliResult<readonly string[]> => {
  if (paths.length === 0) return failure('a board change names no file');
  const bad = paths.find((path) => !isPlainPath(path));
  if (bad !== undefined) return failure(`a board change names ${JSON.stringify(bad)}, which is not a plain path below ${dirs.state}`);
  return ok([...new Set(paths)]);
};

/** The text of one touched file as it is on disk, or null when the file is not there. A link, a folder and a large file are failures. */
const currentTextOf = async (deps: Deps, layout: Layout, path: string): Promise<CliResult<string | null>> => {
  const parts = path.split('/');
  const folders: NamedPath[] = [{ path: layout.stateDir, what: dirs.state }];
  for (let at = 1; at < parts.length; at += 1) {
    const folder = parts.slice(0, at).join('/');
    folders.push({ path: join(layout.stateDir, folder), what: folder });
  }
  const read = await readCheckedFile(deps, folders, { path: join(layout.stateDir, path), what: path }, maxFileBytes);
  if (!read.ok) return read;
  if (read.value.state === 'absent') return ok(null);
  if (read.value.state === 'invalid') return failure(`cannot read ${path}: ${read.value.reason}`);
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

/** The text of the board at the last commit, or null when the repo has no commit or the last commit holds no board. */
const headBoardText = async (deps: Deps, stateDir: string, hasCommit: boolean): Promise<CliResult<string | null>> => {
  if (!hasCommit) return ok(null);
  const listed = await headEntriesAt(deps, stateDir, BOARD);
  if (!listed.ok) return listed;
  const [entry, ...more] = listed.value;
  if (entry === undefined) return ok(null);
  const unreadable = (reason: string): CliResult<never> => failure(`cannot read ${BOARD} of the last commit: ${reason}`);
  if (more.length > 0) return unreadable('git listed more than one entry');
  if (entry.kind !== 'blob' || !isFileMode(entry.mode)) return unreadable('it is not a plain file');
  if (entry.size === null || entry.size > maxFileBytes) return unreadable(`it is larger than ${maxFileBytes} bytes`);
  return blobTextOf(deps, stateDir, entry.id);
};

/**
 * No item id of the board at the last commit may be missing from the new board text. A closed item keeps its id. A board that can
 * not be read, on either side, stops the change: the check fails closed.
 */
const requireNoLostIds = async (
  deps: Deps,
  stateDir: string,
  hasCommit: boolean,
  newBoard: string | null,
  command: CommandName,
): Promise<CliResult<void>> => {
  const before = await headBoardText(deps, stateDir, hasCommit);
  if (!before.ok) return before;
  const lost = lostItemIds(before.value, newBoard);
  const again = `then run "${commandText(command)}" again.`;
  if (!lost.ok) {
    return lost.error.side === 'before'
      ? failure(
          `cannot read ${BOARD} of the last commit: ${lost.error.reason}`,
          `Repair ${BOARD}, then commit the repair with "git commit --no-verify". Then run "${commandText(command)}" again.`,
        )
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

/**
 * Put the written files back as they were, and clear their staged changes when a commit was tried. The value is the reasons that a
 * step failed, as text for the end of a message, or an empty text.
 */
const putBack = async (
  deps: Deps,
  layout: Layout,
  written: readonly string[],
  before: BoardTexts,
  staged: RepoPaths | null,
): Promise<string> => {
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
  return notes.length === 0 ? '' : `. ${notes.join('; ')}`;
};

const commitLocked = async (
  deps: Deps,
  layout: Layout,
  request: BoardChange,
  touched: readonly string[],
): Promise<CliResult<BoardCommit>> => {
  const { command, message } = request;
  const ready = await requireStateRepoCommit(deps, layout.stateDir, touched, 'the board change', command);
  if (!ready.ok) return ready;
  // The refusal for a guard that is off comes before any write, and before the change of the caller runs.
  const guarded = await requireGuardOn(deps, layout.stateDir);
  if (!guarded.ok) return guarded;
  const head = await headOf(deps, layout.stateDir);
  if (!head.ok) return head;
  const now = await currentTexts(deps, layout, touched);
  if (!now.ok) return now;

  const changed = await request.change(now.value);
  if (!changed.ok) return changed;
  const updates = updatesOf(now.value, changed.value);
  if (!updates.ok) return updates;
  if (updates.value.size === 0) return ok({ committed: false });
  if (updates.value.has(BOARD)) {
    const kept = await requireNoLostIds(deps, layout.stateDir, head.value !== null, updates.value.get(BOARD) ?? null, command);
    if (!kept.ok) return kept;
  }

  const written: string[] = [];
  const wrote = await writeUpdates(deps, layout, updates.value, written);
  if (!wrote.ok) {
    // The error keeps its kind, so a refused path keeps its exit code.
    return err({ ...wrote.error, message: `${wrote.error.message}${await putBack(deps, layout, written, now.value, null)}` });
  }

  const paths: RepoPaths = {
    present: [...updates.value].filter(([, text]) => text !== null).map(([path]) => path),
    gone: [...updates.value].filter(([, text]) => text === null).map(([path]) => path),
  };
  const committed = await commitPaths(deps, layout.stateDir, paths, message);
  if (committed.ok) return ok({ committed: true });

  // The commit may have landed although git reported an error, for example when the time limit stopped git.
  const error = committed.error.message;
  const headAfter = await headOf(deps, layout.stateDir);
  if (!headAfter.ok) {
    return failure(
      `${error}. ${headAfter.error.message}, so the files are not put back. ` +
        `Run "git log -1 --stat" in ${dirs.state} to see whether the commit is there.`,
    );
  }
  if (headAfter.value !== head.value) {
    return failure(
      `${error}. The commit was made in ${dirs.state}, so the files stay changed. Run "git log -1 --stat" in ${dirs.state} to check it.`,
    );
  }
  return failure(`${error}${await putBack(deps, layout, written, now.value, paths)}`);
};

/**
 * Change files of the state repo that hold the board, and commit them (design 4.3). One call holds the state lock once, and does these
 * steps in order:
 * 1. The state repo is ready for the commit, as for any other command that commits there.
 * 2. The delete guard is on, else the call stops with exit 4 and writes nothing. This refusal is only here: the other commands that
 *    commit to the state repo keep working in a repo whose guard is off.
 * 3. The change of the caller runs on the text of the touched files, as they are now.
 * 4. No item id of the board at the last commit is missing from the new board text (exit 4), and a board that can not be read stops
 *    the call (exit 1).
 * 5. The files are written, and one commit holds exactly the files that changed.
 * A failed write or commit puts the files back and clears the staged changes. A commit that landed although git reported an error
 * stays, and the failure says so. The change of the caller runs inside the lock, which is not re-entrant, so it calls no step that
 * takes the lock.
 */
export const commitBoardChange = async (deps: Deps, layout: Layout, request: BoardChange): Promise<CliResult<BoardCommit>> => {
  const touched = requirePlainPaths(request.touched);
  if (!touched.ok) return touched;
  return withStateLock(deps, layout, () => commitLocked(deps, layout, request, touched.value));
};
