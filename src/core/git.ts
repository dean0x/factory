import { failure, type CliResult } from '../cli/errors.js';
import { isBranchName } from '../config/schema.js';
import type { Deps } from './deps.js';
import { ok } from './result.js';

const GIT_TIMEOUT_MS = 15_000;

const GITHUB_URL =
  /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_][A-Za-z0-9._-]{0,99}?)(?:\.git)?\/?$/;

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
