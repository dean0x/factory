import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { freeLock, holdsLock, holderStateOf, takeLock, type LivenessInput, type LockPolicy } from '../../src/core/file-lock.js';
import { changePrivateFile, type PrivateChange } from '../../src/core/private-file.js';
import { err, ok } from '../../src/core/result.js';
import { privateFile } from '../../src/names.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
import { psStarts } from '../helpers/ps-fake.js';

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
    const stuck: Deps = { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove: EBUSY') } };
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

const OWN_PID = 4242;
const OWN_START = Date.UTC(2030, 0, 1);
const HOLDER_PID = 777;
const OTHER_PID = 888;
const HOLDER_START = Date.UTC(2029, 11, 31);
const HEX = '0123456789abcdef';
const CLAIM_PATH = `${LOCK_PATH}${POLICY.takeoverSuffix}`;
const LIVE: LockPolicy = { ...POLICY, staleMs: 60_000, liveness: { startToleranceMs: 3_000 } };
const DAY_MS = 86_400_000;

const holderText = (pid: number, startMs: number): string => `${pid}-${startMs}-${HEX}\n`;

const liveInput = (): LivenessInput => ({ ownStartMs: OWN_START, startCache: new Map() });
const takeLive = (deps: Deps, input: LivenessInput = liveInput(), policy: LockPolicy = LIVE) =>
  takeLock(deps, LOCK_PATH, policy, input);
const psCalls = (deps: FakeDeps) => deps.calls.filter((call) => call.command === 'ps');
const withRunning = (deps: FakeDeps, isRunning: Deps['isRunning']): Deps => ({ ...deps, isRunning });

/** A fake with a lock file of a holder that runs. `observedStart` is the start that `ps` reports for it: the token holds `HOLDER_START`. */
const holderLockedFake = (observedStart = HOLDER_START): FakeDeps => {
  const deps = fakeWithFolder({ run: psStarts({ [HOLDER_PID]: observedStart }) });
  deps.seed(LOCK_PATH, holderText(HOLDER_PID, HOLDER_START));
  return deps;
};

describe('lock file: the liveness of the holder', () => {
  it('writes a token with the pid, the own start and 16 hex digits', async () => {
    const deps = fakeWithFolder();
    const result = await takeLive(deps);
    expect(result).toMatchObject({ ok: true, value: { kind: 'taken' } });
    expect(deps.files.get(LOCK_PATH)).toMatch(new RegExp(`^${OWN_PID}-${OWN_START}-[0-9a-f]{16}\\n$`));
  });

  it('never takes over a lock whose holder runs, also when the lock file is older than any age limit', async () => {
    const deps = holderLockedFake();
    deps.advance(10 * DAY_MS);
    expect(await takeLive(deps)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.files.get(LOCK_PATH)).toBe(holderText(HOLDER_PID, HOLDER_START));
    expect(deps.terminated).toEqual([]);
  });

  it('keeps a live holder when the start read moves the clock by 4 s, and takes nothing', async () => {
    const starts = psStarts({ [HOLDER_PID]: HOLDER_START });
    const deps: FakeDeps = fakeWithFolder({
      run: (call) => {
        deps.advance(4_000);
        return starts(call);
      },
    });
    deps.seed(LOCK_PATH, holderText(HOLDER_PID, HOLDER_START));
    expect(await takeLive(deps)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.files.get(LOCK_PATH)).toBe(holderText(HOLDER_PID, HOLDER_START));
  });

  it('takes over a lock whose holder pid is gone, and signals no process', async () => {
    const deps = holderLockedFake();
    const result = await takeLive(withRunning(deps, (pid) => ok(pid !== HOLDER_PID)));
    expect(result).toMatchObject({ ok: true, value: { kind: 'taken' } });
    expect(deps.files.get(LOCK_PATH)).toMatch(new RegExp(`^${OWN_PID}-${OWN_START}-`));
    expect(deps.terminated).toEqual([]);
  });

  it('takes a stale lock in the same try: one attempt is enough, and no wait comes before the take', async () => {
    const deps = holderLockedFake();
    const once: LockPolicy = { ...LIVE, attempts: 1 };
    const result = await takeLive(withRunning(deps, (pid) => ok(pid !== HOLDER_PID)), liveInput(), once);
    expect(result).toMatchObject({ ok: true, value: { kind: 'taken' } });
    expect(deps.files.get(LOCK_PATH)).toMatch(new RegExp(`^${OWN_PID}-${OWN_START}-`));
    expect(deps.files.has(CLAIM_PATH)).toBe(false);
    expect(deps.sleeps).toEqual([]);
  });

  it('takes a lock that is stale by age in the same try, for a policy with no liveness', async () => {
    const deps = holderLockedFake();
    deps.advance(POLICY.staleMs + 1);
    const result = await takeLock(deps, LOCK_PATH, { ...POLICY, attempts: 1 });
    expect(result).toMatchObject({ ok: true, value: { kind: 'taken' } });
    expect(deps.sleeps).toEqual([]);
  });

  it('ends the try as held when another waiter makes the lock between the removal and the second create', async () => {
    const deps = holderLockedFake();
    const racing = withRunning(deps, (pid) => ok(pid !== HOLDER_PID));
    const remove = deps.fs.removeFile;
    const taker: Deps = {
      ...racing,
      fs: {
        ...racing.fs,
        removeFile: async (path) => {
          const removed = await remove(path);
          if (path === LOCK_PATH) deps.seed(LOCK_PATH, holderText(OTHER_PID, HOLDER_START));
          return removed;
        },
      },
    };
    const result = await takeLive(taker, liveInput(), { ...LIVE, attempts: 1 });
    expect(result).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.files.get(LOCK_PATH)).toBe(holderText(OTHER_PID, HOLDER_START));
  });

  it.each([
    ['later by the tolerance', 3_000, 'held'],
    ['earlier by the tolerance', -3_000, 'held'],
    // The start that ps prints has 1 s resolution, so the next value above the tolerance is 4 s.
    ['later by more than the tolerance', 4_000, 'taken'],
    ['earlier by more than the tolerance', -4_000, 'taken'],
  ])('with a start that the system reads %s, the result is %s', async (_name, offsetMs, kind) => {
    const deps = holderLockedFake(HOLDER_START + offsetMs);
    expect(await takeLive(deps)).toMatchObject({ ok: true, value: { kind } });
  });

  it('gives a stale lock to exactly one of two waiters', async () => {
    const deps = fakeWithFolder({ run: psStarts({ 11: OWN_START, 12: OWN_START }) });
    deps.seed(LOCK_PATH, holderText(HOLDER_PID, HOLDER_START));
    const waiter = (pid: number): Deps => withRunning({ ...deps, pid }, (other) => ok(other !== HOLDER_PID));
    const results = await Promise.all([takeLive(waiter(11)), takeLive(waiter(12))]);
    expect(results.map((result) => (result.ok ? result.value.kind : 'error')).sort()).toEqual(['held', 'taken']);
  });

  it.each([
    ['an empty file', ''],
    ['text that is no token', 'abc\n'],
    ['a token with no start', `${HOLDER_PID}-${HEX}\n`],
    ['a file over the byte cap', `${'x'.repeat(300)}\n`],
  ])('counts %s as a live holder while it is younger than the claim age, and as stale after, with one warn line', async (_name, text) => {
    const deps = fakeWithFolder();
    deps.seed(LOCK_PATH, text);
    deps.advance(59_000);
    expect(await takeLive(deps)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.warned).toEqual([]);
    expect(deps.files.get(LOCK_PATH)).toBe(text);

    deps.advance(2_000);
    expect(await takeLive(deps)).toMatchObject({ ok: true, value: { kind: 'taken' } });
    expect(deps.warned).toEqual([expect.stringContaining(LOCK_PATH)]);
  });

  it('counts a holder as live when the running check gives an error', async () => {
    const deps = holderLockedFake();
    deps.advance(10 * DAY_MS);
    const blind = withRunning(deps, () => failure('cannot signal the process 777: EPERM'));
    expect(await takeLive(blind)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.files.get(LOCK_PATH)).toBe(holderText(HOLDER_PID, HOLDER_START));
  });

  it('counts a holder as live when the start read fails', async () => {
    const deps = fakeWithFolder({ run: psStarts({}) });
    deps.seed(LOCK_PATH, holderText(HOLDER_PID, HOLDER_START));
    deps.advance(10 * DAY_MS);
    expect(await takeLive(deps)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.files.get(LOCK_PATH)).toBe(holderText(HOLDER_PID, HOLDER_START));
  });

  it('reads the start once for each holder token over a long wait, and checks that the holder runs on each try', async () => {
    const deps = holderLockedFake();
    const input = liveInput();
    const patient: LockPolicy = { ...LIVE, attempts: 5 };
    expect(await takeLive(deps, input, patient)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(psCalls(deps)).toHaveLength(1);
    expect(deps.checked.filter((pid) => pid === HOLDER_PID)).toHaveLength(5);
  });

  it('reads the start again for a new holder token, and once for it', async () => {
    const deps = fakeWithFolder({ run: psStarts({ [HOLDER_PID]: HOLDER_START, [OTHER_PID]: HOLDER_START }) });
    const input = liveInput();
    deps.seed(LOCK_PATH, holderText(HOLDER_PID, HOLDER_START));
    await takeLive(deps, input);
    deps.seed(LOCK_PATH, holderText(OTHER_PID, HOLDER_START));
    await takeLive(deps, input);
    await takeLive(deps, input);
    expect(psCalls(deps).map((call) => call.args[3])).toEqual([String(HOLDER_PID), String(OTHER_PID)]);
  });

  it('keeps the age rule, and the old token form, for a policy with no liveness', async () => {
    const deps = holderLockedFake();
    deps.advance(POLICY.staleMs + 1);
    const result = await takeLock(deps, LOCK_PATH, POLICY);
    expect(result).toMatchObject({ ok: true, value: { kind: 'taken' } });
    expect(psCalls(deps)).toHaveLength(0);
    expect(deps.files.get(LOCK_PATH)).toMatch(new RegExp(`^${OWN_PID}-[0-9a-f]{16}\\n$`));
  });

  it('counts a lock of its own pid and own start as live, with no running check', async () => {
    const deps = fakeWithFolder();
    deps.seed(LOCK_PATH, holderText(OWN_PID, OWN_START));
    deps.advance(10 * DAY_MS);
    expect(await takeLive(deps)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.checked).toEqual([]);
  });

  it('takes over a lock of its own pid with another start, as a pid that came back', async () => {
    const deps = fakeWithFolder();
    deps.seed(LOCK_PATH, holderText(OWN_PID, OWN_START - 3_001));
    expect(await takeLive(deps)).toMatchObject({ ok: true, value: { kind: 'taken' } });
  });

  it('removes a claim file older than the stale age, and takes the stale lock', async () => {
    const deps = holderLockedFake();
    deps.seed(CLAIM_PATH, '1\n');
    deps.advance(LIVE.staleMs + 1);
    const result = await takeLive(withRunning(deps, (pid) => ok(pid !== HOLDER_PID)));
    expect(result).toMatchObject({ ok: true, value: { kind: 'taken' } });
    expect(deps.files.has(CLAIM_PATH)).toBe(false);
  });

  it('leaves a claim file younger than the stale age, and the stale lock stays', async () => {
    const deps = holderLockedFake();
    deps.seed(CLAIM_PATH, '1\n');
    const result = await takeLive(withRunning(deps, (pid) => ok(pid !== HOLDER_PID)));
    expect(result).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.files.get(LOCK_PATH)).toBe(holderText(HOLDER_PID, HOLDER_START));
    expect(deps.files.has(CLAIM_PATH)).toBe(true);
  });

  it('leaves a lock that another process took over while the check of the holder ran', async () => {
    const deps = fakeWithFolder({ run: psStarts({ [OTHER_PID]: HOLDER_START }) });
    deps.seed(LOCK_PATH, holderText(HOLDER_PID, HOLDER_START));
    const racing = withRunning(deps, (pid) => {
      if (pid !== HOLDER_PID) return ok(true);
      deps.advance(5);
      deps.seed(LOCK_PATH, holderText(OTHER_PID, HOLDER_START));
      return ok(false);
    });
    expect(await takeLive(racing)).toEqual({ ok: true, value: { kind: 'held' } });
    expect(deps.files.get(LOCK_PATH)).toBe(holderText(OTHER_PID, HOLDER_START));
  });

  it('takes no lock when the policy asks for liveness and the caller gives no start', async () => {
    const deps = fakeWithFolder();
    expect(await takeLock(deps, LOCK_PATH, LIVE)).toMatchObject({ ok: false, error: expect.stringContaining('start') });
    expect(deps.files.size).toBe(0);
  });

  it.each([Number.NaN, -1, 1.5, 1e15])('takes no lock for an own start of %s', async (ownStartMs) => {
    const deps = fakeWithFolder();
    const result = await takeLive(deps, { ownStartMs, startCache: new Map() });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('start') });
    expect(deps.files.size).toBe(0);
  });
});

