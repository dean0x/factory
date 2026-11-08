import { basename, isAbsolute, join, resolve } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { isBranchName } from '../config/primitives.js';
import { commands, commandText, dirs, minGitVersion, program, trackedFiles, type CommandName } from '../names.js';
import type { Deps, RunOutput } from './deps.js';
import { isInUserClaudeFolder, isWrittenInside, userClaudeFolderOf } from './paths.js';
import { ok } from './result.js';
import { shellWord } from './shell-word.js';

const GIT_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 300_000;
const WORKTREE_TIMEOUT_MS = 120_000;
/** The entry that every work tree has in its top folder: a folder, or a file for a linked work tree. */
export const GIT_ENTRY = '.git';
const MAX_STDERR_CHARS = 200;

const GITHUB_URL =
  /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_][A-Za-z0-9._-]{0,99}?)(?:\.git)?\/?$/;

/** The start of a URL with a scheme, up to and including the `@` that ends its userinfo. */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/g;

/**
 * The text with the userinfo of every `scheme://` URL in it removed: the scheme, the host and the path stay.
 * Every text that holds a URL of a person goes through this function before it is shown or written.
 * The form `user@host:path` has no scheme and holds no secret, so it stays as it is.
 */
export const withoutUserinfo = (text: string): string => text.replace(URL_USERINFO, '$1');

/** `owner/name` of a GitHub remote URL, or null. Only the owner and the name are kept. */
export const parseGithubRepo = (url: string): string | null => {
  const match = GITHUB_URL.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
};

/** The setting that turns off the program that git runs to find the changed files. */
const FILE_MONITOR_OFF = 'core.fsmonitor=false';

/**
 * The first words of a git command in the folder `dir`. With `gitDir`, git takes the repo from that folder and the files from
 * `dir`, so the `.git` entry of `dir` is not read, and the file monitor is off. Use `gitDir` for a folder whose content a worker
 * can change.
 */
const gitIn = (dir: string, gitDir?: string): readonly string[] =>
  gitDir === undefined ? ['-C', dir] : ['-C', dir, '-c', FILE_MONITOR_OFF, '--git-dir', gitDir, '--work-tree', dir];

