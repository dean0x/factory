import { basename, join } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { commands, commandText, places } from '../names.js';
import type { Deps } from './deps.js';
import { takeLock, type LockPolicy } from './file-lock.js';
import { comparable, isSameOrInside, realPathOf } from './paths.js';
import { ok } from './result.js';

/**
 * A write into one folder that refuses links. It does not use `writeTextAtomic`: that call follows a link in the folder
 * of the file, and a caller of this file must know that the folder is a real folder in the place it expects.
 */

/** The file, the folder that holds it, and the folder that the real path of that folder must be inside. */
export interface FolderTarget {
  /** The folder that the caller expects above `folder`. The real path of `folder` must be inside the real path of it. */
  readonly parent: string;
  /** The folder of the file. A write creates it when it does not exist. */
  readonly folder: string;
  /** The name of the file: one plain name, with no separator. */
  readonly name: string;
  /** The permission bits of the new file. */
  readonly mode: number;
  /** The permission bits of the folder, when this call creates it. */
  readonly folderMode?: number;
}

/** The temporary file has the name of the file, this text, the pid and a number. */
const TEMPORARY_MARK = '.tmp-';

/** A write tries this many temporary names. Each name is new, so a name that exists was left by another writer. */
const MAX_TEMPORARY_NAMES = 8;

const CHECK_STEP = `Then run "${commandText(commands.doctor)}" to check the ${places.folder}.`;
const LINK_REMEDY = `Replace the link with a real folder or file. ${CHECK_STEP}`;
const OUTSIDE_REMEDY = `Use a real folder in the expected place. ${CHECK_STEP}`;

const isPlainName = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && basename(name) === name;

const notPlainName = (target: FolderTarget): CliResult<never> =>
  failure(`cannot write ${target.folder}: ${JSON.stringify(target.name)} is not a plain name`);

/** A link as the last part of a path is a security stop. The caller names what the path is. */
const requireNoLink = async (deps: Deps, path: string, what: string): Promise<CliResult<void>> => {
  const kind = await deps.fs.lstat(path);
  if (!kind.ok) return kind;
  return kind.value === 'link' ? safetyRefusal(`cannot write ${path}: ${what} is a link`, LINK_REMEDY) : ok(undefined);
};

/** The real folder of the target, made when it does not exist. The real path is inside the real path of the parent. */
const realFolderOf = async (deps: Deps, target: FolderTarget): Promise<CliResult<string>> => {
  const parent = await requireNoLink(deps, target.parent, 'the parent folder');
  if (!parent.ok) return parent;
  const kind = await deps.fs.lstat(target.folder);
  if (!kind.ok) return kind;
  if (kind.value === 'link') return safetyRefusal(`cannot write ${target.folder}: it is a link`, LINK_REMEDY);
  if (kind.value !== null && kind.value !== 'dir') return failure(`cannot write in ${target.folder}: it is not a folder`);
  if (kind.value === null) {
    const made = await deps.fs.mkdir(target.folder, target.folderMode);
    if (!made.ok) return made;
    // A link can take the place of the new folder before the next check.
    const again = await requireNoLink(deps, target.folder, 'the folder');
    if (!again.ok) return again;
  }
  const [realParent, realFolder] = [await realPathOf(deps, target.parent), await realPathOf(deps, target.folder)];
  if (!realParent.ok) return realParent;
  if (!realFolder.ok) return realFolder;
  const [outer, inner] = [comparable(deps, realParent.value), comparable(deps, realFolder.value)];
  if (outer === inner || !isSameOrInside(outer, inner)) {
    return safetyRefusal(`cannot write in ${target.folder}: its real path is outside ${target.parent}`, OUTSIDE_REMEDY);
  }
  return ok(realFolder.value);
};

/**
 * Write the text to a new temporary file in the folder, then rename it over the file. The folder and the file are never
 * links, and the real folder is inside the expected parent. A reader sees the old text or the new text, never a part. The
 * temporary file is created with a name that must not exist, so a link is never followed. A refusal of a link or of a
 * folder outside the parent is a security stop (exit 4). Any other fault is a failure (exit 1). A failure leaves the file as
 * it was and removes the temporary file.
 */
export const writeInFolder = async (deps: Deps, target: FolderTarget, text: string): Promise<CliResult<void>> => {
  if (!isPlainName(target.name)) return notPlainName(target);
  const folder = await realFolderOf(deps, target);
  if (!folder.ok) return folder;
  const file = join(folder.value, target.name);
  const found = await deps.fs.lstat(file);
  if (!found.ok) return found;
  if (found.value === 'link') return safetyRefusal(`cannot write ${file}: it is a link`, LINK_REMEDY);
  if (found.value !== null && found.value !== 'file') return failure(`cannot write ${file}: it is not a file`);
  for (let attempt = 0; attempt < MAX_TEMPORARY_NAMES; attempt += 1) {
    const temporary = join(folder.value, `${target.name}${TEMPORARY_MARK}${deps.pid}-${attempt}`);
    const created = await deps.fs.writeTextExclusive(temporary, text, target.mode);
    if (!created.ok) return created;
    if (!created.value) continue;
    const renamed = await deps.fs.rename(temporary, file);
    if (renamed.ok) return renamed;
    await deps.fs.remove(temporary);
    return renamed;
  }
  return failure(`cannot write ${file}: no free temporary name`);
};

/** The bounds of a lock beside a file, and the end of its name: the lock file is the name of the file and the suffix. */
export interface FolderLock extends LockPolicy {
  readonly suffix: string;
}

/**
 * Run `work` while this call holds a lock file beside the file of the target. The folder is checked and made as for
 * `writeInFolder`, and the lock file is made in that real folder. A lock path that is a link is a security stop (exit 4),
 * and the link is not followed. The call waits within the bounds of the lock only. When the lock stays with another process
 * for all tries, `work` does not run and the value is a failure (exit 1). The lock file is removed when `work` ends, also
 * after a throw. A lock file that stays because of a failed removal is taken over when it is older than the stale age.
 */
export const withFolderLock = async <T>(
  deps: Deps,
  target: FolderTarget,
  lock: FolderLock,
  work: () => Promise<CliResult<T>>,
): Promise<CliResult<T>> => {
  if (!isPlainName(target.name)) return notPlainName(target);
  const folder = await realFolderOf(deps, target);
  if (!folder.ok) return folder;
  const lockPath = join(folder.value, `${target.name}${lock.suffix}`);
  const taken = await takeLock(deps, lockPath, lock);
  if (!taken.ok) return failure(taken.error);
  if (taken.value === 'link') return safetyRefusal(`cannot write ${lockPath}: it is a link`, LINK_REMEDY);
  if (taken.value === 'held') {
    return failure(`cannot write ${join(folder.value, target.name)}: another process holds the lock ${lockPath}`);
  }
  try {
    return await work();
  } finally {
    await deps.fs.remove(lockPath);
  }
};
