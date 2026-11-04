import { basename, dirname, join, resolve } from 'node:path';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { printable } from '../cli/output.js';
import { localFileAccess } from '../config/load.js';
import { ACCEPT_ANSWER, type Deps } from '../core/deps.js';
import { listRepoChildren, MAX_SCAN_ENTRIES, workTreeTop, type SkippedFolder } from '../core/git.js';
import { listedRootAbove, readHomeIndex } from '../core/home-index.js';
import { requireOutsideUserClaudeFolder } from '../core/paths.js';
import { ok } from '../core/result.js';
import { commands, commandText, dirs, files, flags, flagText, places, program, roles } from '../names.js';
import { isStagingDirName, layoutOf } from '../state/layout.js';

export interface HomeChoice {
  readonly home: string;
  /**
   * The git work trees that the command found and that become the first projects: the work tree that the command
   * runs in, or each repo of a workspace folder. Empty when the home is not proposed.
   */
  readonly found: readonly string[];
  /** The folders of a workspace folder that are one more checkout of a repo in `found`. */
  readonly skipped: readonly SkippedFolder[];
  /** True when a workspace folder holds more entries than the scan reads. */
  readonly truncated: boolean;
  /** What the home is for `init`. */
  readonly kind: FolderKind;
}

const NOT_PROPOSED = { found: [], skipped: [], truncated: false } as const;

/**
 * What a folder is for `init`. `received`: it holds `factory.yaml` and no local file, so a factory arrived in it. `both`:
 * it holds both config files, so a factory is there already. `other`: it holds no `factory.yaml`; `checkHomeIsNew` decides
 * what happens then.
 */
export type FolderKind = 'received' | 'both' | 'other';

/** The kind of a folder. A local file counts as present when its path is any kind of entry, a dangling link included. */
export const folderKindOf = async (deps: Deps, folder: string): Promise<CliResult<FolderKind>> => {
  const layout = layoutOf(folder);
  const config = await deps.fs.stat(layout.configFile);
  if (!config.ok) return config;
  if (config.value !== 'file') return ok('other');
  const local = await deps.fs.lstat(layout.localConfigFile);
  if (!local.ok) return local;
  return ok(local.value === null ? 'received' : 'both');
};

const describeSkipped = (skipped: readonly SkippedFolder[]): string =>
  skipped.length === 0
    ? ''
    : ` Skipped: ${skipped.map((folder) => `${folder.path} (${folder.reason})`).join('; ')}.`;

/**
 * Ask for the proposed home. The yes flag accepts it. A person accepts it on a terminal.
 * With no terminal and no yes flag, the command prints the proposal and exits with a usage error.
 */
const confirmProposal = async (
  deps: Deps,
  yes: boolean,
  choice: HomeChoice,
  reason: string,
): Promise<CliResult<HomeChoice>> => {
  if (yes) return ok(choice);
  const about = `${reason}.${describeSkipped(choice.skipped)} The proposed ${places.folder} is ${choice.home}`;
  if (!(deps.stdinIsTTY && deps.stdoutIsTTY)) {
    return usageError(
      about,
      `Run "${commandText(commands.init)}" again with ${flagText(flags.yes)} to use it, or with ${flagText(flags.home)} DIR to choose another folder.`,
    );
  }
  const answer = await deps.prompt(printable(`${about}\nCreate the ${places.folder} here? [y/N] `));
  if (!answer.ok) return answer;
  if (ACCEPT_ANSWER.test(answer.value.trim())) return ok(choice);
  return usageError(
    `the ${places.folder} ${choice.home} was not accepted`,
    `Pass ${flagText(flags.home)} DIR to choose a folder.`,
  );
};

/** The name of the home beside a folder: `<folder name>-factory`. */
const proposedName = (folder: string): string | null => {
  const name = basename(folder);
  return name === '' ? null : `${name}-${program}`;
};

export const nodeExists = (home: string): CliResult<never> =>
  failure(
    `${files.config} already exists in ${home}`,
    `That folder is already a ${roles.node}. Run "${commandText(commands.doctor)}".`,
  );

/** The folder holds no node: no config file, no state folder, and it is a folder or does not exist. */
export const checkHomeIsNew = async (deps: Deps, home: string): Promise<CliResult<void>> => {
  const layout = layoutOf(home);
  const configKind = await deps.fs.stat(layout.configFile);
  if (!configKind.ok) return configKind;
  if (configKind.value !== null) return nodeExists(home);
  // A local file with no shared file next to it is not ours to replace: it can hold values of a person.
  // The command stops with exit 4 when another account owns it or others can write it, as every command does.
  const localAccess = await localFileAccess(deps, home);
  if (!localAccess.ok) return localAccess;
  if (localAccess.value.kind !== 'absent') {
    return failure(
      `${files.localConfig} already exists in ${home}`,
      `Move it away, or use another folder. Then run "${commandText(commands.init)}" again.`,
    );
  }
  const stateKind = await deps.fs.stat(layout.stateDir);
  if (!stateKind.ok) return stateKind;
  if (stateKind.value !== null) {
    return failure(
      `${dirs.state} already exists in ${home}`,
      `Remove it, or use another folder. Then run "${commandText(commands.init)}" again.`,
    );
  }
  const homeKind = await deps.fs.stat(home);
  if (!homeKind.ok) return homeKind;
  if (homeKind.value !== null && homeKind.value !== 'dir') return failure(`${home} is not a folder`);
  return ok(undefined);
};

