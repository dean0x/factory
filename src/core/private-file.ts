import { dirname, isAbsolute, join, resolve } from 'node:path';
import { safetyRefusal, type CliResult } from '../cli/errors.js';
import { commands, commandText, dirs, env, places, privateFile, program } from '../names.js';
import type { Deps, PathInfo } from './deps.js';
import { freeLock, holdsLock, takeLock, type LockPolicy } from './file-lock.js';
import { isWrittenInside } from './paths.js';
import { err, ok, type Err, type Result } from './result.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** The remedy line of a store file of the user that would lie inside the factory folder. */
export const STORE_INSIDE_FOLDER_REMEDY = `Set the state folder to a folder outside the ${places.folder}, then run "${commandText(commands.init)}" again.`;

/** The value of an environment variable when it is an absolute path, else undefined. */
const absoluteEnv = (environment: Environment, name: string): string | undefined => {
  const value = environment[name];
  return value !== undefined && value !== '' && isAbsolute(value) ? resolve(value) : undefined;
};

/**
 * The place of a per-user file: below the state home when that variable holds an absolute path, else below `.local/state`
 * of the user home. It is null when neither variable names a folder. A path inside the folder of Claude Code is refused.
 * The two paths are compared as they are written, and no call of the file system is made: nothing asks about the folder
 * of Claude Code, and a link into it is not detected. On macOS the comparison ignores the case of letters.
 */
export const userStatePathOf = async (deps: Deps, fileName: string): Promise<CliResult<string | null>> => {
  const userHome = absoluteEnv(deps.env, env.userHome);
  const stateHome =
    absoluteEnv(deps.env, env.stateHome) ??
    (userHome === undefined ? undefined : join(userHome, ...privateFile.defaultStateHome));
  if (stateHome === undefined) return ok(null);

  const path = join(stateHome, program, fileName);
  if (userHome === undefined) return ok(path);
  const claudeDir = join(userHome, dirs.claude);
  if (isWrittenInside(deps, claudeDir, path)) {
    return safetyRefusal(
      `the file would be ${path}, inside ${claudeDir}`,
      `Claude Code owns that folder. Set ${env.stateHome} to another absolute folder, then run "${commandText(commands.doctor)}".`,
    );
  }
  return ok(path);
};

/**
 * What the path is, or null when it does not exist. The path must belong to this user, and no group or other user may
 * write it, because the files decide which home a command uses and which approvals count. A platform with no user ids is
 * not checked.
 */
const ownInfo = async (deps: Deps, path: string, what: string): Promise<Result<PathInfo | null, string>> => {
  const info = await deps.fs.statInfo(path);
  if (!info.ok) return err(info.error.message);
  if (info.value === null || deps.uid === null) return ok(info.value);
  if (info.value.uid !== deps.uid) return err(`the ${what} ${path} belongs to another user`);
  if ((info.value.mode & privateFile.groupOtherWrite) !== 0) {
    return err(`the ${what} ${path} can be written by a group or by other users`);
  }
  return ok(info.value);
};

/**
 * The text of a per-user file, or null when the file does not exist. A file or a folder that another user owns or can
 * write is refused, and so is a file over `maxBytes`. The error is the reason.
 */
export const readPrivateText = async (deps: Deps, path: string, maxBytes: number): Promise<Result<string | null, string>> => {
  const folder = await ownInfo(deps, dirname(path), 'folder');
  if (!folder.ok) return folder;
  const file = await ownInfo(deps, path, 'file');
  if (!file.ok) return file;
  if (file.value === null) return ok(null);
  if (file.value.kind !== 'file') return err('it is not a file');
  const text = await deps.fs.readTextLimited(path, maxBytes);
  return text.ok ? ok(text.value) : err(text.error.message);
};

/**
 * Make the folder of the file ready: a folder that another user owns or can write is refused, and the folder gets
 * mode 0700, also when it exists. The folder of the state home keeps its mode.
 */
const prepareFolder = async (deps: Deps, path: string): Promise<Result<void, string>> => {
  const folderPath = dirname(path);
  const own = await ownInfo(deps, folderPath, 'folder');
  if (!own.ok) return err(`${path} cannot be used: ${own.error}`);
  const made = await deps.fs.mkdir(folderPath, privateFile.folderMode);
  if (!made.ok) return err(made.error.message);
  const tightened = await deps.fs.chmod(folderPath, privateFile.folderMode);
  return tightened.ok ? ok(undefined) : err(tightened.error.message);
};

