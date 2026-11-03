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
    switch (rest) {
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
