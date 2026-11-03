import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import {
  entryOfHome,
  findHomeInIndex,
  goneHomes,
  homeHoldingFolder,
  indexPathOf,
  listedRootAbove,
  matchFolder,
  originOf,
  readHomeIndex,
  recordHome,
  recordNode,
  type HomeEntry,
} from '../../src/core/home-index.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const INDEX = '/state/factory/homes.json';
const HOME_A = '/w/web-factory';
const HOME_B = '/w/other-factory';

const entry = (home: string, projects: readonly string[], id = 'web'): HomeEntry => ({ home, id, projects: [...projects] });

const indexText = (homes: readonly HomeEntry[]): string => JSON.stringify({ schema: 1, homes });

interface Setup {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly links?: Record<string, string>;
}

/** Fake deps with an index file and the config file of each home in the list. */
const withIndex = (homes: readonly HomeEntry[], setup: Setup = {}, existing: readonly string[] = homes.map((h) => h.home)): FakeDeps => {
  const deps = createFakeDeps({
    cwd: setup.cwd ?? '/w/web',
    env: setup.env ?? { XDG_STATE_HOME: '/state', HOME: '/home/me' },
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  deps.seed(INDEX, indexText(homes));
  for (const home of existing) deps.seed(`${home}/factory.yaml`, 'schema: 2\n');
  deps.seedDir(deps.cwd);
  return deps;
};

describe('home index: the path', () => {
  /** The place of the index for these variables, in a fake file system that holds only the folders in `folders`. */
  const pathFor = (
    environment: Record<string, string | undefined>,
    extra: { readonly os?: string; readonly links?: Record<string, string>; readonly folders?: readonly string[] } = {},
  ) => {
    const deps = createFakeDeps({
      env: environment,
      ...(extra.os === undefined ? {} : { os: extra.os }),
      ...(extra.links === undefined ? {} : { links: extra.links }),
    });
    for (const folder of extra.folders ?? []) deps.seedDir(folder);
    return indexPathOf(deps);
  };

  it('uses XDG_STATE_HOME when it is an absolute path', async () => {
    expect(await pathFor({ XDG_STATE_HOME: '/state', HOME: '/home/me' })).toEqual({ ok: true, value: INDEX });
  });

  it('uses the folder .local/state of HOME when XDG_STATE_HOME is not set, empty or relative', async () => {
    const expected = { ok: true, value: '/home/me/.local/state/factory/homes.json' };
    expect(await pathFor({ HOME: '/home/me' })).toEqual(expected);
    expect(await pathFor({ HOME: '/home/me', XDG_STATE_HOME: '' })).toEqual(expected);
    expect(await pathFor({ HOME: '/home/me', XDG_STATE_HOME: 'relative/state' })).toEqual(expected);
  });

  it('has no path when neither variable names an absolute folder', async () => {
    expect(await pathFor({})).toEqual({ ok: true, value: null });
    expect(await pathFor({ HOME: 'relative' })).toEqual({ ok: true, value: null });
  });

  it('refuses a path under the folder of Claude Code with a safety refusal', async () => {
    for (const state of ['/home/me/.claude', '/home/me/.claude/state', '/home/me/.claude/a/../b']) {
      const result = await pathFor({ HOME: '/home/me', XDG_STATE_HOME: state });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    }
  });

  it('accepts a sibling folder whose name starts with the same letters', async () => {
    expect(await pathFor({ HOME: '/home/me', XDG_STATE_HOME: '/home/me/.claude-state' })).toMatchObject({ ok: true });
  });

  it('never gives a path under the folder of Claude Code for the default places', async () => {
    for (const environment of [{ HOME: '/home/me' }, { HOME: '/home/me', XDG_STATE_HOME: '/state' }]) {
      const result = await pathFor(environment);
      expect(result.ok && result.value?.startsWith('/home/me/.claude/')).toBe(false);
    }
  });

  describe('the folder of Claude Code is compared by real path', () => {
    const environment = { HOME: '/home/me', XDG_STATE_HOME: '/state' };

    it('refuses a state folder that is a link into the folder of Claude Code', async () => {
      const result = await pathFor(environment, {
        links: { '/state': '/home/me/.claude/state' },
        folders: ['/state', '/home/me/.claude'],
      });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    });

    it('refuses a state folder that does not exist yet, below a link into the folder of Claude Code', async () => {
      const result = await pathFor(
        { HOME: '/home/me', XDG_STATE_HOME: '/state/deep/er' },
        { links: { '/state': '/home/me/.claude' }, folders: ['/state', '/home/me/.claude'] },
      );
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    });

    it('refuses a folder of Claude Code that is a link to the state folder', async () => {
      const result = await pathFor(environment, {
        links: { '/home/me/.claude': '/state' },
        folders: ['/state', '/home/me/.claude'],
      });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    });

    it('refuses a different letter case on macOS', async () => {
      for (const state of ['/home/me/.CLAUDE/state', '/Home/Me/.Claude', '/HOME/ME/.claude/x']) {
        const result = await pathFor({ HOME: '/home/me', XDG_STATE_HOME: state }, { os: 'darwin' });
        expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      }
    });

    it('compares the letters exactly on the other platforms', async () => {
      for (const os of ['linux', 'freebsd']) {
        const result = await pathFor({ HOME: '/home/me', XDG_STATE_HOME: '/home/me/.CLAUDE/state' }, { os });
        expect(result).toMatchObject({ ok: true });
      }
    });

    it('accepts a normal path, also when links exist that lead elsewhere', async () => {
      const result = await pathFor(environment, { links: { '/state': '/data/state' }, folders: ['/state', '/home/me/.claude'] });
      expect(result).toEqual({ ok: true, value: INDEX });
    });

    it('stops with the error when it cannot resolve the links of the path', async () => {
      const deps = createFakeDeps({ env: environment });
      const result = await indexPathOf({ ...deps, fs: { ...deps.fs, realpath: async () => failure('cannot resolve /: EACCES') } });
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('EACCES') } });
    });
  });

  describe('with a real file system', () => {
    let folder = '';
    beforeAll(async () => {
      folder = await mkdtemp(join(tmpdir(), 'factory-home-index-'));
      await mkdir(join(folder, 'home', '.claude'), { recursive: true });
      await mkdir(join(folder, 'elsewhere'), { recursive: true });
      await symlink(join(folder, 'home', '.claude'), join(folder, 'via-link'));
    });
    afterAll(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    const realDeps = (state: string): Deps => ({
      ...createNodeDeps(),
      env: { HOME: join(folder, 'home'), XDG_STATE_HOME: state },
    });

    it('refuses a state folder that is a link into the fake folder of Claude Code', async () => {
      expect(await indexPathOf(realDeps(join(folder, 'via-link')))).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(await indexPathOf(realDeps(join(folder, 'via-link', 'state')))).toMatchObject({ ok: false, error: { kind: 'safety' } });
    });

    it('accepts a state folder that holds no link into it', async () => {
      const state = join(folder, 'elsewhere');
      expect(await indexPathOf(realDeps(state))).toEqual({ ok: true, value: join(state, 'factory', 'homes.json') });
    });
  });
});

