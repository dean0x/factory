import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { commandText, commands, dirs, env, instructionFiles, places } from '../names.js';
import type { Deps } from './deps.js';
import { comparable, isSameOrInside, realPathOf } from './paths.js';

/**
 * The instruction-file check (design 4.3, the instruction-file rule). An agent loads instruction files from its
 * working folder and from every folder above it, so a file in or above the root reaches every session of the factory.
 * The check walks from the root to the top of the file system and tests which paths of `instructionFiles` exist. It
 * only warns: it never stops a command (F-17c), and it never reads a file.
 *
 * The user Claude folder is the folder of the user level instructions. The walk never looks inside it. In the user
 * home folder it skips the paths that start with the Claude folder name. So factory cannot see the instructions of the
 * user level, which are the choice of the user.
 */

/** The most folders that the walk looks at: the root and the folders above it. */
export const MAX_WALK_LEVELS = 64;

export interface UnreadableFolder {
  readonly folder: string;
  readonly reason: string;
}

export interface InstructionFileScan {
  /** The paths of the files that exist, the root first and then each folder above it. */
  readonly found: readonly string[];
  /** The folders that the walk could not read. The walk goes on with the next folder. */
  readonly unreadable: readonly UnreadableFolder[];
  /** True when the walk stopped at `MAX_WALK_LEVELS` folders and the top of the file system was not reached. */
  readonly truncated: boolean;
}

/** The user home folder and the user Claude folder, as written and with the links resolved. */
interface UserFolders {
  readonly home: readonly string[];
  readonly claude: readonly string[];
}

/** Where a folder is: inside the user Claude folder, in the user home folder (or may be), or elsewhere. */
type Place = 'claude-folder' | 'user-home' | 'elsewhere';

/** Null when the variable of the user home is not set or is not an absolute path. */
const userFoldersOf = async (deps: Deps): Promise<UserFolders | null> => {
  const written = deps.env[env.userHome];
  if (written === undefined || !isAbsolute(written)) return null;
  const home = resolve(written);
  const real = await realPathOf(deps, home);
  if (!real.ok) return null;
  const forms = [home, real.value];
  return { home: forms, claude: forms.map((form) => join(form, dirs.claude)) };
};

const insideAny = (deps: Deps, parents: readonly string[], path: string): boolean =>
  parents.some((parent) => isSameOrInside(comparable(deps, parent), comparable(deps, path)));

/**
 * True when the folder is in the user Claude folder by the way its path is written, so that no call of the file system
 * is needed to know it. With no user home known, a folder with the Claude folder name in its path counts.
 */
const insideClaudeByName = (deps: Deps, user: UserFolders | null, folder: string): boolean =>
  user === null ? folder.split(sep).includes(dirs.claude) : insideAny(deps, user.claude, folder);

const placeOf = (deps: Deps, user: UserFolders | null, folder: string, real: string, isRoot: boolean): Place => {
  if (user === null) {
    // The user home is not known, so every folder above the root may be it.
    return isRoot ? 'elsewhere' : 'user-home';
  }
  if (insideAny(deps, user.claude, real)) return 'claude-folder';
  const forms = [comparable(deps, folder), comparable(deps, real)];
  return user.home.some((home) => forms.includes(comparable(deps, home))) ? 'user-home' : 'elsewhere';
};

const inClaudeFolder = (name: string): boolean => name.startsWith(`${dirs.claude}/`);

interface Looked {
  readonly found: readonly string[];
  readonly unreadable: UnreadableFolder | null;
}

const NOTHING: Looked = { found: [], unreadable: null };

/** Test which listed paths exist in one folder. A call that fails ends the look at this folder. */
const lookIn = async (deps: Deps, user: UserFolders | null, folder: string, isRoot: boolean): Promise<Looked> => {
  if (insideClaudeByName(deps, user, folder)) return NOTHING;
  const real = await realPathOf(deps, folder);
  if (!real.ok) return { found: [], unreadable: { folder, reason: real.error.message } };
  const place = placeOf(deps, user, folder, real.value, isRoot);
  if (place === 'claude-folder') return NOTHING;
  const names = place === 'user-home' ? instructionFiles.filter((name) => !inClaudeFolder(name)) : instructionFiles;
  const found: string[] = [];
  for (const name of names) {
    const path = join(folder, name);
    const kind = await deps.fs.lstat(path);
    if (!kind.ok) return { found, unreadable: { folder, reason: kind.error.message } };
    if (kind.value !== null) found.push(path);
  }
  return { found, unreadable: null };
};

/**
 * Find the instruction files in the root and in the folders above it, at most `MAX_WALK_LEVELS` folders. A path that is
 * a link counts as a file. The scan never fails: a folder that can not be read is part of the result.
 */
export const scanInstructionFiles = async (deps: Deps, root: string): Promise<InstructionFileScan> => {
  const user = await userFoldersOf(deps);
  const found: string[] = [];
  const unreadable: UnreadableFolder[] = [];
  let folder = resolve(root);
  for (let level = 0; level < MAX_WALK_LEVELS; level += 1) {
    const looked = await lookIn(deps, user, folder, level === 0);
    found.push(...looked.found);
    if (looked.unreadable !== null) unreadable.push(looked.unreadable);
    const parent = dirname(folder);
    if (parent === folder) return { found, unreadable, truncated: false };
    folder = parent;
  }
  return { found, unreadable, truncated: true };
};

const CHECK_NAME = 'The check for agent instruction files';

/** The lines of the warning, empty for a scan with nothing to say. `doctor`, `start` and `init` all print these lines. */
export const instructionFileWarnings = (scan: InstructionFileScan): readonly string[] => [
  ...(scan.found.length === 0
    ? []
    : [
        `Agent instruction files are in the ${places.folder} or above it: ${scan.found.join(', ')}. ` +
          'A session can load them. Move each file out of those folders, or keep it on purpose. ' +
          `Then run "${commandText(commands.doctor)}".`,
      ]),
  ...(scan.unreadable.length === 0
    ? []
    : [`${CHECK_NAME} did not look in ${scan.unreadable.map((entry) => `${entry.folder} (${entry.reason})`).join('; ')}.`]),
  ...(scan.truncated
    ? [`${CHECK_NAME} stopped after ${MAX_WALK_LEVELS} folders. It did not look in the folders above them.`]
    : []),
];

/** Print the warning at once, before the command acts. It prints nothing for a clean scan, and it never stops the command. */
export const warnInstructionFiles = async (deps: Deps, root: string): Promise<void> => {
  for (const line of instructionFileWarnings(await scanInstructionFiles(deps, root))) deps.warn(line);
};
