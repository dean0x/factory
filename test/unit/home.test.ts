import { describe, expect, it } from 'vitest';
import {
  entryProblemOf,
  locateHome,
  locateHomeFolder,
  markerProblemOf,
  reasonOf,
  type NodeIdReader,
} from '../../src/core/home.js';
import { err, ok } from '../../src/core/result.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';

const HOME = '/w/node';
const INDEX = '/state/factory/homes.json';
const MARKER = `${HOME}/.factory/node.json`;

/** A reader that gives one node id for every folder, as the command layer gives the id of the shared config. */
const idOf = (id: string, schema = 2): NodeIdReader => async () => ok({ id, schema });
const reader = idOf('demo');
const unreadable: NodeIdReader = async () => err('factory.yaml does not parse');

/** A folder with a config file. It is a registered root when `registered` is true. */
const nodeAt = (cwd: string, env: Record<string, string | undefined> = {}, registered = true): FakeDeps => {
  const deps = createFakeDeps({ cwd, env: { XDG_STATE_HOME: '/state', ...env } });
  deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
  deps.seedDir(cwd);
  if (registered) registerRoot(deps, HOME, 'demo');
  return deps;
};

const located = async (deps: FakeDeps, homeFlag?: string, read: NodeIdReader = reader) => {
  const result = await locateHome(deps, homeFlag, read);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const stopped = async (deps: FakeDeps, homeFlag?: string, read: NodeIdReader = reader) => {
  const result = await locateHome(deps, homeFlag, read);
  if (result.ok) throw new Error(`expected a stop, got ${result.value.home}`);
  return result.error;
};

describe('home: the order', () => {
  it('takes the home flag first, also when the environment and the current folder name a home', async () => {
    const deps = nodeAt(HOME, { FACTORY_HOME: '/other' });
    expect(await located(deps, '/flag')).toEqual({ home: '/flag', source: 'flag', unregistered: false });
  });

  it('takes FACTORY_HOME second, before the folders above the current folder', async () => {
    const deps = nodeAt(`${HOME}/deep`, { FACTORY_HOME: '/elsewhere' });
    expect(await located(deps)).toEqual({ home: '/elsewhere', source: 'env', unregistered: false });
  });

  it('resolves a relative FACTORY_HOME against the current folder', async () => {
    const deps = nodeAt('/w', { FACTORY_HOME: 'node' });
    expect(await located(deps)).toEqual({ home: HOME, source: 'env', unregistered: false });
  });

  it('counts a FACTORY_HOME that is the current folder as the current folder', async () => {
    const deps = nodeAt(HOME, { FACTORY_HOME: HOME });
    expect(await located(deps)).toEqual({ home: HOME, source: 'cwd', unregistered: false });
  });

  it('ignores an empty FACTORY_HOME and walks up from the current folder', async () => {
    const deps = nodeAt(`${HOME}/deep`, { FACTORY_HOME: '' });
    expect(await located(deps)).toEqual({ home: HOME, source: 'ancestor', unregistered: false });
  });

  it('finds the home in the current folder when the environment names none', async () => {
    expect(await located(nodeAt(HOME))).toEqual({ home: HOME, source: 'cwd', unregistered: false });
  });

  it('fails with a hint when no source names a home', async () => {
    const result = await locateHome(createFakeDeps({ cwd: '/empty' }), undefined, reader);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('usage');
      expect(result.error.message).toContain('no factory.yaml found');
      expect(result.error.hint).toContain('--home DIR');
    }
  });

  it('does not walk more than 64 levels', async () => {
    const deep = `${HOME}${'/d'.repeat(70)}`;
    const result = await locateHome(nodeAt(deep), undefined, reader);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
  });
});

