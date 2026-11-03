import { dirname, join, resolve } from 'node:path';
import { safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import { CLONE_URL_REMEDY, cloneIssueReason, isPlainRepoName, parseCloneUrl } from '../core/clone-url.js';
import type { Deps } from '../core/deps.js';
import { gitClone, isWorkTreeRoot, originUrlOf, withoutUserinfo } from '../core/git.js';
import { missingFolders } from '../core/paths.js';
import { err, ok } from '../core/result.js';
import { flags, flagText, program, roles } from '../names.js';

export const MAX_PROJECTS = 100;

export interface RepoUrl {
  readonly url: string;
  /** The last part of the URL without the git suffix. It is a plain folder name. */
  readonly name: string;
}

export interface PlannedClone extends RepoUrl {
  /** The folder that the clone makes: beside the node home. */
  readonly target: string;
  /** True when the folder is a clone of this URL already. */
  readonly present: boolean;
}

/**
 * Read a value of the project flag as a repo URL. The accepted forms are https://, ssh://, user@host:path and a file
 * URL. The result is null when the value is a path of this machine. The rules of the clone URL decide: a user name in
 * an https URL, a password or a token in any form, a scheme that is not allowed and a hyphen at the start are refused
 * with a usage error before any clone, and the error does not repeat the value.
 */
export const parseProjectUrl = (argument: string): CliResult<RepoUrl | null> => {
  const parsed = parseCloneUrl(argument);
  if (!parsed.ok) {
    return usageError(
      `${flagText(flags.project)}: ${cloneIssueReason(parsed.error)}`,
      `${CLONE_URL_REMEDY} Then run the same command again.`,
    );
  }
  if (parsed.value.kind === 'local') return ok(null);
  if (!isPlainRepoName(parsed.value.name)) {
    return usageError(
      `${flagText(flags.project)}: the repo name in the URL is not a plain name`,
      'A repo name has letters, digits, dot, hyphen and underscore, and starts with a letter or a digit.',
    );
  }
  return ok({ url: parsed.value.url, name: parsed.value.name });
};

/** True when `target` is a work tree whose origin is this URL. A target that exists in any other way is refused. */
const isPresentClone = async (deps: Deps, url: string, target: string): Promise<CliResult<boolean>> => {
  const kind = await deps.fs.stat(target);
  if (!kind.ok) return kind;
  if (kind.value === null) return ok(false);
  if (kind.value === 'dir' && (await isWorkTreeRoot(deps, target)) && (await originUrlOf(deps, target)) === url) {
    return ok(true);
  }
  return safetyRefusal(
    `${target} exists and is not a clone of ${withoutUserinfo(url)}`,
    `${program} clones only into a folder that does not exist. Move the folder, or choose another repo.`,
  );
};

/** The count of the projects of one command: the repos that it found and the values of the project flag. */
export const checkProjectCount = (count: number): CliResult<void> =>
  count > MAX_PROJECTS ? usageError(`at most ${MAX_PROJECTS} projects are allowed`) : ok(undefined);

export interface ProjectPlan {
  /** The value of each project flag as a path: a URL is replaced by the folder of its clone. */
  readonly paths: readonly string[];
  readonly clones: readonly PlannedClone[];
}

/**
 * Decide, with no write, where each URL of the project flag is cloned: in the folder that holds the home,
 * as `<folder>/<repo name>`. A target that is a clone of the same URL is reused.
 */
export const planProjects = async (
  deps: Deps,
  home: string,
  projects: readonly string[],
): Promise<CliResult<ProjectPlan>> => {
  const counted = checkProjectCount(projects.length);
  if (!counted.ok) return counted;
  const folder = dirname(resolve(deps.cwd, home));
  const paths: string[] = [];
  const clones: PlannedClone[] = [];
  for (const argument of projects) {
    const parsed = parseProjectUrl(argument);
    if (!parsed.ok) return parsed;
    if (parsed.value === null) {
      paths.push(argument);
      continue;
    }
    const target = join(folder, parsed.value.name);
    if (target === resolve(deps.cwd, home)) {
      return usageError(`the repo ${parsed.value.name} would be cloned into the ${roles.node} home`, 'Choose another home folder.');
    }
    if (clones.some((clone) => clone.target === target)) {
      return usageError(`two values of ${flagText(flags.project)} name the folder ${target}`);
    }
    const present = await isPresentClone(deps, parsed.value.url, target);
    if (!present.ok) return present;
    clones.push({ ...parsed.value, target, present: present.value });
    paths.push(target);
  }
  return ok({ paths, clones });
};

/** The paths that a removal step removed, and the paths that it could not remove, each with its reason. */
interface Removal {
  readonly removed: readonly string[];
  readonly stuck: readonly string[];
}

const removeEach = async (
  paths: readonly string[],
  remove: (path: string) => Promise<CliResult<void>>,
): Promise<Removal> => {
  const removed: string[] = [];
  const stuck: string[] = [];
  for (const path of paths) {
    const result = await remove(path);
    if (result.ok) removed.push(path);
    else stuck.push(`${path} (${result.error.message})`);
  }
  return { removed, stuck };
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * Undo what this run made, after a later step failed: the clones in `made`, then the folders in `folders` (the deepest
 * first) when they are empty. Only these paths are removed, so a folder that was there before the run is never touched.
 * The message names each path that was removed, and each path that could not be removed.
 */
export const undoClones = async (
  deps: Deps,
  made: readonly string[],
  folders: readonly string[],
  cause: CliError,
): Promise<CliResult<never>> => {
  if (made.length === 0 && folders.length === 0) return err(cause);
  const clones = await removeEach(made, (target) => deps.fs.remove(target));
  const emptied = await removeEach(folders, (folder) => deps.fs.removeEmptyDir(folder));
  const notes = [
    ...(clones.removed.length === 0
      ? []
      : [`Removed the ${plural(clones.removed.length, 'clone', 'clones')} that this run made: ${clones.removed.join(', ')}.`]),
    ...(clones.stuck.length === 0 ? [] : [`These clones could not be removed: ${clones.stuck.join('; ')}.`]),
    ...(emptied.removed.length === 0
      ? []
      : [`Removed the ${plural(emptied.removed.length, 'folder', 'folders')} that this run made: ${emptied.removed.join(', ')}.`]),
    ...(emptied.stuck.length === 0 ? [] : [`These folders could not be removed: ${emptied.stuck.join('; ')}.`]),
  ];
  return err({ ...cause, message: `${cause.message.replace(/\.$/, '')}. ${notes.join(' ')}` });
};

/**
 * Make the folders above the home that do not exist, so that `git clone` makes none. The result is the folders that
 * this run made, the deepest first. When a folder cannot be made, the folders made before it are removed again.
 */
export const makeCloneParents = async (deps: Deps, home: string): Promise<CliResult<readonly string[]>> => {
  const missing = await missingFolders(deps, dirname(resolve(deps.cwd, home)));
  if (!missing.ok) return missing;
  const made: string[] = [];
  for (const folder of [...missing.value].reverse()) {
    const result = await deps.fs.mkdir(folder);
    if (!result.ok) return undoClones(deps, [], made, result.error);
    made.unshift(folder);
  }
  return ok(made);
};

/**
 * Clone each repo that is not there yet. The result is the folders that this run made. When a clone fails, the
 * clones that this run made before it, and the empty folders in `folders`, are removed again.
 */
export const runClones = async (
  deps: Deps,
  clones: readonly PlannedClone[],
  folders: readonly string[],
): Promise<CliResult<readonly string[]>> => {
  const made: string[] = [];
  for (const clone of clones) {
    if (clone.present) continue;
    const cloned = await gitClone(deps, clone.url, clone.target);
    if (!cloned.ok) return undoClones(deps, made, folders, cloned.error);
    made.push(clone.target);
  }
  return ok(made);
};
