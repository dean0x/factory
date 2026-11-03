import { dirname, isAbsolute, join, resolve } from 'node:path';
import { safetyRefusal, type CliResult } from '../cli/errors.js';
import { dirs, env, privateFile, program } from '../names.js';
import type { Deps, PathInfo } from './deps.js';
import { isSameOrInsideFolder } from './paths.js';
import { err, ok, type Result } from './result.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** The value of an environment variable when it is an absolute path, else undefined. */
const absoluteEnv = (environment: Environment, name: string): string | undefined => {
  const value = environment[name];
  return value !== undefined && value !== '' && isAbsolute(value) ? resolve(value) : undefined;
};

/**
 * The place of a per-user file: below the state home when that variable holds an absolute path, else below `.local/state`
 * of the user home. It is null when neither variable names a folder. A path inside the folder of Claude Code is refused.
 * The two paths are compared as they are written, and again with their links resolved. On macOS the comparison ignores
 * the case of letters. A link that cannot be resolved is an error.
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
  const inside = await isSameOrInsideFolder(deps, claudeDir, path);
  if (!inside.ok) return inside;
  if (inside.value) {
    return safetyRefusal(
      `the file would be ${path}, inside ${claudeDir}`,
      `Claude Code owns that folder. Set ${env.stateHome} to another absolute folder.`,
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

/**
 * Remove a lock that is older than `privateFile.lockStaleMs`: a process that ended left it. The value is true when
 * the lock is gone and the caller may try to take it at once.
 */
const dropStaleLock = async (deps: Deps, lockPath: string): Promise<Result<boolean, string>> => {
  const info = await deps.fs.statInfo(lockPath);
  if (!info.ok) return err(info.error.message);
  if (info.value === null) return ok(true);
  if (deps.now().getTime() - info.value.mtimeMs <= privateFile.lockStaleMs) return ok(false);
  const removed = await deps.fs.remove(lockPath);
  return removed.ok ? ok(true) : err(removed.error.message);
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
  return err(`another ${program} command holds the lock ${lockPath}. Run the command again, or remove that file when no such command runs.`);
};

/** What a change of a per-user file reads and gives: the current text, or null for a file that does not exist. */
export type PrivateChange = (current: string | null) => Promise<Result<string, string>>;

/**
 * Change a per-user file. The call makes the folder ready, takes the lock file beside the file, reads the current text,
 * asks `change` for the new text and writes it atomically with mode 0600. A lock file lets only one process read, change
 * and write at a time, so two runs at once lose no change. A file that cannot be read stays as it is. The lock is taken
 * over once it is older than `privateFile.lockStaleMs`. The error is the reason.
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
  const written = next.ok ? await deps.fs.writeTextAtomic(path, next.value, privateFile.fileMode) : null;
  await deps.fs.remove(lockPath);
  if (!next.ok) return next;
  return written?.ok === false ? err(written.error.message) : ok(undefined);
};
