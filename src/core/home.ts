import { dirname, join, resolve } from 'node:path';
import { failure, safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import { commands, commandText, env, files, flags, flagText, places, program, roles } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { inspectState, STATE_LABEL } from '../state/load.js';
import type { Deps } from './deps.js';
import { entryOfHome, findHomeInIndex, homeHoldingFolder, indexPathOf, readHomeIndex } from './home-index.js';
import { realPathOf } from './paths.js';
import { ok, type Err, type Result } from './result.js';

const MAX_WALK_LEVELS = 64;

/** The oldest schema version of the config file. Only `upgrade` may count such a file with no entry. */
const OLDEST_SCHEMA = 1;

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
 * in a parent folder, or in the home index. A home from the environment that is the current folder
 * counts as the current folder.
 */
export type HomeSource = 'flag' | 'env' | 'cwd' | 'ancestor' | 'index';

export interface LocatedHome {
  readonly home: string;
  readonly source: HomeSource;
  /** True when the factory list has no entry for the folder, and it counts only by the exception of `upgrade`. */
  readonly unregistered: boolean;
}

/** The node id that a config file states, and the version of its schema. */
export interface NodeIdentity {
  readonly id: string;
  readonly schema: number;
}

/**
 * Reads the node id of the config file in a folder. The command layer gives the reader, so that the core imports
 * nothing from the config. The error is the reason when the file gives no id.
 */
export type NodeIdReader = (deps: Deps, home: string) => Promise<Result<NodeIdentity, string>>;

export interface LocateOptions {
  /**
   * `upgrade` only: a folder that the factory list does not list counts when its config has schema 1 and the home
   * flag names it. The caller must get the consent of the owner before it writes.
   */
  readonly allowUnregisteredSchema1?: boolean;
}

/** Why a config file does not count. The message and the remedy are plain text for the person. */
export type RootProblem =
  | { readonly kind: 'no-entry' }
  | { readonly kind: 'in-clone'; readonly factory: string }
  | { readonly kind: 'other-id'; readonly listed: string }
  | { readonly kind: 'state-not-folder' }
  | { readonly kind: 'marker'; readonly reason: string }
  | { readonly kind: 'marker-newer'; readonly reason: string }
  | { readonly kind: 'list'; readonly reason: string; readonly remedy: string };

const INIT = commandText(commands.init);

/** The reason why a config file does not count, as a sentence that follows "does not count:". */
export const reasonOf = (home: string, problem: RootProblem): string => {
  switch (problem.kind) {
    case 'no-entry':
      return `the ${places.list} has no entry for ${home}`;
    case 'in-clone':
      return `it is in a clone of the ${places.folder} ${problem.factory}`;
    case 'other-id':
      return `the ${places.list} has the ${roles.node} id "${problem.listed}" for ${home}, and the file has another id`;
    case 'state-not-folder':
      return `${layoutOf(home).stateDir} is not a folder`;
    case 'marker':
    case 'marker-newer':
      return `the ${places.marker} ${STATE_LABEL} ${problem.reason}`;
    case 'list':
      return problem.reason;
    default: {
      const unreachable: never = problem;
      return unreachable;
    }
  }
};

/** The stop (exit 4) of a command for a config file that does not count: the file, the reason and the remedy. */
export const rootRefusalOf = (home: string, problem: RootProblem): Err<CliError> => {
  const layout = layoutOf(home);
  const file = layout.configFile;
  const initHere = `Run "${INIT}" in the ${places.folder} ${home}.`;
  const message = `${file} does not count: ${reasonOf(home, problem)}`;
  switch (problem.kind) {
    case 'no-entry':
    case 'other-id':
    case 'marker':
      return safetyRefusal(message, initHere);
    case 'in-clone':
      return safetyRefusal(
        message,
        `Run the command from the ${places.folder} ${problem.factory}, or name it with ${flagText(flags.home)} ${problem.factory}.`,
      );
    case 'state-not-folder':
      return safetyRefusal(
        `${layout.stateDir} is not a folder, so ${file} does not count`,
        `Move ${layout.stateDir} away, then run "${INIT}" in the ${places.folder} ${home}.`,
      );
    case 'marker-newer':
      return safetyRefusal(message, `Upgrade ${program}, then run the command again.`);
    case 'list':
      return safetyRefusal(message, problem.remedy);
    default: {
      const unreachable: never = problem;
      return unreachable;
    }
  }
};

/** The entry of the factory list for the folder, or the reason that none counts. */
const listingOf = async (deps: Deps, home: string): Promise<CliResult<{ readonly entryId: string } | RootProblem>> => {
  const path = await indexPathOf(deps);
  if (!path.ok) return path;
  if (path.value === null) {
    return ok({
      kind: 'list',
      reason: `${env.stateHome} and ${env.userHome} name no folder for the ${places.list}`,
      remedy: `Set ${env.stateHome} or ${env.userHome} to an absolute folder, then run "${INIT}" in the ${places.folder} ${home}.`,
    });
  }
  const entries = await readHomeIndex(deps, path.value);
  if (!entries.ok) {
    return ok({
      kind: 'list',
      reason: `the ${places.list} ${path.value} cannot be used: ${entries.error}`,
      remedy: `Fix or remove ${path.value}, then run "${INIT}" in the ${places.folder} ${home}.`,
    });
  }
  const entry = await entryOfHome(deps, entries.value, home);
  if (entry !== null) return ok({ entryId: entry.id });
  const real = await realPathOf(deps, home);
  const factory = real.ok ? homeHoldingFolder(entries.value, real.value) : null;
  return ok(factory === null ? { kind: 'no-entry' } : { kind: 'in-clone', factory });
};

/**
 * The problem with the factory marker, or null when the marker is there and valid at a known state version (an older
 * version is no problem: the state check of `doctor` names `upgrade` for it).
 */
export const markerProblemOf = async (deps: Deps, home: string): Promise<CliResult<RootProblem | null>> => {
  const stateDir = await deps.fs.stat(layoutOf(home).stateDir);
  if (!stateDir.ok) return stateDir;
  if (stateDir.value !== null && stateDir.value !== 'dir') return ok({ kind: 'state-not-folder' });
  const marker = await inspectState(deps, home);
  switch (marker.kind) {
    case 'valid':
    case 'older':
      return ok(null);
    case 'newer':
      return ok({ kind: 'marker-newer', reason: 'is from a newer version' });
    case 'missing':
      return ok({ kind: 'marker', reason: 'is missing' });
    case 'unparsable':
      return ok({ kind: 'marker', reason: 'does not parse' });
    case 'invalid':
    case 'unsafe':
      return ok({ kind: 'marker', reason: 'is not valid' });
    default: {
      const unreachable: never = marker;
      return unreachable;
    }
  }
};

/**
 * The entry part of the root rule, for a folder that holds its config file: the factory list has an entry for the
 * folder, and the id of that entry is the node id of the config. A config that gives no node id is not used by the
 * command either, so only the entry is checked then. The value is null when the entry is right, else the reason.
 */
export const entryProblemOf = async (deps: Deps, home: string, readNodeId: NodeIdReader): Promise<CliResult<RootProblem | null>> => {
  const listing = await listingOf(deps, home);
  if (!listing.ok) return listing;
  if (!('entryId' in listing.value)) return ok(listing.value);

  const identity = await readNodeId(deps, home);
  return identity.ok && identity.value.id !== listing.value.entryId
    ? ok({ kind: 'other-id', listed: listing.value.entryId })
    : ok(null);
};

/**
 * The registration check, the root rule of design 4.3. A config file counts only when the factory list has an entry
 * for its folder, the id of that entry is the node id of the config, and the factory marker is there and valid. A
 * folder with no config file has nothing to count: the command reports the missing file. The error is a failure of
 * the file system. The value is null when the config counts, else the reason.
 */
const rootProblemOf = async (deps: Deps, home: string, readNodeId: NodeIdReader): Promise<CliResult<RootProblem | null>> => {
  const folder = await deps.fs.stat(home);
  if (!folder.ok) return folder;
  if (folder.value !== 'dir') return ok(null);
  const config = await deps.fs.stat(layoutOf(home).configFile);
  if (!config.ok) return config;
  if (config.value !== 'file') return ok(null);

  const entry = await entryProblemOf(deps, home, readNodeId);
  if (!entry.ok || entry.value !== null) return entry;
  return markerProblemOf(deps, home);
};

const chosenHome = async (
  deps: Deps,
  homeFlag: string | undefined,
): Promise<CliResult<{ readonly home: string; readonly source: HomeSource }>> => {
  if (homeFlag !== undefined) return ok({ home: resolve(deps.cwd, homeFlag), source: 'flag' });
  const fromEnv = deps.env[env.home];
  if (fromEnv !== undefined && fromEnv !== '') {
    const home = resolve(deps.cwd, fromEnv);
    return ok({ home, source: home === resolve(deps.cwd) ? 'cwd' : 'env' });
  }
  const found = await findNearestConfig(deps, deps.cwd);
  if (!found.ok) return found;
  if (found.value !== null) {
    const home = dirname(found.value);
    return ok({ home, source: home === resolve(deps.cwd) ? 'cwd' : 'ancestor' });
  }

  const indexed = await findHomeInIndex(deps);
  if (!indexed.ok) return indexed;
  if (indexed.value !== null) return ok({ home: indexed.value, source: 'index' });
  return usageError(
    `no ${files.config} found in this folder or in a parent folder, and no ${places.folder} in the ${places.list} lists this folder`,
    `Run "${commandText(commands.init)}" here, or use ${flagText(flags.home)} DIR.`,
  );
};

/**
 * The node home and how it was found: the home flag, else the home variable of the environment, else the folder of
 * the nearest config file above the current folder, else the home index, which matches the current folder to a
 * project path. The registration check applies to the home from every source. A config that does not pass it is a
 * security stop (exit 4) that names the file, the reason and the remedy.
 */
export const locateHome = async (
  deps: Deps,
  homeFlag: string | undefined,
  readNodeId: NodeIdReader,
  options: LocateOptions = {},
): Promise<CliResult<LocatedHome>> => {
  const chosen = await chosenHome(deps, homeFlag);
  if (!chosen.ok) return chosen;
  const { home, source } = chosen.value;
  const problem = await rootProblemOf(deps, home, readNodeId);
  if (!problem.ok) return problem;
  if (problem.value === null) return ok({ home, source, unregistered: false });

  if (options.allowUnregisteredSchema1 === true && source === 'flag' && problem.value.kind === 'no-entry') {
    const identity = await readNodeId(deps, home);
    if (identity.ok && identity.value.schema === OLDEST_SCHEMA) return ok({ home, source, unregistered: true });
  }
  return rootRefusalOf(home, problem.value);
};

/** Like `locateHome`, and the home must be a folder. */
export const locateHomeFolder = async (
  deps: Deps,
  homeFlag: string | undefined,
  readNodeId: NodeIdReader,
  options: LocateOptions = {},
): Promise<CliResult<LocatedHome>> => {
  const located = await locateHome(deps, homeFlag, readNodeId, options);
  if (!located.ok) return located;
  const folder = await deps.fs.stat(located.value.home);
  if (!folder.ok) return folder;
  return folder.value === 'dir' ? located : failure(`${located.value.home} is not a folder`);
};
