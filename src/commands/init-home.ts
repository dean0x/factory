import { basename, dirname, join, resolve } from 'node:path';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { workTreeTop } from '../core/git.js';
import { findNearestConfig } from '../core/home.js';
import { isSameOrInside } from '../core/paths.js';
import { ok } from '../core/result.js';
import { flags, flagText, program, roles } from '../names.js';

const MAX_PARENT_LEVELS = 64;
const ACCEPT_ANSWER = /^y(?:es)?$/i;

export interface HomeChoice {
  readonly home: string;
  /** The top folder of the git work tree that the command runs in. It is the first project. Null when the home is not proposed. */
  readonly firstProject: string | null;
}

/**
 * Choose the node home. The home flag wins. Else, in a git work tree, the proposal is a folder beside the work tree:
 * a person confirms it on a terminal, or the yes flag confirms it. Else the home is the current folder.
 */
export const chooseHome = async (
  deps: Deps,
  options: { readonly home: string | undefined; readonly yes: boolean },
): Promise<CliResult<HomeChoice>> => {
  if (options.home !== undefined) return ok({ home: resolve(deps.cwd, options.home), firstProject: null });
  const top = await workTreeTop(deps, deps.cwd);
  if (top === null) return ok({ home: resolve(deps.cwd), firstProject: null });

  const name = basename(top);
  if (name === '') return usageError(`cannot make a ${roles.node} home name from the folder ${top}`, `Pass ${flagText(flags.home)} DIR.`);
  const proposal = join(dirname(top), `${name}-${program}`);
  const choice: HomeChoice = { home: proposal, firstProject: top };
  if (options.yes) return ok(choice);

  if (!(deps.stdinIsTTY && deps.stdoutIsTTY)) {
    return usageError(
      `this folder is in the git work tree ${top}. The proposed ${roles.node} home is ${proposal}`,
      `Run the command again with ${flagText(flags.yes)} to use it, or with ${flagText(flags.home)} DIR to choose another folder.`,
    );
  }
  const answer = await deps.prompt(
    `The proposed ${roles.node} home is ${proposal}\nCreate the ${roles.node} home here? [y/N] `,
  );
  if (!answer.ok) return answer;
  if (ACCEPT_ANSWER.test(answer.value.trim())) return ok(choice);
  return usageError(`the ${roles.node} home ${proposal} was not accepted`, `Pass ${flagText(flags.home)} DIR to choose a folder.`);
};

/** The nearest folder on the way up from `path` that exists, and the names of the folders below it. */
const nearestExisting = async (
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

/** The path with its links resolved. The part that does not exist yet is added as it is. */
export const realPathOf = async (deps: Deps, path: string): Promise<CliResult<string>> => {
  const nearest = await nearestExisting(deps, path);
  if (!nearest.ok) return nearest;
  const real = await deps.fs.realpath(nearest.value.dir);
  return real.ok ? ok(join(real.value, ...nearest.value.below)) : real;
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

  const parentConfig = await findNearestConfig(deps, dirname(home));
  if (!parentConfig.ok) return parentConfig;
  if (parentConfig.value !== null) {
    return safetyRefusal(
      `the ${roles.node} home ${home} is inside another ${roles.node} home: ${parentConfig.value} exists`,
      `A ${roles.node} home must be outside every other ${roles.node} home. Choose another folder with ${flagText(flags.home)} DIR.`,
    );
  }
  return ok(undefined);
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