describe('home index: the match', () => {
  const projects = [
    { home: HOME_A, project: '/w/web' },
    { home: HOME_B, project: '/w/web/packages/ui' },
    { home: HOME_B, project: '/w/api' },
  ];

  it('takes the home of the project that holds the folder', () => {
    expect(matchFolder(projects, '/w/web')).toEqual({ kind: 'one', home: HOME_A });
    expect(matchFolder(projects, '/w/web/src/deep')).toEqual({ kind: 'one', home: HOME_A });
    expect(matchFolder(projects, '/w/api/lib')).toEqual({ kind: 'one', home: HOME_B });
  });

  it('lets the deepest project path win', () => {
    expect(matchFolder(projects, '/w/web/packages/ui/src')).toEqual({ kind: 'one', home: HOME_B });
  });

  it('finds no match for a folder in no project, also for a folder that only starts with the same letters', () => {
    expect(matchFolder(projects, '/w')).toEqual({ kind: 'none' });
    expect(matchFolder(projects, '/w/web-search')).toEqual({ kind: 'none' });
    expect(matchFolder(projects, '/elsewhere')).toEqual({ kind: 'none' });
    expect(matchFolder([], '/w/web')).toEqual({ kind: 'none' });
  });

  it('reports a tie between two homes that list the same project, with both homes sorted', () => {
    const tied = [
      { home: HOME_A, project: '/w/web' },
      { home: HOME_B, project: '/w/web' },
    ];
    expect(matchFolder(tied, '/w/web/src')).toEqual({ kind: 'tie', homes: [HOME_B, HOME_A] });
  });

  it('does not call it a tie when one home lists a project twice', () => {
    const twice = [
      { home: HOME_A, project: '/w/web' },
      { home: HOME_A, project: '/w/web' },
    ];
    expect(matchFolder(twice, '/w/web')).toEqual({ kind: 'one', home: HOME_A });
  });
});