/** The bounds of the lock file beside a per-user file. */
const userFileLock: LockPolicy = {
  attempts: privateFile.lockAttempts,
  waitMs: privateFile.lockWaitMs,
  staleMs: privateFile.lockStaleMs,
  takeoverSuffix: privateFile.takeoverSuffix,
  mode: privateFile.fileMode,
};

/**
 * Take the lock file beside the file. The lock file is new, so only one process holds it. A stale lock is taken over. The
 * value is the token that frees the lock. The error is the reason that the lock is not taken.
 */
const takeUserFileLock = async (deps: Deps, lockPath: string): Promise<Result<string, string>> => {
  const taken = await takeLock(deps, lockPath, userFileLock);
  if (!taken.ok) return taken;
  if (taken.value.kind === 'link') return err(`the lock ${lockPath} is a link. Remove that file.`);
  if (taken.value.kind === 'held') {
    return err(`another ${program} command holds the lock ${lockPath}. Wait until that command ends, or remove that file when no such command runs.`);
  }
  return ok(taken.value.token);
};

/** What a change of a per-user file reads and gives: the current text, or null for a file that does not exist. */
export type PrivateChange = (current: string | null) => Promise<Result<string, string>>;

/**
 * What a failed change left in the file. `saved-lock-left` is a change that is saved, where only the lock file stays. In every
 * other failure the file is as it was before the call (`not-saved`). A caller reads this field, never the text of the message.
 */
export type WriteState = 'saved-lock-left' | 'not-saved';

/** The error of a change of a per-user file: the reason, and what the failure left in the file. */
export interface PrivateChangeError {
  readonly message: string;
  readonly writeState: WriteState;
}

export interface PrivateChangeOptions {
  /**
   * Check, just before the rename, that the lock file still holds the token of this call. A lock that another process took
   * over writes nothing. The check makes the window of a stale lock smaller, and does not close it: a pause between the check
   * and the rename is still possible.
   */
  readonly recheckLock?: boolean;
}

const notSaved = (message: string): Err<PrivateChangeError> => err({ message, writeState: 'not-saved' });

/** The atomic write of the new text. With `recheckLock`, a lock that this call no longer holds, or that cannot be checked, writes nothing. */
const writeUnderLock = async (
  deps: Deps,
  path: string,
  held: { readonly lockPath: string; readonly token: string },
  text: string,
  options: PrivateChangeOptions,
): Promise<Result<void, string>> => {
  if (options.recheckLock === true) {
    const holds = await holdsLock(deps, held.lockPath, held.token);
    if (!holds.ok) return err(`the lock ${held.lockPath} cannot be checked, so nothing was written: ${holds.error}`);
    if (!holds.value) {
      return err(`another ${program} command took the lock ${held.lockPath} over, so nothing was written. Run the command again.`);
    }
  }
  const written = await deps.fs.writeTextAtomic(path, text, dirname(path), privateFile.fileMode);
  return written.ok ? ok(undefined) : err(written.error.message);
};

/**
 * Change a per-user file. The call makes the folder ready, takes the lock file beside the file, reads the current text,
 * asks `change` for the new text and writes it atomically with mode 0600. A lock file lets only one process read, change
 * and write at a time, so two runs at once lose no change. A file that cannot be read stays as it is. The lock is taken
 * over once it is older than `privateFile.lockStaleMs`. The error holds the reason and `writeState`. When the change is saved and
 * the lock file cannot be removed, the state is `saved-lock-left` and the message names the lock file.
 */
export const changePrivateFile = async (
  deps: Deps,
  path: string,
  maxBytes: number,
  change: PrivateChange,
  options: PrivateChangeOptions = {},
): Promise<Result<void, PrivateChangeError>> => {
  const folder = await prepareFolder(deps, path);
  if (!folder.ok) return notSaved(folder.error);
  const lockPath = `${path}${privateFile.lockSuffix}`;
  const locked = await takeUserFileLock(deps, lockPath);
  if (!locked.ok) return notSaved(locked.error);

  const current = await readPrivateText(deps, path, maxBytes);
  const next = current.ok ? await change(current.value) : err(`${path} cannot be read: ${current.error}`);
  const written = next.ok ? await writeUnderLock(deps, path, { lockPath, token: locked.value }, next.value, options) : null;
  const lockGone = await freeLock(deps, lockPath, locked.value);
  if (!next.ok) return notSaved(next.error);
  if (written?.ok === false) return notSaved(written.error);
  return lockGone.ok
    ? ok(undefined)
    : err({
        message: `the change is saved, but ${program} cannot remove the lock file ${lockPath}: ${lockGone.error}. Remove that file.`,
        writeState: 'saved-lock-left',
      });
};
