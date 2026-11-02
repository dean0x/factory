import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { slug } from '../config/primitives.js';
import { dirs, env, files, flagText, flags, homeIndex, program, roles } from '../names.js';
import { parseJsonText } from '../state/load.js';
import type { Deps } from './deps.js';
import { isSameOrInside, realPathOf } from './paths.js';
import { err, ok, type Result } from './result.js';
import { describeIssues } from './zod.js';

const MAX_PATH_CHARS = 4096;
/** The value of `process.platform` on macOS. */
const MACOS = 'darwin';
/** The folder of the index is private to the user, and so is the file. */
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;

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

/** The path in the form that is compared: macOS has a file system that ignores the case of letters. */
const comparable = (deps: Deps, path: string): string => (deps.platform.os === MACOS ? path.toLowerCase() : path);

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
  const [realPath, realClaudeDir] = [await realPathOf(deps, path), await realPathOf(deps, claudeDir)];
  if (!realPath.ok) return realPath;
  if (!realClaudeDir.ok) return realClaudeDir;
  const inside =
    isSameOrInside(comparable(deps, claudeDir), comparable(deps, path)) ||
    isSameOrInside(comparable(deps, realClaudeDir.value), comparable(deps, realPath.value));
  if (inside) {
    return safetyRefusal(
      `the home index would be ${path}, inside ${claudeDir}`,
      `Claude Code owns that folder. Set ${env.stateHome} to another absolute folder.`,
    );
  }
  return ok(path);
};

/** The entries of the index file. A file that does not exist holds no entry. The error is the reason. */
export const readHomeIndex = async (deps: Deps, path: string): Promise<Result<readonly HomeEntry[], string>> => {
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return err(kind.error.message);
  if (kind.value === null) return ok([]);
  if (kind.value !== 'file') return err('it is not a file');
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
 * Put the home in the index file. An entry of the same home is replaced. A file that cannot be read stays as it is.
 * The file is written atomically, with mode 0600, in a folder of mode 0700. The error is the reason.
 */
export const recordHome = async (deps: Deps, path: string, entry: HomeEntry): Promise<Result<void, string>> => {
  if (entry[homeIndex.keys.projects].length > homeIndex.maxProjects) {
    return err(`a home can list at most ${homeIndex.maxProjects} projects`);
  }
  const entries = await readHomeIndex(deps, path);
  if (!entries.ok) return err(`${path} cannot be read: ${entries.error}`);
  const next = withEntry(entries.value, entry);
  if (next.length > homeIndex.maxHomes) return err(`the index lists the most homes that it can: ${homeIndex.maxHomes}`);

  const text = `${JSON.stringify({ [homeIndex.keys.schema]: homeIndex.schema, [homeIndex.keys.homes]: next }, null, 2)}\n`;
  const folder = await deps.fs.mkdir(dirname(path), FOLDER_MODE);
  if (!folder.ok) return err(folder.error.message);
  const written = await deps.fs.writeTextAtomic(path, text, FILE_MODE);
  return written.ok ? ok(undefined) : err(written.error.message);
};

/** True when the folder of the home still holds its config file. */
const homeExists = async (deps: Deps, home: string): Promise<boolean> => {
  const kind = await deps.fs.stat(join(home, files.config));
  return kind.ok && kind.value === 'file';
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
