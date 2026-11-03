import { basename, dirname, join, resolve } from 'node:path';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { printable } from '../cli/output.js';
import { localFileAccess } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { listRepoChildren, MAX_SCAN_ENTRIES, workTreeTop, type SkippedFolder } from '../core/git.js';
import { findNearestConfig } from '../core/home.js';
import { isSameOrInside, nearestExisting, realPathOf } from '../core/paths.js';
import { ok } from '../core/result.js';
import { commands, commandText, dirs, files, flags, flagText, program, roles } from '../names.js';
import { isStagingDirName, layoutOf } from '../state/layout.js';

/** The answers that mean yes to a question of a command. Any other answer, and an empty one, means no. */
export const ACCEPT_ANSWER = /^y(?:es)?$/i;

export interface HomeChoice {
  readonly home: string;
  /**
   * The git work trees that the command found and that become the first projects: the work tree that the command
   * runs in, or each repo of a workspace folder. Empty when the home is not proposed.
   */
  readonly found: readonly string[];
  /** The folders of a workspace folder that are one more checkout of a repo in `found`. */
  readonly skipped: readonly SkippedFolder[];
  /** True when a workspace folder holds more entries than the scan reads. */
  readonly truncated: boolean;
}

const NOT_PROPOSED = { found: [], skipped: [], truncated: false } as const;

const describeSkipped = (skipped: readonly SkippedFolder[]): string =>
  skipped.length === 0
    ? ''
    : ` Skipped: ${skipped.map((folder) => `${folder.path} (${folder.reason})`).join('; ')}.`;

/**
 * Ask for the proposed home. The yes flag accepts it. A person accepts it on a terminal.
 * With no terminal and no yes flag, the command prints the proposal and exits with a usage error.
 */
const confirmProposal = async (
  deps: Deps,
  yes: boolean,
  choice: HomeChoice,
  reason: string,
): Promise<CliResult<HomeChoice>> => {
  if (yes) return ok(choice);
  const about = `${reason}.${describeSkipped(choice.skipped)} The proposed ${roles.node} home is ${choice.home}`;
  if (!(deps.stdinIsTTY && deps.stdoutIsTTY)) {
    return usageError(
      about,
      `Run the command again with ${flagText(flags.yes)} to use it, or with ${flagText(flags.home)} DIR to choose another folder.`,
    );
  }
  const answer = await deps.prompt(printable(`${about}\nCreate the ${roles.node} home here? [y/N] `));
  if (!answer.ok) return answer;
  if (ACCEPT_ANSWER.test(answer.value.trim())) return ok(choice);
  return usageError(
    `the ${roles.node} home ${choice.home} was not accepted`,
    `Pass ${flagText(flags.home)} DIR to choose a folder.`,
  );
};

/** The name of the home beside a folder: `<folder name>-factory`. */
const proposedName = (folder: string): string | null => {
  const name = basename(folder);
  return name === '' ? null : `${name}-${program}`;
};

const nodeExists = (home: string): CliResult<never> =>
  failure(
    `${files.config} already exists in ${home}`,
    `That folder is already a ${roles.node}. Run "${commandText(commands.doctor)}".`,
  );

/** The folder holds no node: no config file, no state folder, and it is a folder or does not exist. */
export const checkHomeIsNew = async (deps: Deps, home: string): Promise<CliResult<void>> => {
  const layout = layoutOf(home);
  const configKind = await deps.fs.stat(layout.configFile);
  if (!configKind.ok) return configKind;
  if (configKind.value !== null) return nodeExists(home);
  // A local file with no shared file next to it is not ours to replace: it can hold values of a person.
  // The command stops with exit 4 when another account owns it or others can write it, as every command does.
  const localAccess = await localFileAccess(deps, home);
  if (!localAccess.ok) return localAccess;
  if (localAccess.value.kind !== 'absent') {
    return failure(`${files.localConfig} already exists in ${home}`, 'Move it away, or use another folder.');
  }
  const stateKind = await deps.fs.stat(layout.stateDir);
  if (!stateKind.ok) return stateKind;
  if (stateKind.value !== null) {
    return failure(`${dirs.state} already exists in ${home}`, 'Remove it, or use another folder.');
  }
  const homeKind = await deps.fs.stat(home);
  if (!homeKind.ok) return homeKind;
  if (homeKind.value !== null && homeKind.value !== 'dir') return failure(`${home} is not a folder`);
  return ok(undefined);
};

/** No folder above the home holds a node config. The home is then outside every other node home. */
const checkInsideNoNodeHome = async (deps: Deps, home: string): Promise<CliResult<void>> => {
  const parentConfig = await findNearestConfig(deps, dirname(home));
  if (!parentConfig.ok) return parentConfig;
  if (parentConfig.value !== null) {
    return failure(
      `the ${roles.node} home ${home} is inside another ${roles.node} home: ${parentConfig.value} exists`,
      `A ${roles.node} home must be outside every other ${roles.node} home. Choose another folder with ${flagText(flags.home)} DIR.`,
    );
  }
  return ok(undefined);
};

/**
 * The folder is no node home, and no folder above it is one. A folder that is one gets the error of a home that exists
 * (exit 1). A folder inside one gets the safety refusal (exit 4).
 */
const checkNoNodeAround = async (deps: Deps, folder: string): Promise<CliResult<void>> => {
  const own = await checkHomeIsNew(deps, folder);
  if (!own.ok) return own;
  return checkInsideNoNodeHome(deps, folder);
};

