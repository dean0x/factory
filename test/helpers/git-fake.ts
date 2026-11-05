import { posix } from 'node:path';
import { failure } from '../../src/cli/errors.js';
import { exited, missingProgram, type RunCall, type RunHandler } from './fake-deps.js';

export interface FakeRepo {
  /** False when the folder is inside a work tree but not its top folder. */
  readonly topLevel?: boolean;
  /** What `git rev-parse --git-common-dir` prints. Default: .git. A linked work tree prints the git folder of its repo. */
  readonly commonDir?: string;
  readonly origin?: string;
  readonly originHead?: string;
  readonly branch?: string;
}

/** The folder of the local copies of the remote branches of the remote `origin`. */
const REMOTE_REFS = 'refs/remotes/origin/';

/** The remote branches that the repo of one folder knows, and what the remote has now. */
export interface FakeRemote {
  /** The local copies of the remote branches (`refs/remotes/origin/<branch>`) at the start: the branch and its commit id. */
  readonly copies: Readonly<Record<string, string>>;
  /** What the remote has now. A fetch makes the copies equal to it, and drops a copy that it lacks. Default: the copies. */
  readonly now?: Readonly<Record<string, string>>;
  /** The exit code of `git fetch`. Default: 0. */
  readonly fetchExit?: number;
}

export interface GitFixture {
  /** The value of git config user.name and user.email. False means no identity. */
  readonly identity?: boolean;
  /** The login that `gh api user` prints. Null means gh fails. Undefined means gh is absent. */
  readonly gh?: string | null;
  /** Work trees by absolute folder. */
  readonly repos?: Readonly<Record<string, FakeRepo>>;
  /** The folders where a commit already exists. */
  readonly committed?: readonly string[];
  /** The user.name that git config returns outside the fixture identity. */
  readonly userName?: string;
  /** The exit code of `git clone`. Default: 0. */
  readonly cloneExit?: number;
  /** What a failed `git clone` prints on stderr. Default: a line with no URL. */
  readonly cloneStderr?: string;
  /** The paths that a work tree tracks, by folder: `git ls-files -z` prints them. A folder with no entry tracks nothing. */
  readonly tracked?: Readonly<Record<string, readonly string[]>>;
  /** The exit code of `git ls-files`. Default: 0. */
  readonly lsFilesExit?: number;
  /** True when the output of `git ls-files` is larger than the program reads: the run fails and gives no path. */
  readonly lsFilesOverflow?: boolean;
  /** What `git status --porcelain -z` prints, by folder: for example " M node.json\0". A folder with no entry is clean. */
  readonly status?: Readonly<Record<string, string>>;
  /**
   * The paths that git ignores, by folder, as the rules of `.gitignore` make them. A folder with no entry ignores every
   * path, as the share list of a factory does.
   */
  readonly ignored?: Readonly<Record<string, readonly string[]>>;
  /** The exit code of `git check-ignore` when it fails. Default: none, the command works. */
  readonly checkIgnoreExit?: number;
  /** The paths for which `git check-ignore` fails with exit code 128. The other paths get the answer of the rules. */
  readonly checkIgnoreFailsFor?: readonly string[];
  /** The folders that stay out of every work tree, also after `git init` ran in them. */
  readonly noWorkTree?: readonly string[];
  /** The commit id that `git rev-parse --verify HEAD` prints, by folder. It wins over `committed`. */
  readonly heads?: Readonly<Record<string, string>>;
  /** The remote branches of a repo, by the folder that git runs in. A folder with no entry has no remote branch. */
  readonly remotes?: Readonly<Record<string, FakeRemote>>;
  /** The commits below another commit, by the commit above them. The count of `rev-list` is 0 for the same commit too. */
  readonly ancestors?: Readonly<Record<string, readonly string[]>>;
  /** The count of entries of the stash, by folder. A folder with no entry has an empty stash. */
  readonly stashes?: Readonly<Record<string, number>>;
  /** The files that git ignores and that exist, by folder. `git status --ignored` lists them as `!!` entries. */
  readonly ignoredFiles?: Readonly<Record<string, readonly string[]>>;
  /** The text of the error of `git worktree remove`, by the folder that git runs in. The command then fails with exit code 128. */
  readonly worktreeRemoveFails?: Readonly<Record<string, string>>;
}

