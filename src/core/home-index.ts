import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { slug } from '../config/primitives.js';
import { dirs, env, files, flagText, flags, homeIndex, program, roles } from '../names.js';
import { parseJsonText } from '../state/load.js';
import type { Deps, PathInfo } from './deps.js';
import { comparable, isSameOrInside, isSameOrInsideFolder, realPathOf } from './paths.js';
import { err, ok, type Result } from './result.js';
import { describeIssues } from './zod.js';

const MAX_PATH_CHARS = 4096;
/** The folder of the index is private to the user, and so is the file. */
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
/** The permission bits that let a group or another user write. */
const GROUP_OTHER_WRITE = 0o022;

const absolutePath = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((path) => isAbsolute(path), 'must be an absolute path');

const entrySchema = z.strictObject({
  [homeIndex.keys.home]: absolutePath,
  [homeIndex.keys.id]: slug,
  [homeIndex.keys.projects]: z.array(absolutePath).max(homeIndex.maxProjects),
});

const indexSchema = z.strictObject({
  [homeIndex.keys.schema]: z.literal(homeIndex.schema),
  [homeIndex.keys.homes]: z.array(entrySchema).max(homeIndex.maxHomes),
});

/** One node home in the index: its folder, its id and the real path of each of its projects. */
export type HomeEntry = z.infer<typeof entrySchema>;

type Environment = Readonly<Record<string, string | undefined>>;

/** The value of an environment variable when it is an absolute path, else undefined. */
const absoluteEnv = (environment: Environment, name: string): string | undefined => {
  const value = environment[name];
  return value !== undefined && value !== '' && isAbsolute(value) ? resolve(value) : undefined;
};

/**
 * The index file: below the state home when that variable holds an absolute path, else below `.local/state`
 * of the user home. It is null when neither variable names a folder. A path inside the folder of Claude Code
 * is refused. The two paths are compared as they are written, and again with their links resolved. On macOS
 * the comparison ignores the case of letters. A link that cannot be resolved is an error.
 */
export const indexPathOf = async (deps: Deps): Promise<CliResult<string | null>> => {
  const userHome = absoluteEnv(deps.env, env.userHome);
  const stateHome =
    absoluteEnv(deps.env, env.stateHome) ??
    (userHome === undefined ? undefined : join(userHome, ...homeIndex.defaultStateHome));
  if (stateHome === undefined) return ok(null);

  const path = join(stateHome, program, files.homeIndex);
  if (userHome === undefined) return ok(path);
  const claudeDir = join(userHome, dirs.claude);
  const inside = await isSameOrInsideFolder(deps, claudeDir, path);
  if (!inside.ok) return inside;
  if (inside.value) {
    return safetyRefusal(
      `the home index would be ${path}, inside ${claudeDir}`,
      `Claude Code owns that folder. Set ${env.stateHome} to another absolute folder.`,
    );
  }
  return ok(path);
};

/**
 * What the path is, or null when it does not exist. The path must belong to this user, and no group or other user may
 * write it, because the index decides which home a command uses. A platform with no user ids is not checked.
 */
const ownInfo = async (deps: Deps, path: string, what: string): Promise<Result<PathInfo | null, string>> => {
  const info = await deps.fs.statInfo(path);
  if (!info.ok) return err(info.error.message);
  if (info.value === null || deps.uid === null) return ok(info.value);
  if (info.value.uid !== deps.uid) return err(`the ${what} ${path} belongs to another user`);
  if ((info.value.mode & GROUP_OTHER_WRITE) !== 0) {
    return err(`the ${what} ${path} can be written by a group or by other users`);
  }
  return ok(info.value);
};

/**
 * The entries of the index file. A file that does not exist holds no entry. A file or a folder that another user owns
 * or can write is refused. The error is the reason.
 */
