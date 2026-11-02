import { describe, expect, it } from 'vitest';
import { gitClone, listRepoChildren, MAX_SCAN_ENTRIES, withoutUserinfo } from '../../src/core/git.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
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
