import { mkdtemp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { writeInFolder, type FolderTarget } from '../../src/core/safe-write.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const PARENT = '/h/state';
const FOLDER = '/h/state/last';
const NAME = 'entry';
const FILE = `${FOLDER}/${NAME}`;
const TARGET: FolderTarget = { parent: PARENT, folder: FOLDER, name: NAME, mode: 0o600 };

const fakeWithParent = (options: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => {
  const deps = createFakeDeps(options);
  deps.seedDir(PARENT);
  return deps;
};

/** The files of the fake as a sorted list, so a test can compare the state before and after a call. */
const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files.entries()].sort(), null, 1) + [...deps.dirs].sort().join(',');

const errorOf = <T>(result: CliResult<T>): { kind: string; message: string; hint?: string } => {
  if (result.ok) throw new Error('the call should have failed');
  return result.error;
};

describe('safe write: with the fake file system', () => {
  it('creates the folder and the file, and leaves no temporary file', async () => {
    const deps = fakeWithParent();
    const result = await writeInFolder(deps, TARGET, 'first\n');
    expect(result).toEqual({ ok: true, value: undefined });
    expect(deps.files.get(FILE)).toBe('first\n');
    expect([...deps.files.keys()]).toEqual([FILE]);
    expect(deps.dirs.has(FOLDER)).toBe(true);
  });

  it('replaces the text of a file that exists', async () => {
    const deps = fakeWithParent();
    deps.seed(FILE, 'old\n');
    expect(await writeInFolder(deps, TARGET, 'new\n')).toEqual({ ok: true, value: undefined });
    expect(deps.files.get(FILE)).toBe('new\n');
    expect([...deps.files.keys()]).toEqual([FILE]);
  });

  it('does not use the atomic write of the file system', async () => {
    const deps = fakeWithParent();
    await writeInFolder(deps, TARGET, 'text\n');
    expect(deps.atomicWrites).toEqual([]);
  });

  it('refuses a folder that is a link, with a security stop, and changes nothing', async () => {
    const deps = fakeWithParent({ links: { [FOLDER]: '/outside' } });
    deps.seed(`/outside/${NAME}`, 'victim');
    const before = snapshot(deps);
    const error = errorOf(await writeInFolder(deps, TARGET, 'text\n'));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('it is a link');
    expect(error.hint).toBe(
      'Replace the link with a real folder or file. Then run "factory doctor" to check the factory folder.',
    );
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses a file that is a link, with a security stop, and keeps the target of the link', async () => {
    const deps = fakeWithParent({ links: { [FILE]: '/outside/target' } });
    deps.seedDir(FOLDER);
    deps.seed('/outside/target', 'victim');
    const before = snapshot(deps);
    const error = errorOf(await writeInFolder(deps, TARGET, 'text\n'));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('it is a link');
    expect(snapshot(deps)).toBe(before);
    expect(deps.files.get('/outside/target')).toBe('victim');
  });

  it('refuses a folder whose real path is outside the expected parent', async () => {
    const inner = `${FOLDER}/inner`;
    const deps = fakeWithParent({ links: { [FOLDER]: '/outside' } });
    deps.seedDir(inner);
    deps.seedDir('/outside/inner');
    const before = snapshot(deps);
    const error = errorOf(await writeInFolder(deps, { ...TARGET, folder: inner }, 'text\n'));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('outside');
    expect(error.hint).toBe('Use a real folder in the expected place. Then run "factory doctor" to check the factory folder.');
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses the expected parent itself as the folder', async () => {
    const deps = fakeWithParent();
    const error = errorOf(await writeInFolder(deps, { ...TARGET, folder: PARENT }, 'text\n'));
    expect(error.kind).toBe('safety');
    expect([...deps.files.keys()]).toEqual([]);
  });

  it('refuses a parent that is a link', async () => {
    const deps = createFakeDeps({ links: { [PARENT]: '/outside' } });
    deps.seedDir(PARENT);
    deps.seedDir('/outside');
    const error = errorOf(await writeInFolder(deps, TARGET, 'text\n'));
    expect(error.kind).toBe('safety');
    expect([...deps.files.keys()]).toEqual([]);
  });

  it('fails, and writes nothing, when the target is a folder', async () => {
    const deps = fakeWithParent();
    deps.seedDir(FILE);
    const error = errorOf(await writeInFolder(deps, TARGET, 'text\n'));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('not a file');
    expect([...deps.files.keys()]).toEqual([]);
  });

  it.each(['', '.', '..', 'a/b', '../escape', '/abs'])('refuses the file name %j', async (name) => {
    const deps = fakeWithParent();
    const error = errorOf(await writeInFolder(deps, { ...TARGET, name }, 'text\n'));
    expect(error.kind).toBe('failure');
    expect([...deps.files.keys()]).toEqual([]);
  });

  it('takes the next temporary name when one is taken', async () => {
    const deps = fakeWithParent();
    let calls = 0;
    const taken: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) => {
          calls += 1;
          return calls === 1 ? { ok: true, value: false } : deps.fs.writeTextExclusive(path, text, mode);
        },
      },
    };
    expect(await writeInFolder(taken, TARGET, 'text\n')).toEqual({ ok: true, value: undefined });
    expect(calls).toBe(2);
    expect(deps.files.get(FILE)).toBe('text\n');
  });

  it('fails with a bound when every temporary name is taken', async () => {
    const deps = fakeWithParent();
    deps.seed(FILE, 'old\n');
    let calls = 0;
    const taken: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async () => {
          calls += 1;
          return { ok: true, value: false };
        },
      },
    };
    const error = errorOf(await writeInFolder(taken, TARGET, 'text\n'));
    expect(error.kind).toBe('failure');
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(16);
    expect(deps.files.get(FILE)).toBe('old\n');
  });

  it('keeps the old text and removes the temporary file when the rename fails', async () => {
    const deps = fakeWithParent();
    deps.seed(FILE, 'old\n');
    const broken: Deps = { ...deps, fs: { ...deps.fs, rename: async () => failure('disk full') } };
    const error = errorOf(await writeInFolder(broken, TARGET, 'new\n'));
    expect(error.message).toContain('disk full');
    expect(deps.files.get(FILE)).toBe('old\n');
    expect([...deps.files.keys()]).toEqual([FILE]);
  });

  it('fails when the temporary file can not be written, and leaves the old text', async () => {
    const deps = fakeWithParent();
    deps.seed(FILE, 'old\n');
    const broken: Deps = { ...deps, fs: { ...deps.fs, writeTextExclusive: async () => failure('disk full') } };
    expect(errorOf(await writeInFolder(broken, TARGET, 'new\n')).message).toContain('disk full');
    expect(deps.files.get(FILE)).toBe('old\n');
  });

  it('gives the folder the mode that the caller names, only when it creates the folder', async () => {
    const deps = fakeWithParent();
    await writeInFolder(deps, { ...TARGET, folderMode: 0o700 }, 'text\n');
    expect(deps.modes.get(FOLDER)).toBe(0o700);
    deps.modes.delete(FOLDER);
    await writeInFolder(deps, { ...TARGET, folderMode: 0o755 }, 'again\n');
    expect(deps.modes.has(FOLDER)).toBe(false);
  });
});