export const readHomeIndex = async (deps: Deps, path: string): Promise<Result<readonly HomeEntry[], string>> => {
  const folder = await ownInfo(deps, dirname(path), 'folder');
  if (!folder.ok) return folder;
  const file = await ownInfo(deps, path, 'file');
  if (!file.ok) return file;
  if (file.value === null) return ok([]);
  if (file.value.kind !== 'file') return err('it is not a file');
  const text = await deps.fs.readTextLimited(path, homeIndex.maxBytes);
  if (!text.ok) return err(text.error.message);

  const json = parseJsonText(text.value);
  if (!json.ok) return json;
  const parsed = indexSchema.safeParse(json.value);
  return parsed.success ? ok(parsed.data[homeIndex.keys.homes]) : err(describeIssues(parsed.error));
};

/** The entries with `entry` in place of the entry of the same home, or at the end. */
const withEntry = (entries: readonly HomeEntry[], entry: HomeEntry): readonly HomeEntry[] => {
  const key = homeIndex.keys.home;
  return entries.some((candidate) => candidate[key] === entry[key])
    ? entries.map((candidate) => (candidate[key] === entry[key] ? entry : candidate))
    : [...entries, entry];
};

/**
 * Make the folder of the index ready: a folder that another user owns or can write is refused, and the folder gets
 * mode 0700, also when it exists. The folder of the state home keeps its mode.
 */
const prepareFolder = async (deps: Deps, path: string): Promise<Result<void, string>> => {
  const folderPath = dirname(path);
  const own = await ownInfo(deps, folderPath, 'folder');
  if (!own.ok) return err(`${path} cannot be used: ${own.error}`);
  const made = await deps.fs.mkdir(folderPath, FOLDER_MODE);
  if (!made.ok) return err(made.error.message);
  const tightened = await deps.fs.chmod(folderPath, FOLDER_MODE);
  return tightened.ok ? ok(undefined) : err(tightened.error.message);
};

/**
 * Remove a lock that is older than `homeIndex.lockStaleMs`: a process that ended left it. The value is true when
 * the lock is gone and the caller may try to take it at once.
 */
const dropStaleLock = async (deps: Deps, lockPath: string): Promise<Result<boolean, string>> => {
  const info = await deps.fs.statInfo(lockPath);
  if (!info.ok) return err(info.error.message);
  if (info.value === null) return ok(true);
  if (deps.now().getTime() - info.value.mtimeMs <= homeIndex.lockStaleMs) return ok(false);
  const removed = await deps.fs.remove(lockPath);
  return removed.ok ? ok(true) : err(removed.error.message);
};

/**
 * Take the lock file beside the index. The file is new, so only one process holds it. The call tries
 * `homeIndex.lockAttempts` times and waits `homeIndex.lockWaitMs` between two tries. A stale lock is taken over.
 */
const takeLock = async (deps: Deps, lockPath: string): Promise<Result<void, string>> => {
  for (let attempt = 1; attempt <= homeIndex.lockAttempts; attempt += 1) {
    const created = await deps.fs.writeTextExclusive(lockPath, `${deps.pid}\n`, FILE_MODE);
    if (!created.ok) return err(created.error.message);
    if (created.value) return ok(undefined);
    const dropped = await dropStaleLock(deps, lockPath);
    if (!dropped.ok) return dropped;
    if (!dropped.value && attempt < homeIndex.lockAttempts) await deps.sleep(homeIndex.lockWaitMs);
  }
  return err(`another ${program} command holds the lock ${lockPath}. Run the command again, or remove that file when no such command runs.`);
};

/**
 * Read the index, add the entry and write the file. The caller holds the lock. When the index has no room for the
 * entry, the entries whose home is gone are dropped first. A home that cannot be checked stays.
 */
