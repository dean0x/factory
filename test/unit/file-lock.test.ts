import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { freeLock, holdsLock, takeLock, type LockPolicy } from '../../src/core/file-lock.js';
import { changePrivateFile, type PrivateChange } from '../../src/core/private-file.js';
import { err, ok } from '../../src/core/result.js';
import { privateFile } from '../../src/names.js';
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

describe('lock file: the check that the caller holds the lock', () => {
  it('M5-1b TP-197 is true when the lock file holds the token of the caller', async () => {
    const deps = fakeWithFolder();
    const token = await taken(deps);
    expect(await holdsLock(deps, LOCK_PATH, token)).toEqual({ ok: true, value: true });
  });

  it('M5-1b TP-197 is false when the lock file holds the token of another process, and the file stays', async () => {
    const deps = fakeWithFolder();
    const first = await taken(deps);
    deps.advance(POLICY.staleMs + 1);
    const second = await taken(deps);
    expect(await holdsLock(deps, LOCK_PATH, first)).toEqual({ ok: true, value: false });
    expect(deps.files.get(LOCK_PATH)).toBe(`${second}\n`);
  });

  it('M5-1b TP-197 is false when the lock file is gone', async () => {
    const deps = fakeWithFolder();
    expect(await holdsLock(deps, LOCK_PATH, 'abc')).toEqual({ ok: true, value: false });
  });

  it('M5-1b TP-197 is false for a lock path that is a link, and it does not read the target', async () => {
    const deps = fakeWithFolder({ links: { [LOCK_PATH]: '/outside/target' } });
    deps.seed('/outside/target', 'abc\n');
    expect(await holdsLock(deps, LOCK_PATH, 'abc')).toEqual({ ok: true, value: false });
  });

  it('M5-1b TP-197 gives the reason, and no answer, when the file system can not read the lock file', async () => {
    const deps = fakeWithFolder();
    const token = await taken(deps);
    const blind: Deps = { ...deps, fs: { ...deps.fs, readTextLimited: async () => failure('cannot read: EIO') } };
    expect(await holdsLock(blind, LOCK_PATH, token)).toMatchObject({ ok: false, error: expect.stringContaining('EIO') });
  });
});

const FILE = `${FOLDER}/data.json`;
const FILE_LOCK = `${FILE}${privateFile.lockSuffix}`;
const ANOTHER_TOKEN = '99-ffffffffffffffff';

/** A change that gives `text`, after it ran `during`: the step is where a test puts a take-over of the lock. */
const changeTo =
  (text: string, during: () => void = () => undefined): PrivateChange =>
  async () => {
    during();
    return ok(text);
  };

describe('private file: the check of the lock before the rename', () => {
  it('M5-1b TP-197 writes the file and frees the lock when the lock is still held', async () => {
    const deps = fakeWithFolder();
    const result = await changePrivateFile(deps, FILE, 1_000, changeTo('new\n'), { recheckLock: true });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(deps.files.get(FILE)).toBe('new\n');
    expect(deps.files.has(FILE_LOCK)).toBe(false);
  });

  it('M5-1b TP-175 writes nothing, and leaves the lock file of the other process, when another process took the lock over', async () => {
    const deps = fakeWithFolder();
    deps.seed(FILE, 'old\n');
    const result = await changePrivateFile(
      deps,
      FILE,
      1_000,
      changeTo('new\n', () => deps.files.set(FILE_LOCK, `${ANOTHER_TOKEN}\n`)),
      { recheckLock: true },
    );
    expect(result).toMatchObject({ ok: false, error: { writeState: 'not-saved', message: expect.stringContaining(FILE_LOCK) } });
    expect(deps.files.get(FILE)).toBe('old\n');
    expect(deps.files.get(FILE_LOCK)).toBe(`${ANOTHER_TOKEN}\n`);
  });

  it('M5-1b TP-175 writes nothing when the lock file is gone before the rename', async () => {
    const deps = fakeWithFolder();
    deps.seed(FILE, 'old\n');
    const result = await changePrivateFile(deps, FILE, 1_000, changeTo('new\n', () => deps.files.delete(FILE_LOCK)), {
      recheckLock: true,
    });
    expect(result).toMatchObject({ ok: false, error: { writeState: 'not-saved' } });
    expect(deps.files.get(FILE)).toBe('old\n');
  });

  it('M5-1b TP-175 writes nothing when the check can not read the lock file', async () => {
    const deps = fakeWithFolder();
    deps.seed(FILE, 'old\n');
    let reads = 0;
    const blind: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        // The first read is the file itself. The check reads the lock file after it.
        readTextLimited: async (path, max) => {
          reads += 1;
          return path === FILE_LOCK && reads > 1 ? failure('cannot read: EIO') : deps.fs.readTextLimited(path, max);
        },
      },
    };
    const result = await changePrivateFile(blind, FILE, 1_000, changeTo('new\n'), { recheckLock: true });
    expect(result).toMatchObject({ ok: false, error: { writeState: 'not-saved', message: expect.stringContaining('EIO') } });
    expect(deps.files.get(FILE)).toBe('old\n');
  });

  it('M5-1b TP-175 keeps the old behaviour with no option: the write goes ahead after a take-over', async () => {
    const deps = fakeWithFolder();
    const result = await changePrivateFile(
      deps,
      FILE,
      1_000,
      changeTo('new\n', () => deps.files.set(FILE_LOCK, `${ANOTHER_TOKEN}\n`)),
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(deps.files.get(FILE)).toBe('new\n');
    expect(deps.files.get(FILE_LOCK)).toBe(`${ANOTHER_TOKEN}\n`);
  });
});

