import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { usageError, type CliResult } from '../cli/errors.js';
import { absolutePath, slug } from '../config/primitives.js';
import { commands, commandText, env, files, flagText, flags, homeIndex, places, type CommandName } from '../names.js';
import { parseJsonText } from '../state/load.js';
import type { Deps } from './deps.js';
import { commonDirOf, GIT_ENTRY } from './git.js';
import { comparable, isInUserClaudeFolder, isSameOrInside, realPathOf, requireOutsideUserClaudeFolder } from './paths.js';
import { changePrivateFile, readPrivateText, userStatePathOf } from './private-file.js';
import { err, ok, type Result } from './result.js';
import { describeIssues } from './zod.js';

const entrySchema = z.strictObject({
  [homeIndex.keys.home]: absolutePath,
  [homeIndex.keys.id]: slug,
  [homeIndex.keys.projects]: z.array(absolutePath).max(homeIndex.maxProjects),
  // Any value parses. `originOf` is the one reader, and it counts every value but the exact word `own` as received.
  [homeIndex.keys.origin]: z.unknown().optional(),
});

const indexSchema = z.strictObject({
  [homeIndex.keys.schema]: z.literal(homeIndex.schema),
  [homeIndex.keys.homes]: z.array(entrySchema).max(homeIndex.maxHomes),
});

/** One node home in the index: its folder, its id, the real path of each of its projects and its origin. */
export type HomeEntry = z.infer<typeof entrySchema>;

/** Whether the root is the owner's own or came from another machine or person. */
export type Origin = (typeof homeIndex.origins)[keyof typeof homeIndex.origins];

/**
 * The origin of a root, from its entry in the index. This is the one reader. Only the exact value `own` counts as own. A
 * missing value, any other value and a root with no entry count as received. The origin never comes from a file in the
 * root, because a pull can change every file there, and it can not change the index.
 */
export const originOf = (entry: HomeEntry | null): Origin =>
  entry?.[homeIndex.keys.origin] === homeIndex.origins.own ? homeIndex.origins.own : homeIndex.origins.received;

/** The index file, in the state folder of the user (see `userStatePathOf`). It is null when no variable names a folder. */
export const indexPathOf = (deps: Deps): Promise<CliResult<string | null>> => userStatePathOf(deps, files.homeIndex);

/** The entries of an index text. A file that does not exist holds no entry. The error is the reason. */
const entriesOf = (text: string | null): Result<readonly HomeEntry[], string> => {
  if (text === null) return ok([]);
  const json = parseJsonText(text);
  if (!json.ok) return json;
  const parsed = indexSchema.safeParse(json.value);
  return parsed.success ? ok(parsed.data[homeIndex.keys.homes]) : err(describeIssues(parsed.error));
};

/**
 * The entries of the index file. A file that does not exist holds no entry. A file or a folder that another user owns
 * or can write is refused. The error is the reason.
 */
export const readHomeIndex = async (deps: Deps, path: string): Promise<Result<readonly HomeEntry[], string>> => {
  const text = await readPrivateText(deps, path, homeIndex.maxBytes);
  return text.ok ? entriesOf(text.value) : text;
};

/** The entries with `entry` in place of the entry of the same home, or at the end. */
const withEntry = (entries: readonly HomeEntry[], entry: HomeEntry): readonly HomeEntry[] => {
  const key = homeIndex.keys.home;
  return entries.some((candidate) => candidate[key] === entry[key])
    ? entries.map((candidate) => (candidate[key] === entry[key] ? entry : candidate))
    : [...entries, entry];
};

/**
 * The text of the index with the entry added. When the index has no room for the entry, the entries whose home is gone
 * are dropped first. A home that cannot be checked stays.
 */
const textWithEntry = async (
  deps: Deps,
  path: string,
  current: string | null,
  wanted: HomeEntry,
  settle: Settle,
): Promise<Result<string, string>> => {
  const entries = entriesOf(current);
  if (!entries.ok) return err(`${path} cannot be read: ${entries.error}`);
  const entry = settle(entries.value.find((candidate) => candidate[homeIndex.keys.home] === wanted[homeIndex.keys.home]), wanted);
  const added = withEntry(entries.value, entry);
  const next = added.length > homeIndex.maxHomes ? withEntry(await withoutGoneHomes(deps, entries.value), entry) : added;
  if (next.length > homeIndex.maxHomes) return err(`the ${places.list} lists the most ${places.folder}s that it can: ${homeIndex.maxHomes}`);
  return ok(`${JSON.stringify({ [homeIndex.keys.schema]: homeIndex.schema, [homeIndex.keys.homes]: next }, null, 2)}\n`);
};