describe('home index: reading the file', () => {
  const read = (text: string | null) => {
    const deps = createFakeDeps({ env: {} });
    if (text !== null) deps.seed(INDEX, text);
    return readHomeIndex(deps, INDEX);
  };

  it('gives no entry for a file that does not exist', async () => {
    expect(await read(null)).toEqual({ ok: true, value: [] });
  });

  it('reads the entries of a valid file', async () => {
    const homes = [entry(HOME_A, ['/w/web'])];
    expect(await read(indexText(homes))).toEqual({ ok: true, value: homes });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a wrong schema number', JSON.stringify({ schema: 2, homes: [] })],
    ['an unknown key at the top', JSON.stringify({ schema: 1, homes: [], extra: true })],
    ['an unknown key in an entry', JSON.stringify({ schema: 1, homes: [{ ...entry(HOME_A, []), extra: 1 }] })],
    ['a relative home path', indexText([entry('web-factory', [])])],
    ['a relative project path', indexText([entry(HOME_A, ['web'])])],
    ['an id that is not a slug', indexText([entry(HOME_A, [], 'Not A Slug')])],
  ])('fails for %s', async (_name, text) => {
    const result = await read(text);
    expect(result.ok).toBe(false);
  });

  it('accepts exactly 200 homes and exactly 200 projects, and refuses one more of each', async () => {
    const projects = (count: number): string[] => Array.from({ length: count }, (_, i) => `/w/p${i}`);
    const homes = (count: number): HomeEntry[] => Array.from({ length: count }, (_, i) => entry(`/h/h${i}`, []));
    expect((await read(indexText(homes(200)))).ok).toBe(true);
    expect((await read(indexText(homes(201)))).ok).toBe(false);
    expect((await read(indexText([entry(HOME_A, projects(200))]))).ok).toBe(true);
    expect((await read(indexText([entry(HOME_A, projects(201))]))).ok).toBe(false);
  });

  it('refuses a file over the size limit before it parses it', async () => {
    const result = await read(`${' '.repeat(1_048_577)}{}`);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('larger') });
  });

  it('counts bytes for the size limit, not characters', async () => {
    const result = await read(`${'é'.repeat(600_000)}{}`);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('larger') });
  });

  it('fails for a path that is a folder', async () => {
    const deps = createFakeDeps({ env: {} });
    deps.seedDir(INDEX);
    expect((await readHomeIndex(deps, INDEX)).ok).toBe(false);
  });

  describe('who may write the index', () => {
    const FOLDER = '/state/factory';
    const seeded = (): FakeDeps => {
      const deps = createFakeDeps({ env: {} });
      deps.seed(INDEX, indexText([entry(HOME_A, [])]));
      return deps;
    };

    it('reads a file and a folder that this user owns and nobody else writes', async () => {
      const deps = seeded();
      deps.modes.set(FOLDER, 0o755);
      deps.modes.set(INDEX, 0o644);
      expect(await readHomeIndex(deps, INDEX)).toEqual({ ok: true, value: [entry(HOME_A, [])] });
    });

    it.each([
      ['a folder that a group may write', FOLDER, 0o770],
      ['a folder that other users may write', FOLDER, 0o707],
      ['a file that a group may write', INDEX, 0o660],
      ['a file that other users may write', INDEX, 0o606],
    ])('refuses %s', async (_name, path, mode) => {
      const deps = seeded();
      deps.modes.set(path, mode);
      const result = await readHomeIndex(deps, INDEX);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('written') });
      if (!result.ok) expect(result.error).toContain(path);
    });

    it.each([
      ['folder', FOLDER],
      ['file', INDEX],
    ])('refuses a %s that another user owns', async (_name, path) => {
      const deps = seeded();
      deps.owners.set(path, 2000);
      const result = await readHomeIndex(deps, INDEX);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('another user') });
      if (!result.ok) expect(result.error).toContain(path);
    });

    it('refuses a folder of another user also when the file does not exist yet', async () => {
      const deps = createFakeDeps({ env: {} });
      deps.seedDir(FOLDER);
      deps.owners.set(FOLDER, 2000);
      expect(await readHomeIndex(deps, INDEX)).toMatchObject({ ok: false, error: expect.stringContaining('another user') });
    });

    it('checks no owner and no mode on a platform that has no user ids', async () => {
      const deps = createFakeDeps({ env: {}, uid: null });
      deps.seed(INDEX, indexText([entry(HOME_A, [])]));
      deps.owners.set(INDEX, 2000);
      deps.modes.set(FOLDER, 0o777);
      expect(await readHomeIndex(deps, INDEX)).toEqual({ ok: true, value: [entry(HOME_A, [])] });
    });

    it('makes findHomeInIndex stop with a usage error that names the file', async () => {
      const deps = withIndex([entry(HOME_A, ['/w/web'])], { cwd: '/w/web' });
      deps.modes.set(FOLDER, 0o777);
      const result = await findHomeInIndex(deps);
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      if (!result.ok) expect(result.error.message).toContain(INDEX);
    });
  });
});