describe('lock file: a folder at a path of the lock', () => {
  const INSIDE = 'keep\n';

  /** A fake with a folder at `path` that holds one file. The folder is older than the stale age of `policy`. */
  const staleFolderFake = (path: string, policy: LockPolicy): FakeDeps => {
    const deps = fakeWithFolder();
    deps.seed(`${path}/inside.txt`, INSIDE);
    deps.mtimes.set(path, deps.now().getTime());
    deps.advance(policy.staleMs + 1);
    return deps;
  };

  it.each([
    ['the age rule', POLICY],
    ['the liveness rule', LIVE],
  ])('keeps a stale folder at the lock path, and all it holds, with %s, and takes no lock', async (_name, policy) => {
    const deps = staleFolderFake(LOCK_PATH, policy);
    const result = await takeLock(deps, LOCK_PATH, policy, liveInput());
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(LOCK_PATH) });
    expect(deps.dirs.has(LOCK_PATH)).toBe(true);
    expect(deps.files.get(`${LOCK_PATH}/inside.txt`)).toBe(INSIDE);
    expect(deps.files.has(CLAIM_PATH)).toBe(false);
  });

  it('keeps a stale folder at the claim path, and all it holds, and takes no lock', async () => {
    const deps = staleFolderFake(CLAIM_PATH, POLICY);
    deps.seed(LOCK_PATH, '1\n');
    deps.mtimes.set(LOCK_PATH, deps.now().getTime() - POLICY.staleMs - 1);
    const result = await takeLock(deps, LOCK_PATH, POLICY);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(CLAIM_PATH) });
    expect(deps.files.get(`${CLAIM_PATH}/inside.txt`)).toBe(INSIDE);
    expect(deps.files.get(LOCK_PATH)).toBe('1\n');
  });
});

