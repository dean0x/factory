import { posix } from 'node:path';
import { exited, missingProgram, type RunCall, type RunHandler } from './fake-deps.js';

export interface FakeRepo {
  /** False when the folder is inside a work tree but not its top folder. */
  readonly topLevel?: boolean;
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
}

export interface GitLog {
  readonly calls: RunCall[];
  /** The git command lines, without the folder: for example "add -A". */
  commands(): string[];
}

/**
 * The top folder of the work tree that holds `dir`: the nearest folder above `dir`, or `dir` itself, that is a work tree.
 * A fixture repo with `topLevel: false` is a folder inside a work tree, so its top is its parent folder.
 */
const workTreeTopOf = (fixture: GitFixture, dir: string): string | null => {
  for (let current = dir; ; current = posix.dirname(current)) {
    const repo = fixture.repos?.[current];
    if (repo !== undefined) return repo.topLevel === false ? posix.dirname(current) : current;
    if (current === '/' || current === '.') return null;
  }
};

export const gitHandler = (fixture: GitFixture = {}): { handler: RunHandler; log: GitLog } => {
  const calls: RunCall[] = [];
  const identity = fixture.identity ?? true;
  const handler: RunHandler = (call) => {
    calls.push(call);
    if (call.command === 'gh') {
      if (fixture.gh === undefined) return missingProgram('gh');
      return fixture.gh === null ? exited(1, '', 'not logged in') : exited(0, `${fixture.gh}\n`);
    }
    if (call.command !== 'git' || call.args[0] !== '-C') return missingProgram(call.command);
    const dir = call.args[1] ?? '';
    const rest = call.args.slice(2).join(' ');
    const repo = fixture.repos?.[dir];
    switch (rest) {
      case 'rev-parse --is-inside-work-tree --show-prefix':
        return repo === undefined ? exited(128) : exited(0, repo.topLevel === false ? 'true\nsub/\n' : 'true\n\n');
      case 'rev-parse --show-toplevel': {
        const top = workTreeTopOf(fixture, dir);
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
        calls.filter((call) => call.command === 'git').map((call) => call.args.slice(2).join(' ')),
    },
  };
};
