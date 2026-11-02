import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import {
  findHomeInIndex,
  goneHomes,
  indexPathOf,
  matchFolder,
  readHomeIndex,
  recordHome,
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

  it('refuses a 201st home and changes nothing', async () => {
    const deps = fresh();
    const homes = Array.from({ length: 200 }, (_, i) => entry(`/h/h${i}`, []));
    deps.seed(INDEX, indexText(homes));
    const result = await recordHome(deps, INDEX, entry(HOME_A, []));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('200') });
    expect(stored(deps)).toEqual({ schema: 1, homes });
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
