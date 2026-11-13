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
  /** The text of the error of the read of the ignored files (`git status --ignored`), by folder. The read then fails with exit code 128. */
  readonly ignoredReadFails?: Readonly<Record<string, string>>;
  /** The text of the error of `git worktree remove`, by the folder that git runs in. The command then fails with exit code 128. */
  readonly worktreeRemoveFails?: Readonly<Record<string, string>>;
  /**
   * What `git config --list --show-scope --includes -z` prints, by folder: a scope, a NUL, the key, a line break, the value and a
   * NUL for each setting. A folder with no entry has one plain local setting.
   */
  readonly configList?: Readonly<Record<string, string>>;
  /** The exit code of `git config --list --show-scope`. Default: 0. A code other than 0 is what git below 2.26 gives. */
  readonly configListExit?: number;
  /** What `git --version` prints. Default: a git that is new enough. */
  readonly version?: string;
  /** The exit code of `git --version`. Default: 0. */
  readonly versionExit?: number;
  /** The value of `core.hooksPath` that git reads, by folder. A folder with no entry has none, and git exits with 1. */
  readonly hooksPath?: Readonly<Record<string, string>>;
  /** The value of `core.hooksPath` at a level other than the local file (global or system), by folder. The local value wins over it. */
  readonly otherLevelHooksPath?: Readonly<Record<string, string>>;
  /** What `git rev-parse --absolute-git-dir` prints, by folder. Default: the folder `.git` inside the folder. */
  readonly gitDirs?: Readonly<Record<string, string>>;
}

export interface GitLog {
  readonly calls: RunCall[];
  /** The git command lines, without the folder and without the words of a step in a state folder: for example "add -A". */
  commands(): string[];
  /** The git command lines, without the folder and with every other word as git got it. */
  rawCommands(): string[];
  /** The argument lists of the clones. */
  clones(): (readonly string[])[];
}

/** The words that a read of a work copy puts after `-C <folder>`: the file monitor off, the git folder and the work tree. */
const PIN_WORDS = 6;

/** The setting that turns the file monitor off: an empty value, which git before 2.36 reads as "no program" and git 2.36 and later reads as "off". */
export const FILE_MONITOR_OFF_WORD = 'core.fsmonitor=';

/** The words that every git step in a state folder puts after `-C <folder>`: the hooks off and the file monitor off. */
export const STATE_GIT_WORDS: readonly string[] = ['-c', 'core.hooksPath=/dev/null', '-c', FILE_MONITOR_OFF_WORD];

/** The same words as one text, for the pin of a command line. */
export const STATE_GIT = STATE_GIT_WORDS.join(' ');

/** The words that a read of one setting of a state folder puts after `-C <folder>`: the file monitor off. The read must see the setting as git sees it, so the hooks stay as set. */
export const STATE_READ_WORDS: readonly string[] = ['-c', FILE_MONITOR_OFF_WORD];

/** The same words as one text, for the pin of a command line. */
export const STATE_READ = STATE_READ_WORDS.join(' ');

const wordsAt = (args: readonly string[], at: number, words: readonly string[]): boolean =>
  words.every((word, index) => args[at + index] === word);

/**
 * The argument list of a git call without the words of a step in a state folder (`STATE_GIT_WORDS`, `STATE_READ_WORDS`). A test that
 * reads what a step does uses this and leaves the check of the words to the tests of the git module. Any other list stays as it is.
 */
export const withoutStateWords = (args: readonly string[]): readonly string[] => {
  if (wordsAt(args, 2, STATE_GIT_WORDS)) return [...args.slice(0, 2), ...args.slice(2 + STATE_GIT_WORDS.length)];
  if (wordsAt(args, 2, STATE_READ_WORDS)) return [...args.slice(0, 2), ...args.slice(2 + STATE_READ_WORDS.length)];
  return args;
};

/**
 * The argument list of a git call without the words of a pinned read (`-c core.fsmonitor= --git-dir X --work-tree Y`) or of a step
 * in a state folder, so the call gets the same answer as the same call without them. Any other list stays as it is.
 */
const unpinned = (args: readonly string[]): readonly string[] =>
  args[2] === '-c' && args[3] === FILE_MONITOR_OFF_WORD && args[4] === '--git-dir' && args[6] === '--work-tree'
    ? [...args.slice(0, 2), ...args.slice(2 + PIN_WORDS)]
    : withoutStateWords(args);

/** What `git --version` prints for a git that is new enough. */
export const DEFAULT_GIT_VERSION = 'git version 2.45.1\n';

