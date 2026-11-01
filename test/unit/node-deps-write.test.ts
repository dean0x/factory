import { chmod, lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDeps } from '../../src/core/node-deps.js';

const deps = createNodeDeps();
let dir = '';
let counter = 0;

const fresh = (name: string): string => join(dir, `${(counter += 1)}-${name}`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-node-write-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('node deps: atomic write', () => {
  it('replaces the text of an existing file and leaves no temporary file', async () => {
    const folder = fresh('replace');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'CLAUDE.md');
    await writeFile(file, 'old text', 'utf8');
    expect((await deps.fs.writeTextAtomic(file, 'new text')).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('new text');
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['CLAUDE.md'] });
  });

  it('creates a file that does not exist', async () => {
    const folder = fresh('create');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'factory.yaml');
    expect((await deps.fs.writeTextAtomic(file, 'schema: 1\n')).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('schema: 1\n');
  });

  it('keeps the permissions of the file', async () => {
    const folder = fresh('mode');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'CLAUDE.md');
    await writeFile(file, 'old text', 'utf8');
    await chmod(file, 0o600);
    expect((await deps.fs.writeTextAtomic(file, 'new text')).ok).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('writes through a link and keeps the link', async () => {
    const folder = fresh('link');
    await deps.fs.mkdir(folder);
    const target = join(folder, 'real.md');
    const link = join(folder, 'CLAUDE.md');
    await writeFile(target, 'old text', 'utf8');
    await symlink(target, link);
    expect((await deps.fs.writeTextAtomic(link, 'new text')).ok).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('new text');
  });

  it('fails and leaves no temporary file when the folder does not exist', async () => {
    const folder = fresh('missing');
    const result = await deps.fs.writeTextAtomic(join(folder, 'CLAUDE.md'), 'text');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
    expect(await deps.fs.stat(folder)).toEqual({ ok: true, value: null });
  });

  it('keeps the old text and leaves no temporary file when the target is a folder', async () => {
    const folder = fresh('blocked');
    const target = join(folder, 'CLAUDE.md');
    await deps.fs.mkdir(target);
    const result = await deps.fs.writeTextAtomic(target, 'text');
    expect(result.ok).toBe(false);
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['CLAUDE.md'] });
  });
});

describe('node deps: remove an empty folder', () => {
  it('removes an empty folder', async () => {
    const folder = fresh('empty');
    await deps.fs.mkdir(folder);
    expect((await deps.fs.removeEmptyDir(folder)).ok).toBe(true);
    expect(await deps.fs.stat(folder)).toEqual({ ok: true, value: null });
  });

  it('keeps a folder that holds a file, and fails', async () => {
    const folder = fresh('full');
    await deps.fs.mkdir(folder);
    await writeFile(join(folder, 'other.txt'), 'x', 'utf8');
    const result = await deps.fs.removeEmptyDir(folder);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/ENOTEMPTY|EEXIST/);
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['other.txt'] });
  });

  it('keeps a folder that holds a folder, and fails', async () => {
    const folder = fresh('nested');
    await deps.fs.mkdir(join(folder, 'inner'));
    expect((await deps.fs.removeEmptyDir(folder)).ok).toBe(false);
    expect(await deps.fs.stat(join(folder, 'inner'))).toEqual({ ok: true, value: 'dir' });
  });

  it('does not fail for a path that does not exist', async () => {
    expect((await deps.fs.removeEmptyDir(fresh('none'))).ok).toBe(true);
  });
});
