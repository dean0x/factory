import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { withFolderLock } from '../core/safe-write.js';
import { stateLock } from '../names.js';
import type { Layout } from './layout.js';

/**
 * Run `work` while this call holds the lock of the state repo: the lock file in the locks folder of the state folder. Every step that
 * changes files of the state repo and commits them runs inside this lock, from the ready check of the repo to the commit, so a second
 * writer never takes the change of the first or loses its own. The second writer waits within the bounds of `stateLock` only; then
 * `work` does not run and the value is a failure (exit 1) that names the lock file. A locks folder or a lock file that is a link is a
 * stop (exit 4). The lock file is removed when `work` ends.
 *
 * The lock is not re-entrant: a call of `withStateLock` inside `work` waits for the lock that its own caller holds, and then fails.
 * So the caller that holds the lock calls no other step that takes it.
 */
export const withStateLock = <T>(deps: Deps, layout: Layout, work: () => Promise<CliResult<T>>): Promise<CliResult<T>> =>
  withFolderLock(
    deps,
    {
      parent: layout.stateDir,
      folder: layout.locksDir,
      name: stateLock.name,
      mode: stateLock.fileMode,
      folderMode: stateLock.folderMode,
    },
    stateLock.lock,
    work,
  );
