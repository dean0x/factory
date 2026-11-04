import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import {
  addWorkTree,
  blobTextOf,
  branchExists,
  commitAll,
  commitPaths,
  gitClone,
  headEntriesAt,
  headOf,
  ignoredPathsOf,
  initRootRepo,
  isFileMode,
  LINK_MODE,
  listRepoChildren,
  MAX_IGNORE_PATHS,
  MAX_SCAN_ENTRIES,
  requireWorkTreeTop,
  statusOf,
  trackedFilesOf,
  unstagePaths,
  withoutUserinfo,
} from '../../src/core/git.js';
import { trackedFiles } from '../../src/names.js';
import { createFakeDeps, exited, withFsWatch, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type FakeRepo, type GitFixture } from '../helpers/git-fake.js';

const WS = '/ws';

/** A workspace folder whose children are the given folders. A repo gets a `.git` entry, like a real work tree. */
const workspace = (
  repos: Readonly<Record<string, FakeRepo>>,
  plain: readonly string[] = [],
  extra: {
    readonly links?: Record<string, string>;
    readonly fixture?: GitFixture;
    readonly env?: Record<string, string | undefined>;
    readonly os?: string;
  } = {},
): { deps: FakeDeps; log: ReturnType<typeof gitHandler>['log'] } => {
  const { handler, log } = gitHandler({ repos, ...extra.fixture });
  const deps = createFakeDeps({
    cwd: WS,
    run: handler,
    ...(extra.links === undefined ? {} : { links: extra.links }),
    ...(extra.env === undefined ? {} : { env: extra.env }),
    ...(extra.os === undefined ? {} : { os: extra.os }),
  });
  for (const path of Object.keys(repos)) deps.seedDir(`${path}/.git`);
  for (const path of plain) deps.seedDir(path);
  return { deps, log };
};