/**
 * What goes into the index for a home: the old entry of the same home, or undefined, and the entry that the caller wants.
 * The call runs under the lock, so the old entry is the entry that the write replaces.
 */
type Settle = (existing: HomeEntry | undefined, wanted: HomeEntry) => HomeEntry;

const asWanted: Settle = (_existing, wanted) => wanted;

/**
 * The result of a write of the index. The warning names a lock file that stays after a saved change, or it is null. A change
 * that is saved with a lock file left counts as written.
 */
export interface HomeWrite {
  readonly warning: string | null;
}

/**
 * Put the home in the index file. An entry of the same home is replaced. A file that cannot be read stays as it is.
 * The file is written atomically, with mode 0600, under a lock (see `changePrivateFile`). The error is the reason. A change
 * that is saved with only the lock file left (`writeState` is `saved-lock-left`) is a success, and the warning names the
 * lock file. `settle` changes the entry under the lock, from the old entry of the same home.
 */
export const recordHome = async (
  deps: Deps,
  path: string,
  entry: HomeEntry,
  settle: Settle = asWanted,
): Promise<Result<HomeWrite, string>> => {
  if (entry[homeIndex.keys.projects].length > homeIndex.maxProjects) {
    return err(`a ${places.folder} can list at most ${homeIndex.maxProjects} projects`);
  }
  const written = await changePrivateFile(deps, path, homeIndex.maxBytes, (current) => textWithEntry(deps, path, current, entry, settle));
  if (written.ok) return ok({ warning: null });
  return written.error.writeState === 'saved-lock-left' ? ok({ warning: written.error.message }) : err(written.error.message);
};

/**
 * A node home for the index: its folder, its id, the paths of its projects as its config holds them, and the origin that
 * the run asks for. The index may keep another origin than `own` (see `settleOrigin`).
 */
export interface IndexedNode {
  readonly home: string;
  readonly id: string;
  readonly projects: readonly string[];
  readonly origin: Origin;
  /** True when this run made the root. Only a new root can go from `received` back to `own`. */
  readonly newRoot?: boolean;
}

/**
 * The entry that goes into the index. A received root is always `received`. A root that this run made is `own`. A
 * root that was there before the run is `own` only when no entry exists for it, or when the old entry is `own` with the
 * same node id. A config with another node id is the config of another factory. So the origin goes from `own` to
 * `received`, and it never goes back, unless `init` makes a new root.
 */
const settleOrigin =
  (node: IndexedNode): Settle =>
  (existing, wanted) => {
    const { own, received } = homeIndex.origins;
    const keepsOwn =
      node.origin === own &&
      (node.newRoot === true ||
        existing === undefined ||
        (originOf(existing) === own && existing[homeIndex.keys.id] === wanted[homeIndex.keys.id]));
    return { ...wanted, [homeIndex.keys.origin]: keepsOwn ? own : received };
  };

/**
 * Put a node home in the index, so that a command finds it from a project folder. The error is a sentence that says the
 * index was not updated and why. `indexPath` is null when no variable names a folder. A saved entry with a lock file left is
 * a success, and the warning names the index and the lock file. The caller decides what an error means: `init` undoes its
 * work, and `upgrade` warns.
 */
export const recordNode = async (deps: Deps, indexPath: string | null, node: IndexedNode): Promise<Result<HomeWrite, string>> => {
  if (indexPath === null) {
    return err(`The ${places.list} was not updated: ${env.stateHome} and ${env.userHome} name no folder.`);
  }
  const realHome = await realPathOf(deps, node.home);
  if (!realHome.ok) return err(`The ${places.list} ${indexPath} was not updated: ${realHome.error.message}`);
  const recorded = await recordHome(
    deps,
    indexPath,
    {
      [homeIndex.keys.home]: realHome.value,
      [homeIndex.keys.id]: node.id,
      [homeIndex.keys.projects]: node.projects.map((project) => resolve(realHome.value, project)),
    },
    settleOrigin(node),
  );
  if (!recorded.ok) return err(`The ${places.list} ${indexPath} was not updated: ${recorded.error}`);
  return ok({ warning: recorded.value.warning === null ? null : `The ${places.list} ${indexPath}: ${recorded.value.warning}` });
};