describe('home: the index', () => {
  const INDEX_HOME = '/w/web-factory';
  const indexed = (cwd: string, env: Record<string, string | undefined> = {}): FakeDeps => {
    const deps = createFakeDeps({ cwd, env: { XDG_STATE_HOME: '/state', ...env } });
    deps.seed(`${INDEX_HOME}/factory.yaml`, 'schema: 2\n');
    registerRoot(deps, INDEX_HOME, 'demo', ['/w/web']);
    deps.seedDir(cwd);
    return deps;
  };

  it('takes the home from the index when no flag, variable or config file names one', async () => {
    expect(await located(indexed('/w/web/src'))).toEqual({ home: INDEX_HOME, source: 'index', unregistered: false });
  });

  it('asks the index last: the flag, the variable and a config file above the folder come first', async () => {
    expect(await located(indexed('/w/web'), '/flag')).toMatchObject({ home: '/flag', source: 'flag' });
    expect(await located(indexed('/w/web', { FACTORY_HOME: '/elsewhere' }))).toMatchObject({ home: '/elsewhere', source: 'env' });
  });

  it('fails with exit 2 and the hint when the index has no entry for the folder', async () => {
    const result = await locateHome(indexed('/w/other'), undefined, reader);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (result.ok) return;
    expect(result.error.hint).toContain('Run "factory init" here, or use --home DIR');
  });

  it('fails with exit 2 when the index cannot be read, and names the file', async () => {
    const deps = indexed('/w/web');
    deps.seed(INDEX, 'broken');
    const result = await locateHome(deps, undefined, reader);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!result.ok) expect(result.error.message).toContain(INDEX);
  });

  it('applies the registration check to a home that the index gives', async () => {
    const deps = indexed('/w/web/src');
    deps.files.delete(`${INDEX_HOME}/.factory/node.json`);
    expect(await stopped(deps)).toMatchObject({ kind: 'safety', message: expect.stringContaining('factory marker') });
  });
});