const scanned = async (deps: FakeDeps) => {
  const result = await listRepoChildren(deps, WS);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('git: the repos one level down', () => {
  it('lists the work trees below a folder, sorted, and not the other folders', async () => {
    const { deps } = workspace({ '/ws/web': {}, '/ws/api': {} }, ['/ws/docs']);
    expect(await scanned(deps)).toEqual({ repos: ['/ws/api', '/ws/web'], skipped: [], truncated: false });
  });

  it('runs git only for a folder that has a .git entry', async () => {
    const { deps, log } = workspace({ '/ws/web': {} }, ['/ws/docs', '/ws/notes']);
    await scanned(deps);
    const probed = log.calls.map((call) => call.args[1]);
    expect(new Set(probed)).toEqual(new Set(['/ws/web']));
  });

  it('lists a repo once and skips another checkout of it, with the reason', async () => {
    const { deps } = workspace({ '/ws/web': {}, '/ws/web-search': { commonDir: '/ws/web/.git' } });
    expect(await scanned(deps)).toEqual({
      repos: ['/ws/web'],
      skipped: [{ path: '/ws/web-search', reason: 'it is one more work tree of the repo web' }],
      truncated: false,
    });
  });

  it('lists the checkout that holds the git folder, also when the other checkout comes first by name', async () => {
    const { deps } = workspace({ '/ws/a-linked': { commonDir: '/ws/web/.git' }, '/ws/web': {} });
    const scan = await scanned(deps);
    expect(scan.repos).toEqual(['/ws/web']);
    expect(scan.skipped.map((folder) => folder.path)).toEqual(['/ws/a-linked']);
  });

  it('lists the first checkout by name when none of them holds the shared git folder', async () => {
    const { deps } = workspace({ '/ws/b': { commonDir: '/elsewhere/.git' }, '/ws/a': { commonDir: '/elsewhere/.git' } });
    const scan = await scanned(deps);
    expect(scan.repos).toEqual(['/ws/a']);
    expect(scan.skipped.map((folder) => folder.path)).toEqual(['/ws/b']);
  });

  it('follows no symbolic link', async () => {
    const { deps } = workspace({ '/ws/web': {}, '/ws/linked': {} }, [], { links: { '/ws/linked': '/elsewhere/real' } });
    expect((await scanned(deps)).repos).toEqual(['/ws/web']);
  });

  it('does not list a folder that git does not accept as the top of a work tree', async () => {
    const { deps } = workspace({ '/ws/web': {}, '/ws/sub': { topLevel: false } });
    expect((await scanned(deps)).repos).toEqual(['/ws/web']);
  });

  it('reads at most 200 entries and says so', async () => {
    const names = Array.from({ length: MAX_SCAN_ENTRIES + 50 }, (_, i) => `/ws/d${String(i).padStart(3, '0')}`);
    const { deps } = workspace({ '/ws/d000': {}, '/ws/d249': {} }, names);
    const scan = await scanned(deps);
    expect(scan.repos).toEqual(['/ws/d000']);
    expect(scan.truncated).toBe(true);
  });

  it('passes on the error of a folder that cannot be listed', async () => {
    const deps = createFakeDeps({ cwd: WS });
    const result = await listRepoChildren(deps, '/ws/none');
    expect(result.ok).toBe(false);
  });

  describe('when the folder is the user home and holds the settings folder of Claude Code', () => {
    const USER = '/users/me';
    const CLAUDE = `${USER}/.claude`;
    const underClaude = (path: string): boolean => {
      const lower = path.toLowerCase();
      return lower === CLAUDE || lower.startsWith(`${CLAUDE}/`);
    };

    /** Scan the user home, which holds one repo and a settings folder that has a .git entry, with every file call noted. */
    const scanUser = async (settings: string, extra: { readonly env?: Record<string, string | undefined>; readonly os?: string }) => {
      const { deps, log } = workspace({ [`${USER}/web`]: {}, [`${USER}/${settings}`]: {} }, [], extra);
      const seen: string[] = [];
      const result = await listRepoChildren(withFsWatch(deps, (_method, path) => seen.push(path)), USER);
      if (!result.ok) throw new Error(result.error.message);
      return { repos: result.value.repos, seen, probed: new Set(log.calls.map((call) => call.args[1])) };
    };

    it('lists the other repo, and makes no file call and no git call at or under that folder', async () => {
      const scan = await scanUser('.claude', { env: { HOME: USER } });
      expect(scan.repos).toEqual([`${USER}/web`]);
      expect(scan.seen.filter(underClaude)).toEqual([]);
      expect(scan.probed).toEqual(new Set([`${USER}/web`]));
    });

    it('ignores the case of letters on macOS only', async () => {
      const mac = await scanUser('.CLAUDE', { env: { HOME: USER }, os: 'darwin' });
      expect(mac.repos).toEqual([`${USER}/web`]);
      expect(mac.seen.filter(underClaude)).toEqual([]);
      const linux = await scanUser('.CLAUDE', { env: { HOME: USER }, os: 'linux' });
      expect(linux.repos).toEqual([`${USER}/.CLAUDE`, `${USER}/web`]);
    });

    it('lists it when the variable of the user home is not set', async () => {
      expect((await scanUser('.claude', { env: {} })).repos).toEqual([`${USER}/.claude`, `${USER}/web`]);
    });
  });
});

describe('git: clone', () => {
  const clone = async (fixture: GitFixture = {}) => {
    const { handler, log } = gitHandler(fixture);
    const deps = createFakeDeps({ cwd: WS, run: handler });
    const result = await gitClone(deps, 'https://host/acme/api.git', '/w/api');
    return { result, log, deps };
  };

  it('runs git with an argument list, "--" before the URL and a time limit of 300 s', async () => {
    const { result, log, deps } = await clone();
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', 'https://host/acme/api.git', '/w/api']]);
    expect(deps.calls[0]?.timeoutMs).toBe(300_000);
  });

  it('passes no option of git before the double hyphen, and never a submodule option', async () => {
    const { log } = await clone();
    const [args] = log.clones();
    expect(args?.slice(0, 2)).toEqual(['clone', '--']);
    expect(args?.filter((argument) => /submodule|recurse|recursive/i.test(argument))).toEqual([]);
    expect(args).toHaveLength(4);
  });

  it('runs git with no shell: the program is git and the URL is one argument', async () => {
    const { deps } = await clone();
    expect(deps.calls.map((call) => call.command)).toEqual(['git']);
    expect(deps.calls[0]?.args).toContain('https://host/acme/api.git');
  });

  it('fails with the exit code and the last line of the git message', async () => {
    const { result } = await clone({ cloneExit: 128 });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toContain('git exited with 128');
      expect(result.error.message).toContain('could not read from the remote repository');
    }
  });

  it('shows no userinfo of the URL in its error, also when git repeats the URL', async () => {
    const url = 'https://user:tok3n@host/acme/api.git';
    const { handler } = gitHandler({
      cloneExit: 128,
      cloneStderr: "fatal: unable to access 'https://user:tok3n@host/acme/api.git/': The requested URL returned error: 403\n",
    });
    const result = await gitClone(createFakeDeps({ cwd: WS, run: handler }), url, '/w/api');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain('tok3n');
      expect(result.error.message).not.toContain('user:');
      expect(result.error.message).toContain('cannot clone https://host/acme/api.git: git exited with 128');
      expect(result.error.message).toContain("unable to access 'https://host/acme/api.git/'");
    }
  });

  it('says that the clone took longer than the limit, and what to do, when the time limit stops git', async () => {
    const deps = createFakeDeps({ cwd: WS, run: () => failure('cannot run git: SIGTERM') });
    const result = await gitClone(deps, 'https://user:tok3n@host/acme/api.git', '/w/api');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('cannot clone https://host/acme/api.git');
      expect(result.error.message).toContain('took longer than 300 seconds');
      expect(result.error.hint).toContain('ssh agent');
      expect(result.error.hint).toContain('gh auth login');
      expect(result.error.hint).toContain('then run "factory init" again.');
      expect(JSON.stringify(result.error)).not.toContain('SIGTERM');
      expect(JSON.stringify(result.error)).not.toContain('tok3n');
    }
  });

  it('keeps the message of another failure to run git', async () => {
    const deps = createFakeDeps({ cwd: WS, run: () => failure('cannot run git: ENOENT') });
    const result = await gitClone(deps, 'https://host/acme/api.git', '/w/api');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('cannot clone https://host/acme/api.git: cannot run git: ENOENT');
  });
});