/** The entry of the index that has this home, as it is written or by its real path, or null when no entry has it. */
export const entryOfHome = async (deps: Deps, entries: readonly HomeEntry[], home: string): Promise<HomeEntry | null> => {
  const real = await realPathOf(deps, home);
  const wanted = [home, ...(real.ok ? [real.value] : [])].map((candidate) => comparable(deps, candidate));
  return entries.find((entry) => wanted.includes(comparable(deps, entry[homeIndex.keys.home]))) ?? null;
};

/**
 * The origin of a folder, read from the index (see `originOf`). An index that has no place, that cannot be read or that
 * has no entry for the folder gives `received`: a check that depends on the origin takes the safe rule.
 */
export const originOfHome = async (deps: Deps, home: string): Promise<Origin> => {
  const path = await indexPathOf(deps);
  if (!path.ok || path.value === null) return homeIndex.origins.received;
  const entries = await readHomeIndex(deps, path.value);
  return entries.ok ? originOf(await entryOfHome(deps, entries.value, home)) : homeIndex.origins.received;
};

/** The folder of the first entry that has a project holding this folder, or null. The folder is a real path. */
export const homeHoldingFolder = (entries: readonly HomeEntry[], folder: string): string | null =>
  entries.find((entry) => entry[homeIndex.keys.projects].some((project) => isSameOrInside(project, folder)))?.[
    homeIndex.keys.home
  ] ?? null;

/** Whether the folder of the home holds its config file. 'unknown' is a home that cannot be checked. */
type HomeState = 'present' | 'gone' | 'unknown';

/**
 * A home in the settings folder of Claude Code is not asked about: it is 'unknown', and the file system gets no call. A
 * command that finds its home from the entry stops first (see `findHomeInIndex`).
 */
