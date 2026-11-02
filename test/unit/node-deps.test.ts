import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, lstat, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeDeps } from '../../src/core/node-deps.js';

const deps = createNodeDeps();
let dir = '';
let counter = 0;

const fresh = (name: string): string => join(dir, `${(counter += 1)}-${name}`);

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

  describe('the environment of the program', () => {
    const show = ['-e', 'process.stdout.write([process.env.LC_ALL, process.env.GIT_TERMINAL_PROMPT].join(","))'];
    const saved = { LC_ALL: process.env['LC_ALL'], GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] };

    beforeEach(() => {
      process.env['LC_ALL'] = 'en_US.UTF-8';
      process.env['GIT_TERMINAL_PROMPT'] = '1';
    });

    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('sets the C locale and no git prompt by default', async () => {
      const result = await deps.run('node', show);
      expect(result.ok && result.value.stdout).toBe('C,0');
    });

    it('keeps the environment of this process when the caller asks for it', async () => {
      const result = await deps.run('node', show, { inheritEnv: true });
      expect(result.ok && result.value.stdout).toBe('en_US.UTF-8,1');
    });
  });
});

describe('node deps: run with the terminal', () => {
  it('gives the exit code of the program as a value', async () => {
    expect(await deps.runAttached('node', ['-e', 'process.exit(0)'])).toEqual({ ok: true, value: 0 });
    expect(await deps.runAttached('node', ['-e', 'process.exit(3)'])).toEqual({ ok: true, value: 3 });
  });

  it('passes arguments without a shell', async () => {
    const result = await deps.runAttached('node', ['-e', 'process.exit(process.argv[1] === "a; exit 9" ? 0 : 1)', 'a; exit 9']);
    expect(result).toEqual({ ok: true, value: 0 });
  });

  it('returns an error when the program does not exist', async () => {
    const result = await deps.runAttached('factory-no-such-program', []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cannot run factory-no-such-program');
  });

  it('returns an error when a signal ends the program', async () => {
    const result = await deps.runAttached('node', ['-e', 'process.kill(process.pid, "SIGTERM")']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('SIGTERM');
  });
});

describe('node deps: the terminal', () => {
  it('tells whether a person types and reads', () => {
    expect(typeof deps.stdinIsTTY).toBe('boolean');
    expect(typeof deps.stdoutIsTTY).toBe('boolean');
  });

  describe('prompt', () => {
    const realStdin = process.stdin;
    let input = new PassThrough();
    let written = '';

    beforeEach(() => {
      input = new PassThrough();
      written = '';
      Object.defineProperty(process, 'stdin', { value: input, configurable: true });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written += String(chunk);
        return true;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    });

    it('writes the question to stderr and returns the line without its line break', async () => {
      const answer = createNodeDeps().prompt('Go on? [y/N] ');
      input.write('yes\nsecond line\n');
      expect(await answer).toEqual({ ok: true, value: 'yes' });
      expect(written).toContain('Go on? [y/N] ');
    });

    it('cuts a long answer to 200 characters', async () => {
      const answer = createNodeDeps().prompt('?');
      input.write(`${'a'.repeat(500)}\n`);
      expect(await answer).toEqual({ ok: true, value: 'a'.repeat(200) });
    });

    it('returns an error when the input ends with no answer', async () => {
      const answer = createNodeDeps().prompt('?');
      input.end();
      const result = await answer;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe('no answer was given');
    });
  });
});

describe('node deps: realpath', () => {
  it('resolves a link', async () => {
    const target = fresh('target');
    const link = fresh('link');
    await writeFile(target, 'x');
    await symlink(target, link);
    const result = await deps.fs.realpath(link);
    expect(result).toEqual({ ok: true, value: await realpath(target) });
  });

  it('returns an error with the code for a path that does not exist', async () => {
    const result = await deps.fs.realpath(fresh('missing'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
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

  describe('a read with a size limit', () => {
    it('reads a file that is exactly as large as the limit', async () => {
      const file = fresh('limit-exact.txt');
      await writeFile(file, 'abcde', 'utf8');
      expect(await deps.fs.readTextLimited(file, 5)).toEqual({ ok: true, value: 'abcde' });
    });

    it('fails for a file that is one byte over the limit, and says that it is too large', async () => {
      const file = fresh('limit-over.txt');
      await writeFile(file, 'abcdef', 'utf8');
      const result = await deps.fs.readTextLimited(file, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('larger than 5 bytes');
    });

    it('counts bytes and not characters', async () => {
      const file = fresh('limit-bytes.txt');
      await writeFile(file, 'ééé', 'utf8');
      expect((await deps.fs.readTextLimited(file, 5)).ok).toBe(false);
      expect(await deps.fs.readTextLimited(file, 6)).toEqual({ ok: true, value: 'ééé' });
    });

    it('returns an error with the code for a missing file', async () => {
      const result = await deps.fs.readTextLimited(fresh('limit-missing.txt'), 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('ENOENT');
    });
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

describe('node deps: owner and mode', () => {
  it('tells the kind, the owner and the permission bits of a file and of a folder', async () => {
    const file = fresh('info.txt');
    await writeFile(file, 'x', 'utf8');
    await chmod(file, 0o640);
    const uid = process.getuid?.() ?? null;
    expect(await deps.fs.statInfo(file)).toEqual({ ok: true, value: { kind: 'file', uid, mode: 0o640 } });
    await chmod(dir, 0o700);
    expect(await deps.fs.statInfo(dir)).toEqual({ ok: true, value: { kind: 'dir', uid, mode: 0o700 } });
  });

  it('gives null for a path that does not exist', async () => {
    expect(await deps.fs.statInfo(fresh('none'))).toEqual({ ok: true, value: null });
  });

  it('knows the user id of the process', () => {
    expect(deps.uid).toBe(process.getuid?.() ?? null);
  });

  it('sets the permission bits of a file and of a folder', async () => {
    const folder = fresh('chmod');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'f.txt');
    await writeFile(file, 'x', 'utf8');
    expect((await deps.fs.chmod(file, 0o600)).ok).toBe(true);
    expect((await deps.fs.chmod(folder, 0o700)).ok).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it('returns an error with the code for a path that does not exist', async () => {
    const result = await deps.fs.chmod(fresh('chmod-missing'), 0o600);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
  });
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

  it('gives a new file the mode that the caller asks for, and replaces the mode of an old file', async () => {
    const folder = fresh('given-mode');
    await deps.fs.mkdir(folder);
    const created = join(folder, 'new.json');
    expect((await deps.fs.writeTextAtomic(created, '{}', 0o600)).ok).toBe(true);
    expect((await stat(created)).mode & 0o777).toBe(0o600);

    const old = join(folder, 'old.json');
    await writeFile(old, '{}', 'utf8');
    await chmod(old, 0o644);
    expect((await deps.fs.writeTextAtomic(old, '{"a":1}', 0o600)).ok).toBe(true);
    expect((await stat(old)).mode & 0o777).toBe(0o600);
  });

  it('creates a folder with the mode that the caller asks for', async () => {
    const folder = fresh('private-folder');
    expect((await deps.fs.mkdir(folder, 0o700)).ok).toBe(true);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
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

  it('does not follow a link at the old temporary name, and leaves the link as it was', async () => {
    const folder = fresh('planted');
    await deps.fs.mkdir(folder);
    const victim = join(folder, 'victim.txt');
    const target = join(folder, 'homes.json');
    await writeFile(victim, 'victim text', 'utf8');
    await symlink(victim, `${target}.tmp-${process.pid}`);
    expect((await deps.fs.writeTextAtomic(target, 'new text', 0o600)).ok).toBe(true);
    expect(await readFile(victim, 'utf8')).toBe('victim text');
    expect(await readFile(target, 'utf8')).toBe('new text');
    expect(await readlink(`${target}.tmp-${process.pid}`)).toBe(victim);
  });

  it('does not touch a file at the old temporary name, and leaves only the target and that file', async () => {
    const folder = fresh('planted-file');
    await deps.fs.mkdir(folder);
    const target = join(folder, 'homes.json');
    const planted = `${target}.tmp-${process.pid}`;
    await writeFile(planted, 'planted text', 'utf8');
    expect((await deps.fs.writeTextAtomic(target, 'new text', 0o600)).ok).toBe(true);
    expect(await readFile(planted, 'utf8')).toBe('planted text');
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['homes.json', `homes.json.tmp-${process.pid}`] });
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