describe('git: the work copy of a worker', () => {
  const CLONE = '/w/web';
  const COPY = '/w/work-copies/web/alpha';

  const added = async (run: RunHandler, branch = 'worker/alpha', folder = COPY) => {
    const deps = createFakeDeps({ cwd: WS, run });
    const result = await addWorkTree(deps, CLONE, branch, folder);
    return { result, deps };
  };

  it('makes the work copy with one git call: a new branch, the folder, no option after them, and a time limit of 120 s', async () => {
    const { result, deps } = await added(() => exited(0));
    expect(result.ok).toBe(true);
    expect(deps.calls.map((call) => [call.command, ...call.args])).toEqual([
      ['git', '-C', CLONE, 'worktree', 'add', '-b', 'worker/alpha', COPY],
    ]);
    expect(deps.calls[0]?.timeoutMs).toBe(120_000);
  });

  it('fails with the exit code and the last line of the git message', async () => {
    const { result } = await added(() => exited(128, '', "Preparing worktree\nfatal: a branch named 'worker/alpha' already exists\n"));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toContain(`cannot make the work copy ${COPY}`);
      expect(result.error.message).toContain('git exited with 128');
      expect(result.error.message).toContain("a branch named 'worker/alpha' already exists");
      expect(result.error.message).not.toContain('Preparing worktree');
    }
  });

  it('says that git took longer than the limit when the time limit stops git', async () => {
    const { result } = await added(() => failure('cannot run git: SIGTERM'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('took longer than 120 seconds');
      expect(result.error.message).not.toContain('SIGTERM');
    }
  });

  it('keeps the message of another failure to run git', async () => {
    const { result } = await added(() => failure('cannot run git: ENOENT'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe(`cannot make the work copy ${COPY}: cannot run git: ENOENT`);
  });

  it.each([['-b'], ['a b'], [''], ['x;y']])('refuses the branch %j before it runs git', async (branch) => {
    const { result, deps } = await added(() => exited(0), branch);
    expect(result.ok).toBe(false);
    expect(deps.calls).toEqual([]);
  });

  it('refuses a folder that is not an absolute path before it runs git', async () => {
    const { result, deps } = await added(() => exited(0), 'worker/alpha', 'work-copies/web/alpha');
    expect(result.ok).toBe(false);
    expect(deps.calls).toEqual([]);
  });

  describe('the branch of the repo', () => {
    const asked = async (run: RunHandler) => {
      const deps = createFakeDeps({ cwd: WS, run });
      return { result: await branchExists(deps, CLONE, 'worker/alpha'), deps };
    };

    it('asks git for the exact branch reference, and reads exit code 0 as a branch that exists', async () => {
      const { result, deps } = await asked(() => exited(0, 'abc123\n'));
      expect(result).toEqual({ ok: true, value: true });
      expect(deps.calls.map((call) => [call.command, ...call.args])).toEqual([
        ['git', '-C', CLONE, 'rev-parse', '--verify', '--quiet', 'refs/heads/worker/alpha'],
      ]);
    });

    it('reads exit code 1 as a branch that does not exist', async () => {
      expect((await asked(() => exited(1))).result).toEqual({ ok: true, value: false });
    });

    it('fails for any other exit code, and when git does not run', async () => {
      expect((await asked(() => exited(128, '', 'fatal: not a git repository'))).result).toMatchObject({ ok: false });
      expect((await asked(() => failure('cannot run git: ENOENT'))).result).toMatchObject({ ok: false });
    });

    it('refuses a branch that is not a branch name before it runs git', async () => {
      const deps = createFakeDeps({ cwd: WS, run: () => exited(0) });
      expect(await branchExists(deps, CLONE, '--all')).toMatchObject({ ok: false });
      expect(deps.calls).toEqual([]);
    });
  });
});

describe('git: the commit of a new state repo', () => {
  it('stages everything and commits with the hooks of the repo off', async () => {
    const { handler, log } = gitHandler();
    const result = await commitAll(createFakeDeps({ cwd: WS, run: handler }), '/w/node/.factory', 'chore: first');
    expect(result.ok).toBe(true);
    expect(log.commands()).toEqual([
      'add -A',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: first',
    ]);
  });
});

describe('git: the repo of the root', () => {
  const ROOT = '/w/node';
  const input = { paths: ['.gitignore', 'factory.yaml', 'setup'], message: 'chore: first', branch: 'main' };

  it('makes the repo on the named branch, stages the named paths after a separator, and commits with the hooks off', async () => {
    const { handler, log } = gitHandler();
    const result = await initRootRepo(createFakeDeps({ cwd: WS, run: handler }), ROOT, input);
    expect(result).toEqual({ ok: true, value: { committed: true } });
    expect(log.commands()).toEqual([
      'init -q -b main',
      'config user.name',
      'config user.email',
      'add -- .gitignore factory.yaml setup',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: first',
    ]);
  });

  it('never stages with -A or a dot, so a path outside the list can not enter the commit', async () => {
    const { handler, log } = gitHandler();
    await initRootRepo(createFakeDeps({ cwd: WS, run: handler }), ROOT, input);
    const staging = log.commands().filter((command) => command.startsWith('add'));
    expect(staging).toEqual(['add -- .gitignore factory.yaml setup']);
    expect(staging[0]?.split(' ')).not.toContain('-A');
    expect(staging[0]?.split(' ')).not.toContain('.');
  });

  it('makes the repo and no commit when git has no identity', async () => {
    const { handler, log } = gitHandler({ identity: false });
    const result = await initRootRepo(createFakeDeps({ cwd: WS, run: handler }), ROOT, input);
    expect(result).toEqual({ ok: true, value: { committed: false } });
    expect(log.commands().filter((command) => command.startsWith('init'))).toEqual(['init -q -b main']);
    expect(log.commands().some((command) => command.startsWith('add') || command.includes('commit'))).toBe(false);
  });

  it('refuses a root that holds a git folder already, and runs no git command', async () => {
    const { handler, log } = gitHandler();
    const deps = createFakeDeps({ cwd: WS, run: handler });
    deps.seedDir(`${ROOT}/.git`);
    const result = await initRootRepo(deps, ROOT, input);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('holds a git repository already') } });
    expect(log.commands()).toEqual([]);
  });

  it('refuses a root that holds a git file, as a linked work tree does', async () => {
    const { handler, log } = gitHandler();
    const deps = createFakeDeps({ cwd: WS, run: handler });
    deps.seed(`${ROOT}/.git`, 'gitdir: /elsewhere\n');
    expect((await initRootRepo(deps, ROOT, input)).ok).toBe(false);
    expect(log.commands()).toEqual([]);
  });

  it.each([
    ['the repo can not be made', 'init', 'cannot create the config repository: git exited with 128'],
    ['the paths can not be staged', 'add', 'cannot stage the config files: git exited with 128'],
    ['the commit fails', 'commit', 'cannot commit the config files: git exited with 128'],
  ])('names the step in the error when %s', async (_name, word, message) => {
    const { handler } = gitHandler();
    const deps = createFakeDeps({ cwd: WS, run: (call) => (call.args.includes(word) ? exited(128) : handler(call)) });
    expect(await initRootRepo(deps, ROOT, input)).toMatchObject({ ok: false, error: { message } });
  });
});