/** Trimmed stdout of a git command, or null when it fails or git is absent. */
const gitOutput = async (deps: Deps, dir: string, args: readonly string[]): Promise<string | null> => {
  const result = await deps.run('git', ['-C', dir, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  return result.ok && result.value.exitCode === 0 ? result.value.stdout.trim() : null;
};

export const configValue = (deps: Deps, dir: string, key: string): Promise<string | null> =>
  gitOutput(deps, dir, ['config', key]);

/** True when `dir` is the top folder of a git work tree. */
export const isWorkTreeRoot = async (deps: Deps, dir: string): Promise<boolean> => {
  const result = await deps.run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree', '--show-prefix'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!result.ok || result.value.exitCode !== 0) return false;
  const [inside, prefix] = result.value.stdout.split('\n');
  return inside === 'true' && (prefix ?? '') === '';
};

/** The git folder that all checkouts of one repo share, as an absolute path, or null when `dir` is in no repo. */
export const commonDirOf = async (deps: Deps, dir: string): Promise<string | null> => {
  const common = await gitOutput(deps, dir, ['rev-parse', '--git-common-dir']);
  return common === null || common === '' ? null : resolve(dir, common);
};

/** The most entries of a folder that a scan reads. */
export const MAX_SCAN_ENTRIES = 200;

export interface SkippedFolder {
  readonly path: string;
  readonly reason: string;
}

export interface RepoScan {
  /** The main checkout of each repo that the folder holds one level down, sorted by path. */
  readonly repos: readonly string[];
  /** The folders that are one more checkout of a repo in `repos`. */
  readonly skipped: readonly SkippedFolder[];
  /** True when the folder holds more entries than the scan reads. */
  readonly truncated: boolean;
}

/**
 * The folders just below `dir` that are the top folder of a git work tree. It reads at most `MAX_SCAN_ENTRIES`
 * entries and follows no symbolic link. A folder that is the settings folder of Claude Code, or is inside it, is left
 * out by its written path, before any call on it. Only a folder with a `.git` entry can be a work tree, so git runs for those.
 * Two folders that share a git folder are one repo (a linked work tree): the checkout that holds the git folder is
 * listed, and the others are skipped. With no such checkout, the first folder by name is listed.
 */
export const listRepoChildren = async (deps: Deps, dir: string): Promise<CliResult<RepoScan>> => {
  const names = await deps.fs.list(dir);
  if (!names.ok) return names;
  const realDir = await deps.fs.realpath(dir);
  if (!realDir.ok) return realDir;

  interface Member {
    readonly path: string;
    /** The git folder of this checkout. A checkout that holds the shared git folder is the main one. */
    readonly ownGit: string;
  }
  const groups = new Map<string, Member[]>();
  for (const name of names.value.slice(0, MAX_SCAN_ENTRIES)) {
    const path = join(dir, name);
    if (isInUserClaudeFolder(deps, path)) continue;
    const real = join(realDir.value, name);
    const resolved = await deps.fs.realpath(path);
    if (!resolved.ok || resolved.value !== real) continue;
    const marker = await deps.fs.stat(join(path, GIT_ENTRY));
    if (!marker.ok || marker.value === null) continue;
    if (!(await isWorkTreeRoot(deps, path))) continue;
    const ownGit = join(real, GIT_ENTRY);
    // Git gives real paths, so the common folder is asked from the real path of the checkout.
    const common = (await commonDirOf(deps, real)) ?? ownGit;
    groups.set(common, [...(groups.get(common) ?? []), { path, ownGit }]);
  }

  const repos: string[] = [];
  const skipped: SkippedFolder[] = [];
  for (const [common, members] of groups) {
    const main = members.find((member) => member.ownGit === common) ?? members[0];
    if (main === undefined) continue;
    repos.push(main.path);
    for (const member of members.filter((candidate) => candidate !== main)) {
      skipped.push({ path: member.path, reason: `it is one more work tree of the repo ${basename(main.path)}` });
    }
  }
  return ok({
    repos: repos.sort(),
    skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
    truncated: names.value.length > MAX_SCAN_ENTRIES,
  });
};

/** The top folder of the git work tree that holds `dir`, or null when `dir` is in none. Git resolves links. */
export const workTreeTop = async (deps: Deps, dir: string): Promise<string | null> => {
  const top = await gitOutput(deps, dir, ['rev-parse', '--show-toplevel']);
  return top === null || top === '' ? null : top;
};

/** The URL of the remote origin, or null when the repo has none. */
export const originUrlOf = (deps: Deps, dir: string): Promise<string | null> =>
  configValue(deps, dir, 'remote.origin.url');

export const hasIdentity = async (deps: Deps, dir: string): Promise<boolean> => {
  const [name, email] = await Promise.all([configValue(deps, dir, 'user.name'), configValue(deps, dir, 'user.email')]);
  return name !== null && name !== '' && email !== null && email !== '';
};

export const hasCommit = async (deps: Deps, dir: string): Promise<boolean> =>
  (await gitOutput(deps, dir, ['rev-parse', '--verify', 'HEAD'])) !== null;

/** The default branch: origin/HEAD, else the current branch, else null. */
export const defaultBranchOf = async (deps: Deps, dir: string): Promise<string | null> => {
  const remote = await gitOutput(deps, dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const fromRemote = remote?.replace(/^origin\//, '') ?? '';
  if (isBranchName(fromRemote)) return fromRemote;
  const current = (await gitOutput(deps, dir, ['branch', '--show-current'])) ?? '';
  return isBranchName(current) ? current : null;
};

/** `cannot <what>: git exited with <code>` and the last line that git printed, with no userinfo and cut short. */
const exitFailure = (what: string, exitCode: number, stderr: string): CliResult<never> => {
  const detail = withoutUserinfo(stderr.trim().split('\n').at(-1) ?? '').slice(0, MAX_STDERR_CHARS);
  return failure(`cannot ${what}: git exited with ${exitCode}${detail === '' ? '' : ` (${detail})`}`);
};

/** One git step that has to work. `lead` is the words before the command, for example `-C <folder>`. */
const gitStepWith = async (deps: Deps, lead: readonly string[], args: readonly string[], what: string): Promise<CliResult<void>> => {
  const result = await deps.run('git', [...lead, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  return result.value.exitCode === 0 ? ok(undefined) : failure(`cannot ${what}: git exited with ${result.value.exitCode}`);
};

const gitStep = (deps: Deps, dir: string, args: readonly string[], what: string): Promise<CliResult<void>> =>
  gitStepWith(deps, ['-C', dir], args, what);

/** The message of `run` ends with this signal name when the time limit stops the program. */
const TIME_LIMIT_SIGNAL = 'SIGTERM';

/** Clone the repo at `url` into the folder `target`. The `--` keeps a URL from acting as an option. */
export const gitClone = async (deps: Deps, url: string, target: string): Promise<CliResult<void>> => {
  const result = await deps.run('git', ['clone', '--', url, target], { timeoutMs: CLONE_TIMEOUT_MS });
  const shown = withoutUserinfo(url);
  if (!result.ok && result.error.message.endsWith(`: ${TIME_LIMIT_SIGNAL}`)) {
    return failure(
      `cannot clone ${shown}: the clone took longer than ${CLONE_TIMEOUT_MS / 1000} seconds`,
      `An ssh clone can wait for a prompt that nobody sees. Load the key into an ssh agent, or sign in with "gh auth login", then run "${commandText(commands.init)}" again.`,
    );
  }
  if (!result.ok) return failure(`cannot clone ${shown}: ${withoutUserinfo(result.error.message)}`);
  return result.value.exitCode === 0 ? ok(undefined) : exitFailure(`clone ${shown}`, result.value.exitCode, result.value.stderr);
};

/**
 * True when the repo of `dir` has a local branch of this name. Git answers with exit code 1 for a branch that is not there.
 * Any other answer is a failure, because the repo may not be one.
 */
export const branchExists = async (deps: Deps, dir: string, branch: string): Promise<CliResult<boolean>> => {
  if (!isBranchName(branch)) return failure('cannot look for a branch: the name is not a branch name');
  const result = await deps.run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!result.ok) return failure(`cannot look for the branch ${branch}: ${result.error.message}`);
  if (result.value.exitCode === 0) return ok(true);
  if (result.value.exitCode === 1) return ok(false);
  return failure(`cannot look for the branch ${branch}: git exited with ${result.value.exitCode}`);
};

/**
 * Make the work copy of a worker: a new work tree of the repo of `clone` in `folder`, on the new branch `branch`. The branch
 * starts at the head of the clone. Git makes the folders above `folder`, and it fails when the branch or the folder exists.
 * The time limit is longer than for the other calls, because git writes every file of the project.
 */
export const addWorkTree = async (deps: Deps, clone: string, branch: string, folder: string): Promise<CliResult<void>> => {
  if (!isBranchName(branch)) return failure('cannot make the work copy: the branch is not a branch name');
  if (!isAbsolute(folder)) return failure('cannot make the work copy: the folder is not an absolute path');
  const what = `make the work copy ${folder}`;
  const result = await deps.run('git', ['-C', clone, 'worktree', 'add', '-b', branch, folder], { timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!result.ok && result.error.message.endsWith(`: ${TIME_LIMIT_SIGNAL}`)) {
    return failure(`cannot ${what}: git took longer than ${WORKTREE_TIMEOUT_MS / 1000} seconds`);
  }
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  return result.value.exitCode === 0 ? ok(undefined) : exitFailure(what, result.value.exitCode, result.value.stderr);
};

export const gitInit = (deps: Deps, dir: string): Promise<CliResult<void>> =>
  gitStep(deps, dir, ['init', '-q'], 'create the state repository');

/**
 * The hooks of a repo do not run for a step of this tool. `/dev/null` is a file, so git finds no hook below it.
 * That turns off every hook; `--no-verify` turns off only two. An empty value is not documented as "no hooks".
 */
const NO_HOOKS = 'core.hooksPath=/dev/null';

/** The setting that turns off the signing of a commit. */
const NO_SIGNING = ['-c', 'commit.gpgsign=false'] as const;

const commitWords = (message: string): readonly string[] => ['commit', '-q', '-m', message];

/**
 * The first words of every git step that factory runs in the state folder `dir`: the hooks are off and the file monitor is off.
 * So the step runs no hook, and it does not run the programs that the local git config of the folder names for these two jobs.
 */
const stateGit = (dir: string): readonly string[] => ['-C', dir, '-c', NO_HOOKS, '-c', FILE_MONITOR_OFF];

/** One git step in the state folder `dir`; see `stateGit`. */
const stateStep = (deps: Deps, dir: string, args: readonly string[], what: string): Promise<CliResult<void>> =>
  gitStepWith(deps, stateGit(dir), args, what);

const COMMIT_STATE = 'commit the state files';

/** Stage everything and commit, for a new repo. The caller checks the identity first. */
export const commitAll = async (deps: Deps, dir: string, message: string): Promise<CliResult<void>> => {
  const staged = await stateStep(deps, dir, ['add', '-A'], 'stage the state files');
  return staged.ok ? stateStep(deps, dir, [...NO_SIGNING, ...commitWords(message)], COMMIT_STATE) : staged;
};

export interface RootRepoInput {
  /** The paths, relative to the root, that the first commit holds. No other path is staged. */
  readonly paths: readonly string[];
  readonly message: string;
  /** The name of the first branch. */
  readonly branch: string;
}

export interface RootRepo {
  /** False when git has no identity: the repo exists, and it holds no commit. */
  readonly committed: boolean;
}

/**
 * Make the root a git repo and commit the allowed paths. The root must hold no git folder yet. The paths are staged by
 * name, so a path that the share list ignores can not enter the commit. The hooks of git do not run for the commit.
 */
export const initRootRepo = async (deps: Deps, root: string, input: RootRepoInput): Promise<CliResult<RootRepo>> => {
  const entry = await deps.fs.stat(join(root, GIT_ENTRY));
  if (!entry.ok) return entry;
  if (entry.value !== null) return failure(`cannot create the config repository: ${root} holds a git repository already`);
  const made = await gitStep(deps, root, ['init', '-q', '-b', input.branch], 'create the config repository');
  if (!made.ok) return made;
  if (!(await hasIdentity(deps, root))) return ok({ committed: false });
  const staged = await gitStep(deps, root, ['add', '--', ...input.paths], 'stage the config files');
  if (!staged.ok) return staged;
  const committed = await gitStep(
    deps,
    root,
    [...NO_SIGNING, '-c', NO_HOOKS, ...commitWords(input.message)],
    'commit the config files',
  );
  return committed.ok ? ok({ committed: true }) : committed;
};

/** Paths in a repo, relative to its top folder. */
export interface RepoPaths {
  /** Paths that exist: the files that changed, and the target of each move. */
  readonly present: readonly string[];
  /** Paths that a move left. The commit records their removal. */
  readonly gone: readonly string[];
}

/**
 * Stage `paths` and commit them, with the hooks off. Nothing else of the working tree is staged.
 * The caller checks the identity first, and that the index holds no other staged change. A list with no path is a failure
 * that runs no git command: `git add -A` with no path would stage the whole work tree. A list with only removals stages no
 * present path.
 */
export const commitPaths = async (
  deps: Deps,
  dir: string,
  paths: RepoPaths,
  message: string,
): Promise<CliResult<void>> => {
  if (paths.present.length === 0 && paths.gone.length === 0) return failure(`cannot ${COMMIT_STATE}: no path was named`);
  if (paths.gone.length > 0) {
    // `--ignore-unmatch`: a path that git never tracked has no removal to record.
    const removed = await stateStep(
      deps,
      dir,
      ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...paths.gone],
      'stage the state files',
    );
    if (!removed.ok) return removed;
  }
  const added =
    paths.present.length === 0 ? ok(undefined) : await stateStep(deps, dir, ['add', '-A', '--', ...paths.present], 'stage the state files');
  return added.ok ? stateStep(deps, dir, [...NO_SIGNING, ...commitWords(message)], COMMIT_STATE) : added;
};

/** Remove the staged changes of `paths` from the index. The files keep their text, and other staged changes stay. */
export const unstagePaths = (deps: Deps, dir: string, paths: RepoPaths): Promise<CliResult<void>> =>
  stateStep(deps, dir, ['reset', '-q', '--', ...paths.present, ...paths.gone], 'clear the staged files');

/** The paths that a repo tracks, in the order of git, and whether git named more paths than the list can hold. */
export interface TrackedList {
  /**
   * At most `maxCount` paths, relative to the top folder of the repo, exactly as git prints them. A path in the user
   * settings folder of Claude Code is not in the list, so that no reader of the list asks about that folder.
   */
  readonly paths: readonly string[];
  /** True when the repo tracks more paths than the list holds. A list that reached its cap is never complete. */
  readonly reachedCap: boolean;
}

/** The message of the error of `run` when the output of the program is larger than the program reads. */
const OUTPUT_TOO_LARGE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * The paths that the repo at `dir` tracks (`git ls-files -z`). The NUL separator keeps a path with a space or a line break
 * whole. The list holds at most `maxCount` paths. A repo that tracks more gives a list that reached its cap, and output
 * that is larger than the program reads counts the same way. The caller never uses a list that reached its cap. A path that
 * is, or is inside, the user settings folder of Claude Code is left out before the count, by its written path: no reader
 * of tracked files may ask the file system about that folder.
 */
export const trackedFilesOf = async (
  deps: Deps,
  dir: string,
  maxCount: number = trackedFiles.maxCount,
): Promise<CliResult<TrackedList>> => {
  const result = await deps.run('git', ['-C', dir, 'ls-files', '-z'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) {
    return result.error.message.endsWith(OUTPUT_TOO_LARGE)
      ? ok({ paths: [], reachedCap: true })
      : failure(`cannot list the tracked files of ${dir}: ${result.error.message}`);
  }
  if (result.value.exitCode !== 0) {
    return failure(`cannot list the tracked files of ${dir}: git exited with ${result.value.exitCode}`);
  }
  const userFolder = userClaudeFolderOf(deps);
  const paths = result.value.stdout
    .split('\0')
    .filter((path) => path !== '' && (userFolder === null || !isWrittenInside(deps, userFolder, join(dir, path))));
  return ok({ paths: paths.slice(0, maxCount), reachedCap: paths.length > maxCount });
};

/** The git mode of a link. */
export const LINK_MODE = '120000';

const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/** True for the git mode of a plain file. */
export const isFileMode = (mode: string): boolean => FILE_MODES.has(mode);

/** One entry of a git tree. */
export interface TreeEntry {
  readonly mode: string;
  /** `blob` for a file or a link, `tree` for a folder, `commit` for a submodule. */
  readonly kind: string;
  readonly id: string;
  /** The size in bytes of a file or a link, or null for any other entry. */
  readonly size: number | null;
  /** The path from the top folder of the repo. */
  readonly path: string;
}

/** `<mode> <kind> <id> <size>TAB<path>`: the line of `git ls-tree -l -z`. The size is padded with spaces, and a folder has `-`. */
const TREE_ENTRY = /^(\d{6}) ([a-z]+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]+)$/;

const treeEntryOf = (record: string): TreeEntry | null => {
  const [, mode, kind, id, size, path] = TREE_ENTRY.exec(record) ?? [];
  if (mode === undefined || kind === undefined || id === undefined || size === undefined || path === undefined) return null;
  return { mode, kind, id, size: size === '-' ? null : Number(size), path };
};

/**
 * The entries that the last commit (HEAD) of the repo at `dir` has at `path` (`git ls-tree -z -l`), one level deep. A path with no
 * trailing slash gives the entry of the path itself: a folder, a file or a link. A path with a trailing slash gives the entries
 * of that folder. A repo with no commit, or a path that git can not read, is a failure. The commit is the one that a new work
 * tree of the repo starts from.
 */
export const headEntriesAt = async (deps: Deps, dir: string, path: string): Promise<CliResult<readonly TreeEntry[]>> => {
  const what = `cannot read ${path} of the last commit of ${dir}`;
  const result = await deps.run('git', ['-C', dir, 'ls-tree', '-z', '-l', 'HEAD', '--', path], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return failure(`${what}: git exited with ${result.value.exitCode}`);
  const entries: TreeEntry[] = [];
  for (const record of result.value.stdout.split('\0')) {
    if (record === '') continue;
    const entry = treeEntryOf(record);
    if (entry === null) return failure(`${what}: git printed an entry that ${program} can not read`);
    entries.push(entry);
  }
  return ok(entries);
};

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** The text of the file of git with this object id. The caller checks the size first, from the entry of the file. */
export const blobTextOf = async (deps: Deps, dir: string, id: string): Promise<CliResult<string>> => {
  if (!OBJECT_ID.test(id)) return failure('cannot read a file of git: the object id is not valid');
  const what = `cannot read the file ${id} of ${dir}`;
  const result = await deps.run('git', ['-C', dir, 'cat-file', 'blob', id], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return failure(`${what}: git exited with ${result.value.exitCode}`);
  return ok(result.value.stdout);
};

/** The most paths that one ignore check takes. */
export const MAX_IGNORE_PATHS = 256;

/**
 * The paths of `paths` that the ignore rules of the repo at `dir` match (`git check-ignore`). A path that the repo tracks
 * is never ignored in the view of git. Git is asked for one path at a time, and only its exit code counts: 0 means ignored,
 * 1 means not ignored. The answer of git is never parsed, so a path with an odd name gets a true answer. Any other exit
 * code is an error, so a failure is never read as "not ignored". At most `MAX_IGNORE_PATHS` paths are asked.
 */
export const ignoredPathsOf = async (
  deps: Deps,
  dir: string,
  paths: readonly string[],
): Promise<CliResult<ReadonlySet<string>>> => {
  if (paths.length > MAX_IGNORE_PATHS) {
    return failure(`cannot check ${paths.length} paths against the ignore rules: the most is ${MAX_IGNORE_PATHS}`);
  }
  const what = `cannot check the ignore rules of ${dir}`;
  const ignored = new Set<string>();
  for (const path of paths) {
    const result = await deps.run('git', ['-C', dir, 'check-ignore', '-q', '--', path], { timeoutMs: GIT_TIMEOUT_MS });
    if (!result.ok) return failure(`${what}: ${result.error.message}`);
    if (result.value.exitCode === 0) ignored.add(path);
    else if (result.value.exitCode !== 1) return failure(`${what}: git exited with ${result.value.exitCode}`);
  }
  return ok(ignored);
};

/**
 * `dir` is the top folder of a work tree of its own. A git write in a folder that is inside the work tree of another repo
 * would change that repo, so the write waits for this check. `what` names the folder for the message.
 */
export const requireWorkTreeTop = async (deps: Deps, dir: string, what: string): Promise<CliResult<void>> =>
  (await isWorkTreeRoot(deps, dir))
    ? ok(undefined)
    : safetyRefusal(
        `${what} ${dir} is not the top folder of a git work tree of its own, so ${program} makes no git change there`,
        `Move ${dir} away, then run "${commandText(commands.init)}" again.`,
      );

/**
 * The id of the commit that HEAD names, or null when the repo has no commit. It is an error when git cannot run. `gitDir` is the git
 * folder that the repo of `dir` has; see `gitIn`.
 */
export const headOf = async (deps: Deps, dir: string, gitDir?: string): Promise<CliResult<string | null>> => {
  const result = await deps.run('git', [...gitIn(dir, gitDir), 'rev-parse', '--verify', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot read the last commit of ${dir}: ${result.error.message}`);
  return ok(result.value.exitCode === 0 ? result.value.stdout.trim() : null);
};

/** One path of `git status`: its state in the index, its state in the work tree, and the path in the repo. */
export interface StatusEntry {
  /** A space for no change; `?` for a file that git does not track. */
  readonly index: string;
  readonly tree: string;
  readonly path: string;
}

/** The characters before the path in an entry of the porcelain form: two states and a space. */
const STATUS_PREFIX_LENGTH = 3;
/** A rename or a copy puts a second path, the old one, after its entry. */
const WITH_OLD_PATH = ['R', 'C'];

const parseStatus = (stdout: string): readonly StatusEntry[] => {
  const parts = stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let at = 0; at < parts.length; at += 1) {
    const part = parts[at] ?? '';
    if (part.length <= STATUS_PREFIX_LENGTH) continue;
    const entry = { index: part.charAt(0), tree: part.charAt(1), path: part.slice(STATUS_PREFIX_LENGTH) };
    entries.push(entry);
    if (WITH_OLD_PATH.includes(entry.index) || WITH_OLD_PATH.includes(entry.tree)) at += 1;
  }
  return entries;
};

const MAX_SHOWN_PATHS = 5;

const shownPaths = (paths: readonly string[]): string => {
  const shown = paths.slice(0, MAX_SHOWN_PATHS).join(', ');
  return paths.length > MAX_SHOWN_PATHS ? `${shown} and ${paths.length - MAX_SHOWN_PATHS} more` : shown;
};

/** The keys of the local git config that name a program and have no switch to turn them off for one call: a filter driver and a config hook. */
const PROGRAM_KEY_PREFIXES: readonly string[] = ['filter.', 'hook.'];

/** The scopes of `git config --show-scope` that belong to the folder itself. */
const FOLDER_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

/** The scope word that git prints: lower case letters only. Any other text means that the list is not read right. */
const SCOPE_WORD = /^[a-z]+$/;

/**
 * The keys of `git config --list --show-scope --includes -z` that are set in the config of the folder itself and name a program. With
 * `-z`, git prints for each setting the scope, a NUL, the key, a line break, the value and a NUL. A key with no value has no line break.
 * The value can hold line breaks, so the key ends at the first one. Null when the list is not in this form.
 */
const programKeysOf = (stdout: string): readonly string[] | null => {
  const parts = stdout.split('\0');
  if (parts.pop() !== '' || parts.length % 2 !== 0) return null;
  const keys: string[] = [];
  for (let at = 0; at < parts.length; at += 2) {
    const scope = parts[at] ?? '';
    const entry = parts[at + 1] ?? '';
    if (!SCOPE_WORD.test(scope)) return null;
    const lineBreak = entry.indexOf('\n');
    const key = lineBreak < 0 ? entry : entry.slice(0, lineBreak);
    if (FOLDER_SCOPES.has(scope) && PROGRAM_KEY_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix))) keys.push(key);
  }
  return keys;
};

/**
 * Refuse (exit 4) when the local git config of the state folder, or a file it includes, has a key that names a program with no switch
 * to turn it off for one call: a filter driver (`filter.`) or a config hook (`hook.`). The refusal names the keys. It reads only.
 * The read needs git 2.26 (`--show-scope`); when it fails, the error (exit 1) names that version. `command` is the command that the
 * person runs again.
 */
export const requireStateConfigSafe = async (deps: Deps, stateDir: string, command: CommandName): Promise<CliResult<void>> => {
  const again = `then run "${commandText(command)}" again.`;
  const unreadable = (detail: string): CliResult<never> =>
    failure(
      `cannot read the git config of ${dirs.state}: ${detail}. ${program} needs git ${minGitVersion} or later.`,
      `Update git, ${again}`,
    );
  const result = await deps.run('git', [...stateGit(stateDir), 'config', '--list', '--show-scope', '--includes', '-z'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!result.ok) return unreadable(result.error.message);
  if (result.value.exitCode !== 0) return unreadable(`git exited with ${result.value.exitCode}`);
  const keys = programKeysOf(result.value.stdout);
  if (keys === null) return unreadable('git printed a list that is not in the form that was expected');
  const [first] = keys;
  if (first === undefined) return ok(undefined);
  const unset = `git -C ${dirs.state} config --unset ${shellWord(first)}`;
  return safetyRefusal(
    `the local git config of ${dirs.state} sets ${shownPaths(keys)}, which ${keys.length === 1 ? 'names' : 'name'} a program, so ${program} makes no git change there`,
    keys.length === 1
      ? `Remove the key with "${unset}", ${again}`
      : `Remove each key, for example the first with "${unset}", ${again}`,
  );
};

/**
 * Refuse when a commit in the state repo could take a change of the owner. The local git config of the state folder must name no
 * program that has no switch for one call (`requireStateConfigSafe`). The index of the state repo must hold no
 * staged change. A path of `touched` must have no change of the owner, staged or not: `changing` names the command that
 * changes these paths ("the upgrade"), and `command` is the command that the person runs again.
 */
export const requireStateRepoReady = async (
  deps: Deps,
  stateDir: string,
  touched: readonly string[],
  changing: string,
  command: CommandName,
): Promise<CliResult<void>> => {
  const again = `Then run "${commandText(command)}" again.`;
  const safe = await requireStateConfigSafe(deps, stateDir, command);
  if (!safe.ok) return safe;
  const status = await stateStatusOf(deps, stateDir);
  if (!status.ok) return status;
  const staged = status.value.filter((entry) => ![' ', '?', '!'].includes(entry.index));
  if (staged.length > 0) {
    return failure(
      `${dirs.state} has staged changes: ${shownPaths(staged.map((entry) => entry.path))}`,
      `Commit them, or clear them with "git reset" in ${dirs.state}. ${again}`,
    );
  }
  const changed = status.value.filter((entry) =>
    touched.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
  );
  if (changed.length > 0) {
    return failure(
      `${dirs.state} has changes in files that ${changing} changes: ${shownPaths(changed.map((entry) => entry.path))}`,
      `Commit them, or put the files back with git in ${dirs.state}. ${again}`,
    );
  }
  return ok(undefined);
};

/**
 * Refuse before a command writes files of the state repo and commits them: the state folder must be a git repo, git must
 * have an identity, and the commit must not take a change of the owner (`requireStateRepoReady`). `changing` names the
 * change ("the upgrade"), and `command` is the command that the person runs again.
 */
export const requireStateRepoCommit = async (
  deps: Deps,
  stateDir: string,
  touched: readonly string[],
  changing: string,
  command: CommandName,
): Promise<CliResult<void>> => {
  const repo = await deps.fs.stat(join(stateDir, GIT_ENTRY));
  if (!repo.ok) return repo;
  if (repo.value === null) return failure(`${dirs.state} is not a git repository`, `Run "${commandText(commands.doctor)}".`);
  if (!(await hasIdentity(deps, stateDir))) {
    return failure(
      'git has no user.name and user.email',
      `Set both with "git config --global", then run "${commandText(command)}" again.`,
    );
  }
  return requireStateRepoReady(deps, stateDir, touched, changing, command);
};

const statusEntriesOf = (result: CliResult<RunOutput>, dir: string): CliResult<readonly StatusEntry[]> => {
  const what = `cannot read the changes of ${dir}`;
  if (!result.ok) return failure(`${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return failure(`${what}: git exited with ${result.value.exitCode}`);
  return ok(parseStatus(result.value.stdout));
};

const STATUS_WORDS = ['status', '--porcelain', '-z', '--untracked-files=all'] as const;

/**
 * The changes in the index and in the work tree of the repo at `dir`. Every untracked file has its own entry. `gitDir` is the git
 * folder that the repo of `dir` has; see `gitIn`.
 */
export const statusOf = async (deps: Deps, dir: string, gitDir: string): Promise<CliResult<readonly StatusEntry[]>> =>
  statusEntriesOf(await deps.run('git', [...gitIn(dir, gitDir), ...STATUS_WORDS], { timeoutMs: GIT_TIMEOUT_MS }), dir);

/** The changes in the index and in the work tree of the state repo at `dir`, as `statusOf`. A submodule is not read. */
export const stateStatusOf = async (deps: Deps, dir: string): Promise<CliResult<readonly StatusEntry[]>> =>
  statusEntriesOf(
    await deps.run('git', [...stateGit(dir), ...STATUS_WORDS, '--ignore-submodules=all'], { timeoutMs: GIT_TIMEOUT_MS }),
    dir,
  );

/**
 * The value of one local setting of the state folder as git reads it, or null when it is not set. This read leaves the hooks as they
 * are set: with the hooks forced off, the value of `core.hooksPath` would always be `/dev/null`. The key is a name of the code.
 */
export const stateConfigValue = async (deps: Deps, dir: string, key: string): Promise<CliResult<string | null>> => {
  const what = `read ${key} of ${dir}`;
  const result = await deps.run('git', ['-C', dir, '-c', FILE_MONITOR_OFF, 'config', key], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  if (result.value.exitCode === 1) return ok(null);
  if (result.value.exitCode !== 0) return exitFailure(what, result.value.exitCode, result.value.stderr);
  return ok(result.value.stdout.replace(/\n$/, ''));
};

/** Set one setting in the local git config of the state folder. The separator keeps a value that starts with a dash from acting as an option. */
export const setStateConfig = (deps: Deps, dir: string, key: string, value: string): Promise<CliResult<void>> =>
  stateStep(deps, dir, ['config', '--', key, value], `set ${key}`);

/** The absolute path of the git folder of the state repo at `dir`. */
export const absoluteGitDirOf = async (deps: Deps, dir: string): Promise<CliResult<string>> => {
  const what = `read the git folder of ${dir}`;
  const result = await deps.run('git', [...stateGit(dir), 'rev-parse', '--absolute-git-dir'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return exitFailure(what, result.value.exitCode, result.value.stderr);
  const printed = result.value.stdout.replace(/\n$/, '');
  return isAbsolute(printed) ? ok(printed) : failure(`cannot ${what}: git printed a path that is not absolute`);
};

/** One entry of the index: the mode and the id of the file. */
export interface IndexEntry {
  readonly mode: string;
  readonly id: string;
}

/** `<mode> <id> <stage>TAB<path>`: the line of `git ls-files --stage -z`. */
const INDEX_ENTRY = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/;

/**
 * The entry that the index of the state repo at `dir` has at `path`, or null when the index has none. The index is the one that git
 * gives the program through `GIT_INDEX_FILE`, so a program that git starts for a commit reads the index of that commit. A path with
 * two entries (a conflict), or an entry that is not at stage 0, is a failure. The read changes nothing.
 */
export const stateIndexEntryAt = async (deps: Deps, dir: string, path: string): Promise<CliResult<IndexEntry | null>> => {
  const what = `read ${path} in the index of ${dir}`;
  const result = await deps.run('git', [...stateGit(dir), 'ls-files', '--stage', '-z', '--', path], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return exitFailure(what, result.value.exitCode, result.value.stderr);
  const records = result.value.stdout.split('\0').filter((record) => record !== '');
  if (records.length === 0) return ok(null);
  const [mode, id, stage, entryPath] = INDEX_ENTRY.exec(records[0] ?? '')?.slice(1) ?? [];
  if (records.length !== 1 || mode === undefined || id === undefined || stage !== '0' || entryPath !== path) {
    return failure(`cannot ${what}: git printed an entry that ${program} can not read`);
  }
  return ok({ mode, id });
};

/** The longest wait for a fetch: it reads the network. */
const FETCH_TIMEOUT_MS = 60_000;

/** The glob of a refspec: every branch below a prefix. */
const ALL_BELOW = '*';

/**
 * Fetch the branches under `<prefix>/` of one remote into `refs/remotes/<remote>/<prefix>/`, in one call. A branch that the remote
 * no longer has is dropped from the local copies (`--prune`, limited to this prefix), so after a fetch that worked, a local copy
 * is the state of the remote now: it is never an older answer. A failed fetch leaves the copies as they were, and the caller must
 * not use them. Each branch of `also` is fetched by its name in the same call, so one fetch updates every copy that a check reads.
 * No tag is fetched. The remote, the prefix and the names must be branch names, so no word acts as an option.
 */
export const fetchBranches = async (
  deps: Deps,
  dir: string,
  remote: string,
  prefix: string,
  also: readonly string[] = [],
): Promise<CliResult<void>> => {
  if (!isBranchName(remote) || !isBranchName(prefix) || !also.every(isBranchName)) {
    return failure('cannot fetch: the remote, the branch prefix and the branches must be names');
  }
  const what = `fetch ${remote}`;
  const refspecs = [
    `+refs/heads/${prefix}/${ALL_BELOW}:refs/remotes/${remote}/${prefix}/${ALL_BELOW}`,
    ...also.map((branch) => `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`),
  ];
  const result = await deps.run('git', ['-C', dir, 'fetch', '--prune', '--no-tags', remote, ...refspecs], { timeoutMs: FETCH_TIMEOUT_MS });
  if (!result.ok && result.error.message.endsWith(`: ${TIME_LIMIT_SIGNAL}`)) {
    return failure(`cannot ${what}: git took longer than ${FETCH_TIMEOUT_MS / 1000} seconds`);
  }
  if (!result.ok) return failure(`cannot ${what}: ${withoutUserinfo(result.error.message)}`);
  return result.value.exitCode === 0 ? ok(undefined) : exitFailure(what, result.value.exitCode, result.value.stderr);
};

/**
 * The commit id that the branch of a remote has in the local copies (`refs/remotes/<remote>/<branch>`), or null when there is no
 * such copy. The caller fetches first (`fetchBranches`), because a copy that no fetch updated is an old answer.
 */
export const remoteBranchHeadOf = async (
  deps: Deps,
  dir: string,
  remote: string,
  branch: string,
): Promise<CliResult<string | null>> => {
  if (!isBranchName(remote) || !isBranchName(branch)) return failure('cannot look for a remote branch: the names must be branch names');
  const what = `look for the branch ${branch} of ${remote}`;
  const result = await deps.run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  if (result.value.exitCode === 1) return ok(null);
  if (result.value.exitCode !== 0) return exitFailure(what, result.value.exitCode, result.value.stderr);
  const id = result.value.stdout.trim();
  return OBJECT_ID.test(id) ? ok(id) : failure(`cannot ${what}: git printed text that is not a commit id`);
};

/**
 * True when the commit `ancestor` is the commit `descendant` or lies below it. Git counts the commits that `ancestor` holds and
 * `descendant` lacks: a count of 0 means that every commit of `ancestor` is on `descendant`. A bad exit code and text that is no
 * count are failures, so an error is never read as either answer. Both words must be commit ids.
 */
export const isAncestor = async (deps: Deps, dir: string, ancestor: string, descendant: string): Promise<CliResult<boolean>> => {
  if (!OBJECT_ID.test(ancestor) || !OBJECT_ID.test(descendant)) return failure('cannot compare commits: a commit id is not valid');
  const what = 'compare two commits';
  const result = await deps.run('git', ['-C', dir, 'rev-list', '--count', `${descendant}..${ancestor}`], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return exitFailure(what, result.value.exitCode, result.value.stderr);
  const count = result.value.stdout.trim();
  return /^\d+$/.test(count) ? ok(count === '0') : failure(`cannot ${what}: git printed text that is not a count`);
};

/**
 * The count of entries in the stash of the repo of `dir`. Every work tree of one repo shares one stash. A failure is never a count:
 * the caller must not read "no stash" from an error.
 */
export const stashCountOf = async (deps: Deps, dir: string): Promise<CliResult<number>> => {
  const what = `read the stash of ${dir}`;
  const result = await deps.run('git', ['-C', dir, 'stash', 'list', '--format=%gd'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return exitFailure(what, result.value.exitCode, result.value.stderr);
  return ok(result.value.stdout.split('\n').filter((line) => line !== '').length);
};

/**
 * Remove the work copy `folder` of the repo of `clone` with the plain git command: it never uses force, so git refuses a work copy
 * that holds a changed file or an untracked file. Git deletes the files that it ignores. The branch of the work copy stays.
 */
export const removeWorkTree = async (deps: Deps, clone: string, folder: string): Promise<CliResult<void>> => {
  if (!isAbsolute(folder)) return failure('cannot remove the work copy: the folder is not an absolute path');
  const what = `remove the work copy ${folder}`;
  const result = await deps.run('git', ['-C', clone, 'worktree', 'remove', '--', folder], { timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!result.ok && result.error.message.endsWith(`: ${TIME_LIMIT_SIGNAL}`)) {
    return failure(`cannot ${what}: git took longer than ${WORKTREE_TIMEOUT_MS / 1000} seconds`);
  }
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  return result.value.exitCode === 0 ? ok(undefined) : exitFailure(what, result.value.exitCode, result.value.stderr);
};

/** The command line, for a remedy text, that unlocks the work copy `folder` of the repo of `clone`. */
export const unlockWorkTreeLine = (clone: string, folder: string): string =>
  `git -C ${shellWord(clone)} worktree unlock ${shellWord(folder)}`;

/**
 * The command line, for a remedy text, that removes the work copy `folder` of the repo of `clone` with force. Git needs force for
 * a work copy that holds submodules.
 */
export const forceRemoveWorkTreeLine = (clone: string, folder: string): string =>
  `git -C ${shellWord(clone)} worktree remove --force ${shellWord(folder)}`;

/** The paths that git ignores in a work tree, and whether git named more paths than the list holds. */
export interface IgnoredList {
  /** At most `maxCount` paths, relative to the top folder, as git prints them: a folder that git ignores whole has a trailing slash. */
  readonly paths: readonly string[];
  /** True when git names more paths than the list holds. Output that is larger than the program reads counts the same way. */
  readonly reachedCap: boolean;
}

/**
 * The files that git ignores in the work tree at `dir` (`git status --ignored`): the files that the removal of a work copy deletes
 * and that no commit holds. A folder that is ignored whole is one entry. `gitDir` is the git folder that the repo of `dir` has; see
 * `gitIn`.
 */
export const ignoredFilesOf = async (deps: Deps, dir: string, maxCount: number, gitDir?: string): Promise<CliResult<IgnoredList>> => {
  const what = `read the ignored files of ${dir}`;
  const result = await deps.run('git', [...gitIn(dir, gitDir), 'status', '--porcelain', '-z', '--ignored'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) {
    return result.error.message.endsWith(OUTPUT_TOO_LARGE) ? ok({ paths: [], reachedCap: true }) : failure(`cannot ${what}: ${result.error.message}`);
  }
  if (result.value.exitCode !== 0) return exitFailure(what, result.value.exitCode, result.value.stderr);
  const ignored = parseStatus(result.value.stdout).filter((entry) => entry.index === '!' && entry.tree === '!');
  return ok({ paths: ignored.slice(0, maxCount).map((entry) => entry.path), reachedCap: ignored.length > maxCount });
};
