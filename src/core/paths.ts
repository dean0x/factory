import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { commandText, dirs, env, flags, flagText, type CommandName } from '../names.js';
import type { Deps } from './deps.js';
import { ok } from './result.js';

const MAX_PARENT_LEVELS = 64;

/** True when `child` is `parent` or a path inside it. Both paths are absolute and clean. */
export const isSameOrInside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** The nearest folder on the way up from `path` that exists, and the names of the folders below it. */
export const nearestExisting = async (
  deps: Deps,
  path: string,
): Promise<CliResult<{ readonly dir: string; readonly below: readonly string[] }>> => {
  const below: string[] = [];
  let current = path;
  for (let level = 0; level < MAX_PARENT_LEVELS; level += 1) {
    const kind = await deps.fs.stat(current);
    if (!kind.ok) return kind;
    if (kind.value !== null) return ok({ dir: current, below });
    below.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return failure(`no folder above ${path} exists`);
};

/** The folders on the way up from `dir` that do not exist, the deepest first. The list is empty when `dir` exists. */
export const missingFolders = async (deps: Deps, dir: string): Promise<CliResult<readonly string[]>> => {
  const missing: string[] = [];
  let current = dir;
  for (let level = 0; level < MAX_PARENT_LEVELS; level += 1) {
    const kind = await deps.fs.stat(current);
    if (!kind.ok) return kind;
    if (kind.value !== null) return ok(missing);
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) return ok(missing);
    current = parent;
  }
  return ok(missing);
};

/** The path with its links resolved. The part that does not exist yet is added as it is. */
export const realPathOf = async (deps: Deps, path: string): Promise<CliResult<string>> => {
  const nearest = await nearestExisting(deps, path);
  if (!nearest.ok) return nearest;
  const real = await deps.fs.realpath(nearest.value.dir);
  return real.ok ? ok(join(real.value, ...nearest.value.below)) : real;
};

/** The value of `process.platform` on macOS. */
const MACOS = 'darwin';

/** The path in the form that is compared: macOS has a file system that ignores the case of letters. */
export const comparable = (deps: Deps, path: string): string => (deps.platform.os === MACOS ? path.toLowerCase() : path);

/**
 * True when `path` is `folder` or inside it, by the two paths as they are written, with the case rule of the platform.
 * No call of the file system is made, so a link is not followed.
 */
export const isWrittenInside = (deps: Deps, folder: string, path: string): boolean =>
  isSameOrInside(comparable(deps, resolve(folder)), comparable(deps, resolve(path)));

/** The user settings folder of Claude Code, as it is written, or null when the variable of the user home is not set. */
export const userClaudeFolderOf = (deps: Deps): string | null => {
  const userHome = deps.env[env.userHome];
  return userHome === undefined || userHome === '' ? null : join(resolve(userHome), dirs.claude);
};

/**
 * True when `path` is the user settings folder of Claude Code or is inside it, by the two paths as they are written. No
 * call of the file system is made. With no user home variable, the folder is not known and the answer is false.
 */
export const isInUserClaudeFolder = (deps: Deps, path: string): boolean => {
  const userFolder = userClaudeFolderOf(deps);
  return userFolder !== null && isWrittenInside(deps, userFolder, path);
};

/**
 * A stop (exit 4) when `folder` is the user settings folder of Claude Code or is inside it. The two paths are compared as
 * they are written, so no call of the file system is made and nothing asks about that folder. With no user home variable,
 * the folder is not known and nothing stops. The remedy names the command to run once the person has chosen another folder.
 */
export const requireOutsideUserClaudeFolder = (deps: Deps, folder: string, command: CommandName): CliResult<void> => {
  const userFolder = userClaudeFolderOf(deps);
  if (userFolder === null || !isInUserClaudeFolder(deps, folder)) return ok(undefined);
  return safetyRefusal(
    `${resolve(folder)} is, or is inside, the settings folder of Claude Code ${userFolder}`,
    `Claude Code owns that folder. Go to another folder, or name one with ${flagText(flags.home)} DIR. Then run "${commandText(command)}".`,
  );
};

/**
 * True when `path` is `folder` or inside it. The two paths are compared as they are written, and again with their
 * links resolved. On macOS the comparison ignores the case of letters. A link that cannot be resolved is an error.
 */
export const isSameOrInsideFolder = async (deps: Deps, folder: string, path: string): Promise<CliResult<boolean>> => {
  const [realPath, realFolder] = [await realPathOf(deps, path), await realPathOf(deps, folder)];
  if (!realPath.ok) return realPath;
  if (!realFolder.ok) return realFolder;
  return ok(
    isSameOrInside(comparable(deps, folder), comparable(deps, path)) ||
      isSameOrInside(comparable(deps, realFolder.value), comparable(deps, realPath.value)),
  );
};