describe('git: the commit of chosen paths', () => {
  const DIR = '/w/node/.factory';
  const paths = { present: ['node.json', 'roles/worker.md'], gone: ['protocol.md'] };

  it('stages the removal of the moved paths and the named paths only, then commits with the hooks off', async () => {
    const { handler, log } = gitHandler();
    const result = await commitPaths(createFakeDeps({ cwd: WS, run: handler }), DIR, paths, 'chore: upgrade the state');
    expect(result.ok).toBe(true);
    expect(log.commands()).toEqual([
      'rm -r -q --cached --ignore-unmatch -- protocol.md',
      'add -A -- node.json roles/worker.md',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: upgrade the state',
    ]);
  });

  it('runs no removal when no path moved', async () => {
    const { handler, log } = gitHandler();
    await commitPaths(createFakeDeps({ cwd: WS, run: handler }), DIR, { present: ['node.json'], gone: [] }, 'm');
    expect(log.commands().map((command) => command.split(' ')[0])).toEqual(['add', '-c']);
  });

  it('does not commit when the staging fails', async () => {
    const { handler, log } = gitHandler();
    const deps = createFakeDeps({ cwd: WS, run: (call) => (call.args.includes('add') ? exited(128) : handler(call)) });
    const result = await commitPaths(deps, DIR, paths, 'm');
    expect(result).toMatchObject({ ok: false, error: { message: 'cannot stage the state files: git exited with 128' } });
    expect(log.commands().some((command) => command.includes('commit'))).toBe(false);
  });

  it('clears only the named paths from the index', async () => {
    const { handler, log } = gitHandler();
    const result = await unstagePaths(createFakeDeps({ cwd: WS, run: handler }), DIR, paths);
    expect(result.ok).toBe(true);
    expect(log.commands()).toEqual(['reset -q -- node.json roles/worker.md protocol.md']);
  });
});

