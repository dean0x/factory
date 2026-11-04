import { dirname, isAbsolute, join, resolve } from 'node:path';
import { safetyRefusal, type CliResult } from '../cli/errors.js';
import { commands, commandText, dirs, env, places, privateFile, program } from '../names.js';
import type { Deps, PathInfo } from './deps.js';
import { isWrittenInside } from './paths.js';
import { err, ok, type Result } from './result.js';

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

/** True when a lock or a claim file is older than `privateFile.lockStaleMs`: a process that ended left it. */
const isStale = (deps: Deps, info: PathInfo): boolean => deps.now().getTime() - info.mtimeMs > privateFile.lockStaleMs;

/**
 * Remove the lock only when it is still the stale lock that the caller saw. The caller holds the claim file, so no other
 * waiter removes the lock now. A lock that a waiter took over in the meantime stays. The value is true when the lock is
 * gone.
 */
const removeSeenLock = async (deps: Deps, lockPath: string, seen: PathInfo): Promise<Result<boolean, string>> => {
  const current = await deps.fs.statInfo(lockPath);
  if (!current.ok) return err(current.error.message);
  if (current.value === null) return ok(true);
  if (current.value.mtimeMs !== seen.mtimeMs) return ok(false);
  const removed = await deps.fs.remove(lockPath);
  return removed.ok ? ok(true) : err(removed.error.message);
};

/**
 * Another waiter holds the claim file: the caller waits. A claim that is stale is removed, because the process that made
 * it ended. The value is always false: the caller tries again after the wait.
 */
const dropStaleClaim = async (deps: Deps, claimPath: string): Promise<Result<boolean, string>> => {
  const claim = await deps.fs.statInfo(claimPath);
  if (!claim.ok) return err(claim.error.message);
  if (claim.value === null || !isStale(deps, claim.value)) return ok(false);
  const removed = await deps.fs.remove(claimPath);
  return removed.ok ? ok(false) : err(removed.error.message);
};

/**
 * Remove a lock that is older than `privateFile.lockStaleMs`: a process that ended left it. Only the waiter that holds
 * the claim file beside the lock removes it, and only the stale lock that it saw, so a second waiter never removes the
 * new lock of the first. The value is true when the lock is gone and the caller may try to take it at once.
 */
const dropStaleLock = async (deps: Deps, lockPath: string): Promise<Result<boolean, string>> => {
  const seen = await deps.fs.statInfo(lockPath);
  if (!seen.ok) return err(seen.error.message);
  if (seen.value === null) return ok(true);
  if (!isStale(deps, seen.value)) return ok(false);

  const claimPath = `${lockPath}${privateFile.takeoverSuffix}`;
  const claimed = await deps.fs.writeTextExclusive(claimPath, `${deps.pid}\n`, privateFile.fileMode);
  if (!claimed.ok) return err(claimed.error.message);
  if (!claimed.value) return dropStaleClaim(deps, claimPath);

  const dropped = await removeSeenLock(deps, lockPath, seen.value);
  const claimGone = await deps.fs.remove(claimPath);
  if (!dropped.ok) return dropped;
  return claimGone.ok ? dropped : err(claimGone.error.message);
};

/**
 * Take the lock file beside the file. The lock file is new, so only one process holds it. The call tries
 * `privateFile.lockAttempts` times and waits `privateFile.lockWaitMs` between two tries. A stale lock is taken over.
 */
const takeLock = async (deps: Deps, lockPath: string): Promise<Result<void, string>> => {
  for (let attempt = 1; attempt <= privateFile.lockAttempts; attempt += 1) {
    const created = await deps.fs.writeTextExclusive(lockPath, `${deps.pid}\n`, privateFile.fileMode);
    if (!created.ok) return err(created.error.message);
    if (created.value) return ok(undefined);
    const dropped = await dropStaleLock(deps, lockPath);
    if (!dropped.ok) return dropped;
    if (!dropped.value && attempt < privateFile.lockAttempts) await deps.sleep(privateFile.lockWaitMs);
  }
  return err(`another ${program} command holds the lock ${lockPath}. Wait until that command ends, or remove that file when no such command runs.`);
};

/** What a change of a per-user file reads and gives: the current text, or null for a file that does not exist. */
export type PrivateChange = (current: string | null) => Promise<Result<string, string>>;

/**
 * Change a per-user file. The call makes the folder ready, takes the lock file beside the file, reads the current text,
 * asks `change` for the new text and writes it atomically with mode 0600. A lock file lets only one process read, change
 * and write at a time, so two runs at once lose no change. A file that cannot be read stays as it is. The lock is taken
 * over once it is older than `privateFile.lockStaleMs`. The error is the reason. When the change is saved and the lock
 * file cannot be removed, the error says so and names the lock file.
 */
export const changePrivateFile = async (
  deps: Deps,
  path: string,
  maxBytes: number,
  change: PrivateChange,
): Promise<Result<void, string>> => {
  const folder = await prepareFolder(deps, path);
  if (!folder.ok) return folder;
  const lockPath = `${path}${privateFile.lockSuffix}`;
  const locked = await takeLock(deps, lockPath);
  if (!locked.ok) return locked;

  const current = await readPrivateText(deps, path, maxBytes);
  const next = current.ok ? await change(current.value) : err(`${path} cannot be read: ${current.error}`);
  const written = next.ok ? await deps.fs.writeTextAtomic(path, next.value, dirname(path), privateFile.fileMode) : null;
  const lockGone = await deps.fs.remove(lockPath);
  if (!next.ok) return next;
  if (written?.ok === false) return err(written.error.message);
  return lockGone.ok
    ? ok(undefined)
    : err(`the change is saved, but ${program} cannot remove the lock file ${lockPath}: ${lockGone.error.message}. Remove that file.`);
};