/**
 * Choose the node home. The home flag wins. Else, in a git work tree, the proposal is a folder beside the work tree.
 * Else, in a folder that is a node home, the command stops: that node exists. Else, in a folder inside a node home, the
 * command stops with the safety refusal. Else, in a folder that holds git repos one level down, the proposal is a
 * folder inside it, and each repo is a project.
 * A person confirms the proposal on a terminal, or the yes flag confirms it. Else the home is the current folder.
 */
export const chooseHome = async (
  deps: Deps,
  options: { readonly home: string | undefined; readonly yes: boolean },
): Promise<CliResult<HomeChoice>> => {
  if (options.home !== undefined) return ok({ home: resolve(deps.cwd, options.home), ...NOT_PROPOSED });
  const refuse = (folder: string): CliResult<never> =>
    usageError(`cannot make a ${roles.node} home name from the folder ${folder}`, `Pass ${flagText(flags.home)} DIR.`);

  const top = await workTreeTop(deps, deps.cwd);
  if (top !== null) {
    const name = proposedName(top);
    if (name === null) return refuse(top);
    const choice = { home: join(dirname(top), name), found: [top], skipped: [], truncated: false };
    return confirmProposal(deps, options.yes, choice, `this folder is in the git work tree ${top}`);
  }

  const folder = resolve(deps.cwd);
  const around = await checkNoNodeAround(deps, folder);
  if (!around.ok) return around;
  const scan = await listRepoChildren(deps, folder);
  if (!scan.ok) return scan;
  if (scan.value.repos.length === 0) return ok({ home: folder, ...NOT_PROPOSED });
  const name = proposedName(folder);
  if (name === null) return refuse(folder);
  const { repos, skipped, truncated } = scan.value;
  const choice = { home: join(folder, name), found: repos, skipped, truncated };
  const names = repos.map((repo) => basename(repo)).join(', ');
  return confirmProposal(deps, options.yes, choice, `this folder holds the git repos ${names}`);
};

/**
 * The temp folders in the home that a stopped `init` left: the staging folders of the state repo. The list is empty when
 * the home does not exist. The names are read from the folder, up to `MAX_SCAN_ENTRIES` of them. Nothing is removed.
 */
export const leftoverTempFolders = async (deps: Deps, home: string): Promise<CliResult<readonly string[]>> => {
  const kind = await deps.fs.stat(home);
  if (!kind.ok) return kind;
  if (kind.value !== 'dir') return ok([]);
  const names = await deps.fs.list(home);
  if (!names.ok) return names;
  return ok(
    names.value
      .slice(0, MAX_SCAN_ENTRIES)
      .filter(isStagingDirName)
      .map((name) => join(home, name)),
  );
};

/** The warning for a temp folder that a stopped `init` left. The remedy is to remove it by hand. */
export const tempFolderWarning = (folder: string): string =>
  `The ${roles.node} home holds the temp folder ${folder}, left by a stopped ${commands.init}. ` +
  `Remove ${folder} by hand when no ${commands.init} runs.`;

/**
 * The home holds no git repo one level down. The state folder of a node is a repo, so it does not count. A temp
 * folder of a stopped `init` is a repo too, and it does not count: `leftoverTempFolders` finds it.
 * This covers a home that is a workspace folder, also when no project is declared.
 */
export const checkHomeHoldsNoRepo = async (deps: Deps, home: string): Promise<CliResult<void>> => {
  const kind = await deps.fs.stat(home);
  if (!kind.ok) return kind;
  if (kind.value !== 'dir') return ok(undefined);
  const scan = await listRepoChildren(deps, home);
  if (!scan.ok) return scan;
  const found = [...scan.value.repos, ...scan.value.skipped.map((folder) => folder.path)].filter(
    (path) => basename(path) !== dirs.state,
  );
  const repo = found.find((path) => !isStagingDirName(basename(path)));
  if (repo === undefined) return ok(undefined);
  return safetyRefusal(
    `the ${roles.node} home ${home} holds the git repo ${basename(repo)} one level down`,
    `A ${roles.node} home must hold no git repo. Choose another folder with ${flagText(flags.home)} DIR.`,
  );
};

/**
 * The home is outside every git work tree, and outside every other node home.
 * The check starts at the nearest folder of the home that exists.
 */
export const checkHomeLocation = async (deps: Deps, home: string): Promise<CliResult<void>> => {
  const nearest = await nearestExisting(deps, home);
  if (!nearest.ok) return nearest;
  const top = await workTreeTop(deps, nearest.value.dir);
  if (top !== null) {
    return safetyRefusal(
      `the ${roles.node} home ${home} is inside the git work tree ${top}`,
      `A ${roles.node} home must be outside every git work tree. Choose another folder with ${flagText(flags.home)} DIR.`,
    );
  }

  return checkInsideNoNodeHome(deps, home);
};

/** The home is not a project folder, and no project is inside it. The paths are compared after their links are resolved. */
export const checkHomeApart = async (
  deps: Deps,
  home: string,
  projects: readonly string[],
): Promise<CliResult<void>> => {
  const realHome = await realPathOf(deps, home);
  if (!realHome.ok) return realHome;
  for (const project of projects) {
    const realProject = await realPathOf(deps, project);
    if (!realProject.ok) return realProject;
    if (isSameOrInside(realHome.value, realProject.value)) {
      return safetyRefusal(
        `the ${roles.node} home ${home} is the project folder ${project}, or holds it`,
        `A ${roles.node} home must be apart from its projects: no project is the home, and no project is inside it. ` +
          `Choose another folder with ${flagText(flags.home)} DIR.`,
      );
    }
  }
  return ok(undefined);
};
