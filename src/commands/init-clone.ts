import { dirname, join, resolve } from 'node:path';
import { safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { gitClone, isWorkTreeRoot, originUrlOf } from '../core/git.js';
import { ok } from '../core/result.js';
import { flags, flagText, program, roles } from '../names.js';

export const MAX_PROJECTS = 100;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const USER = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const HOST = '[A-Za-z0-9][A-Za-z0-9.-]*';
const URL_PATH = '[A-Za-z0-9._~%+/-]+';
const HTTPS_URL = new RegExp(`^https://(?:${USER}@)?${HOST}(?::\\d{1,5})?/${URL_PATH}$`);
const SSH_URL = new RegExp(`^ssh://(?:${USER}@)?${HOST}(?::\\d{1,5})?/${URL_PATH}$`);
const SCP_URL = new RegExp(`^${USER}@${HOST}:${URL_PATH}$`);
const OTHER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const GIT_SUFFIX = '.git';

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
 * Read a value of the project flag as a repo URL. The accepted forms are https://, ssh:// and user@host:path.
 * The result is null when the value is a path. A form with a hostname or a user name that starts with a hyphen
 * is not accepted, so a URL can never act as an option of git or ssh.
 */
export const parseProjectUrl = (argument: string): CliResult<RepoUrl | null> => {
  const accepted = HTTPS_URL.test(argument) || SSH_URL.test(argument) || SCP_URL.test(argument);
  if (!accepted) {
    return OTHER_SCHEME.test(argument)
      ? usageError(
          `${flagText(flags.project)}: this URL form is not accepted`,
          'Use a URL that starts with https:// or ssh://, or the form user@host:path.',
        )
      : ok(null);
  }
  const last = argument.split(/[/:]/).filter((part) => part !== '').at(-1) ?? '';
  const name = last.endsWith(GIT_SUFFIX) ? last.slice(0, -GIT_SUFFIX.length) : last;
  if (!NAME_PATTERN.test(name) || name.includes('..')) {
    return usageError(
      `${flagText(flags.project)}: the repo name in the URL is not a plain name`,
      'A repo name has letters, digits, dot, hyphen and underscore, and starts with a letter or a digit.',
    );
  }
  return ok({ url: argument, name });
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
    `${target} exists and is not a clone of ${url}`,
    `${program} clones only into a folder that does not exist. Move the folder, or choose another repo.`,
  );
};

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
  if (projects.length > MAX_PROJECTS) return usageError(`at most ${MAX_PROJECTS} projects are allowed`);
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

/** Clone each repo that is not there yet. A clone that was made stays when a later step fails. */
export const runClones = async (deps: Deps, clones: readonly PlannedClone[]): Promise<CliResult<void>> => {
  for (const clone of clones) {
    if (clone.present) continue;
    const cloned = await gitClone(deps, clone.url, clone.target);
    if (!cloned.ok) return cloned;
  }
  return ok(undefined);
};