const addEntry = async (deps: Deps, path: string, entry: HomeEntry): Promise<Result<void, string>> => {
  const entries = await readHomeIndex(deps, path);
  if (!entries.ok) return err(`${path} cannot be read: ${entries.error}`);
  const added = withEntry(entries.value, entry);
  const next = added.length > homeIndex.maxHomes ? withEntry(await withoutGoneHomes(deps, entries.value), entry) : added;
  if (next.length > homeIndex.maxHomes) return err(`the index lists the most homes that it can: ${homeIndex.maxHomes}`);

  const text = `${JSON.stringify({ [homeIndex.keys.schema]: homeIndex.schema, [homeIndex.keys.homes]: next }, null, 2)}\n`;
  const written = await deps.fs.writeTextAtomic(path, text, FILE_MODE);
  return written.ok ? ok(undefined) : err(written.error.message);
};

/**
 * Put the home in the index file. An entry of the same home is replaced. A file that cannot be read stays as it is.
 * The file is written atomically, with mode 0600. Its folder gets mode 0700 (see `prepareFolder`). A lock file beside
 * the index lets only one process read, change and write at a time, so two runs at once lose no entry.
 * The error is the reason.
 */
export const recordHome = async (deps: Deps, path: string, entry: HomeEntry): Promise<Result<void, string>> => {
  if (entry[homeIndex.keys.projects].length > homeIndex.maxProjects) {
    return err(`a home can list at most ${homeIndex.maxProjects} projects`);
  }
  const folder = await prepareFolder(deps, path);
  if (!folder.ok) return folder;
  const lockPath = `${path}${homeIndex.lockSuffix}`;
  const locked = await takeLock(deps, lockPath);
  if (!locked.ok) return locked;

  const recorded = await addEntry(deps, path, entry);
  // A lock that stays is taken over once it is older than homeIndex.lockStaleMs.
  await deps.fs.remove(lockPath);
  return recorded;
};

/** A node home for the index: its folder, its id and the paths of its projects as its config holds them. */
export interface IndexedNode {
  readonly home: string;
  readonly id: string;
  readonly projects: readonly string[];
}

/**
 * Put a node home in the index, so that a command finds it from a project folder. The node exists already, so a problem
 * is a warning and not a failure. The result is the warnings. `indexPath` is null when no variable names a folder.
 */
export const recordNode = async (deps: Deps, indexPath: string | null, node: IndexedNode): Promise<readonly string[]> => {
  if (indexPath === null) {
    return [`The home index was not updated: ${env.stateHome} and ${env.userHome} name no folder.`];
  }
  const realHome = await realPathOf(deps, node.home);
  if (!realHome.ok) return [`The home index ${indexPath} was not updated: ${realHome.error.message}`];
  const recorded = await recordHome(deps, indexPath, {
    [homeIndex.keys.home]: realHome.value,
    [homeIndex.keys.id]: node.id,
    [homeIndex.keys.projects]: node.projects.map((project) => resolve(realHome.value, project)),
  });
  return recorded.ok ? [] : [`The home index ${indexPath} was not updated: ${recorded.error}`];
};

/** The entry of the index that has this home, as it is written or by its real path, or null when no entry has it. */
export const entryOfHome = async (deps: Deps, entries: readonly HomeEntry[], home: string): Promise<HomeEntry | null> => {
  const real = await realPathOf(deps, home);
  const wanted = [home, ...(real.ok ? [real.value] : [])].map((candidate) => comparable(deps, candidate));
  return entries.find((entry) => wanted.includes(comparable(deps, entry[homeIndex.keys.home]))) ?? null;
};

/** The folder of the first entry that has a project holding this folder, or null. The folder is a real path. */
export const homeHoldingFolder = (entries: readonly HomeEntry[], folder: string): string | null =>
  entries.find((entry) => entry[homeIndex.keys.projects].some((project) => isSameOrInside(project, folder)))?.[
    homeIndex.keys.home
  ] ?? null;

/** Whether the folder of the home holds its config file. 'unknown' is a home that cannot be checked. */
type HomeState = 'present' | 'gone' | 'unknown';

const homeStateOf = async (deps: Deps, home: string): Promise<HomeState> => {
  const kind = await deps.fs.stat(join(home, files.config));
  if (!kind.ok) return 'unknown';
  return kind.value === 'file' ? 'present' : 'gone';
};

