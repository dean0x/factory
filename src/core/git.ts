import { basename, join, resolve } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
import { isBranchName } from '../config/primitives.js';
import type { Deps } from './deps.js';
import { ok } from './result.js';

const GIT_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 300_000;
/** The entry that every work tree has in its top folder: a folder, or a file for a linked work tree. */
const GIT_ENTRY = '.git';
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
const parseGithubRepo = (url: string): string | null => {
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

export const githubRepoOf = async (deps: Deps, dir: string): Promise<string | null> => {
  const url = await gitOutput(deps, dir, ['remote', 'get-url', 'origin']);
  return url === null ? null : parseGithubRepo(url);
};

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

/** Clone the repo at `url` into the folder `target`. The `--` keeps a URL from acting as an option. */
export const gitClone = async (deps: Deps, url: string, target: string): Promise<CliResult<void>> => {
  const result = await deps.run('git', ['clone', '--', url, target], { timeoutMs: CLONE_TIMEOUT_MS });
  const shown = withoutUserinfo(url);
  if (!result.ok) return failure(`cannot clone ${shown}: ${withoutUserinfo(result.error.message)}`);
  if (result.value.exitCode === 0) return ok(undefined);
  const detail = withoutUserinfo(result.value.stderr.trim().split('\n').at(-1) ?? '').slice(0, MAX_STDERR_CHARS);
  return failure(`cannot clone ${shown}: git exited with ${result.value.exitCode}${detail === '' ? '' : ` (${detail})`}`);
};

export const gitInit = (deps: Deps, dir: string): Promise<CliResult<void>> =>
  gitStep(deps, dir, ['init', '-q'], 'create the state repository');

/** Stage everything and commit. The caller checks the identity first. */
export const commitAll = async (deps: Deps, dir: string, message: string): Promise<CliResult<void>> => {
  const staged = await gitStep(deps, dir, ['add', '-A'], 'stage the state files');
  if (!staged.ok) return staged;
  return gitStep(deps, dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], 'commit the state files');
};

/** Remove the staged changes from the index. The files keep their text. */
export const unstageAll = (deps: Deps, dir: string): Promise<CliResult<void>> =>
  gitStep(deps, dir, ['reset', '-q'], 'clear the staged files');
