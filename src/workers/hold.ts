import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { isSlug } from '../config/primitives.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { LINK_REMEDY, writeInFolder } from '../core/safe-write.js';
import { files, roles, workerHold, workerRecord } from '../names.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { readWorkerFile } from './registry.js';

/**
 * The hold word of a worker (design 4.11): `parked` or `on-hold` in the file `hold-word` of the folder of the worker, or `none` with no
 * file. Only `worker mark` writes the file. The rows of `worker list --json` and `status --json` read it. A hold word is no approval:
 * no check of factory reads it.
 */

export type HoldWord = (typeof workerHold.words)[keyof typeof workerHold.words];
/** The hold of a worker: a hold word, or `none`. */
export type Hold = HoldWord | typeof workerHold.none;

/** The words that `worker mark` takes, in this order: each hold word, then `none`. */
export const markWords: readonly Hold[] = [...Object.values(workerHold.words), workerHold.none];

/** The hold of a word that a person typed, or null for a word that is not one of `markWords`. */
export const holdOf = (word: string): Hold | null => markWords.find((hold) => hold === word) ?? null;

/** What a read of the hold file of a worker finds: the hold (`none` with no file), or the reason that the file can not be used. */
export type HoldRead = { readonly kind: 'hold'; readonly hold: Hold } | { readonly kind: 'fault'; readonly reason: string };

const HOLD_WHAT = 'the hold file';

/** The hold word of a file text: exactly one hold word and one new line. Any other text gives null. */
const wordOfText = (text: string): HoldWord | null => {
  if (!text.endsWith('\n')) return null;
  const hold = holdOf(text.slice(0, -1));
  return hold === null || hold === workerHold.none ? null : hold;
};

/**
 * Read the hold of a worker. The read checks the workers folder, the folder of the worker and the file (`readWorkerFile`): it
 * follows no link and caps the bytes. No file is `none`. A file that is not valid, or a fault of the file system, gives the reason,
 * and the reason never holds a part of the file. It never fails.
 */
export const readHold = async (deps: Deps, home: string, id: string): Promise<HoldRead> => {
  const found = await readWorkerFile(deps, home, id, { of: 'holdFile', what: HOLD_WHAT, maxBytes: workerHold.maxBytes });
  if (!found.ok) return { kind: 'fault', reason: found.error.message };
  if (found.value.state === 'absent') return { kind: 'hold', hold: workerHold.none };
  if (found.value.state === 'invalid') return { kind: 'fault', reason: found.value.reason };
  const word = wordOfText(found.value.text);
  return word === null ? { kind: 'fault', reason: `${HOLD_WHAT} holds no hold word` } : { kind: 'hold', hold: word };
};

/**
 * Remove the hold file of a worker. A workers folder or a folder of the worker that is a link is a security stop (exit 4), and
 * nothing is removed. A folder or a file that is not there has no hold file already. A folder at the path of the file is a failure.
 */
const clearHold = async (deps: Deps, home: string, id: string): Promise<CliResult<void>> => {
  const paths = workerPathsOf(home, id);
  for (const path of [layoutOf(home).workersDir, paths.dir]) {
    const found = await deps.fs.lstat(path);
    if (!found.ok) return found;
    if (found.value === null) return ok(undefined);
    if (found.value === 'link') return safetyRefusal(`cannot remove ${paths.holdFile}: ${path} is a link`, LINK_REMEDY);
    if (found.value !== 'dir') return failure(`cannot remove ${paths.holdFile}: ${path} is not a folder`);
  }
  const file = await deps.fs.lstat(paths.holdFile);
  if (!file.ok) return file;
  if (file.value === 'dir') return failure(`cannot remove ${paths.holdFile}: it is a folder`);
  return file.value === null ? ok(undefined) : deps.fs.removeFile(paths.holdFile);
};

/**
 * Set the hold of a worker. A hold word replaces the file with one write (`writeInFolder`): a reader sees the old word or the new
 * word, never a part. `none` removes the file. The caller checks that the worker has a record. An id that is not a slug is a
 * failure, and no path is touched.
 */
export const writeHold = async (deps: Deps, home: string, id: string, hold: Hold): Promise<CliResult<void>> => {
  if (!isSlug(id)) return failure(`cannot mark the ${roles.worker}: the id is not a slug`);
  if (hold === workerHold.none) return clearHold(deps, home, id);
  return writeInFolder(
    deps,
    {
      parent: layoutOf(home).workersDir,
      folder: workerPathsOf(home, id).dir,
      name: files.workerHold,
      mode: workerRecord.fileMode,
      folderMode: workerRecord.folderMode,
    },
    `${hold}\n`,
  );
};