describe('git: the commit that HEAD names', () => {
  const head = (run: RunHandler) => headOf(createFakeDeps({ cwd: WS, run }), '/w/node/.factory');

  it('is the commit id when the repo has a commit', async () => {
    expect(await head(() => exited(0, 'abc123\n'))).toEqual({ ok: true, value: 'abc123' });
  });

  it('is null when the repo has no commit', async () => {
    expect(await head(() => exited(128))).toEqual({ ok: true, value: null });
  });

  it('is an error when git cannot run', async () => {
    expect(await head(() => failure('cannot run git: SIGTERM'))).toMatchObject({ ok: false });
  });
});

describe('git: the status of a repo', () => {
  const status = (run: RunHandler) => statusOf(createFakeDeps({ cwd: WS, run }), '/w/node/.factory');

  it('asks for every untracked file one by one, with names that git does not quote', async () => {
    const { handler, log } = gitHandler();
    await statusOf(createFakeDeps({ cwd: WS, run: handler }), '/w/node/.factory');
    expect(log.commands()).toEqual(['status --porcelain -z --untracked-files=all']);
  });

  it('reads the state of the index and of the work tree for each path', async () => {
    const result = await status(() => exited(0, 'M  a.md\0 M dir/b.md\0?? c.md\0 D d.md\0'));
    expect(result).toEqual({
      ok: true,
      value: [
        { index: 'M', tree: ' ', path: 'a.md' },
        { index: ' ', tree: 'M', path: 'dir/b.md' },
        { index: '?', tree: '?', path: 'c.md' },
        { index: ' ', tree: 'D', path: 'd.md' },
      ],
    });
  });

  it('reads a path with a space, and skips the old name of a rename', async () => {
    const result = await status(() => exited(0, 'R  new name.md\0old name.md\0 M e.md\0'));
    expect(result).toEqual({
      ok: true,
      value: [
        { index: 'R', tree: ' ', path: 'new name.md' },
        { index: ' ', tree: 'M', path: 'e.md' },
      ],
    });
  });

  it('is empty for a clean repo', async () => {
    expect(await status(() => exited(0, ''))).toEqual({ ok: true, value: [] });
  });

  it('is an error when git exits with a code or cannot run', async () => {
    expect(await status(() => exited(128))).toMatchObject({
      ok: false,
      error: { message: 'cannot read the changes of the state repository: git exited with 128' },
    });
    expect(await status(() => failure('cannot run git: SIGTERM'))).toMatchObject({ ok: false });
  });
});