describe('home index: recording a home', () => {
  const fresh = (): FakeDeps => {
    const deps = createFakeDeps({ env: {} });
    deps.seedDir('/state');
    return deps;
  };
  const stored = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(INDEX) ?? 'null');

  it('writes the file atomically with mode 0600, in a folder of mode 0700', async () => {
    const deps = fresh();
    const result = await recordHome(deps, INDEX, entry(HOME_A, ['/w/web']));
    expect(result).toEqual({ ok: true, value: undefined });
    expect(stored(deps)).toEqual({ schema: 1, homes: [entry(HOME_A, ['/w/web'])] });
    expect(deps.atomicWrites).toEqual([INDEX]);
    expect(deps.modes.get(INDEX)).toBe(0o600);
    expect(deps.modes.get('/state/factory')).toBe(0o700);
  });

  it('sets mode 0700 on an existing index folder, and leaves the state home as it is', async () => {
    const deps = fresh();
    deps.seedDir('/state/factory');
    deps.modes.set('/state', 0o755);
    deps.modes.set('/state/factory', 0o755);
    expect((await recordHome(deps, INDEX, entry(HOME_A, []))).ok).toBe(true);
    expect(deps.modes.get('/state/factory')).toBe(0o700);
    expect(deps.modes.get('/state')).toBe(0o755);
  });

  it.each([
    ['a folder that a group may write', '/state/factory', 0o775],
    ['a file that other users may write', INDEX, 0o646],
  ])('refuses %s, and changes nothing', async (_name, path, mode) => {
    const deps = fresh();
    deps.seed(INDEX, indexText([entry(HOME_B, [], 'api')]));
    deps.modes.set(path, mode);
    const result = await recordHome(deps, INDEX, entry(HOME_A, []));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('written') });
    expect(deps.atomicWrites).toEqual([]);
    expect(deps.modes.get(path)).toBe(mode);
    expect(stored(deps)).toEqual({ schema: 1, homes: [entry(HOME_B, [], 'api')] });
  });

  it('refuses a folder that another user owns, and changes nothing', async () => {
    const deps = fresh();
    deps.seedDir('/state/factory');
    deps.owners.set('/state/factory', 2000);
    const result = await recordHome(deps, INDEX, entry(HOME_A, []));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('another user') });
    expect(deps.files.has(INDEX)).toBe(false);
  });

  it('replaces the entry of the same home and keeps the others', async () => {
    const deps = fresh();
    await recordHome(deps, INDEX, entry(HOME_A, ['/w/web']));
    await recordHome(deps, INDEX, entry(HOME_B, ['/w/api'], 'api'));
    await recordHome(deps, INDEX, entry(HOME_A, ['/w/web', '/w/web2']));
    expect(stored(deps)).toEqual({
      schema: 1,
      homes: [entry(HOME_A, ['/w/web', '/w/web2']), entry(HOME_B, ['/w/api'], 'api')],
    });
  });

  it('does not overwrite a file that it cannot read, and names the reason', async () => {
    const deps = fresh();
    deps.seed(INDEX, 'not json');
    const result = await recordHome(deps, INDEX, entry(HOME_A, []));
    expect(result.ok).toBe(false);
    expect(deps.files.get(INDEX)).toBe('not json');
    expect(deps.atomicWrites).toEqual([]);
  });

  describe('when the index is full', () => {
    const fullIndex = (deps: FakeDeps, present: (index: number) => boolean = () => true): HomeEntry[] => {
      const homes = Array.from({ length: 200 }, (_, i) => entry(`/h/h${i}`, []));
      deps.seed(INDEX, indexText(homes));
      homes.forEach((home, i) => {
        if (present(i)) deps.seed(`${home.home}/factory.yaml`, 'schema: 2\n');
      });
      return homes;
    };
    const homesOf = (deps: FakeDeps): string[] =>
      (stored(deps) as { homes: { home: string }[] }).homes.map((candidate) => candidate.home);

    it('refuses a 201st home and changes nothing, when every home in it is present', async () => {
      const deps = fresh();
      const homes = fullIndex(deps);
      const result = await recordHome(deps, INDEX, entry(HOME_A, []));
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('200') });
      expect(stored(deps)).toEqual({ schema: 1, homes });
    });

    it('drops the entries whose home is gone, and records the new home', async () => {
      const deps = fresh();
      fullIndex(deps, (i) => i % 50 !== 0);
      const result = await recordHome(deps, INDEX, entry(HOME_A, ['/w/web']));
      expect(result.ok).toBe(true);
      const kept = homesOf(deps);
      expect(kept).toHaveLength(197);
      expect(kept).not.toContain('/h/h0');
      expect(kept).not.toContain('/h/h150');
      expect(kept).toContain('/h/h1');
      expect(kept[kept.length - 1]).toBe(HOME_A);
    });

    it('keeps the entries of a home that it cannot check', async () => {
      const deps = fresh();
      fullIndex(deps, (i) => i >= 10);
      const unreadable: Deps = {
        ...deps,
        fs: {
          ...deps.fs,
          stat: async (path) =>
            path === '/h/h3/factory.yaml' ? failure('cannot stat /h/h3/factory.yaml: EIO') : deps.fs.stat(path),
        },
      };
      expect((await recordHome(unreadable, INDEX, entry(HOME_A, []))).ok).toBe(true);
      const kept = homesOf(deps);
      expect(kept).toContain('/h/h3');
      expect(kept).not.toContain('/h/h4');
      expect(kept).toHaveLength(192);
    });

    it('refuses the home when every home that is not present cannot be checked', async () => {
      const deps = fresh();
      const homes = fullIndex(deps, () => false);
      const unreadable: Deps = {
        ...deps,
        fs: { ...deps.fs, stat: async (path) => failure(`cannot stat ${path}: EIO`) },
      };
      const result = await recordHome(unreadable, INDEX, entry(HOME_A, []));
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('200') });
      expect(stored(deps)).toEqual({ schema: 1, homes });
    });

    it('does not drop the new home, also when its config file is not there', async () => {
      const deps = fresh();
      fullIndex(deps, () => false);
      expect((await recordHome(deps, INDEX, entry(HOME_A, []))).ok).toBe(true);
      expect(homesOf(deps)).toEqual([HOME_A]);
    });

    it('replaces the entry of a home that is in the index, with no need to drop anything', async () => {
      const deps = fresh();
      fullIndex(deps, () => false);
      expect((await recordHome(deps, INDEX, entry('/h/h7', ['/w/web']))).ok).toBe(true);
      expect(homesOf(deps)).toHaveLength(200);
    });
  });

  it('keeps the entries of homes that are gone while the index has room', async () => {
    const deps = fresh();
    deps.seed(INDEX, indexText([entry(HOME_B, [], 'api')]));
    expect((await recordHome(deps, INDEX, entry(HOME_A, []))).ok).toBe(true);
    expect(stored(deps)).toEqual({ schema: 1, homes: [entry(HOME_B, [], 'api'), entry(HOME_A, [])] });
  });

  it('refuses an entry with more than 200 projects', async () => {
    const deps = fresh();
    const projects = Array.from({ length: 201 }, (_, i) => `/w/p${i}`);
    expect((await recordHome(deps, INDEX, entry(HOME_A, projects))).ok).toBe(false);
    expect(deps.files.has(INDEX)).toBe(false);
  });

  it('keeps the old file when the write fails', async () => {
    const deps = fresh();
    deps.seed(INDEX, indexText([entry(HOME_B, [], 'api')]));
    const failing = { ...deps, fs: { ...deps.fs, writeTextAtomic: async () => ({ ok: false as const, error: { kind: 'failure' as const, message: 'disk full' } }) } };
    const result = await recordHome(failing, INDEX, entry(HOME_A, []));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('disk full') });
    expect(stored(deps)).toEqual({ schema: 1, homes: [entry(HOME_B, [], 'api')] });
  });

  it('refuses a link at the index path, and leaves the file and the lock as they were', async () => {
    const deps = createFakeDeps({ env: {}, links: { [INDEX]: '/elsewhere/homes.json' } });
    deps.seedDir('/elsewhere');
    deps.seed(INDEX, indexText([entry(HOME_B, [], 'api')]));
    const result = await recordHome(deps, INDEX, entry(HOME_A, []));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('is a link') });
    expect(stored(deps)).toEqual({ schema: 1, homes: [entry(HOME_B, [], 'api')] });
    expect(deps.files.has(`${INDEX}.lock`)).toBe(false);
  });
});

