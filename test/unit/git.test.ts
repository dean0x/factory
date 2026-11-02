import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import {
  commitAll,
  commitPaths,
  gitClone,
  headOf,
  listRepoChildren,
  MAX_SCAN_ENTRIES,
  statusOf,
  unstagePaths,
  withoutUserinfo,
} from '../../src/core/git.js';
import { createFakeDeps, exited, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type FakeRepo, type GitFixture } from '../helpers/git-fake.js';

const WS = '/ws';

/** A workspace folder whose children are the given folders. A repo gets a `.git` entry, like a real work tree. */
const workspace = (
  repos: Readonly<Record<string, FakeRepo>>,
  plain: readonly string[] = [],
  extra: { readonly links?: Record<string, string>; readonly fixture?: GitFixture } = {},
): { deps: FakeDeps; log: ReturnType<typeof gitHandler>['log'] } => {
  const { handler, log } = gitHandler({ repos, ...extra.fixture });
  const deps = createFakeDeps({ cwd: WS, run: handler, ...(extra.links === undefined ? {} : { links: extra.links }) });
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
      skipped: [{ path: '/ws/web-search', reason: 'it is one more checkout of the repo web' }],
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