/** What `git config --list --show-scope --includes -z` prints for a folder with one plain local setting. */
const PLAIN_CONFIG_LIST = 'local\0core.bare\nfalse\0';

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
  /**
   * The local settings that a `git config -- <key> <value>` call wrote, by folder and key, or null for a `git config --unset <key>` call.
   * A write wins over the fixture.
   */
  const written = new Map<string, string | null>();
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
    if (call.command === 'git' && call.args.length === 1 && call.args[0] === '--version') {
      const code = fixture.versionExit ?? 0;
      return code === 0 ? exited(0, fixture.version ?? DEFAULT_GIT_VERSION) : exited(code, '', 'git: broken');
    }
    if (call.command !== 'git' || call.args[0] !== '-C') return missingProgram(call.command);
    // A read of a work copy names its git folder and turns the file monitor off: the answer is the same as without these words.
    const args = unpinned(call.args);
    const dir = args[1] ?? '';
    const rest = args.slice(2).join(' ');
    const repo = repoAt(dir);
    // As real git does: `git init` makes the folder the top of a work tree.
    if (args[2] === 'init') {
      if (fixture.noWorkTree?.includes(dir) !== true) cloned.set(dir, {});
      return exited(0);
    }
    if (rest === 'config --list --show-scope --includes -z') {
      const code = fixture.configListExit ?? 0;
      if (code !== 0) return exited(code, '', "error: unknown option `show-scope'");
      return exited(0, fixture.configList?.[dir] ?? PLAIN_CONFIG_LIST);
    }
    if (args[2] === 'config' && args[3] === '--' && args.length === 6) {
      written.set(`${dir}\0${args[4]}`, args[5] ?? '');
      return exited(0);
    }
    if (args[2] === 'config' && args[3] === '--unset' && args.length === 5) {
      const key = `${dir}\0${args[4]}`;
      const current = written.has(key) ? written.get(key) : fixture.hooksPath?.[dir];
      written.set(key, null);
      return exited(current === undefined || current === null ? 5 : 0);
    }
    // The fixture value counts as a local setting, so a read of the local file and a read of every level agree.
    if (rest === 'config core.hooksPath' || rest === 'config --local core.hooksPath') {
      const local = written.has(`${dir}\0core.hooksPath`) ? written.get(`${dir}\0core.hooksPath`) : fixture.hooksPath?.[dir];
      // A level other than the local file (global or system) shows only in a read of every level, and the local file wins.
      const value = local ?? (rest === 'config core.hooksPath' ? fixture.otherLevelHooksPath?.[dir] : undefined);
      return value === undefined || value === null ? exited(1) : exited(0, `${value}\n`);
    }
    if (rest === 'rev-parse --absolute-git-dir') return exited(0, `${fixture.gitDirs?.[dir] ?? `${dir}/.git`}\n`);
    if (rest === 'ls-files -z') {
      if (repo === undefined) return exited(128, '', 'fatal: not a git repository');
      if ((fixture.lsFilesExit ?? 0) !== 0) return exited(fixture.lsFilesExit ?? 0, '', 'fatal: ls-files failed');
      if (fixture.lsFilesOverflow === true) return failure('cannot run git: ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      return exited(0, (fixture.tracked?.[dir] ?? []).map((path) => `${path}\0`).join(''));
    }
    if (args[2] === 'check-ignore') {
      if (repo === undefined) return exited(128, '', 'fatal: not a git repository');
      if (fixture.checkIgnoreExit !== undefined) return exited(fixture.checkIgnoreExit, '', 'fatal: check-ignore failed');
      const asked = args.slice(args.indexOf('--') + 1);
      if (asked.some((path) => fixture.checkIgnoreFailsFor?.includes(path) === true)) {
        return exited(128, '', 'fatal: check-ignore failed');
      }
      const rules = fixture.ignored?.[dir];
      const found = rules === undefined ? asked : asked.filter((path) => rules.includes(path));
      return found.length === 0 ? exited(1) : exited(0);
    }
    if (args[2] === 'fetch') {
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
    if (args[2] === 'rev-list' && args[3] === '--count') {
      const [descendant = '', ancestor = ''] = (args[4] ?? '').split('..');
      return ancestor === descendant || fixture.ancestors?.[descendant]?.includes(ancestor) === true ? exited(0, '0\n') : exited(0, '1\n');
    }
    if (rest === 'stash list --format=%gd') {
      const count = fixture.stashes?.[dir] ?? 0;
      return exited(0, Array.from({ length: count }, (_, index) => `stash@{${index}}\n`).join(''));
    }
    if (rest === 'status --porcelain -z --ignored') {
      const refused = fixture.ignoredReadFails?.[dir];
      if (refused !== undefined) return exited(128, '', `${refused}\n`);
      const ignored = (fixture.ignoredFiles?.[dir] ?? []).map((path) => `!! ${path}\0`).join('');
      return exited(0, `${fixture.status?.[dir] ?? ''}${ignored}`);
    }
    if (args[2] === 'worktree' && args[3] === 'remove') {
      const failed = fixture.worktreeRemoveFails?.[dir];
      return failed === undefined ? exited(0) : exited(128, '', `${failed}\n`);
    }
    switch (rest) {
      case 'status --porcelain -z --untracked-files=all':
      case 'status --porcelain -z --untracked-files=all --ignore-submodules=dirty':
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
      // The state repo asks in the quiet form, and git exits with 1 for a repo with no commit. The other form exits with 128.
      case 'rev-parse -q --verify HEAD':
      case 'rev-parse --verify HEAD':
        if (fixture.heads?.[dir] !== undefined) return exited(0, `${fixture.heads[dir]}\n`);
        if (fixture.committed?.includes(dir) === true) return exited(0, 'abc123\n');
        return exited(rest === 'rev-parse -q --verify HEAD' ? 1 : 128);
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
          .map((call) => (call.args[0] === '-C' ? withoutStateWords(call.args).slice(2) : call.args).join(' ')),
      rawCommands: () =>
        calls
          .filter((call) => call.command === 'git')
          .map((call) => (call.args[0] === '-C' ? call.args.slice(2) : call.args).join(' ')),
      clones: () => calls.filter((call) => call.command === 'git' && call.args[0] === 'clone').map((call) => call.args),
    },
  };
};