describe('home: the registration check', () => {
  describe.each([
    ['the home flag', HOME, {}],
    ['FACTORY_HOME', '/elsewhere', { FACTORY_HOME: HOME }],
    ['the current folder', HOME, {}],
    ['a folder above the current folder', `${HOME}/deep`, {}],
  ])('for %s', (name, cwd, env) => {
    const flag = name === 'the home flag' ? HOME : undefined;

    it('exits 4 and names the file when the factory list has no entry for the folder', async () => {
      const deps = nodeAt(cwd, env, false);
      const error = await stopped(deps, flag);
      expect(error.kind).toBe('safety');
      expect(error.message).toContain(`${HOME}/factory.yaml`);
      expect(error.message).toContain('no entry');
      expect(error.hint).toBe(`Run "factory init" in the factory folder ${HOME}.`);
    });

    it('exits 4 when the entry has another node id, and says to run init', async () => {
      const deps = nodeAt(cwd, env);
      registerRoot(deps, HOME, 'other');
      const error = await stopped(deps, flag);
      expect(error.kind).toBe('safety');
      expect(error.message).toContain(`${HOME}/factory.yaml`);
      expect(error.message).toContain('"other"');
      expect(error.hint).toContain('Run "factory init" in the factory folder');
    });

    it('exits 4 when the factory marker is missing', async () => {
      const deps = nodeAt(cwd, env);
      deps.files.delete(MARKER);
      const error = await stopped(deps, flag);
      expect(error.kind).toBe('safety');
      expect(error.message).toContain('.factory/node.json');
      expect(error.hint).toContain('Run "factory init" in the factory folder');
    });

    it('passes a registered root', async () => {
      expect(await located(nodeAt(cwd, env), flag)).toMatchObject({ home: HOME, unregistered: false });
    });
  });

  it('exits 4 when the factory marker does not parse or is not valid', async () => {
    for (const text of ['not json', '[]', '{"schema_version": 2}', '{"schema_version": "x"}']) {
      const deps = nodeAt(HOME);
      deps.seed(MARKER, text);
      const error = await stopped(deps);
      expect(error).toMatchObject({ kind: 'safety', message: expect.stringContaining('.factory/node.json') });
    }
  });

  it('exits 4 when .factory is a file, and names the path to move away', async () => {
    const deps = createFakeDeps({ cwd: HOME, env: { XDG_STATE_HOME: '/state' } });
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    deps.seed(`${HOME}/.factory`, 'x');
    registerRoot(deps, HOME, 'demo');
    const error = await stopped(deps);
    expect(error.kind).toBe('safety');
    expect(error.message).toContain(`${HOME}/.factory is not a folder`);
    expect(error.hint).toContain(`Move ${HOME}/.factory away`);
    expect(error.hint).toContain('factory init');
  });

  it('passes a factory marker of an old state version, so that the state check can name upgrade', async () => {
    const deps = nodeAt(HOME);
    deps.seed(MARKER, '{"schema_version": 1}');
    expect(await located(deps)).toMatchObject({ home: HOME });
  });

  it('exits 4 for a factory marker of a newer state version, and says to upgrade the program', async () => {
    const deps = nodeAt(HOME);
    deps.seed(MARKER, '{"schema_version": 99}');
    const error = await stopped(deps);
    expect(error.kind).toBe('safety');
    expect(error.hint).toBe('Upgrade factory, then run "factory doctor".');
  });

  it('exits 4 with the remedy of a clone when the config file is in a clone of a registered factory', async () => {
    const deps = createFakeDeps({ cwd: '/w/factory/web/src', env: { XDG_STATE_HOME: '/state' } });
    deps.seed('/w/factory/factory.yaml', 'schema: 2\n');
    deps.seed('/w/factory/web/factory.yaml', 'schema: 2\n');
    registerRoot(deps, '/w/factory', 'demo', ['/w/factory/web']);
    const error = await stopped(deps);
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('/w/factory/web/factory.yaml');
    expect(error.message).toContain('clone');
    expect(error.hint).toBe('Go to the factory folder /w/factory, or name it with --home /w/factory.');
  });

  it('gives the same remedy of a clone for FACTORY_HOME and the home flag that name the clone', async () => {
    const deps = createFakeDeps({ cwd: '/w', env: { XDG_STATE_HOME: '/state', FACTORY_HOME: '/w/factory/web' } });
    deps.seed('/w/factory/factory.yaml', 'schema: 2\n');
    deps.seed('/w/factory/web/factory.yaml', 'schema: 2\n');
    registerRoot(deps, '/w/factory', 'demo', ['/w/factory/web']);
    expect(await stopped(deps)).toMatchObject({ kind: 'safety', hint: expect.stringContaining('--home /w/factory') });
    expect(await stopped(deps, '/w/factory/web')).toMatchObject({ kind: 'safety', hint: expect.stringContaining('--home /w/factory') });
  });

  it('exits 4 when the factory list cannot be used, and names the file', async () => {
    const deps = nodeAt(HOME);
    deps.seed(INDEX, 'broken');
    const error = await stopped(deps);
    expect(error.kind).toBe('safety');
    expect(error.message).toContain(INDEX);
    expect(error.hint).toContain('factory init');
  });

  it('exits 4 when no variable names a folder for the factory list', async () => {
    const deps = createFakeDeps({ cwd: HOME });
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    const error = await stopped(deps);
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('XDG_STATE_HOME');
  });

  it('exits 4 when another account can write the factory list', async () => {
    const deps = nodeAt(HOME);
    deps.modes.set(INDEX, 0o666);
    expect(await stopped(deps)).toMatchObject({ kind: 'safety', message: expect.stringContaining(INDEX) });
  });

  it('does not apply to a folder with no config file: the command reports the missing file', async () => {
    const deps = createFakeDeps({ cwd: '/w', env: { XDG_STATE_HOME: '/state' } });
    expect(await located(deps, '/w/empty')).toEqual({ home: '/w/empty', source: 'flag', unregistered: false });
  });

  it('lets the load report a config that does not parse when the entry and the marker are right', async () => {
    expect(await located(nodeAt(HOME), undefined, unreadable)).toMatchObject({ home: HOME });
  });

  it('keeps two roots on one machine apart', async () => {
    const deps = createFakeDeps({ cwd: '/w/a/deep', env: { XDG_STATE_HOME: '/state' } });
    for (const [folder, id] of [['/w/a', 'alpha'], ['/w/b', 'beta']] as const) {
      deps.seed(`${folder}/factory.yaml`, 'schema: 2\n');
      registerRoot(deps, folder, id);
    }
    const readOf: NodeIdReader = async (_deps, home) => ok({ id: home === '/w/a' ? 'alpha' : 'beta', schema: 2 });
    expect(await located(deps, undefined, readOf)).toMatchObject({ home: '/w/a' });
    deps.seedDir('/w/b/deep');
    expect(await located({ ...deps, cwd: '/w/b/deep' }, undefined, readOf)).toMatchObject({ home: '/w/b' });
    expect(await located(deps, '/w/b', readOf)).toMatchObject({ home: '/w/b' });
    expect(await stopped(deps, '/w/b', idOf('alpha'))).toMatchObject({ kind: 'safety' });
  });
});

