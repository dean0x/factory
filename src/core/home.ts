import { dirname, join, resolve } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
import { commands, commandText, env, files, flags, flagText } from '../names.js';
import type { Deps } from './deps.js';
import { ok } from './result.js';

const MAX_WALK_LEVELS = 64;

/** The nearest config file from `startDir` up to the file-system root, or null. */
export const findNearestConfig = async (deps: Deps, startDir: string): Promise<CliResult<string | null>> => {
  let dir = startDir;
  for (let level = 0; level < MAX_WALK_LEVELS; level += 1) {
    const candidate = join(dir, files.config);
    const kind = await deps.fs.stat(candidate);
    if (!kind.ok) return kind;
    if (kind.value === 'file') return ok(candidate);
    const parent = dirname(dir);
    if (parent === dir) return ok(null);
    dir = parent;
  }
  return ok(null);
};

/**
 * How the node home was found: from the home flag, from the environment, in the current folder,
 * or in a parent folder. A home from the environment that is the current folder counts as the current folder.
 */
export type HomeSource = 'flag' | 'env' | 'cwd' | 'ancestor';

export interface LocatedHome {
  readonly home: string;
  readonly source: HomeSource;
}

/**
 * The node home and how it was found: the home flag, else the home variable of the environment,
 * else the folder of the nearest config file above the current folder.
 */
export const locateHome = async (deps: Deps, homeFlag: string | undefined): Promise<CliResult<LocatedHome>> => {
  if (homeFlag !== undefined) return ok({ home: resolve(deps.cwd, homeFlag), source: 'flag' });
  const fromEnv = deps.env[env.home];
  if (fromEnv !== undefined && fromEnv !== '') {
    const home = resolve(deps.cwd, fromEnv);
    return ok({ home, source: home === resolve(deps.cwd) ? 'cwd' : 'env' });
  }
  const found = await findNearestConfig(deps, deps.cwd);
  if (!found.ok) return found;
  if (found.value === null) {
    return failure(
      `no ${files.config} found in this folder or in a parent folder`,
      `Use ${flagText(flags.home)} DIR, or run "${commandText(commands.init)}".`,
    );
  }
  const home = dirname(found.value);
  return ok({ home, source: home === resolve(deps.cwd) ? 'cwd' : 'ancestor' });
};

/** The node home, in the order of `locateHome`. */
export const resolveHome = async (deps: Deps, homeFlag: string | undefined): Promise<CliResult<string>> => {
  const located = await locateHome(deps, homeFlag);
  return located.ok ? ok(located.value.home) : located;
};
