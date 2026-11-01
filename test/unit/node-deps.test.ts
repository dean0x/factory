import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDeps } from '../../src/core/node-deps.js';

const deps = createNodeDeps();
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-node-deps-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('node deps: run', () => {
  it('passes arguments without a shell', async () => {
    const result = await deps.run('echo', ['a; echo b', '$HOME']);
    expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: 'a; echo b $HOME\n', stderr: '' } });
  });

  it('returns a non-zero exit code as a value', async () => {
    const result = await deps.run('node', ['-e', 'process.exit(3)']);
    expect(result.ok && result.value.exitCode).toBe(3);
  });

  it('returns an error when the program does not exist', async () => {
    const result = await deps.run('factory-no-such-program', []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cannot run factory-no-such-program');
  });

  it('returns an error when the time limit passes', async () => {
    const result = await deps.run('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 });
    expect(result.ok).toBe(false);
  });

  it('runs in the folder that the caller names', async () => {
    const result = await deps.run('pwd', [], { cwd: dir });
    expect(result.ok && result.value.stdout.trim().endsWith(dir.split('/').pop() ?? '?')).toBe(true);
  });
});

describe('node deps: fs', () => {
  it('writes, reads, lists and stats', async () => {
    const folder = join(dir, 'a', 'b');
    expect((await deps.fs.mkdir(folder)).ok).toBe(true);
    expect((await deps.fs.writeText(join(folder, 'x.txt'), 'hello')).ok).toBe(true);
    expect(await deps.fs.readText(join(folder, 'x.txt'))).toEqual({ ok: true, value: 'hello' });
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['x.txt'] });
    expect(await deps.fs.stat(folder)).toEqual({ ok: true, value: 'dir' });
    expect(await deps.fs.stat(join(folder, 'x.txt'))).toEqual({ ok: true, value: 'file' });
    expect(await deps.fs.stat(join(folder, 'none'))).toEqual({ ok: true, value: null });
  });

  it('returns an error with the code for a missing file', async () => {
    const result = await deps.fs.readText(join(dir, 'missing.txt'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
  });

  it('copies a tree into a folder inside the tree, and leaves out the skipped folder', async () => {
    const source = join(dir, 'self');
    await deps.fs.mkdir(join(source, 'old'));
    await deps.fs.writeText(join(source, 'a.txt'), 'a');
    await deps.fs.writeText(join(source, 'old', 'b.txt'), 'b');
    const target = join(source, 'old', 'copy');

    expect((await deps.fs.copyTree(source, target, [join(source, 'old')])).ok).toBe(true);
    expect(await deps.fs.list(target)).toEqual({ ok: true, value: ['a.txt'] });
    expect(await deps.fs.readText(join(target, 'a.txt'))).toEqual({ ok: true, value: 'a' });

    const again = await deps.fs.copyTree(source, target, [join(source, 'old')]);
    expect(again.ok).toBe(false);
  });

  it('copies one file', async () => {
    const file = join(dir, 'one.txt');
    await deps.fs.writeText(file, 'one');
    expect((await deps.fs.copyTree(file, join(dir, 'two.txt'), [])).ok).toBe(true);
    expect(await deps.fs.readText(join(dir, 'two.txt'))).toEqual({ ok: true, value: 'one' });
  });

  it('renames, copies with a skip list, and removes a tree', async () => {
    const source = join(dir, 'tree');
    await deps.fs.mkdir(join(source, 'keep'));
    await deps.fs.mkdir(join(source, 'skip'));
    await deps.fs.writeText(join(source, 'keep', 'f.txt'), '1');
    await deps.fs.writeText(join(source, 'skip', 'g.txt'), '2');

    const copy = join(dir, 'copy');
    expect((await deps.fs.copyTree(source, copy, [join(source, 'skip')])).ok).toBe(true);
    expect(await deps.fs.list(copy)).toEqual({ ok: true, value: ['keep'] });

    const moved = join(dir, 'moved');
    expect((await deps.fs.rename(copy, moved)).ok).toBe(true);
    expect(await deps.fs.stat(copy)).toEqual({ ok: true, value: null });

    expect((await deps.fs.remove(moved)).ok).toBe(true);
    expect((await deps.fs.remove(moved)).ok).toBe(true);
    expect(await deps.fs.stat(moved)).toEqual({ ok: true, value: null });
  });
});

describe('node deps: fetch', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/slow') return;
      response.statusCode = request.url === '/broken' ? 500 : 200;
      response.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns the status of an answer', async () => {
    expect(await deps.fetch(`${base}/ok`, 2000)).toEqual({ ok: true, value: { status: 200 } });
    expect(await deps.fetch(`${base}/broken`, 2000)).toEqual({ ok: true, value: { status: 500 } });
  });

  it('returns an error when nothing answers in time', async () => {
    expect((await deps.fetch(`${base}/slow`, 150)).ok).toBe(false);
  });

  it('returns an error when the port is closed', async () => {
    expect((await deps.fetch('http://127.0.0.1:1/health', 1000)).ok).toBe(false);
  });
});