describe('git: the tracked files of a repo (TP-167)', () => {
  const ROOT = '/r';
  const listed = async (fixture: GitFixture, max?: number, run?: RunHandler) => {
    const { handler, log } = gitHandler({ repos: { [ROOT]: {} }, ...fixture });
    const deps = createFakeDeps({ run: run ?? handler });
    return { result: await trackedFilesOf(deps, ROOT, ...(max === undefined ? [] : [max])), log };
  };
  const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `f${String(i).padStart(5, '0')}`);

  it('runs git ls-files with NUL separators and gives the paths exactly as git prints them', async () => {
    const odd = ['a b.md', 'dir/line\nbreak.txt', 'é.md'];
    const { result, log } = await listed({ tracked: { [ROOT]: odd } });
    expect(result).toEqual({ ok: true, value: { paths: odd, reachedCap: false } });
    expect(log.commands()).toEqual(['ls-files -z']);
  });

  it('gives an empty list for a repo that tracks nothing', async () => {
    expect((await listed({})).result).toEqual({ ok: true, value: { paths: [], reachedCap: false } });
  });

  it('says that the list is complete at the cap, and keeps every path (the cap)', async () => {
    const { result } = await listed({ tracked: { [ROOT]: names(trackedFiles.maxCount) } });
    expect(result).toMatchObject({ ok: true, value: { reachedCap: false } });
    expect(result.ok && result.value.paths).toHaveLength(trackedFiles.maxCount);
  });

  it('says that the list reached its cap at the cap plus one, and keeps the first paths only (the cap plus one)', async () => {
    const { result } = await listed({ tracked: { [ROOT]: names(trackedFiles.maxCount + 1) } });
    expect(result).toMatchObject({ ok: true, value: { reachedCap: true } });
    expect(result.ok && result.value.paths).toEqual(names(trackedFiles.maxCount));
  });

  it('takes the cap as an argument', async () => {
    expect((await listed({ tracked: { [ROOT]: names(3) } }, 3)).result).toMatchObject({ ok: true, value: { reachedCap: false } });
    expect((await listed({ tracked: { [ROOT]: names(4) } }, 3)).result).toMatchObject({ ok: true, value: { reachedCap: true } });
  });

  describe('the user settings folder of Claude Code', () => {
    const tracked = ['a.md', '.claude/x.json', '.claude/rules/y.md', '.claudex/z.md', '.CLAUDE/w.md'];
    const listedFor = (env: Record<string, string>, os: string, max?: number) => {
      const { handler } = gitHandler({ repos: { [ROOT]: {} }, tracked: { [ROOT]: tracked } });
      return trackedFilesOf(createFakeDeps({ run: handler, env, os }), ROOT, ...(max === undefined ? [] : [max]));
    };

    it('leaves out a path in it, by the written path, when the folder is the user home folder', async () => {
      expect(await listedFor({ HOME: ROOT }, 'linux')).toEqual({
        ok: true,
        value: { paths: ['a.md', '.claudex/z.md', '.CLAUDE/w.md'], reachedCap: false },
      });
    });

    it('ignores the case of letters on macOS only', async () => {
      expect(await listedFor({ HOME: ROOT }, 'darwin')).toEqual({
        ok: true,
        value: { paths: ['a.md', '.claudex/z.md'], reachedCap: false },
      });
    });

    it('leaves out the path when the folder is above the user home folder', async () => {
      const { handler } = gitHandler({ repos: { '/': {} }, tracked: { '/': ['r/.claude/x.json', 'r/b.md'] } });
      const result = await trackedFilesOf(createFakeDeps({ run: handler, env: { HOME: ROOT }, os: 'linux' }), '/');
      expect(result).toEqual({ ok: true, value: { paths: ['r/b.md'], reachedCap: false } });
    });

    it('keeps every path when HOME is not set, and counts the cap without the left-out paths', async () => {
      expect(await listedFor({}, 'linux')).toMatchObject({ ok: true, value: { paths: tracked } });
      expect(await listedFor({ HOME: ROOT }, 'linux', 3)).toEqual({
        ok: true,
        value: { paths: ['a.md', '.claudex/z.md', '.CLAUDE/w.md'], reachedCap: false },
      });
    });
  });

  it('says that the list reached its cap when the output of git is larger than the program reads', async () => {
    const { result } = await listed({}, undefined, () => failure('cannot run git: ERR_CHILD_PROCESS_STDIO_MAXBUFFER'));
    expect(result).toEqual({ ok: true, value: { paths: [], reachedCap: true } });
  });

  it('is an error when git fails, when the folder is no repo, and when git is absent', async () => {
    expect((await listed({ lsFilesExit: 128 })).result).toMatchObject({ ok: false });
    expect((await listed({ repos: {} })).result).toMatchObject({ ok: false });
    expect((await listed({}, undefined, () => failure('cannot run git: ENOENT'))).result).toMatchObject({ ok: false });
  });
});