const FILE = `${FOLDER}/data.json`;
const FILE_LOCK =`${FILE}${privateFile.lockSuffix}`;
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
    const stuck: Deps = { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove: EBUSY') } };
    const result = await changePrivateFile(stuck, FILE, 1_000, changeTo('new\n'));
    expect(result).toMatchObject({
      ok: false,
      error: { writeState: 'saved-lock-left', message: expect.stringContaining(FILE_LOCK) },
    });
    expect(deps.files.get(FILE)).toBe('new\n');
  });

  it('M5-1b TP-180 says saved-lock-left also with the check before the rename', async () => {
    const deps = fakeWithFolder();
    const stuck: Deps = { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove: EBUSY') } };
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

describe('lock file: the state of the holder in a text', () => {
  const stateOf = (deps: Deps, text: string) => holderStateOf(deps, text, LIVE.liveness ?? { startToleranceMs: 0 }, liveInput());

  it('says live for a holder that runs with the recorded start, and ended when it does not run or runs with another start', async () => {
    const text = holderText(HOLDER_PID, HOLDER_START);
    expect(await stateOf(holderLockedFake(), text)).toBe('live');
    expect(await stateOf(withRunning(holderLockedFake(), () => ok(false)), text)).toBe('ended');
    expect(await stateOf(holderLockedFake(HOLDER_START + 4_000), text)).toBe('ended');
  });

  it.each([[''], ['not a token\n'], [`${HOLDER_PID}-${HOLDER_START}`]])('says invalid for the text %j, and touches nothing', async (text) => {
    const deps = holderLockedFake();
    expect(await stateOf(deps, text)).toBe('invalid');
    expect([...deps.files.keys()]).toEqual([LOCK_PATH]);
    expect(deps.terminated).toEqual([]);
  });
});