export interface GitLog {
  readonly calls: RunCall[];
  /** The git command lines, without the folder: for example "add -A". */
  commands(): string[];
  /** The argument lists of the clones. */
  clones(): (readonly string[])[];
}

/**
 * The top folder of the work tree that holds `dir`: the nearest folder above `dir`, or `dir` itself, that is a work tree.
 * A fixture repo with `topLevel: false` is a folder inside a work tree, so its top is its parent folder.
 */
const workTreeTopOf = (repoAt: (dir: string) => FakeRepo | undefined, dir: string): string | null => {
  for (let current = dir; ; current = posix.dirname(current)) {
    const repo = repoAt(current);
    if (repo !== undefined) return repo.topLevel === false ? posix.dirname(current) : current;
    if (current === '/' || current === '.') return null;
  }
};

export const gitHandler = (fixture: GitFixture = {}): { handler: RunHandler; log: GitLog } => {
  const calls: RunCall[] = [];
  const identity = fixture.identity ?? true;
  /** The work trees that a clone made. A fixture repo at the same folder wins. */
  const cloned = new Map<string, FakeRepo>();
  const repoAt = (dir: string): FakeRepo | undefined => fixture.repos?.[dir] ?? cloned.get(dir);
  /** The local copies of the remote branches by folder, as pairs of the branch and its commit id. A fetch replaces them. */
  const copies = new Map<string, [string, string][]>();
  const copiesOf = (dir: string, remote: FakeRemote): [string, string][] => {
    const found = copies.get(dir) ?? Object.entries(remote.copies);
    copies.set(dir, found);
    return found;
  };
  const handler: RunHandler = (call) => {
    calls.push(call);
    if (call.command === 'gh') {
      if (fixture.gh === undefined) return missingProgram('gh');
      return fixture.gh === null ? exited(1, '', 'not logged in') : exited(0, `${fixture.gh}\n`);
    }
    if (call.command === 'git' && call.args[0] === 'clone') {
      const code = fixture.cloneExit ?? 0;
      if (code !== 0) {
        return exited(code, '', fixture.cloneStderr ?? 'fatal: could not read from the remote repository\n');
      }
      // As real git does: the clone is a work tree, its origin is the place it came from, and it has the default branch of that place.
      const [from, target] = [call.args[2] ?? '', call.args[3] ?? ''];
      const source = repoAt(from);
      cloned.set(target, { origin: from, ...(source?.originHead === undefined ? {} : { originHead: source.originHead }) });
      return exited(0);
    }
    if (call.command !== 'git' || call.args[0] !== '-C') return missingProgram(call.command);
    const dir = call.args[1] ?? '';
    const rest = call.args.slice(2).join(' ');
    const repo = repoAt(dir);
    // As real git does: `git init` makes the folder the top of a work tree.
    if (call.args[2] === 'init') {
      if (fixture.noWorkTree?.includes(dir) !== true) cloned.set(dir, {});
      return exited(0);
    }
    if (rest === 'ls-files -z') {
      if (repo === undefined) return exited(128, '', 'fatal: not a git repository');
      if ((fixture.lsFilesExit ?? 0) !== 0) return exited(fixture.lsFilesExit ?? 0, '', 'fatal: ls-files failed');
      if (fixture.lsFilesOverflow === true) return failure('cannot run git: ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      return exited(0, (fixture.tracked?.[dir] ?? []).map((path) => `${path}\0`).join(''));
    }
    if (call.args[2] === 'check-ignore') {
      if (repo === undefined) return exited(128, '', 'fatal: not a git repository');
      if (fixture.checkIgnoreExit !== undefined) return exited(fixture.checkIgnoreExit, '', 'fatal: check-ignore failed');
      const asked = call.args.slice(call.args.indexOf('--') + 1);
      if (asked.some((path) => fixture.checkIgnoreFailsFor?.includes(path) === true)) {
        return exited(128, '', 'fatal: check-ignore failed');
      }
      const rules = fixture.ignored?.[dir];
      const found = rules === undefined ? asked : asked.filter((path) => rules.includes(path));
      return found.length === 0 ? exited(1) : exited(0);
    }
    if (call.args[2] === 'fetch') {
      const remote = fixture.remotes?.[dir];
      if (remote?.fetchExit !== undefined && remote.fetchExit !== 0) {
        return exited(remote.fetchExit, '', 'fatal: unable to access the remote');
      }
      if (remote !== undefined) copiesOf(dir, remote).splice(0, Infinity, ...Object.entries(remote.now ?? remote.copies));
      return exited(0);
    }
    if (rest.startsWith(`rev-parse --verify --quiet ${REMOTE_REFS}`)) {
      const branch = rest.slice(`rev-parse --verify --quiet ${REMOTE_REFS}`.length);
      const remote = fixture.remotes?.[dir];
      const copy = remote === undefined ? undefined : copiesOf(dir, remote).find(([name]) => name === branch);
      return copy === undefined ? exited(1) : exited(0, `${copy[1]}\n`);
    }
    if (call.args[2] === 'rev-list' && call.args[3] === '--count') {
      const [descendant = '', ancestor = ''] = (call.args[4] ?? '').split('..');
      return ancestor === descendant || fixture.ancestors?.[descendant]?.includes(ancestor) === true ? exited(0, '0\n') : exited(0, '1\n');
    }
    if (rest === 'stash list --format=%gd') {
      const count = fixture.stashes?.[dir] ?? 0;
      return exited(0, Array.from({ length: count }, (_, index) => `stash@{${index}}\n`).join(''));
    }
    if (rest === 'status --porcelain -z --ignored') {
      const ignored = (fixture.ignoredFiles?.[dir] ?? []).map((path) => `!! ${path}\0`).join('');
      return exited(0, `${fixture.status?.[dir] ?? ''}${ignored}`);
    }
    if (call.args[2] === 'worktree' && call.args[3] === 'remove') {
      const failed = fixture.worktreeRemoveFails?.[dir];
      return failed === undefined ? exited(0) : exited(128, '', `${failed}\n`);
    }
    switch (rest) {
      case 'status --porcelain -z --untracked-files=all':
        return exited(0, fixture.status?.[dir] ?? '');
      case 'rev-parse --git-common-dir':
        return repo === undefined ? exited(128) : exited(0, `${repo.commonDir ?? '.git'}\n`);
      case 'config remote.origin.url':
        return repo?.origin === undefined ? exited(1) : exited(0, `${repo.origin}\n`);
      case 'rev-parse --is-inside-work-tree --show-prefix':
        return repo === undefined ? exited(128) : exited(0, repo.topLevel === false ? 'true\nsub/\n' : 'true\n\n');
      case 'rev-parse --show-toplevel': {
        const top = workTreeTopOf(repoAt, dir);
        return top === null ? exited(128) : exited(0, `${top}\n`);
      }
      case 'config user.name':
        return identity ? exited(0, `${fixture.userName ?? 'Git User'}\n`) : exited(1);
      case 'config user.email':
        return identity ? exited(0, 'git.user@example.com\n') : exited(1);
      case 'remote get-url origin':
        return repo?.origin === undefined ? exited(2) : exited(0, `${repo.origin}\n`);
      case 'symbolic-ref --short refs/remotes/origin/HEAD':
        return repo?.originHead === undefined ? exited(128) : exited(0, `${repo.originHead}\n`);
      case 'branch --show-current':
        return repo?.branch === undefined ? exited(0, '\n') : exited(0, `${repo.branch}\n`);
      case 'rev-parse --verify HEAD':
        if (fixture.heads?.[dir] !== undefined) return exited(0, `${fixture.heads[dir]}\n`);
        return fixture.committed?.includes(dir) === true ? exited(0, 'abc123\n') : exited(128);
      default:
        return exited(0);
    }
  };
  return {
    handler,
    log: {
      calls,
      commands: () =>
        calls
          .filter((call) => call.command === 'git')
          .map((call) => (call.args[0] === '-C' ? call.args.slice(2) : call.args).join(' ')),
      clones: () => calls.filter((call) => call.command === 'git' && call.args[0] === 'clone').map((call) => call.args),
    },
  };
};
