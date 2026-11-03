import { basename, join, resolve } from 'node:path';
import { failure, safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import {
  classifyOrigin,
  CLONE_URL_REMEDY,
  cloneIssueReason,
  isPlainRepoName,
  parseCloneUrl,
  type OriginClass,
} from '../core/clone-url.js';
import type { Deps } from '../core/deps.js';
import { gitClone, isWorkTreeRoot, originUrlOf, withoutUserinfo } from '../core/git.js';
import { comparable, isSameOrInside, missingFolders, realPathOf } from '../core/paths.js';
import { describeProjectPathIssue, projectFolderKey, projectPathIssue } from '../core/project-path.js';
import { err, ok } from '../core/result.js';
import { flags, flagText, places, program } from '../names.js';

export const MAX_PROJECTS = 100;

export interface RepoUrl {
  readonly url: string;
  /** The last part of the URL without the git suffix. It is a plain folder name. */
  readonly name: string;
}

/** A project of the command, planned before any clone. */
export interface PlannedProject {
  /** The path of the project: the name of its folder in the root. */
  readonly name: string;
  /** The folder of the project in the root. */
  readonly target: string;
  /** What git clones from: a URL, or a folder of this machine. */
  readonly from: string;
  /** True when the folder is a clone of the repo already, so no clone runs. */
  readonly present: boolean;
  /** How the origin of the repo is sorted. The url of the project and its local source follow from it. */
  readonly origin: OriginClass;
  /** The folder of this machine that the clone starts from. It is null for a URL, and for a folder that is in the root. */
  readonly oldFolder: string | null;
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
  return ok({ url: parsed.value.url, name: parsed.value.name });
};

const PLAIN_NAME_REMEDY = 'A repo name has letters, digits, dot, hyphen and underscore, and starts with a letter or a digit.';

/** The name of a repo in a URL must be a plain folder name. */
const checkPlainName = (name: string): CliResult<void> =>
  isPlainRepoName(name)
    ? ok(undefined)
    : usageError(`${flagText(flags.project)}: the repo name in the URL is not a plain name`, PLAIN_NAME_REMEDY);

/**
 * The project path rule (design 4.3): the name of the folder is one name that the root does not keep for itself.
 * A name that breaks the rule is a stop (exit 4), before any clone.
 */
const checkProjectName = (name: string): CliResult<void> => {
  const issue = projectPathIssue(name);
  if (issue === null) return ok(undefined);
  return safetyRefusal(
    `the project folder name "${name}" ${describeProjectPathIssue(issue)}`,
    `Use one folder name that is not reserved: rename the repo or the folder. Then run the same command again.`,
  );
};

/** The folder of a project is inside the root and is not the root. A link to a folder outside the root is refused. */
const requireInsideRoot = async (deps: Deps, realHome: string, target: string): Promise<CliResult<true>> => {
  const real = await realPathOf(deps, target);
  if (!real.ok) return real;
  const root = comparable(deps, realHome);
  const folder = comparable(deps, real.value);
  if (folder !== root && isSameOrInside(root, folder)) return ok(true);
  return safetyRefusal(
    `the project folder ${target} is outside the ${places.folder}: it resolves to ${real.value}`,
    `Replace it with a clone of the repo inside the ${places.folder}. Then run the same command again.`,
  );
};

/**
 * True when `target` is a work tree whose origin is `from`. A target that does not exist is not present. A target that
 * exists in any other way is refused. A present target must be inside the root after its links are resolved.
 */
const isPresentClone = async (deps: Deps, realHome: string, from: string, target: string): Promise<CliResult<boolean>> => {
  const kind = await deps.fs.stat(target);
  if (!kind.ok) return kind;
  if (kind.value === null) return ok(false);
  if (kind.value === 'dir' && (await isWorkTreeRoot(deps, target)) && (await originUrlOf(deps, target)) === from) {
    return requireInsideRoot(deps, realHome, target);
  }
  return failure(
    `${target} exists and is not a clone of ${withoutUserinfo(from)}`,
    `${program} clones only into a folder that does not exist. Move the folder, or choose another repo.`,
  );
};

/** The count of the projects of one command: the repos that it found and the values of the project flag. */
export const checkProjectCount = (count: number): CliResult<void> =>
  count > MAX_PROJECTS ? usageError(`at most ${MAX_PROJECTS} projects are allowed`) : ok(undefined);

/** The plan of a project that a URL names. The origin of the clone is the URL. */
const planUrlProject = async (
  deps: Deps,
  home: string,
  realHome: string,
  repo: RepoUrl,
): Promise<CliResult<PlannedProject>> => {
  const plain = checkPlainName(repo.name);
  if (!plain.ok) return plain;
  const named = checkProjectName(repo.name);
  if (!named.ok) return named;
  const target = join(home, repo.name);
  const present = await isPresentClone(deps, realHome, repo.url, target);
  if (!present.ok) return present;
  return ok({ name: repo.name, target, from: repo.url, present: present.value, origin: classifyOrigin(repo.url), oldFolder: null });
};

/** The folder name of a repo that has a shareable or a file origin: the last part of the origin URL. */
const nameOfOrigin = (origin: Exclude<OriginClass, { readonly kind: 'other' }>): CliResult<string> => {
  const parsed = parseCloneUrl(origin.url);
  if (!parsed.ok || parsed.value.kind === 'local') return failure('the origin of a repo is not a URL');
  const plain = checkPlainName(parsed.value.name);
  return plain.ok ? ok(parsed.value.name) : plain;
};

/**
 * The plan of a project that is a work tree of this machine. The clone starts from the origin of the work tree, with no
 * secret part. A work tree with no origin that the config can hold is cloned from its folder. A work tree that is the
 * folder in the root already is not cloned.
 */
const planLocalProject = async (
  deps: Deps,
  home: string,
  realHome: string,
  argument: string,
): Promise<CliResult<PlannedProject>> => {
  const absolute = resolve(deps.cwd, argument);
  if (!(await isWorkTreeRoot(deps, absolute))) {
    return usageError(`${argument} is not the top folder of a git work tree`);
  }
  const real = await realPathOf(deps, absolute);
  if (!real.ok) return real;
  const origin = classifyOrigin(await originUrlOf(deps, absolute));
  const name = origin.kind === 'other' ? ok(basename(real.value)) : nameOfOrigin(origin);
  if (!name.ok) return name;
  const named = checkProjectName(name.value);
  if (!named.ok) return named;
  const from = origin.kind === 'other' ? real.value : origin.url;
  const target = join(home, name.value);

  const targetReal = await realPathOf(deps, target);
  if (!targetReal.ok) return targetReal;
  if (comparable(deps, targetReal.value) === comparable(deps, real.value)) {
    const inside = await requireInsideRoot(deps, realHome, target);
    return inside.ok ? ok({ name: name.value, target, from, present: true, origin, oldFolder: null }) : inside;
  }
  const present = await isPresentClone(deps, realHome, from, target);
  if (!present.ok) return present;
  return ok({ name: name.value, target, from, present: present.value, origin, oldFolder: real.value });
};

/**
 * Decide, with no write, what each project of the command is and where its folder is: `<root>/<name>`. A project is a URL
 * or a git work tree of this machine. A target that is a clone of the same repo is reused. Two projects can not take
 * one folder, also when only the letter case differs. This function writes nothing.
 */
export const planProjects = async (
  deps: Deps,
  home: string,
  projects: readonly string[],
): Promise<CliResult<readonly PlannedProject[]>> => {
  const counted = checkProjectCount(projects.length);
  if (!counted.ok) return counted;
  const root = resolve(deps.cwd, home);
  const realHome = await realPathOf(deps, root);
  if (!realHome.ok) return realHome;
  const planned: PlannedProject[] = [];
  for (const argument of projects) {
    const parsed = parseProjectUrl(argument);
    if (!parsed.ok) return parsed;
    const project =
      parsed.value === null
        ? await planLocalProject(deps, root, realHome.value, argument)
        : await planUrlProject(deps, root, realHome.value, parsed.value);
    if (!project.ok) return project;
    if (planned.some((other) => projectFolderKey(other.name) === projectFolderKey(project.value.name))) {
      return usageError(`two projects take the folder ${project.value.name}`);
    }
    planned.push(project.value);
  }
  return ok(planned);
};

/** A project as `factory.yaml` lists it. */
export interface ListedProject {
  readonly id: string;
  /** The name of the folder of the project in the root. */
  readonly path: string;
  readonly url?: string | undefined;
}

/** What `init` does with the projects of a received factory. */
export interface ReceivedProjects {
  /** The projects that `init` clones, or reuses when the folder is a clone of the repo already. */
  readonly planned: readonly PlannedProject[];
  /** One warning for each project that `init` does not clone, with the folder to fill. */
  readonly warnings: readonly string[];
}

const notClonedWarning = (project: ListedProject, target: string, why: string): string =>
  `The project ${project.id} ${why}, so ${program} does not clone it. Put a clone of its repo into ${target}.`;

/**
 * Decide, with no write, what `init` does with each project of a received factory. The folder of a project is
 * `<root>/<path>`. A project with an https or ssh URL is cloned. A project with no URL, with a file URL or with a path of
 * a machine is never cloned: the file came from another machine, so the warning names the folder to fill. A folder that is
 * there and is not a clone of the repo stays an error. This function writes nothing.
 */
export const planReceivedProjects = async (
  deps: Deps,
  home: string,
  projects: readonly ListedProject[],
): Promise<CliResult<ReceivedProjects>> => {
  const counted = checkProjectCount(projects.length);
  if (!counted.ok) return counted;
  const root = resolve(deps.cwd, home);
  const realHome = await realPathOf(deps, root);
  if (!realHome.ok) return realHome;
  const planned: PlannedProject[] = [];
  const warnings: string[] = [];
  for (const project of projects) {
    const target = join(root, project.path);
    const parsed = project.url === undefined ? null : parseCloneUrl(project.url);
    if (parsed === null || !parsed.ok || parsed.value.kind !== 'remote') {
      const kind = await deps.fs.stat(target);
      if (!kind.ok) return kind;
      if (kind.value === null) {
        warnings.push(notClonedWarning(project, target, parsed === null ? 'has no URL' : 'has a URL that works on one machine only'));
      }
    } else {
      const present = await isPresentClone(deps, realHome.value, parsed.value.url, target);
      if (!present.ok) return present;
      planned.push({
        name: project.path,
        target,
        from: parsed.value.url,
        present: present.value,
        origin: classifyOrigin(parsed.value.url),
        oldFolder: null,
      });
    }
  }
  return ok({ planned, warnings });
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
 * Make the root and the folders above it that do not exist, so that the clones go into a folder that this run made, and
 * so that the undo can remove it. The result is the folders that this run made, the deepest first. When a folder
 * cannot be made, the folders made before it are removed again.
 */
export const makeRootFolders = async (deps: Deps, home: string): Promise<CliResult<readonly string[]>> => {
  const missing = await missingFolders(deps, resolve(deps.cwd, home));
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
  projects: readonly PlannedProject[],
  folders: readonly string[],
): Promise<CliResult<readonly string[]>> => {
  const made: string[] = [];
  for (const project of projects) {
    if (project.present) continue;
    const cloned = await gitClone(deps, project.from, project.target);
    if (!cloned.ok) return undoClones(deps, made, folders, cloned.error);
    made.push(project.target);
  }
  return ok(made);
};
