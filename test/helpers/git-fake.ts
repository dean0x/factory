import { posix } from 'node:path';
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
  /** What `git status --porcelain -z` prints, by folder: for example " M node.json\0". A folder with no entry is clean. */
  readonly status?: Readonly<Record<string, string>>;
  /**
   * The paths that git ignores, by folder, as the rules of `.gitignore` make them. A folder with no entry ignores every
   * path, as the share list of a factory does.
   */
  readonly ignored?: Readonly<Record<string, readonly string[]>>;
  /** The exit code of `git check-ignore` when it fails. Default: none, the command works. */
  readonly checkIgnoreExit?: number;
  /** The folders that stay out of every work tree, also after `git init` ran in them. */
  readonly noWorkTree?: readonly string[];
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
      return exited(0, (fixture.tracked?.[dir] ?? []).map((path) => `${path}\0`).join(''));
    }
    if (call.args[2] === 'check-ignore') {
      if (repo === undefined) return exited(128, '', 'fatal: not a git repository');
      if (fixture.checkIgnoreExit !== undefined) return exited(fixture.checkIgnoreExit, '', 'fatal: check-ignore failed');
      const asked = call.args.slice(call.args.indexOf('--') + 1);
      const rules = fixture.ignored?.[dir];
      const found = rules === undefined ? asked : asked.filter((path) => rules.includes(path));
      return found.length === 0 ? exited(1) : exited(0);
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