describe('home: the exception of upgrade', () => {
  const unregisteredNode = (): FakeDeps => nodeAt(HOME, {}, false);
  const withException = (deps: FakeDeps, flag: string | undefined, read: NodeIdReader) =>
    locateHome(deps, flag, read, { allowUnregisteredSchema1: true });

  it('counts an unregistered folder with schema 1 that the home flag names, and marks it', async () => {
    const result = await withException(unregisteredNode(), HOME, idOf('demo', 1));
    expect(result).toEqual({ ok: true, value: { home: HOME, source: 'flag', unregistered: true } });
  });

  it.each([
    ['a folder with schema 2', idOf('demo', 2), HOME, {}, HOME],
    ['a folder that FACTORY_HOME names', idOf('demo', 1), undefined, { FACTORY_HOME: HOME }, '/elsewhere'],
    ['a folder that the walk finds', idOf('demo', 1), undefined, {}, `${HOME}/deep`],
  ])('exits 4 for %s', async (_name, read, flag, env, cwd) => {
    const deps = nodeAt(cwd, env, false);
    const result = await withException(deps, flag, read);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('exits 4 without the flag exception for a schema 1 folder that the home flag names', async () => {
    const result = await locateHome(unregisteredNode(), HOME, idOf('demo', 1));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('does not count a folder with an entry of another id, also with schema 1', async () => {
    const deps = nodeAt(HOME);
    registerRoot(deps, HOME, 'other');
    expect(await withException(deps, HOME, idOf('demo', 1))).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('does not mark a registered folder', async () => {
    const result = await withException(nodeAt(HOME), HOME, idOf('demo', 1));
    expect(result).toMatchObject({ ok: true, value: { unregistered: false } });
  });
});

describe('home: the parts of the registration check', () => {
  const problem = async <T extends { ok: boolean }>(result: Promise<T>) => {
    const done = await result;
    if (!done.ok) throw new Error('the check failed');
    return (done as unknown as { value: unknown }).value;
  };

  it('finds no entry for a folder that the list does not hold, and does not look at the marker', async () => {
    const deps = nodeAt(HOME, {}, false);
    expect(await problem(entryProblemOf(deps, HOME, reader))).toEqual({ kind: 'no-entry' });
  });

  it('finds the other id of an entry, and gives none for an entry with the same id', async () => {
    const deps = nodeAt(HOME);
    expect(await problem(entryProblemOf(deps, HOME, reader))).toBeNull();
    registerRoot(deps, HOME, 'old');
    expect(await problem(entryProblemOf(deps, HOME, reader))).toEqual({ kind: 'other-id', listed: 'old' });
  });

  it('does not look at the marker when the entry is right', async () => {
    const deps = nodeAt(HOME);
    deps.files.delete(MARKER);
    expect(await problem(entryProblemOf(deps, HOME, reader))).toBeNull();
  });

  it.each([
    ['is missing', undefined, { kind: 'marker', reason: 'is missing' }],
    ['does not parse', '{', { kind: 'marker', reason: 'does not parse' }],
    ['is not valid', '{"schema_version": "x"}', { kind: 'marker', reason: 'is not valid' }],
  ])('names a marker that %s', async (_name, text, expected) => {
    const deps = nodeAt(HOME);
    deps.files.delete(MARKER);
    if (text !== undefined) deps.seed(MARKER, text);
    expect(await problem(markerProblemOf(deps, HOME))).toEqual(expected);
  });

  it('gives none for a valid marker, and names a state path that is not a folder', async () => {
    const deps = nodeAt(HOME);
    expect(await problem(markerProblemOf(deps, HOME))).toBeNull();
    const file = nodeAt(HOME, {}, false);
    file.seed(`${HOME}/.factory`, 'x');
    expect(await problem(markerProblemOf(file, HOME))).toEqual({ kind: 'state-not-folder' });
  });

  it('keeps the order of the check: the entry first, then the marker', async () => {
    const deps = nodeAt(HOME, {}, false);
    deps.files.delete(MARKER);
    expect(await stopped(deps, HOME)).toMatchObject({ message: expect.stringContaining('has no entry') });
    registerRoot(deps, HOME, 'demo');
    deps.files.delete(MARKER);
    expect(await stopped(deps, HOME)).toMatchObject({ message: expect.stringContaining('is missing') });
  });

  it.each([
    [{ kind: 'no-entry' }, 'the factory list has no entry for /w/node'],
    [{ kind: 'in-clone', factory: '/w/other' }, 'it is in a clone of the factory folder /w/other'],
    [{ kind: 'other-id', listed: 'old' }, 'the factory list has the node id "old" for /w/node, and the file has another id'],
    [{ kind: 'state-not-folder' }, '/w/node/.factory is not a folder'],
    [{ kind: 'marker', reason: 'is missing' }, 'the factory marker .factory/node.json is missing'],
    [{ kind: 'marker-newer', reason: 'is from a newer version' }, 'the factory marker .factory/node.json is from a newer version'],
    [{ kind: 'list', reason: 'the list is gone', remedy: 'x' }, 'the list is gone'],
  ] as const)('gives the reason of %j as a sentence', (found, reason) => {
    expect(reasonOf(HOME, found)).toBe(reason);
  });

  it('gives the same reason in the stop of a command', async () => {
    const stop = await stopped(nodeAt(HOME, {}, false), HOME);
    expect(stop.message).toBe(`/w/node/factory.yaml does not count: ${reasonOf(HOME, { kind: 'no-entry' })}`);
  });
});

describe('home: a folder', () => {
  it('gives the located home when it is a folder', async () => {
    const result = await locateHomeFolder(nodeAt(HOME), undefined, reader);
    expect(result).toEqual({ ok: true, value: { home: HOME, source: 'cwd', unregistered: false } });
  });

  it('fails for a home that is a file or does not exist', async () => {
    const deps = nodeAt(HOME);
    deps.seed('/w/file', 'x');
    expect(await locateHomeFolder(deps, '/w/file', reader)).toMatchObject({ ok: false, error: { message: '/w/file is not a folder' } });
    expect(await locateHomeFolder(deps, '/w/none', reader)).toMatchObject({ ok: false, error: { message: '/w/none is not a folder' } });
  });

  it('passes on the failure of locateHome', async () => {
    const result = await locateHomeFolder(createFakeDeps({ cwd: '/empty' }), undefined, reader);
    expect(result.ok).toBe(false);
  });

  it('exits 4 for a folder that is not registered', async () => {
    const result = await locateHomeFolder(nodeAt(HOME, {}, false), undefined, reader);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });
});