describe('home index: two writers at once', () => {
  const LOCK = `${INDEX}.lock`;
  const fresh = (): FakeDeps => {
    const deps = createFakeDeps({ env: {} });
    deps.seedDir('/state');
    return deps;
  };
  const stored = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(INDEX) ?? 'null');

  it('keeps both entries when two homes are recorded at the same time', async () => {
    const deps = fresh();
    const results = await Promise.all([
      recordHome(deps, INDEX, entry(HOME_A, ['/w/web'])),
      recordHome(deps, INDEX, entry(HOME_B, ['/w/api'], 'api')),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(stored(deps)).toEqual({
      schema: 1,
      homes: expect.arrayContaining([entry(HOME_A, ['/w/web']), entry(HOME_B, ['/w/api'], 'api')]),
    });
    expect((stored(deps) as { homes: unknown[] }).homes).toHaveLength(2);
  });

  it('keeps all entries when five homes are recorded at the same time', async () => {
    const deps = fresh();
    const homes = ['/h/a', '/h/b', '/h/c', '/h/d', '/h/e'];
    const results = await Promise.all(homes.map((home) => recordHome(deps, INDEX, entry(home, [], 'node'))));
    expect(results.every((result) => result.ok)).toBe(true);
    expect((stored(deps) as { homes: { home: string }[] }).homes.map((candidate) => candidate.home).sort()).toEqual(homes);
  });

  it('removes the lock when it has recorded the home', async () => {
    const deps = fresh();
    await recordHome(deps, INDEX, entry(HOME_A, []));
    expect(deps.files.has(LOCK)).toBe(false);
  });

  it('removes the lock when the index cannot be read', async () => {
    const deps = fresh();
    deps.seed(INDEX, 'not json');
    expect((await recordHome(deps, INDEX, entry(HOME_A, []))).ok).toBe(false);
    expect(deps.files.has(LOCK)).toBe(false);
  });

  it('removes the lock when the write fails', async () => {
    const deps = fresh();
    const failing = { ...deps, fs: { ...deps.fs, writeTextAtomic: async () => failure('cannot write: disk full') } };
    expect((await recordHome(failing, INDEX, entry(HOME_A, []))).ok).toBe(false);
    expect(deps.files.has(LOCK)).toBe(false);
  });

  it('waits for a lock that another process holds, and goes on when the lock goes away', async () => {
    const deps = fresh();
    deps.seed(LOCK, '1\n');
    const waiting: Deps = {
      ...deps,
      sleep: async (ms) => {
        await deps.sleep(ms);
        if (deps.sleeps.length === 3) deps.files.delete(LOCK);
      },
    };
    expect((await recordHome(waiting, INDEX, entry(HOME_A, []))).ok).toBe(true);
    expect(deps.sleeps).toEqual([50, 50, 50]);
    expect(stored(deps)).toEqual({ schema: 1, homes: [entry(HOME_A, [])] });
  });

  it('gives up after 20 tries when the lock stays, writes nothing, and leaves the lock of the other process', async () => {
    const deps = fresh();
    deps.seed(LOCK, '1\n');
    const result = await recordHome(deps, INDEX, entry(HOME_A, []));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(LOCK) });
    expect(deps.sleeps).toEqual(Array.from({ length: 19 }, () => 50));
    expect(deps.files.has(INDEX)).toBe(false);
    expect(deps.files.get(LOCK)).toBe('1\n');
  });

  it('takes over a lock that is older than the stale age', async () => {
    const deps = fresh();
    deps.seed(LOCK, '1\n');
    deps.advance(5_001);
    expect((await recordHome(deps, INDEX, entry(HOME_A, []))).ok).toBe(true);
    expect(deps.sleeps).toEqual([]);
    expect(deps.files.has(LOCK)).toBe(false);
    expect(stored(deps)).toEqual({ schema: 1, homes: [entry(HOME_A, [])] });
  });

  it('takes over a lock that becomes stale while it waits, after the time on the clock and not before', async () => {
    const deps = fresh();
    deps.seed(LOCK, '1\n');
    deps.advance(4_880);
    expect((await recordHome(deps, INDEX, entry(HOME_A, []))).ok).toBe(true);
    expect(deps.sleeps).toEqual([50, 50, 50]);
  });

  it('does not take a lock that is as old as the stale age', async () => {
    const deps = fresh();
    deps.seed(LOCK, '1\n');
    deps.advance(5_000 - 19 * 50);
    expect((await recordHome(deps, INDEX, entry(HOME_A, []))).ok).toBe(false);
  });

  it('creates the lock with mode 0600', async () => {
    const deps = fresh();
    const modes: number[] = [];
    const watched: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) => {
          modes.push(mode);
          return deps.fs.writeTextExclusive(path, text, mode);
        },
      },
    };
    await recordHome(watched, INDEX, entry(HOME_A, []));
    expect(modes).toEqual([0o600]);
  });

  it('stops with the error when it cannot create the lock', async () => {
    const deps = fresh();
    const denied: Deps = {
      ...deps,
      fs: { ...deps.fs, writeTextExclusive: async () => failure('cannot write /state/factory/homes.json.lock: EACCES') },
    };
    const result = await recordHome(denied, INDEX, entry(HOME_A, []));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') });
    expect(deps.sleeps).toEqual([]);
  });
});

