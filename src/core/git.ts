import { basename, join, resolve } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
import { isBranchName } from '../config/primitives.js';
import type { Deps } from './deps.js';
import { ok } from './result.js';

const GIT_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 300_000;
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
 * entries and follows no symbolic link. Only a folder with a `.git` entry can be a work tree, so git runs for those.
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
      skipped.push({ path: member.path, reason: `it is one more checkout of the repo ${basename(main.path)}` });
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

const gitStep = async (deps: Deps, dir: string, args: readonly string[], what: string): Promise<CliResult<void>> => {
  const result = await deps.run('git', ['-C', dir, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  if (!result.ok) return failure(`cannot ${what}: ${result.error.message}`);
  return result.value.exitCode === 0 ? ok(undefined) : failure(`cannot ${what}: git exited with ${result.value.exitCode}`);
};

/** The message of `run` ends with this signal name when the time limit stops the program. */
const TIME_LIMIT_SIGNAL = 'SIGTERM';

/** Clone the repo at `url` into the folder `target`. The `--` keeps a URL from acting as an option. */
export const gitClone = async (deps: Deps, url: string, target: string): Promise<CliResult<void>> => {
  const result = await deps.run('git', ['clone', '--', url, target], { timeoutMs: CLONE_TIMEOUT_MS });
  const shown = withoutUserinfo(url);
  if (!result.ok && result.error.message.endsWith(`: ${TIME_LIMIT_SIGNAL}`)) {
    return failure(
      `cannot clone ${shown}: the clone took longer than ${CLONE_TIMEOUT_MS / 1000} seconds`,
      'An ssh clone can wait for a prompt that nobody sees. Load the key into an ssh agent, or sign in with "gh auth login", then run the command again.',
    );
  }
  if (!result.ok) return failure(`cannot clone ${shown}: ${withoutUserinfo(result.error.message)}`);
  if (result.value.exitCode === 0) return ok(undefined);
  const detail = withoutUserinfo(result.value.stderr.trim().split('\n').at(-1) ?? '').slice(0, MAX_STDERR_CHARS);
  return failure(`cannot clone ${shown}: git exited with ${result.value.exitCode}${detail === '' ? '' : ` (${detail})`}`);
};

export const gitInit = (deps: Deps, dir: string): Promise<CliResult<void>> =>
  gitStep(deps, dir, ['init', '-q'], 'create the state repository');

/**
 * The hooks of a state repo do not run for a commit of this tool. `/dev/null` is a file, so git finds no hook below it.
 * That turns off every hook; `--no-verify` turns off only two. An empty value is not documented as "no hooks".
 */
const NO_HOOKS = 'core.hooksPath=/dev/null';

const commitStaged = (deps: Deps, dir: string, message: string, what: string): Promise<CliResult<void>> =>
  gitStep(deps, dir, ['-c', 'commit.gpgsign=false', '-c', NO_HOOKS, 'commit', '-q', '-m', message], what);

const COMMIT_STATE = 'commit the state files';

/** Stage everything and commit, for a new repo. The caller checks the identity first. */
export const commitAll = async (deps: Deps, dir: string, message: string): Promise<CliResult<void>> => {
  const staged = await gitStep(deps, dir, ['add', '-A'], 'stage the state files');
  return staged.ok ? commitStaged(deps, dir, message, COMMIT_STATE) : staged;
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
  const committed = await commitStaged(deps, root, input.message, 'commit the config files');
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
 * The caller checks the identity first, and that the index holds no other staged change.
 */
export const commitPaths = async (
  deps: Deps,
  dir: string,
  paths: RepoPaths,
  message: string,
): Promise<CliResult<void>> => {
  if (paths.gone.length > 0) {
    // `--ignore-unmatch`: a path that git never tracked has no removal to record.
    const removed = await gitStep(
      deps,
      dir,
      ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...paths.gone],
      'stage the state files',
    );
    if (!removed.ok) return removed;
  }
  const added = await gitStep(deps, dir, ['add', '-A', '--', ...paths.present], 'stage the state files');
  return added.ok ? commitStaged(deps, dir, message, COMMIT_STATE) : added;
};

/** Remove the staged changes of `paths` from the index. The files keep their text, and other staged changes stay. */
export const unstagePaths = (deps: Deps, dir: string, paths: RepoPaths): Promise<CliResult<void>> =>
  gitStep(deps, dir, ['reset', '-q', '--', ...paths.present, ...paths.gone], 'clear the staged files');

/** The id of the commit that HEAD names, or null when the repo has no commit. It is an error when git cannot run. */
export const headOf = async (deps: Deps, dir: string): Promise<CliResult<string | null>> => {
  const result = await deps.run('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
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

/** The changes in the index and in the work tree of the repo at `dir`. Every untracked file has its own entry. */
export const statusOf = async (deps: Deps, dir: string): Promise<CliResult<readonly StatusEntry[]>> => {
  const result = await deps.run('git', ['-C', dir, 'status', '--porcelain', '-z', '--untracked-files=all'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const what = 'cannot read the changes of the state repository';
  if (!result.ok) return failure(`${what}: ${result.error.message}`);
  if (result.value.exitCode !== 0) return failure(`${what}: git exited with ${result.value.exitCode}`);
  return ok(parseStatus(result.value.stdout));
};
