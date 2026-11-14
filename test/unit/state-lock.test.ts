import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { ok } from '../../src/core/result.js';
import { stateLock } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { withStateLock } from '../../src/state/state-lock.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const HOME = '/h/node';
const LAYOUT = layoutOf(HOME);
const LOCK_FILE = `${LAYOUT.locksDir}/${stateLock.name}${stateLock.lock.suffix}`;
const WAITS = Array.from({ length: stateLock.lock.attempts - 1 }, () => stateLock.lock.waitMs);

const fake = (options: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => {
  const deps = createFakeDeps(options);
  deps.seedDir(LAYOUT.stateDir);
  return deps;
};

const errorOf = <T>(result: CliResult<T>) => {
  if (result.ok) throw new Error('the call worked');
  return result.error;
};

describe('the state lock: one writer', () => {
  it('runs the work with the lock file in the locks folder of the state folder, and removes the lock file after it', async () => {
    const deps = fake();
    let seen: string[] = [];
    const result = await withStateLock(deps, LAYOUT, async () => {
      seen = [...deps.files.keys()];
      return ok('done');
    });
    expect(result).toEqual({ ok: true, value: 'done' });
    expect(seen).toEqual([LOCK_FILE]);
    expect(deps.files.size).toBe(0);
    expect(deps.modes.get(LOCK_FILE)).toBe(stateLock.fileMode);
  });

  it('removes the lock file when the work gives a failure, and gives that failure', async () => {
    const deps = fake();
    const result = await withStateLock(deps, LAYOUT, async () => failure('the work failed'));
    expect(errorOf(result).message).toBe('the work failed');
    expect(deps.files.size).toBe(0);
  });

  it('refuses a locks folder that is a link, with exit 4, and does not run the work', async () => {
    const deps = fake({ links: { [LAYOUT.locksDir]: '/outside' } });
    deps.seedDir(LAYOUT.locksDir);
    deps.seedDir('/outside');
    let ran = false;
    const result = await withStateLock(deps, LAYOUT, async () => {
      ran = true;
      return ok('done');
    });
    expect(exitCodeOf[errorOf(result).kind]).toBe(4);
    expect(ran).toBe(false);
    expect(deps.files.size).toBe(0);
  });
});

describe('the state lock: two writers at once', () => {
  it('lets the second writer wait for the first, then run after it', async () => {
    const deps = fake();
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = withStateLock(deps, LAYOUT, async () => {
      order.push('first starts');
      started();
      await gate;
      order.push('first ends');
      return ok('first');
    });
    await firstHolds;
    // The wait of the second writer ends when the first writer has finished.
    const waiting: Deps = {
      ...deps,
      sleep: async (ms) => {
        await deps.sleep(ms);
        release();
        await first;
      },
    };
    const second = await withStateLock(waiting, LAYOUT, async () => {
      order.push('second runs');
      return ok('second');
    });
    expect(second).toEqual({ ok: true, value: 'second' });
    expect(await first).toEqual({ ok: true, value: 'first' });
    expect(order).toEqual(['first starts', 'first ends', 'second runs']);
    expect(deps.sleeps).toEqual([stateLock.lock.waitMs]);
    expect(deps.files.size).toBe(0);
  });

  it('stops the second writer at the bound with exit 1 and the lock path, runs no work, and keeps the lock of the first', async () => {
    const deps = fake();
    deps.seed(LOCK_FILE, '1\n');
    let ran = false;
    const result = await withStateLock(deps, LAYOUT, async () => {
      ran = true;
      return ok('done');
    });
    const error = errorOf(result);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(LOCK_FILE);
    expect(ran).toBe(false);
    expect(deps.sleeps).toEqual(WAITS);
    expect([...deps.files.entries()]).toEqual([[LOCK_FILE, '1\n']]);
  });

  it('takes over a lock that is older than the stale age, which a process that ended left', async () => {
    const deps = fake();
    deps.seed(LOCK_FILE, '1\n');
    deps.mtimes.set(LOCK_FILE, deps.now().getTime() - stateLock.lock.staleMs - 1);
    expect(await withStateLock(deps, LAYOUT, async () => ok('done'))).toEqual({ ok: true, value: 'done' });
    expect(deps.files.size).toBe(0);
  });

  it('never takes over the lock of a writer that is still inside the longest wait of another writer', () => {
    expect(stateLock.lock.staleMs).toBeGreaterThan(stateLock.lock.attempts * stateLock.lock.waitMs);
  });
});

describe('the state lock: with the real file system', () => {
  const deps = createNodeDeps();
  let home = '';

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'state-lock-'));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lets one writer at a time read and change a file of the state folder, so five writers lose no write', async () => {
    const layout = layoutOf(home);
    await mkdir(layout.stateDir, { recursive: true });
    const counter = join(layout.stateDir, 'counter.txt');
    await writeFile(counter, '0', 'utf8');
    const countUp = async (): Promise<CliResult<void>> => {
      const count = Number(await readFile(counter, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 2));
      await writeFile(counter, `${count + 1}`, 'utf8');
      return ok(undefined);
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => withStateLock(deps, layout, countUp)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await readFile(counter, 'utf8')).toBe('5');
    expect(await readdir(layout.locksDir)).toEqual([]);
  });
});