describe('home index: recording a home, with a real file system', () => {
  let folder = '';
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'factory-home-index-record-'));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

  it('creates the index folder with mode 0700 and the file with mode 0600', async () => {
    const index = join(folder, 'new', 'factory', 'homes.json');
    expect((await recordHome(createNodeDeps(), index, entry(HOME_A, []))).ok).toBe(true);
    expect(await modeOf(join(folder, 'new', 'factory'))).toBe(0o700);
    expect(await modeOf(index)).toBe(0o600);
  });

  it('sets mode 0700 on an index folder that exists, and leaves the state home as it is', async () => {
    const state = join(folder, 'old');
    await mkdir(join(state, 'factory'), { recursive: true });
    await chmod(state, 0o755);
    await chmod(join(state, 'factory'), 0o755);
    expect((await recordHome(createNodeDeps(), join(state, 'factory', 'homes.json'), entry(HOME_A, []))).ok).toBe(true);
    expect(await modeOf(join(state, 'factory'))).toBe(0o700);
    expect(await modeOf(state)).toBe(0o755);
  });

  it('keeps every entry when five homes are recorded at the same time, and leaves no lock file', async () => {
    const index = join(folder, 'parallel', 'factory', 'homes.json');
    const homes = ['/h/a', '/h/b', '/h/c', '/h/d', '/h/e'];
    const results = await Promise.all(homes.map((home) => recordHome(createNodeDeps(), index, entry(home, [], 'node'))));
    expect(results.every((result) => result.ok)).toBe(true);
    const read = await readHomeIndex(createNodeDeps(), index);
    expect(read.ok && read.value.map((candidate) => candidate.home).sort()).toEqual(homes);
    expect(await readdir(join(folder, 'parallel', 'factory'))).toEqual(['homes.json']);
  });

  it('refuses an index folder that a group may write, and writes no file', async () => {
    const state = join(folder, 'shared');
    await mkdir(join(state, 'factory'), { recursive: true });
    await chmod(join(state, 'factory'), 0o775);
    const index = join(state, 'factory', 'homes.json');
    expect(await recordHome(createNodeDeps(), index, entry(HOME_A, []))).toMatchObject({
      ok: false,
      error: expect.stringContaining('written'),
    });
    expect(await readdir(join(state, 'factory'))).toEqual([]);
  });
});

describe('home index: the entry of a folder', () => {
  const entries = [entry(HOME_A, ['/w/web'], 'web'), entry(HOME_B, ['/w/api'], 'other')];

  it('gives the entry that has the folder as its home', async () => {
    const deps = createFakeDeps();
    expect(await entryOfHome(deps, entries, HOME_B)).toEqual(entries[1]);
  });

  it('gives null for a folder that no entry has as its home, also a folder inside a home and a project folder', async () => {
    const deps = createFakeDeps();
    expect(await entryOfHome(deps, entries, '/w/elsewhere')).toBeNull();
    expect(await entryOfHome(deps, entries, `${HOME_A}/sub`)).toBeNull();
    expect(await entryOfHome(deps, entries, '/w/web')).toBeNull();
    expect(await entryOfHome(deps, [], HOME_A)).toBeNull();
  });

  it('compares real paths: a folder behind a link finds the entry of its real folder', async () => {
    const deps = createFakeDeps({ links: { '/link': '/w' } });
    deps.seedDir('/link/web-factory');
    expect(await entryOfHome(deps, entries, '/link/web-factory')).toEqual(entries[0]);
  });

  it('finds an entry that was written as the home is given, also when the home does not exist', async () => {
    const deps = createFakeDeps();
    expect(await entryOfHome(deps, [entry('/gone/home', [])], '/gone/home')).toEqual(entry('/gone/home', []));
  });

  it('ignores the case of letters on macOS and keeps it on Linux', async () => {
    expect(await entryOfHome(createFakeDeps({ os: 'darwin' }), entries, '/W/Web-Factory')).toEqual(entries[0]);
    expect(await entryOfHome(createFakeDeps({ os: 'linux' }), entries, '/W/Web-Factory')).toBeNull();
  });
});

describe('home index: the home that holds a folder as a project', () => {
  const entries = [entry(HOME_A, ['/w/web'], 'web'), entry(HOME_B, ['/w/api'], 'other')];

  it('gives the home of the entry with a project that is or holds the folder', () => {
    expect(homeHoldingFolder(entries, '/w/web')).toBe(HOME_A);
    expect(homeHoldingFolder(entries, '/w/api/src/deep')).toBe(HOME_B);
  });

  it('gives null for a folder in no project, also for a folder that only starts with the same letters', () => {
    expect(homeHoldingFolder(entries, '/w')).toBeNull();
    expect(homeHoldingFolder(entries, '/w/web-search')).toBeNull();
    expect(homeHoldingFolder([], '/w/web')).toBeNull();
  });
});

describe('home index: the listed root above a folder', () => {
  const entries = [entry(HOME_A, ['/w/web-factory/web']), entry(HOME_B, [])];

  it('gives the listed root that holds the folder, also when the folder does not exist yet', async () => {
    const deps = withIndex(entries);
    expect(await listedRootAbove(deps, entries, `${HOME_A}/coordinator`)).toEqual({ ok: true, value: HOME_A });
    expect(await listedRootAbove(deps, entries, `${HOME_A}/a/b/c`)).toEqual({ ok: true, value: HOME_A });
  });

  it('gives null for a listed root itself, so a root can be made again', async () => {
    expect(await listedRootAbove(withIndex(entries), entries, HOME_A)).toEqual({ ok: true, value: null });
  });

  it('gives null for a folder beside a root and for a folder that only starts with the same letters', async () => {
    const deps = withIndex(entries);
    expect(await listedRootAbove(deps, entries, '/w/web-factory-2')).toEqual({ ok: true, value: null });
    expect(await listedRootAbove(deps, entries, '/w/third-factory')).toEqual({ ok: true, value: null });
  });

  it('ignores a listed root that no longer holds its config file', async () => {
    const deps = withIndex(entries, {}, [HOME_B]);
    expect(await listedRootAbove(deps, entries, `${HOME_A}/inner`)).toEqual({ ok: true, value: null });
  });

  it('compares real paths: a folder behind a link into a root is inside the root', async () => {
    const deps = withIndex(entries, { links: { '/via': HOME_A } });
    deps.seedDir('/via');
    expect(await listedRootAbove(deps, entries, '/via/inner')).toEqual({ ok: true, value: HOME_A });
  });

  it('gives null for an empty list', async () => {
    expect(await listedRootAbove(withIndex([]), [], `${HOME_A}/inner`)).toEqual({ ok: true, value: null });
  });
});

