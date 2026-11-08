import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { freeLock, takeLock, type LockPolicy } from '../../src/core/file-lock.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const FOLDER = '/h/state';
const LOCK_PATH = `${FOLDER}/entry.lock`;
const POLICY: LockPolicy = { attempts: 3, waitMs: 10, staleMs: 1_000, takeoverSuffix: '.takeover', mode: 0o600 };

const fakeWithFolder = (options: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => {
  const deps = createFakeDeps(options);
  deps.seedDir(FOLDER);
  return deps;
};

/** Take the lock and give the token of the taker. A take that does not end in `taken` is a fault of the test. */
const taken = async (deps: Deps): Promise<string> => {
  const result = await takeLock(deps, LOCK_PATH, POLICY);
  if (!result.ok || result.value.kind !== 'taken') throw new Error('the lock should be taken');
  return result.value.token;
};

describe('lock file: the token of the owner', () => {
  it('writes the token of the taker into the lock file', async () => {
    const deps = fakeWithFolder();
    const token = await taken(deps);
    expect(deps.files.get(LOCK_PATH)).toBe(`${token}\n`);
  });

  it('gives the token of its own to a taker that takes over a stale lock, also when the pid is the same', async () => {
    const deps = fakeWithFolder();
    const first = await taken(deps);
    deps.advance(POLICY.staleMs + 1);
    const second = await taken(deps);
    expect(second).not.toBe(first);
    expect(deps.files.get(LOCK_PATH)).toBe(`${second}\n`);
  });

  it('takes no lock, and makes no lock file, when the random source fails', async () => {
    const deps = fakeWithFolder();
    const blind: Deps = { ...deps, randomHex: () => failure('cannot make random text') };
    const result = await takeLock(blind, LOCK_PATH, POLICY);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('random') });
    expect(deps.files.size).toBe(0);
  });
});

describe('lock file: freeing the lock', () => {
  it('removes the lock file when it holds the token of the caller', async () => {
    const deps = fakeWithFolder();
    const token = await taken(deps);
    expect(await freeLock(deps, LOCK_PATH, token)).toEqual({ ok: true, value: undefined });
    expect(deps.files.size).toBe(0);
  });

  it('leaves the lock file, and gives no error, when it holds the token of another process', async () => {
    const deps = fakeWithFolder();
    const first = await taken(deps);
    deps.advance(POLICY.staleMs + 1);
    const second = await taken(deps);
    expect(await freeLock(deps, LOCK_PATH, first)).toEqual({ ok: true, value: undefined });
    expect(deps.files.get(LOCK_PATH)).toBe(`${second}\n`);
    expect(await freeLock(deps, LOCK_PATH, second)).toEqual({ ok: true, value: undefined });
    expect(deps.files.size).toBe(0);
  });

  it('leaves a lock file with text that is no token of the caller, and gives no error', async () => {
    const deps = fakeWithFolder();
    deps.seed(LOCK_PATH, '1\n');
    expect(await freeLock(deps, LOCK_PATH, 'abc')).toEqual({ ok: true, value: undefined });
    expect(deps.files.get(LOCK_PATH)).toBe('1\n');
  });

  it('gives no error when the lock file is gone', async () => {
    const deps = fakeWithFolder();
    expect(await freeLock(deps, LOCK_PATH, 'abc')).toEqual({ ok: true, value: undefined });
  });

  it('leaves a lock path that is a link, and does not read the target', async () => {
    const deps = fakeWithFolder({ links: { [LOCK_PATH]: '/outside/target' } });
    deps.seed('/outside/target', 'abc\n');
    expect(await freeLock(deps, LOCK_PATH, 'abc')).toEqual({ ok: true, value: undefined });
    expect(deps.files.get('/outside/target')).toBe('abc\n');
  });

  it('gives the reason when the file system can not remove the lock file of the caller', async () => {
    const deps = fakeWithFolder();
    const token = await taken(deps);
    const stuck: Deps = { ...deps, fs: { ...deps.fs, remove: async () => failure('cannot remove: EBUSY') } };
    expect(await freeLock(stuck, LOCK_PATH, token)).toMatchObject({ ok: false, error: expect.stringContaining('EBUSY') });
    expect(deps.files.get(LOCK_PATH)).toBe(`${token}\n`);
  });
});