/** True when the folder of the home still holds its config file. */
const homeExists = async (deps: Deps, home: string): Promise<boolean> => (await homeStateOf(deps, home)) === 'present';

/** The entries whose home is not known to be gone. Each home is checked once. */
const withoutGoneHomes = async (deps: Deps, entries: readonly HomeEntry[]): Promise<readonly HomeEntry[]> => {
  const kept: HomeEntry[] = [];
  for (const candidate of entries) {
    if ((await homeStateOf(deps, candidate[homeIndex.keys.home])) !== 'gone') kept.push(candidate);
  }
  return kept;
};

/** The homes of the entries that no longer hold a config file. Each home is checked once. */
export const goneHomes = async (deps: Deps, entries: readonly HomeEntry[]): Promise<readonly string[]> => {
  const gone: string[] = [];
  for (const entry of entries) {
    const home = entry[homeIndex.keys.home];
    if (!gone.includes(home) && !(await homeExists(deps, home))) gone.push(home);
  }
  return gone;
};

export interface IndexedProject {
  readonly home: string;
  /** The real path of the project. */
  readonly project: string;
}

export type IndexMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly home: string }
  | { readonly kind: 'tie'; readonly homes: readonly string[] };

/**
 * The home of the deepest project path that holds the folder. Two different homes that list that same project are
 * a tie. All paths are real paths.
 */
export const matchFolder = (projects: readonly IndexedProject[], folder: string): IndexMatch => {
  const holding = projects.filter(({ project }) => isSameOrInside(project, folder));
  const deepest = Math.max(0, ...holding.map(({ project }) => project.length));
  if (deepest === 0) return { kind: 'none' };
  const homes = [...new Set(holding.filter(({ project }) => project.length === deepest).map(({ home }) => home))].sort();
  const [first, ...others] = homes;
  if (first === undefined) return { kind: 'none' };
  return others.length === 0 ? { kind: 'one', home: first } : { kind: 'tie', homes };
};

const unusable = (path: string, reason: string): CliResult<never> =>
  usageError(
    `the home index ${path} cannot be used: ${reason}`,
    `Fix or remove that file, or use ${flagText(flags.home)} DIR.`,
  );

/**
 * The node home whose project holds the current folder, or null when no entry does. A home that is gone is ignored.
 * An index that cannot be read, and a tie between two homes, are errors that name the file or the homes.
 */
export const findHomeInIndex = async (deps: Deps): Promise<CliResult<string | null>> => {
  const path = await indexPathOf(deps);
  if (!path.ok) return path;
  if (path.value === null) return ok(null);
  const entries = await readHomeIndex(deps, path.value);
  if (!entries.ok) return unusable(path.value, entries.error);

  const folder = await deps.fs.realpath(deps.cwd);
  if (!folder.ok) return folder;
  const candidates = entries.value.flatMap((entry) =>
    entry[homeIndex.keys.projects].map((project) => ({ home: entry[homeIndex.keys.home], project })),
  );
  const holding = candidates.filter(({ project }) => isSameOrInside(project, folder.value));
  const present: IndexedProject[] = [];
  const checked = new Map<string, boolean>();
  for (const candidate of holding) {
    const known = checked.get(candidate.home);
    const exists = known ?? (await homeExists(deps, candidate.home));
    checked.set(candidate.home, exists);
    if (exists) present.push(candidate);
  }

  const match = matchFolder(present, folder.value);
  switch (match.kind) {
    case 'none':
      return ok(null);
    case 'one':
      return ok(match.home);
    case 'tie':
      return usageError(
        `the folder ${folder.value} is in a project of more than one ${roles.node} home: ${match.homes.join(', ')}`,
        `Use ${flagText(flags.home)} DIR to choose one.`,
      );
    default: {
      const unreachable: never = match;
      return unreachable;
    }
  }
};