describe('home index: recording a node', () => {
  const fresh = (): FakeDeps => {
    const deps = createFakeDeps({ env: {} });
    deps.seedDir('/state');
    deps.seedDir(HOME_A);
    return deps;
  };
  const stored = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(INDEX) ?? 'null');
  const own = (home: string, projects: readonly string[], id = 'web'): HomeEntry => ({ ...entry(home, projects, id), origin: 'own' });

  it('writes the real path of the root and the folder of each project, and gives ok', async () => {
    const deps = fresh();
    const result = await recordNode(deps, INDEX, { home: HOME_A, id: 'web', projects: ['web', 'api'], origin: 'own' });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(stored(deps)).toEqual({ schema: 1, homes: [own(HOME_A, [`${HOME_A}/web`, `${HOME_A}/api`])] });
  });

  it('gives an error that says the index was not updated when no variable names a folder', async () => {
    const deps = fresh();
    const result = await recordNode(deps, null, { home: HOME_A, id: 'web', projects: [], origin: 'own' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('was not updated') });
    expect(deps.atomicWrites).toEqual([]);
  });

  it('gives an error with the path of the index and the reason when the write fails', async () => {
    const deps = fresh();
    deps.seed(INDEX, 'not json');
    const result = await recordNode(deps, INDEX, { home: HOME_A, id: 'web', projects: [], origin: 'own' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`The home index ${INDEX} was not updated`) });
    expect(deps.files.get(INDEX)).toBe('not json');
  });

  it('throws nothing when the write is refused', async () => {
    const deps = fresh();
    deps.seedDir('/state/factory');
    deps.modes.set('/state/factory', 0o775);
    await expect(recordNode(deps, INDEX, { home: HOME_A, id: 'web', projects: [], origin: 'own' })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('home index: the origin of a root (TP-159)', () => {
  const stored = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(INDEX) ?? 'null');
  const withEntries = (homes: readonly object[]): FakeDeps => {
    const deps = createFakeDeps({ env: {} });
    deps.seedDir(HOME_A);
    deps.seed(INDEX, JSON.stringify({ schema: 1, homes }));
    return deps;
  };
  const before = (origin?: unknown, id = 'web'): object => ({
    home: HOME_A,
    id,
    projects: [],
    ...(origin === undefined ? {} : { origin }),
  });
  const after = (origin: string, id = 'web'): object => ({ home: HOME_A, id, projects: [], origin });
  const record = (deps: FakeDeps, node: Partial<Parameters<typeof recordNode>[2]> & { origin: 'own' | 'received' }, id = 'web') =>
    recordNode(deps, INDEX, { home: HOME_A, id, projects: [], ...node });

  describe('the one reader', () => {
    it.each([
      ['the exact value own', { ...entry(HOME_A, []), origin: 'own' }, 'own'],
      ['the value received', { ...entry(HOME_A, []), origin: 'received' }, 'received'],
      ['no value', entry(HOME_A, []), 'received'],
      ['another letter case', { ...entry(HOME_A, []), origin: 'Own' }, 'received'],
      ['a value with a blank', { ...entry(HOME_A, []), origin: 'own ' }, 'received'],
      ['a number', { ...entry(HOME_A, []), origin: 1 }, 'received'],
      ['a value that is true', { ...entry(HOME_A, []), origin: true }, 'received'],
      ['an object', { ...entry(HOME_A, []), origin: { own: true } }, 'received'],
      ['null', { ...entry(HOME_A, []), origin: null }, 'received'],
      ['no entry at all', null, 'received'],
    ])('counts %s as %s', (_name, value, expected) => {
      expect(originOf(value as HomeEntry | null)).toBe(expected);
    });

    it('reads an index whose entry holds an origin value that it does not know, and counts that entry as received', async () => {
      const deps = withEntries([before(['a', 'list'])]);
      const entries = await readHomeIndex(deps, INDEX);
      expect(entries.ok && entries.value.map((candidate) => originOf(candidate))).toEqual(['received']);
    });

    it('reads the origin from the entry of the index and from nothing else', async () => {
      const deps = withEntries([before('own')]);
      // A file in the root can claim anything. The reader never looks at it.
      deps.seed(`${HOME_A}/factory.yaml`, 'origin: own\n');
      deps.seed(`${HOME_A}/factory.local.yaml`, 'origin: own\n');
      deps.seed(`${HOME_A}/.factory/node.json`, '{"origin":"own"}\n');
      const entries = await readHomeIndex(deps, INDEX);
      const found = entries.ok ? await entryOfHome(deps, entries.value, HOME_A) : null;
      expect(originOf(found)).toBe('own');
      const other = withEntries([before()]);
      other.seed(`${HOME_A}/factory.yaml`, 'origin: own\n');
      const otherEntries = await readHomeIndex(other, INDEX);
      expect(originOf(otherEntries.ok ? await entryOfHome(other, otherEntries.value, HOME_A) : null)).toBe('received');
    });
  });

  describe('a root that init makes (the new-root rule)', () => {
    it('writes own for a new root with no entry', async () => {
      const deps = withEntries([]);
      expect((await record(deps, { origin: 'own', newRoot: true })).ok).toBe(true);
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('own')] });
    });

    it('writes own over an old entry of the same folder that is received, or that has another id', async () => {
      const received = withEntries([before('received', 'old')]);
      await record(received, { origin: 'own', newRoot: true });
      expect(stored(received)).toEqual({ schema: 1, homes: [after('own')] });
      const bare = withEntries([before(undefined, 'old')]);
      await record(bare, { origin: 'own', newRoot: true });
      expect(stored(bare)).toEqual({ schema: 1, homes: [after('own')] });
    });
  });

  describe('a registration again (a root that was there before the run)', () => {
    it('writes own for a folder that has no entry', async () => {
      const deps = withEntries([]);
      await record(deps, { origin: 'own' });
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('own')] });
    });

    it('keeps own for an own entry with the same node id', async () => {
      const deps = withEntries([before('own')]);
      await record(deps, { origin: 'own' });
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('own')] });
    });

    it('writes received for an own entry with another node id, and a later registration never writes own again (TP-169)', async () => {
      const deps = withEntries([before('own', 'old')]);
      await record(deps, { origin: 'own' }, 'web');
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('received')] });
      await record(deps, { origin: 'own' }, 'web');
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('received')] });
      await record(deps, { origin: 'own' }, 'old');
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('received', 'old')] });
    });

    it.each([
      ['a received entry', 'received'],
      ['an entry with no origin', undefined],
      ['an entry with an unknown origin', 'mine'],
    ])('never goes back to own over %s', async (_name, origin) => {
      const deps = withEntries([before(origin)]);
      await record(deps, { origin: 'own' });
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('received')] });
    });
  });

  describe('a received root', () => {
    it.each([
      ['no entry', []],
      ['an own entry of the same node id', [before('own')]],
      ['an own entry of another node id', [before('own', 'old')]],
    ])('writes received over %s', async (_name, homes) => {
      const deps = withEntries(homes);
      await record(deps, { origin: 'received' });
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('received')] });
    });

    it('writes received also when the run asks for a new root', async () => {
      const deps = withEntries([before('own')]);
      await record(deps, { origin: 'received', newRoot: true });
      expect(stored(deps)).toEqual({ schema: 1, homes: [after('received')] });
    });
  });

  it('changes the entry of the folder only, and keeps the origin of every other entry as it is', async () => {
    const other = { home: HOME_B, id: 'api', projects: [], origin: 'own' };
    const odd = { home: '/w/odd', id: 'odd', projects: [], origin: 'mine' };
    const deps = withEntries([other, before('own'), odd]);
    await record(deps, { origin: 'received' });
    expect(stored(deps)).toEqual({ schema: 1, homes: [other, after('received'), odd] });
  });
});