describe('safe write: with the real file system', () => {
  const deps = createNodeDeps();
  let dir = '';
  let counter = 0;

  const fresh = async (): Promise<{ parent: string; folder: string; target: FolderTarget }> => {
    const parent = join(dir, `case-${(counter += 1)}`);
    await mkdir(parent);
    const folder = join(parent, 'last');
    return { parent, folder, target: { parent, folder, name: NAME, mode: 0o600, folderMode: 0o700 } };
  };

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-safe-write-')));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the folder and the file with the modes, and leaves no temporary file', async () => {
    const { folder, target } = await fresh();
    expect(await writeInFolder(deps, target, 'one\n')).toEqual({ ok: true, value: undefined });
    expect(await readFile(join(folder, NAME), 'utf8')).toBe('one\n');
    expect((await lstat(join(folder, NAME))).mode & 0o777).toBe(0o600);
    expect((await lstat(folder)).mode & 0o777).toBe(0o700);
    expect(await readdir(folder)).toEqual([NAME]);
  });

  it('replaces a file that exists', async () => {
    const { folder, target } = await fresh();
    await writeInFolder(deps, target, 'one\n');
    await writeInFolder(deps, target, 'two\n');
    expect(await readFile(join(folder, NAME), 'utf8')).toBe('two\n');
    expect(await readdir(folder)).toEqual([NAME]);
  });

  it('refuses a folder that is a link and leaves the folder behind the link as it was', async () => {
    const { parent, folder, target } = await fresh();
    const outside = join(parent, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, NAME), 'victim', 'utf8');
    await symlink(outside, folder);
    const error = errorOf(await writeInFolder(deps, target, 'text\n'));
    expect(error.kind).toBe('safety');
    expect(await readFile(join(outside, NAME), 'utf8')).toBe('victim');
    expect(await readdir(outside)).toEqual([NAME]);
  });

  it('refuses a file that is a link and leaves the target of the link as it was', async () => {
    const { parent, folder, target } = await fresh();
    await mkdir(folder);
    const victim = join(parent, 'victim.txt');
    await writeFile(victim, 'victim', 'utf8');
    await symlink(victim, join(folder, NAME));
    const error = errorOf(await writeInFolder(deps, target, 'text\n'));
    expect(error.kind).toBe('safety');
    expect(await readFile(victim, 'utf8')).toBe('victim');
    expect(await readdir(folder)).toEqual([NAME]);
  });

  it('refuses a file that is a link to a path that does not exist', async () => {
    const { parent, folder, target } = await fresh();
    await mkdir(folder);
    const missing = join(parent, 'missing.txt');
    await symlink(missing, join(folder, NAME));
    expect(errorOf(await writeInFolder(deps, target, 'text\n')).kind).toBe('safety');
    expect(await lstat(missing).catch(() => null)).toBeNull();
  });

  it('refuses a folder whose real path is outside the expected parent', async () => {
    const { parent, folder, target } = await fresh();
    const outside = `${parent}-outside`;
    await mkdir(join(outside, 'inner'), { recursive: true });
    await symlink(outside, folder);
    const inner = join(folder, 'inner');
    const error = errorOf(await writeInFolder(deps, { ...target, folder: inner }, 'text\n'));
    expect(error.kind).toBe('safety');
    expect(await readdir(join(outside, 'inner'))).toEqual([]);
  });

  it('accepts a parent that is reached through a link in a folder above it', async () => {
    const { parent } = await fresh();
    const real = join(parent, 'real');
    await mkdir(join(real, 'state'), { recursive: true });
    const via = join(parent, 'via');
    await symlink(real, via);
    const target: FolderTarget = { parent: join(via, 'state'), folder: join(via, 'state', 'last'), name: NAME, mode: 0o600 };
    expect(await writeInFolder(deps, target, 'text\n')).toEqual({ ok: true, value: undefined });
    expect(await readFile(join(real, 'state', 'last', NAME), 'utf8')).toBe('text\n');
  });
});
