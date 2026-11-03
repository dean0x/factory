import { isAbsolute, join, relative, sep } from 'node:path';
import { safetyRefusal, type CliResult } from '../cli/errors.js';
import { commands, commandText, places, program } from '../names.js';
import type { Layout } from '../state/layout.js';
import type { Deps } from './deps.js';
import { ok } from './result.js';

/** The most parts that one path below the factory folder can have. A longer path is not one of ours. */
const MAX_PARTS = 32;

/** The remedy line of a link in `setup/`, in `coordinator/` or in the backup of a block. */
export const LINK_REMEDY = `Replace the link with a plain file inside the ${places.folder}, then run "${commandText(commands.doctor)}".`;

/** The parts of `path` below `root`, or null when `path` is not inside `root`. */
const partsBelow = (root: string, path: string): readonly string[] | null => {
  const rest = relative(root, path);
  if (isAbsolute(rest) || rest === '..' || rest.startsWith(`..${sep}`)) return null;
  const parts = rest.split(sep).filter((part) => part !== '');
  return parts.length <= MAX_PARTS ? parts : null;
};

/**
 * The link rule. No part of a path below the factory folder may be a link, because a link can lead to a file outside the
 * folder. The folders above the factory folder are the layout of the user, so they may hold links, and a factory folder
 * that is a link itself works. A part that does not exist ends the walk of its path: nothing below it can be a link.
 * The first link, or the first path outside the folder, is a security stop (exit 4) that names the part and the remedy.
 * The caller checks again before it writes, because a path can change after this check.
 */
export const requireNoLinks = async (
  deps: Deps,
  root: string,
  paths: readonly string[],
  remedy: string = LINK_REMEDY,
): Promise<CliResult<void>> => {
  for (const path of paths) {
    const parts = partsBelow(root, path);
    if (parts === null) {
      return safetyRefusal(`${path} is not inside the ${places.folder}, so ${program} does not use it`, remedy);
    }
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const kind = await deps.fs.lstat(current);
      if (!kind.ok) return kind;
      if (kind.value === null) break;
      if (kind.value === 'link') {
        return safetyRefusal(`${parts.slice(0, index + 1).join('/')} is a link, so ${program} does not use it`, remedy);
      }
    }
  }
  return ok(undefined);
};

/**
 * The paths that `init`, `upgrade` and `doctor` read or write below the factory folder, and that the link rule covers:
 * the setup folder and its two texts, the coordinator folder and its `CLAUDE.md`, the worker file and the backups. The
 * local file has its own check, with its own remedy line, in `localFileAccess`.
 */
export const rootGuardPaths = (layout: Layout): readonly string[] => [
  layout.setupCoordinatorFile,
  layout.setupWorkerFile,
  layout.claudeMd,
  layout.workerMd,
  layout.backupsDir,
];

/** Check the link rule for every path that the commands read or write below the factory folder. */
export const requireNoRootLinks = (deps: Deps, layout: Layout): Promise<CliResult<void>> =>
  requireNoLinks(deps, layout.home, rootGuardPaths(layout));
