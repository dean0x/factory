import { isAbsolute, join, relative, sep } from 'node:path';
import { safetyRefusal, type CliResult } from '../cli/errors.js';
import {
  claudeSettings,
  commands,
  commandText,
  dirs,
  files,
  instructionFiles,
  places,
  program,
  roles,
  trackedFiles,
} from '../names.js';
import type { Layout } from '../state/layout.js';
import type { Deps } from './deps.js';
import { projectFolderKey } from './project-path.js';
import { ok } from './result.js';
import { visibleText } from './setup-acceptance.js';

/** The most parts that one path below the factory folder can have. A longer path is not one of ours. */
const MAX_PARTS = 32;

/** The remedy line of a link in `setup/`, in `coordinator/` or in the backup of a block. */
export const LINK_REMEDY = `Replace the link with a plain file inside the ${places.folder}, then run "${commandText(commands.doctor)}".`;

/** The parts of `path` below `root`, or null when `path` is not inside `root`. */
const partsBelow = (root: string, path: string): readonly string[] | null => {
  const rest = relative(root, path);
  if (isAbsolute(rest) || rest === '..' || rest.startsWith(`..${sep}`)) return null;
  const parts = rest.split(sep).filter((part) => part !== '');
  return parts.length <= MAX_PARTS ? parts : null;
};

/**
 * The link rule. No part of a path below the factory folder may be a link, because a link can lead to a file outside the
 * folder. The folders above the factory folder are the layout of the user, so they may hold links, and a factory folder
 * that is a link itself works. A part that does not exist ends the walk of its path: nothing below it can be a link.
 * The first link, or the first path outside the folder, is a security stop (exit 4) that names the part and the remedy.
 * The caller checks again before it writes, because a path can change after this check.
 */
export const requireNoLinks = async (
  deps: Deps,
  root: string,
  paths: readonly string[],
  remedy: string = LINK_REMEDY,
): Promise<CliResult<void>> => {
  for (const path of paths) {
    const parts = partsBelow(root, path);
    if (parts === null) {
      return safetyRefusal(`${path} is not inside the ${places.folder}, so ${program} does not use it`, remedy);
    }
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const kind = await deps.fs.lstat(current);
      if (!kind.ok) return kind;
      if (kind.value === null) break;
      if (kind.value === 'link') {
        return safetyRefusal(`${parts.slice(0, index + 1).join('/')} is a link, so ${program} does not use it`, remedy);
      }
    }
  }
  return ok(undefined);
};

/**
 * The paths that `init`, `upgrade` and `doctor` read or write below the factory folder, and that the link rule covers:
 * the setup folder and its two texts, the coordinator folder and its `CLAUDE.md`, the worker file and the backups. The
 * local file has its own check, with its own remedy line, in `localFileAccess`.
 */
export const rootGuardPaths = (layout: Layout): readonly string[] => [
  layout.setupCoordinatorFile,
  layout.setupWorkerFile,
  layout.claudeMd,
  layout.workerMd,
  layout.backupsDir,
];

/** Check the link rule for every path that the commands read or write below the factory folder. */
export const requireNoRootLinks = (deps: Deps, layout: Layout): Promise<CliResult<void>> =>
  requireNoLinks(deps, layout.home, rootGuardPaths(layout));

/**
 * The tracked set of a received root: every path that the root repo tracks, apart from `factory.yaml` and the
 * `.gitignore` of the root, which have their own checks. The set needs no list of names, so a new kind of file is in it
 * from the first day. The paths are relative to the root and keep the order of the list.
 */
export const trackedSetOf = (tracked: readonly string[]): readonly string[] =>
  tracked.filter((path) => path !== files.config && path !== files.gitignore);

/** The link rule for the paths that a repo tracks, which are relative to the root. A tracked link is a stop (exit 4). */
export const requireNoTrackedLinks = (deps: Deps, root: string, tracked: readonly string[]): Promise<CliResult<void>> =>
  requireNoLinks(
    deps,
    root,
    tracked.map((path) => join(root, path)),
  );

const lowerKey = (path: string): string => path.normalize('NFKC').toLowerCase();

/**
 * True when the tracked path is a file that a session can load as instructions, at any depth: a listed instruction file,
 * or a path below a listed folder (`.claude/rules`). The names come from `instructionFiles`. The compare ignores the
 * letter case, because a file system that ignores it loads `claude.md` as `CLAUDE.md`.
 */
export const isInstructionPath = (path: string): boolean => {
  const wanted = `/${lowerKey(path)}`;
  return instructionFiles.some((name) => {
    const listed = `/${lowerKey(name)}`;
    return wanted.endsWith(listed) || wanted.includes(`${listed}/`);
  });
};