/**
 * The new root is not inside a root that the factory list holds (exit 1). A root can sit beside another root, and a
 * root that is listed already can be made again. An unreadable list stops the command before it writes anything.
 */
export const checkHomeOutsideRoots = async (deps: Deps, indexPath: string, home: string): Promise<CliResult<void>> => {
  const entries = await readHomeIndex(deps, indexPath);
  if (!entries.ok) {
    return failure(
      `the ${places.list} ${indexPath} cannot be read: ${entries.error}`,
      `Fix or remove that file, then run "${commandText(commands.init)}" again.`,
    );
  }
  const around = await listedRootAbove(deps, entries.value, home);
  if (!around.ok) return around;
  if (around.value === null) return ok(undefined);
  return failure(
    `the ${places.folder} ${home} is inside the ${places.folder} ${around.value}`,
    `A ${places.folder} must be outside every other ${places.folder}. Choose another folder with ${flagText(flags.home)} DIR.`,
  );
};

/**
 * Choose the node home. The home flag wins. Else, in a git work tree, the proposal is a folder beside the work tree;
 * a work tree whose top holds `factory.yaml` is a factory that is there already, and the top is the home. The kind says
 * which: `received` with no local file, `both` with a local file. Else, in a folder that holds `factory.yaml`, that
 * folder is the home, with the same two kinds. Else, in a folder that holds git repos one level down, the proposal is a
 * folder inside it, and each repo is a project.
 * A person confirms the proposal on a terminal, or the yes flag confirms it. Else the home is the current folder.
 */
export const chooseHome = async (
  deps: Deps,
  options: { readonly home: string | undefined; readonly yes: boolean },
): Promise<CliResult<HomeChoice>> => {
  // The check comes before any call on a folder. With no home flag, the command asks about the current folder and the
  // folders around it, so the current folder is the one to check.
  const named = options.home === undefined ? undefined : resolve(deps.cwd, options.home);
  const outside = requireOutsideUserClaudeFolder(deps, named ?? resolve(deps.cwd), commands.init);
  if (!outside.ok) return outside;
  if (named !== undefined) {
    const kind = await folderKindOf(deps, named);
    return kind.ok ? ok({ home: named, ...NOT_PROPOSED, kind: kind.value }) : kind;
  }
  const refuse = (folder: string): CliResult<never> =>
    usageError(`cannot make a name for the ${places.folder} from the folder ${folder}`, `Pass ${flagText(flags.home)} DIR.`);

  const top = await workTreeTop(deps, deps.cwd);
  if (top !== null) {
    const kind = await folderKindOf(deps, top);
    if (!kind.ok) return kind;
    if (kind.value !== 'other') return ok({ home: top, ...NOT_PROPOSED, kind: kind.value });
    const known = await checkHomeIsNew(deps, top);
    if (!known.ok) return known;
    const name = proposedName(top);
    if (name === null) return refuse(top);
    const choice = { home: join(dirname(top), name), found: [top], skipped: [], truncated: false, kind: 'other' as const };
    return confirmProposal(deps, options.yes, choice, `this folder is in the git work tree ${top}`);
  }

  const folder = resolve(deps.cwd);
  const folderKind = await folderKindOf(deps, folder);
  if (!folderKind.ok) return folderKind;
  if (folderKind.value !== 'other') return ok({ home: folder, ...NOT_PROPOSED, kind: folderKind.value });
  const own = await checkHomeIsNew(deps, folder);
  if (!own.ok) return own;
  const scan = await listRepoChildren(deps, folder);
  if (!scan.ok) return scan;
  if (scan.value.repos.length === 0) return ok({ home: folder, ...NOT_PROPOSED, kind: 'other' });
  const name = proposedName(folder);
  if (name === null) return refuse(folder);
  const { repos, skipped, truncated } = scan.value;
  const choice = { home: join(folder, name), found: repos, skipped, truncated, kind: 'other' as const };
  const names = repos.map((repo) => basename(repo)).join(', ');
  return confirmProposal(deps, options.yes, choice, `this folder holds the git repos ${names}`);
};

/**
 * The temp folders in the home that a stopped `init` left: the staging folders of the state repo. The list is empty when
 * the home does not exist. It names all staging folders of the home, up to `MAX_SCAN_ENTRIES` of them. Nothing is removed.
 */
export const leftoverTempFolders = async (deps: Deps, home: string): Promise<CliResult<readonly string[]>> => {
  const kind = await deps.fs.stat(home);
  if (!kind.ok) return kind;
  if (kind.value !== 'dir') return ok([]);
  const names = await deps.fs.list(home);
  if (!names.ok) return names;
  return ok(
    names.value
      .filter(isStagingDirName)
      .slice(0, MAX_SCAN_ENTRIES)
      .map((name) => join(home, name)),
  );
};

/** The warning for a temp folder that a stopped `init` left. The remedy is to remove it by hand. */
export const tempFolderWarning = (folder: string): string =>
  `The ${places.folder} holds the temp folder ${folder}, left by a stopped ${commands.init}. ` +
  `Remove ${folder} by hand when no ${commands.init} runs.`;