describe('git: the ignore check', () => {
  const ROOT = '/r';
  const ask = async (paths: readonly string[], fixture: GitFixture = {}) => {
    const { handler, log } = gitHandler({ repos: { [ROOT]: {} }, ...fixture });
    const deps = createFakeDeps({ run: handler });
    return { result: await ignoredPathsOf(deps, ROOT, paths), log };
  };

  it('gives the paths that git ignores, and asks git for one path at a time by its exit code', async () => {
    const { result, log } = await ask(['factory.local.yaml', '.factory/', 'coordinator/'], {
      ignored: { [ROOT]: ['factory.local.yaml', '.factory/'] },
    });
    expect(result).toEqual({ ok: true, value: new Set(['factory.local.yaml', '.factory/']) });
    expect(log.commands()).toEqual([
      'check-ignore -q -- factory.local.yaml',
      'check-ignore -q -- .factory/',
      'check-ignore -q -- coordinator/',
    ]);
  });

  it('gives a true answer for a path with a line break, a quote or a non-ASCII letter in its name', async () => {
    const odd = ['a\nb', 'say "hi"', 'café'];
    expect((await ask(odd, { ignored: { [ROOT]: odd } })).result).toEqual({ ok: true, value: new Set(odd) });
  });

  it('gives an empty set when git ignores none of them (exit 1)', async () => {
    expect((await ask(['a'], { ignored: { [ROOT]: [] } })).result).toEqual({ ok: true, value: new Set() });
  });

  it('runs no command for an empty list', async () => {
    const { result, log } = await ask([]);
    expect(result).toEqual({ ok: true, value: new Set() });
    expect(log.commands()).toEqual([]);
  });

  it('is an error when git fails, so a failure is never read as "not ignored"', async () => {
    expect((await ask(['a'], { checkIgnoreExit: 128 })).result).toMatchObject({ ok: false });
    expect((await ask(['a'], { repos: {} })).result).toMatchObject({ ok: false });
  });

  it('accepts the most paths that one call takes, and refuses one path more', async () => {
    const paths = (count: number): string[] => Array.from({ length: count }, (_, i) => `p${i}`);
    expect((await ask(paths(MAX_IGNORE_PATHS))).result).toMatchObject({ ok: true });
    const over = await ask(paths(MAX_IGNORE_PATHS + 1));
    expect(over.result).toMatchObject({ ok: false });
    expect(over.log.commands()).toEqual([]);
  });

  it('puts the paths after a double hyphen, so a path that starts with a hyphen is never an option', async () => {
    const { log } = await ask(['-x']);
    expect(log.commands()).toEqual(['check-ignore -q -- -x']);
  });
});

describe('git: a folder is the top of its own work tree', () => {
  const check = async (repos: Readonly<Record<string, FakeRepo>>) => {
    const { handler } = gitHandler({ repos });
    return requireWorkTreeTop(createFakeDeps({ run: handler }), '/r/.factory', 'the state folder');
  };

  it('passes for the top folder of a work tree', async () => {
    expect(await check({ '/r/.factory': {} })).toEqual({ ok: true, value: undefined });
  });

  it('stops with exit 4 for a folder that is inside the work tree of another repo', async () => {
    const result = await check({ '/r/.factory': { topLevel: false } });
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(!result.ok && result.error.message).toContain('the state folder');
  });

  it('stops with exit 4 for a folder that no work tree holds', async () => {
    expect(await check({})).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });
});

