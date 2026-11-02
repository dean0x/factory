import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
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

/** The path with its links resolved. The part that does not exist yet is added as it is. */
export const realPathOf = async (deps: Deps, path: string): Promise<CliResult<string>> => {
  const nearest = await nearestExisting(deps, path);
  if (!nearest.ok) return nearest;
  const real = await deps.fs.realpath(nearest.value.dir);
  return real.ok ? ok(join(real.value, ...nearest.value.below)) : real;
};
