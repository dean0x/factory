import { join } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { commonDirOf } from '../core/git.js';
import { ok } from '../core/result.js';
import { LINK_REMEDY, withFolderLock, writeInFolder, type FolderTarget } from '../core/safe-write.js';
import { cloneExclude } from '../names.js';

/**
 * The exclude entry of a project clone (design 4.6). The settings file of a work copy is a file that the project does not
 * track, and `worker new` writes it. The entry in the exclude file of the clone hides it from git, so a work copy that holds
 * only that file counts as clean and `dismiss` can count the work as pushed. The file is shared by every work copy of the
 * clone, and it is not part of any commit.
 */

export type ExcludeOutcome = 'added' | 'present';

/** The text of the exclude file and its permission bits. A file that does not exist has no text and no bits. */
interface Current {
  readonly text: string;
  readonly mode: number | null;
}

/** True when a line of the text is the entry. A line end of Windows and blanks at the end of a line do not count. */
const hasEntry = (text: string): boolean => text.split('\n').some((line) => line.trimEnd() === cloneExclude.entry);

/**
 * Read the exclude file. The folder of the file and the file must not be links: nothing is read or written through a link.
 * A file that does not exist is an empty text.
 */
const readCurrent = async (deps: Deps, folder: string, file: string): Promise<CliResult<Current>> => {
  const folderKind = await deps.fs.lstat(folder);
  if (!folderKind.ok) return folderKind;
  if (folderKind.value === 'link') return safetyRefusal(`cannot use ${folder}: it is a link`, LINK_REMEDY);
  const kind = await deps.fs.lstat(file);
  if (!kind.ok) return kind;
  if (kind.value === null) return ok({ text: '', mode: null });
  if (kind.value === 'link') return safetyRefusal(`cannot use ${file}: it is a link`, LINK_REMEDY);
  if (kind.value !== 'file') return failure(`cannot use ${file}: it is not a file`);
  const info = await deps.fs.statInfo(file);
  if (!info.ok) return info;
  const text = await deps.fs.readTextLimited(file, cloneExclude.maxBytes);
  return text.ok ? ok({ text: text.value, mode: info.value?.mode ?? null }) : text;
};

/**
 * Make sure the exclude file of the clone has the entry. Every line that the file has stays, and the entry goes at the end,
 * once. A file that has the entry is not written. The write holds a lock file beside the file, and it reads the file again
 * under the lock, so two commands that run at the same time do not lose a write. A link at the folder or the file is a
 * security stop (exit 4). The value says whether the call added the entry.
 */
export const ensureCloneExclude = async (deps: Deps, clone: string): Promise<CliResult<ExcludeOutcome>> => {
  const common = await commonDirOf(deps, clone);
  if (common === null) return failure(`cannot find the git folder of ${clone}`);
  const folder = join(common, cloneExclude.folder);
  const file = join(folder, cloneExclude.file);
  const seen = await readCurrent(deps, folder, file);
  if (!seen.ok) return seen;
  if (hasEntry(seen.value.text)) return ok('present');
  const target: FolderTarget = {
    parent: common,
    folder,
    name: cloneExclude.file,
    mode: cloneExclude.fileMode,
    folderMode: cloneExclude.folderMode,
  };
  return withFolderLock(deps, target, cloneExclude.lock, async (): Promise<CliResult<ExcludeOutcome>> => {
    const current = await readCurrent(deps, folder, file);
    if (!current.ok) return current;
    if (hasEntry(current.value.text)) return ok('present');
    const { text } = current.value;
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    const written = await writeInFolder(
      deps,
      { ...target, mode: current.value.mode ?? cloneExclude.fileMode },
      `${text}${separator}${cloneExclude.entry}\n`,
    );
    return written.ok ? ok('added') : written;
  });
};