describe('git: the entries of the last commit (the settings folder of a new work copy)', () => {
  const ID = 'edb1527b23ccdb7ac7d3ae02584b377b406514fe';
  const OTHER = '3b9f379c935c5c919fc9b946a5103110cdeed1f3';
  /** The lines that `git ls-tree -z -l` prints: the size is padded with spaces, and a folder has a dash. */
  const listing = [
    `040000 tree d955ddfa3a9e242df8971376e618f79b8496f7e6       -\t.claude/commands`,
    `120000 blob ${ID}      19\t.claude/settings.json`,
    `100644 blob ${OTHER}      35\t.claude/settings.local.json`,
  ]
    .map((line) => `${line}\0`)
    .join('');

  const askedWith = (answer: ReturnType<RunHandler>) => {
    const calls: string[][] = [];
    const deps = createFakeDeps({
      run: (call) => {
        calls.push([...call.args]);
        return answer;
      },
    });
    return { deps, calls };
  };

  it('reads the mode, the kind, the id, the size and the path of each entry, one level deep', async () => {
    const { deps, calls } = askedWith(exited(0, listing));
    const entries = await headEntriesAt(deps, '/r/web', '.claude/');
    expect(calls).toEqual([['-C', '/r/web', 'ls-tree', '-z', '-l', 'HEAD', '--', '.claude/']]);
    expect(entries).toEqual({
      ok: true,
      value: [
        { mode: '040000', kind: 'tree', id: 'd955ddfa3a9e242df8971376e618f79b8496f7e6', size: null, path: '.claude/commands' },
        { mode: LINK_MODE, kind: 'blob', id: ID, size: 19, path: '.claude/settings.json' },
        { mode: '100644', kind: 'blob', id: OTHER, size: 35, path: '.claude/settings.local.json' },
      ],
    });
  });

  it('gives no entry for a path that the commit does not have', async () => {
    const { deps } = askedWith(exited(0, ''));
    expect(await headEntriesAt(deps, '/r/web', '.claude')).toEqual({ ok: true, value: [] });
  });

  it('is a failure when git can not read the commit, and when it prints a line that it does not know', async () => {
    const unborn = await headEntriesAt(askedWith(exited(128, '', 'fatal: bad revision HEAD\n')).deps, '/r/web', '.claude');
    expect(unborn).toMatchObject({ ok: false, error: { kind: 'failure' } });
    const odd = await headEntriesAt(askedWith(exited(0, 'something else\0')).deps, '/r/web', '.claude');
    expect(odd).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('tells a plain file mode from a link and a folder', () => {
    expect([isFileMode('100644'), isFileMode('100755'), isFileMode(LINK_MODE), isFileMode('040000'), isFileMode('160000')]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('reads the text of a file by its object id, and refuses any other word before a call', async () => {
    const { deps, calls } = askedWith(exited(0, '{"a":1}\n'));
    expect(await blobTextOf(deps, '/r/web', OTHER)).toEqual({ ok: true, value: '{"a":1}\n' });
    expect(calls).toEqual([['-C', '/r/web', 'cat-file', 'blob', OTHER]]);
    calls.length = 0;
    expect(await blobTextOf(deps, '/r/web', '--textconv')).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(calls).toEqual([]);
  });

  it('is a failure when git can not give the file', async () => {
    const { deps } = askedWith(exited(128, '', 'fatal: Not a valid object name\n'));
    expect(await blobTextOf(deps, '/r/web', OTHER)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });
});

describe('git: the userinfo of a URL', () => {
  it.each([
    ['a token as the user', 'https://tok3n@host/acme/api.git', 'https://host/acme/api.git'],
    ['a user and a password', 'https://user:tok3n@host:8443/acme/api.git', 'https://host:8443/acme/api.git'],
    ['an @ inside the userinfo', 'https://us@er:tok3n@host/acme/api.git', 'https://host/acme/api.git'],
    ['an ssh:// user', 'ssh://git@host/acme/api.git', 'ssh://host/acme/api.git'],
    ['a URL with no userinfo', 'https://host/acme/api.git', 'https://host/acme/api.git'],
    ['an @ in the path', 'https://host/acme/a@b.git', 'https://host/acme/a@b.git'],
    ['the user@host:path form, which holds no secret', 'git@host:acme/api.git', 'git@host:acme/api.git'],
    [
      'a URL inside a message',
      "fatal: unable to access 'https://user:tok3n@host/acme/api.git/': 403",
      "fatal: unable to access 'https://host/acme/api.git/': 403",
    ],
    [
      'two URLs in one text',
      'https://a@h1/x and ssh://b:c@h2/y',
      'https://h1/x and ssh://h2/y',
    ],
  ])('removes it from %s', (_name, text, expected) => {
    expect(withoutUserinfo(text)).toBe(expected);
  });
});