describe('private file: the typed outcome of a failed change', () => {
  it('M5-1b TP-180 says saved-lock-left when the change is saved and only the lock file stays', async () => {
    const deps = fakeWithFolder();
    const stuck: Deps = { ...deps, fs: { ...deps.fs, remove: async () => failure('cannot remove: EBUSY') } };
    const result = await changePrivateFile(stuck, FILE, 1_000, changeTo('new\n'));
    expect(result).toMatchObject({
      ok: false,
      error: { writeState: 'saved-lock-left', message: expect.stringContaining(FILE_LOCK) },
    });
    expect(deps.files.get(FILE)).toBe('new\n');
  });

  it('M5-1b TP-180 says saved-lock-left also with the check before the rename', async () => {
    const deps = fakeWithFolder();
    const stuck: Deps = { ...deps, fs: { ...deps.fs, remove: async () => failure('cannot remove: EBUSY') } };
    const result = await changePrivateFile(stuck, FILE, 1_000, changeTo('new\n'), { recheckLock: true });
    expect(result).toMatchObject({ ok: false, error: { writeState: 'saved-lock-left' } });
  });

  it('M5-1b TP-180 says not-saved when the change gives an error, and the file stays as it is', async () => {
    const deps = fakeWithFolder();
    deps.seed(FILE, 'old\n');
    const result = await changePrivateFile(deps, FILE, 1_000, async () => err('the text is not valid'));
    expect(result).toEqual({ ok: false, error: { writeState: 'not-saved', message: 'the text is not valid' } });
    expect(deps.files.get(FILE)).toBe('old\n');
    expect(deps.files.has(FILE_LOCK)).toBe(false);
  });

  it('M5-1b TP-180 says not-saved when the lock stays with another process for all tries', async () => {
    const deps = fakeWithFolder();
    deps.seed(FILE_LOCK, `${ANOTHER_TOKEN}\n`);
    const result = await changePrivateFile(deps, FILE, 1_000, changeTo('new\n'));
    expect(result).toMatchObject({ ok: false, error: { writeState: 'not-saved', message: expect.stringContaining(FILE_LOCK) } });
    expect(deps.files.has(FILE)).toBe(false);
  });

  it('M5-1b TP-180 says not-saved when the file system can not write the file', async () => {
    const deps = fakeWithFolder();
    const full: Deps = { ...deps, fs: { ...deps.fs, writeTextAtomic: async () => failure('cannot write: ENOSPC') } };
    const result = await changePrivateFile(full, FILE, 1_000, changeTo('new\n'));
    expect(result).toMatchObject({ ok: false, error: { writeState: 'not-saved', message: expect.stringContaining('ENOSPC') } });
    expect(deps.files.has(FILE_LOCK)).toBe(false);
  });
});