/** True when the tracked path is a Claude Code settings file, directly in a `.claude` folder at any depth. */
export const isClaudeSettingsPath = (path: string): boolean => {
  const parts = lowerKey(path).split('/');
  const name = parts.at(-1) ?? '';
  return (
    parts.at(-2) === dirs.claude &&
    name.startsWith(claudeSettings.prefix) &&
    name.endsWith(claudeSettings.suffix)
  );
};

/** The tracked paths below one folder of the root: the first part of the path is the folder, in the form of the folder key. */
export const trackedUnder = (tracked: readonly string[], folder: string): readonly string[] =>
  tracked.filter((path) => path.includes('/') && projectFolderKey(path.split('/', 1)[0] ?? '') === projectFolderKey(folder));

/** The paths below the root that the ignore check probes, one for each thing that git must ignore. */
export interface IgnoreProbes {
  readonly local: string;
  readonly state: string;
  readonly coordinator: string;
  readonly workCopies: string;
  readonly clones: readonly string[];
}

/**
 * The probe paths of the ignore check. Git answers for one path, so each folder has a path inside it: a rule that ignores
 * the folder ignores the path. The probes are names that may or may not exist.
 */
export const ignoreProbesOf = (projectPaths: readonly string[]): IgnoreProbes => ({
  local: files.localConfig,
  state: join(dirs.state, files.nodeState),
  coordinator: join(dirs.coordinator, files.claudeMd),
  workCopies: join(dirs.workCopies, 'probe'),
  clones: projectPaths.map((path) => join(path, files.claudeMd)),
});

/** Why a tracked path stops `init`. */
export type TrackedProblemKind = 'local-file' | 'state-folder' | 'session-folder' | 'clone';

export interface TrackedProblem {
  readonly path: string;
  readonly kind: TrackedProblemKind;
}

/**
 * The tracked paths that stop `init` on a received or a moved root: the local file, a path in the state folder, a path in
 * the coordinator folder, and (when the caller names the clone folders) a path in a clone folder. The first part of the
 * path decides, in the normal form of the folder key, so a case-blind file system finds no way around the check.
 * The problems keep the order of the list.
 */
export const trackedProblems = (tracked: readonly string[], cloneFolders: readonly string[]): readonly TrackedProblem[] => {
  const clones = new Set(cloneFolders.map(projectFolderKey));
  const kindOf = (path: string): TrackedProblemKind | null => {
    const first = projectFolderKey(path.split('/', 1)[0] ?? '');
    if (path.indexOf('/') < 0 && first === projectFolderKey(files.localConfig)) return 'local-file';
    if (first === projectFolderKey(dirs.state)) return 'state-folder';
    if (first === projectFolderKey(dirs.coordinator)) return 'session-folder';
    return clones.has(first) ? 'clone' : null;
  };
  return tracked.flatMap((path) => {
    const kind = kindOf(path);
    return kind === null ? [] : [{ path, kind }];
  });
};

/** The most items that a message names. A longer list ends with the count of the rest. */
export const MAX_NAMED_ITEMS = 5;

/** A path as one line of text: every control character shows as an escape, the line break and the tab among them. */
export const shownPath = (path: string): string => visibleText(path).replaceAll('\n', '\\n').replaceAll('\t', '\\t');

/** The first items of a list as text, and the count of the rest. */
export const namedItems = (items: readonly string[]): string =>
  items.slice(0, MAX_NAMED_ITEMS).join(', ') +
  (items.length > MAX_NAMED_ITEMS ? ` and ${items.length - MAX_NAMED_ITEMS} more` : '');

/** The remedy line for the tracked paths that must stay on this machine. */
export const REMOVE_REMEDY =
  'Remove each of them from git with "git rm --cached", commit the change, then run the command again.';

/** The stop for a list of tracked files over its cap, and its remedy line. */
export const TRACKED_CAP_MESSAGE = `the root repo tracks more than ${trackedFiles.maxCount} files, so ${program} does not hash them`;
export const TRACKED_CAP_REMEDY = `Remove the files that the ${places.folder} does not need from git with "git rm --cached", then run "${commandText(commands.init)}" again.`;

const trackedProblemText = (problem: TrackedProblem): string => {
  switch (problem.kind) {
    case 'local-file':
      return `the local file ${shownPath(problem.path)}`;
    case 'state-folder':
      return `${shownPath(problem.path)} in the state folder ${dirs.state}`;
    case 'session-folder':
      return `${shownPath(problem.path)} in the ${roles.coordinator} folder ${dirs.coordinator}`;
    case 'clone':
      return `${shownPath(problem.path)} in a project folder`;
    default: {
      const unreachable: never = problem.kind;
      return unreachable;
    }
  }
};

/** The tracked problems as text: at most five of them, and the count of the rest. */
export const describeTrackedProblems = (problems: readonly TrackedProblem[]): string =>
  namedItems(problems.map(trackedProblemText));
