import { join, resolve } from 'node:path';
import { z } from 'zod';
import { usageError, type CliResult } from '../cli/errors.js';
import { absolutePath, slug } from '../config/primitives.js';
import { env, files, flagText, flags, homeIndex, roles } from '../names.js';
import { parseJsonText } from '../state/load.js';
import type { Deps } from './deps.js';
import { comparable, isSameOrInside, realPathOf } from './paths.js';
import { changePrivateFile, readPrivateText, userStatePathOf } from './private-file.js';
import { err, ok, type Result } from './result.js';
import { describeIssues } from './zod.js';

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
const textWithEntry = async (deps: Deps, path: string, current: string | null, entry: HomeEntry): Promise<Result<string, string>> => {
  const entries = entriesOf(current);
  if (!entries.ok) return err(`${path} cannot be read: ${entries.error}`);
  const added = withEntry(entries.value, entry);
  const next = added.length > homeIndex.maxHomes ? withEntry(await withoutGoneHomes(deps, entries.value), entry) : added;
  if (next.length > homeIndex.maxHomes) return err(`the index lists the most homes that it can: ${homeIndex.maxHomes}`);
  return ok(`${JSON.stringify({ [homeIndex.keys.schema]: homeIndex.schema, [homeIndex.keys.homes]: next }, null, 2)}\n`);
};

/**
 * Put the home in the index file. An entry of the same home is replaced. A file that cannot be read stays as it is.
 * The file is written atomically, with mode 0600, under a lock (see `changePrivateFile`). The error is the reason.
 */
export const recordHome = async (deps: Deps, path: string, entry: HomeEntry): Promise<Result<void, string>> => {
  if (entry[homeIndex.keys.projects].length > homeIndex.maxProjects) {
    return err(`a home can list at most ${homeIndex.maxProjects} projects`);
  }
  return changePrivateFile(deps, path, homeIndex.maxBytes, (current) => textWithEntry(deps, path, current, entry));
};

/** A node home for the index: its folder, its id and the paths of its projects as its config holds them. */
export interface IndexedNode {
  readonly home: string;
  readonly id: string;
  readonly projects: readonly string[];
}

/**
 * Put a node home in the index, so that a command finds it from a project folder. The error is a sentence that says the
 * index was not updated and why. `indexPath` is null when no variable names a folder. The caller decides what a
 * problem means: `init` undoes its work, and `upgrade` warns.
 */
export const recordNode = async (deps: Deps, indexPath: string | null, node: IndexedNode): Promise<Result<void, string>> => {
  if (indexPath === null) {
    return err(`The home index was not updated: ${env.stateHome} and ${env.userHome} name no folder.`);
  }
  const realHome = await realPathOf(deps, node.home);
  if (!realHome.ok) return err(`The home index ${indexPath} was not updated: ${realHome.error.message}`);
  const recorded = await recordHome(deps, indexPath, {
    [homeIndex.keys.home]: realHome.value,
    [homeIndex.keys.id]: node.id,
    [homeIndex.keys.projects]: node.projects.map((project) => resolve(realHome.value, project)),
  });
  return recorded.ok ? ok(undefined) : err(`The home index ${indexPath} was not updated: ${recorded.error}`);
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