const homeStateOf = async (deps: Deps, home: string): Promise<HomeState> => {
  if (isInUserClaudeFolder(deps, home)) return 'unknown';
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

/**
 * The folder of the first root in the list that holds `folder` below it, or null. A folder that is a listed root itself
 * does not count, so a root can be made again. A root that no longer holds its config file is ignored. `folder` may not
 * exist yet; its links are resolved as far as it exists.
 */
export const listedRootAbove = async (
  deps: Deps,
  entries: readonly HomeEntry[],
  folder: string,
): Promise<CliResult<string | null>> => {
  const real = await realPathOf(deps, folder);
  if (!real.ok) return real;
  const wanted = comparable(deps, real.value);
  for (const entry of entries) {
    const root = entry[homeIndex.keys.home];
    const listed = comparable(deps, root);
    if (listed !== wanted && isSameOrInside(listed, wanted) && (await homeExists(deps, root))) return ok(root);
  }
  return ok(null);
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
  return matchOfHomes(holding.filter(({ project }) => project.length === deepest).map(({ home }) => home));
};

/** No home, one home, or a tie between the different homes of the list. */
const matchOfHomes = (homes: readonly string[]): IndexMatch => {
  const sorted = [...new Set(homes)].sort();
  const [first, ...others] = sorted;
  if (first === undefined) return { kind: 'none' };
  return others.length === 0 ? { kind: 'one', home: first } : { kind: 'tie', homes: sorted };
};

const unusable = (path: string, reason: string, command: CommandName): CliResult<never> =>
  usageError(
    `the ${places.list} ${path} cannot be used: ${reason}`,
    `Fix or remove that file, or use ${flagText(flags.home)} DIR. Then run "${commandText(command)}" again.`,
  );

/** The entries of the index file, or null when no variable names a folder for it. An index that cannot be read is an error. */
const readEntries = async (deps: Deps, command: CommandName): Promise<CliResult<readonly HomeEntry[] | null>> => {
  const path = await indexPathOf(deps);
  if (!path.ok) return path;
  if (path.value === null) return ok(null);
  const entries = await readHomeIndex(deps, path.value);
  return entries.ok ? ok(entries.value) : unusable(path.value, entries.error, command);
};

/** Every project of every entry, with the home of its entry. */
const projectsOf = (entries: readonly HomeEntry[]): readonly IndexedProject[] =>
  entries.flatMap((entry) => entry[homeIndex.keys.projects].map((project) => ({ home: entry[homeIndex.keys.home], project })));

/**
 * The candidates whose home still holds its config file. A home in the settings folder of Claude Code is a stop (exit 4) before
 * any call on it. Each home is checked once.
 */
const presentOf = async (deps: Deps, candidates: readonly IndexedProject[]): Promise<CliResult<readonly IndexedProject[]>> => {
  const present: IndexedProject[] = [];
  const checked = new Map<string, boolean>();
  for (const candidate of candidates) {
    const outside = requireOutsideUserClaudeFolder(deps, candidate.home, commands.doctor);
    if (!outside.ok) return outside;
    const known = checked.get(candidate.home);
    const exists = known ?? (await homeExists(deps, candidate.home));
    checked.set(candidate.home, exists);
    if (exists) present.push(candidate);
  }
  return ok(present);
};

/** The home that a match names: its one home, or null for none. Two homes are an error, and `tie` is the start of its message. */
const homeOfMatch = (match: IndexMatch, tie: string, command: CommandName): CliResult<string | null> => {
  switch (match.kind) {
    case 'none':
      return ok(null);
    case 'one':
      return ok(match.home);
    case 'tie':
      return usageError(
        `${tie}: ${match.homes.join(', ')}`,
        `Run "${commandText(command)}" again with ${flagText(flags.home)} DIR to choose one.`,
      );
    default: {
      const unreachable: never = match;
      return unreachable;
    }
  }
};

/** The home whose project holds the current folder, or null. The caller has read the entries. */
const homeHoldingCwd = async (deps: Deps, entries: readonly HomeEntry[], command: CommandName): Promise<CliResult<string | null>> => {
  const folder = await deps.fs.realpath(deps.cwd);
  if (!folder.ok) return folder;
  const holding = projectsOf(entries).filter(({ project }) => isSameOrInside(project, folder.value));
  const present = await presentOf(deps, holding);
  if (!present.ok) return present;
  return homeOfMatch(
    matchFolder(present.value, folder.value),
    `the folder ${folder.value} is in a project of more than one ${places.folder}`,
    command,
  );
};

/**
 * The home of a listed project whose git folder is the common git folder of the current folder, or null. The current folder is then
 * a git work tree of the project that lies outside it, for example a work tree that `git worktree add` made. A project counts when
 * the common git folder is its own `.git` folder, so the check is one git call on the current folder and no call on a project.
 */
const homeOfWorkTree = async (deps: Deps, entries: readonly HomeEntry[], command: CommandName): Promise<CliResult<string | null>> => {
  const projects = projectsOf(entries);
  if (projects.length === 0) return ok(null);
  const common = await commonDirOf(deps, deps.cwd);
  if (common === null) return ok(null);
  const real = await realPathOf(deps, common);
  if (!real.ok) return real;
  if (basename(real.value) !== GIT_ENTRY) return ok(null);
  const repo = dirname(real.value);
  const present = await presentOf(
    deps,
    projects.filter(({ project }) => comparable(deps, project) === comparable(deps, repo)),
  );
  if (!present.ok) return present;
  return homeOfMatch(
    matchOfHomes(present.value.map(({ home }) => home)),
    `the git repo ${repo} belongs to a project of more than one ${places.folder}`,
    command,
  );
};

/**
 * The node home whose project holds the current folder, or null when no entry does. When no project holds the folder, the home
 * whose project has the same git repo as the folder (a work tree of the project outside it). A home that is gone is ignored.
 * An index that cannot be read, and a tie between two homes, are errors that name the file or the homes. An entry that
 * holds the current folder and whose home is in the settings folder of Claude Code is a stop (exit 4) before any call on it.
 * `command` is the command that runs: the remedy line of an error names it.
 */
export const findHomeInIndex = async (deps: Deps, command: CommandName): Promise<CliResult<string | null>> => {
  const entries = await readEntries(deps, command);
  if (!entries.ok || entries.value === null) return entries.ok ? ok(null) : entries;
  const holding = await homeHoldingCwd(deps, entries.value, command);
  if (!holding.ok || holding.value !== null) return holding;
  return homeOfWorkTree(deps, entries.value, command);
};