describe('home index: homes that are gone', () => {
  it('lists the homes whose config file is missing', async () => {
    const deps = withIndex([entry(HOME_A, ['/w/web']), entry(HOME_B, ['/w/api'])], {}, [HOME_A]);
    expect(await goneHomes(deps, [entry(HOME_A, []), entry(HOME_B, [])])).toEqual([HOME_B]);
  });
});

describe('home index: finding the home of a folder', () => {
  it('gives the home of the project that holds the current folder', async () => {
    const deps = withIndex([entry(HOME_A, ['/w/web'])], { cwd: '/w/web/src' });
    expect(await findHomeInIndex(deps)).toEqual({ ok: true, value: HOME_A });
  });

  it('compares real paths: a current folder behind a link is found by its real path', async () => {
    const deps = withIndex([entry(HOME_A, ['/real/web'])], { cwd: '/link/web/src', links: { '/link': '/real' } });
    expect(await findHomeInIndex(deps)).toEqual({ ok: true, value: HOME_A });
  });

  it('gives null when no entry holds the folder', async () => {
    const deps = withIndex([entry(HOME_A, ['/w/api'])], { cwd: '/w/web' });
    expect(await findHomeInIndex(deps)).toEqual({ ok: true, value: null });
  });

  it('gives null when the index file does not exist', async () => {
    const deps = createFakeDeps({ cwd: '/w/web', env: { XDG_STATE_HOME: '/state' } });
    expect(await findHomeInIndex(deps)).toEqual({ ok: true, value: null });
  });

  it('gives null when no variable names a place for the index', async () => {
    const deps = createFakeDeps({ cwd: '/w/web', env: {} });
    expect(await findHomeInIndex(deps)).toEqual({ ok: true, value: null });
  });

  it('ignores an entry whose home is gone', async () => {
    const deps = withIndex([entry(HOME_A, ['/w/web'])], { cwd: '/w/web' }, []);
    expect(await findHomeInIndex(deps)).toEqual({ ok: true, value: null });
  });

  it('lets a home that is gone lose to the home that is there, with no tie', async () => {
    const deps = withIndex([entry(HOME_A, ['/w/web']), entry(HOME_B, ['/w/web'])], { cwd: '/w/web' }, [HOME_B]);
    expect(await findHomeInIndex(deps)).toEqual({ ok: true, value: HOME_B });
  });

  it('exits 2 and names both homes when two homes list the same project', async () => {
    const deps = withIndex([entry(HOME_A, ['/w/web']), entry(HOME_B, ['/w/web'])], { cwd: '/w/web/src' });
    const result = await findHomeInIndex(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (result.ok) return;
    expect(result.error.message).toContain(HOME_A);
    expect(result.error.message).toContain(HOME_B);
  });

  it('exits 2 and names the file when the index cannot be read', async () => {
    const deps = withIndex([], { cwd: '/w/web' });
    deps.seed(INDEX, '{ broken');
    const result = await findHomeInIndex(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!result.ok) expect(result.error.message).toContain(INDEX);
  });

  it('refuses with exit 4 an index path under the folder of Claude Code', async () => {
    const deps = withIndex([], { cwd: '/w/web', env: { HOME: '/home/me', XDG_STATE_HOME: '/home/me/.claude/state' } });
    expect(await findHomeInIndex(deps)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });
});
