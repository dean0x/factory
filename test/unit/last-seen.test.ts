import { describe, expect, it } from 'vitest';
import { failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { eventState, hookNames, lastSeen, schemaIds, type HookEvent } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import {
  parsePercent,
  promptStateOf,
  readLastSeen,
  readWorkerLastSeen,
  writeLastSeen,
  writeWorkerSession,
  type LastSeen,
  type LastSeenRead,
} from '../../src/workers/last-seen.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const HOME = '/h/node';
const ID = 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc';
const FOLDER = layoutOf(HOME).heartbeatDir;
const FILE = `${FOLDER}/${ID}`;
const T0 = '2030-01-02T03:04:05.678Z';
const T1 = '2030-01-02T03:05:05.678Z';
const MINUTE = 60_000;

const event = (name: HookEvent) => ({ kind: 'event', event: name }) as const;
const percent = (value: number | null) => ({ kind: 'percent', percent: value }) as const;

/** The line as the file holds it. The keys are written out here, so a test pins the format that a reader of the file sees. */
const line = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: schemaIds.lastSeen,
  session_id: ID,
  event: null,
  event_at: null,
  context_pct: null,
  pct_at: null,
  ...fields,
});

const seedLine = (deps: FakeDeps, fields: Record<string, unknown> = {}): void => deps.seed(FILE, `${JSON.stringify(line(fields))}\n`);

const storedLine = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(FILE) ?? 'null');

const readValue = async (deps: Deps, id = ID): Promise<LastSeenRead> => {
  const result = await readLastSeen(deps, HOME, id);
  if (!result.ok) throw new Error(`the read failed: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): { kind: string; message: string } => {
  if (result.ok) throw new Error('the call should have failed');
  return result.error;
};

const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');

describe('the names of the last-seen line', () => {
  it('puts the file in the heartbeat folder below the run-time folder, named by the session id', () => {
    expect(FOLDER).toBe('/h/node/.factory/state/heartbeat');
  });

  it('lists the four events of the hook', () => {
    expect([...hookNames.events]).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact']);
  });
});

describe('parsePercent', () => {
  it.each([null, undefined, 'x', '42', {}, [], true, Number.NaN])('means no percent for %j', (value) => {
    expect(parsePercent(value)).toEqual({ ok: true, value: null });
  });

  it.each([0, 1, 42, 42.5, 100])('keeps the number %j', (value) => {
    expect(parsePercent(value)).toEqual({ ok: true, value });
  });

  it.each([101, -1, -0.1, 100.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('refuses %j, outside 0-100', (value) => {
    const error = errorOf(parsePercent(value));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('0-100');
  });
});

describe('writeLastSeen', () => {
  it('writes the first hook event with no percent', async () => {
    const deps = createFakeDeps();
    const result = await writeLastSeen(deps, HOME, ID, event('SessionStart'));
    expect(result.ok).toBe(true);
    expect(storedLine(deps)).toEqual(line({ event: 'SessionStart', event_at: T0 }));
    expect(deps.files.get(FILE)?.endsWith('}\n')).toBe(true);
    expect(deps.files.get(FILE)?.trimEnd()).not.toContain('\n');
  });

  it('writes the first status line percent with no event', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, percent(42));
    expect(storedLine(deps)).toEqual(line({ context_pct: 42, pct_at: T0 }));
  });

  it('returns the line that it wrote', async () => {
    const deps = createFakeDeps();
    const result = await writeLastSeen(deps, HOME, ID, event('Stop'));
    expect(result).toEqual({ ok: true, value: line({ event: 'Stop', event_at: T0 }) });
  });

  it('keeps the stored percent and its time when a hook event comes (TP-7)', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, percent(42));
    deps.advance(MINUTE);
    await writeLastSeen(deps, HOME, ID, event('Stop'));
    expect(storedLine(deps)).toEqual(line({ event: 'Stop', event_at: T1, context_pct: 42, pct_at: T0 }));
  });

  it('keeps the stored event and its time when a status line percent comes (TP-7)', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, event('Stop'));
    deps.advance(MINUTE);
    await writeLastSeen(deps, HOME, ID, percent(55));
    expect(storedLine(deps)).toEqual(line({ event: 'Stop', event_at: T0, context_pct: 55, pct_at: T1 }));
  });

  it('replaces the stored event and keeps the percent over a run of changes', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, event('SessionStart'));
    await writeLastSeen(deps, HOME, ID, percent(10));
    deps.advance(MINUTE);
    await writeLastSeen(deps, HOME, ID, event('UserPromptSubmit'));
    await writeLastSeen(deps, HOME, ID, event('PreCompact'));
    expect(storedLine(deps)).toEqual(line({ event: 'PreCompact', event_at: T1, context_pct: 10, pct_at: T0 }));
  });

  it('clears the stored percent when the status line has none, and keeps the event', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, event('Stop'));
    await writeLastSeen(deps, HOME, ID, percent(42));
    deps.advance(MINUTE);
    await writeLastSeen(deps, HOME, ID, percent(null));
    expect(storedLine(deps)).toEqual(line({ event: 'Stop', event_at: T0 }));
  });

  it.each([0, 100])('writes the percent %j at the edge of the range', async (value) => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, percent(value));
    expect(storedLine(deps)).toEqual(line({ context_pct: value, pct_at: T0 }));
  });

  it.each([101, -1, Number.NaN, Number.POSITIVE_INFINITY])('writes nothing for the percent %j (TP-8)', async (value) => {
    const deps = createFakeDeps();
    expect(errorOf(await writeLastSeen(deps, HOME, ID, percent(value))).kind).toBe('failure');
    expect(deps.files.size).toBe(0);
    expect(deps.dirs.has(FOLDER)).toBe(false);
  });

  it('keeps the stored line when the new percent is outside 0-100', async () => {
    const deps = createFakeDeps();
    seedLine(deps, { event: 'Stop', event_at: T0 });
    const before = snapshot(deps);
    expect(errorOf(await writeLastSeen(deps, HOME, ID, percent(101))).kind).toBe('failure');
    expect(snapshot(deps)).toBe(before);
  });

  it('writes nothing for an event that is not on the list', async () => {
    const deps = createFakeDeps();
    const result = await writeLastSeen(deps, HOME, ID, event('Bogus' as HookEvent));
    expect(errorOf(result).kind).toBe('failure');
    expect(deps.files.size).toBe(0);
  });

  it.each(['', 'abc', '../escape', `${ID}x`, `${ID}\n`, ID.toUpperCase(), ID.replaceAll('-', ''), `${FOLDER}/${ID}`])(
    'writes nothing for the session id %j, which is not a UUID',
    async (id) => {
      const deps = createFakeDeps();
      const result = await writeLastSeen(deps, HOME, id, event('Stop'));
      expect(errorOf(result).kind).toBe('failure');
      expect(deps.files.size).toBe(0);
      expect(deps.dirs.has(FOLDER)).toBe(false);
    },
  );

  it('starts again when the stored line is not valid', async () => {
    const deps = createFakeDeps();
    deps.seed(FILE, 'not json at all');
    await writeLastSeen(deps, HOME, ID, event('Stop'));
    expect(storedLine(deps)).toEqual(line({ event: 'Stop', event_at: T0 }));
  });

  it('writes with the safe write and never with the atomic write of the file system', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, event('Stop'));
    expect(deps.atomicWrites).toEqual([]);
    expect([...deps.files.keys()]).toEqual([FILE]);
  });

  it('holds only the six keys, and no path of a transcript', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, event('Stop'));
    await writeLastSeen(deps, HOME, ID, percent(7));
    expect(Object.keys(storedLine(deps) as object).sort()).toEqual(
      ['context_pct', 'event', 'event_at', 'pct_at', 'schema', 'session_id'],
    );
    expect(deps.files.get(FILE)).not.toContain('transcript');
  });

  it('fails, and writes nothing, when the stored line can not be read', async () => {
    const deps = createFakeDeps();
    seedLine(deps, { event: 'Stop', event_at: T0 });
    const before = snapshot(deps);
    const broken: Deps = { ...deps, fs: { ...deps.fs, lstat: async () => failure('cannot stat: EIO') } };
    expect(errorOf(await writeLastSeen(broken, HOME, ID, percent(5))).message).toContain('EIO');
    expect(snapshot(deps)).toBe(before);
  });

  describe('a link (TP-11)', () => {
    it('refuses a heartbeat folder that is a link, and keeps the folder behind it', async () => {
      const deps = createFakeDeps({ links: { [FOLDER]: '/outside' } });
      deps.seed(`/outside/${ID}`, 'victim');
      deps.seedDir(FOLDER);
      const before = snapshot(deps);
      const error = errorOf(await writeLastSeen(deps, HOME, ID, event('Stop')));
      expect(error.kind).toBe('safety');
      expect(snapshot(deps)).toBe(before);
      expect(deps.files.get(`/outside/${ID}`)).toBe('victim');
    });

    it('refuses a last-seen file that is a link, and keeps its target', async () => {
      const deps = createFakeDeps({ links: { [FILE]: '/outside/target' } });
      deps.seedDir(FOLDER);
      deps.seed('/outside/target', 'victim');
      const before = snapshot(deps);
      const error = errorOf(await writeLastSeen(deps, HOME, ID, percent(30)));
      expect(error.kind).toBe('safety');
      expect(snapshot(deps)).toBe(before);
      expect(deps.files.get('/outside/target')).toBe('victim');
    });

    it('refuses a run-time folder that is a link', async () => {
      const state = layoutOf(HOME).runtimeDir;
      const deps = createFakeDeps({ links: { [state]: '/outside' } });
      deps.seedDir(state);
      deps.seedDir('/outside');
      expect(errorOf(await writeLastSeen(deps, HOME, ID, event('Stop'))).kind).toBe('safety');
      expect(deps.files.size).toBe(0);
    });
  });
});

describe('writeLastSeen: two writers at once', () => {
  const LOCK = `${FILE}.lock`;
  const BOUND = hookNames.heartbeatLock;
  const MAX_WAIT_MS = 300;

  /** A copy of the deps whose `sleep` also runs `afterSleep` with the number of waits so far. */
  const withWait = (deps: FakeDeps, afterSleep: (waits: number) => void): Deps => ({
    ...deps,
    sleep: async (ms) => {
      await deps.sleep(ms);
      afterSleep(deps.sleeps.length);
    },
  });

  it('waits 300 ms at most, in fixed steps', () => {
    expect((BOUND.attempts - 1) * BOUND.waitMs).toBeLessThanOrEqual(MAX_WAIT_MS);
    expect(BOUND.attempts).toBeGreaterThan(1);
  });

  it.each([
    ['the hook first', [event('Stop'), percent(42)]],
    ['the status line first', [percent(42), event('Stop')]],
  ] as const)('keeps both the event and the percent when two writes start together, %s', async (_name, changes) => {
    const deps = createFakeDeps();
    const results = await Promise.all(changes.map((change) => writeLastSeen(deps, HOME, ID, change)));
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(storedLine(deps)).toEqual(line({ event: 'Stop', event_at: expect.any(String), context_pct: 42, pct_at: expect.any(String) }));
    expect([...deps.files.keys()]).toEqual([FILE]);
  });

  it('reads the line again inside the lock, so a line that another writer saved while it waited stays', async () => {
    const deps = createFakeDeps();
    deps.seed(LOCK, '1\n');
    const waiting = withWait(deps, () => {
      deps.seed(FILE, `${JSON.stringify(line({ event: 'Stop', event_at: T0 }))}\n`);
      deps.files.delete(LOCK);
    });
    expect((await writeLastSeen(waiting, HOME, ID, percent(42))).ok).toBe(true);
    expect(storedLine(deps)).toEqual(line({ event: 'Stop', event_at: T0, context_pct: 42, pct_at: '2030-01-02T03:04:05.728Z' }));
  });

  it('waits for a lock that another writer holds, then writes, and removes its own lock', async () => {
    const deps = createFakeDeps();
    deps.seed(LOCK, '1\n');
    const waiting = withWait(deps, (waits) => {
      if (waits === 2) deps.files.delete(LOCK);
    });
    expect((await writeLastSeen(waiting, HOME, ID, event('Stop'))).ok).toBe(true);
    expect(deps.sleeps).toEqual([BOUND.waitMs, BOUND.waitMs]);
    expect(storedLine(deps)).toMatchObject({ event: 'Stop' });
    expect([...deps.files.keys()]).toEqual([FILE]);
  });

  it('gives up, writes nothing and leaves the lock of the other writer when the lock stays past the wait bound', async () => {
    const deps = createFakeDeps();
    deps.seed(LOCK, '1\n');
    const result = await writeLastSeen(deps, HOME, ID, event('Stop'));
    expect(errorOf(result)).toMatchObject({ kind: 'failure', message: expect.stringContaining(LOCK) });
    expect(deps.sleeps).toEqual(Array.from({ length: BOUND.attempts - 1 }, () => BOUND.waitMs));
    expect(deps.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(MAX_WAIT_MS);
    expect([...deps.files.entries()]).toEqual([[LOCK, '1\n']]);
  });

  it('takes over a lock that is older than the stale bound, with no wait', async () => {
    const deps = createFakeDeps();
    deps.seed(LOCK, '1\n');
    deps.advance(BOUND.staleMs + 1);
    expect((await writeLastSeen(deps, HOME, ID, event('Stop'))).ok).toBe(true);
    expect(deps.sleeps).toEqual([]);
    expect([...deps.files.keys()]).toEqual([FILE]);
  });

  it('does not take over a lock that is not older than the stale bound', async () => {
    const deps = createFakeDeps();
    deps.seed(LOCK, '1\n');
    // The last try is 300 ms after the first one, so the lock is exactly as old as the bound then.
    deps.advance(BOUND.staleMs - (BOUND.attempts - 1) * BOUND.waitMs);
    expect(errorOf(await writeLastSeen(deps, HOME, ID, event('Stop'))).kind).toBe('failure');
    expect([...deps.files.entries()]).toEqual([[LOCK, '1\n']]);
  });

  it('keeps the fresh lock of another writer that took the place of the stale lock while it took over', async () => {
    const deps = createFakeDeps();
    deps.seed(LOCK, '1\n');
    deps.advance(BOUND.staleMs + 1);
    const racing: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) => {
          const created = await deps.fs.writeTextExclusive(path, text, mode);
          // The claim of the takeover is made. Now the other writer replaces the stale lock with its own, fresh lock.
          if (path === `${LOCK}.takeover`) {
            deps.files.delete(LOCK);
            deps.seed(LOCK, '2\n');
          }
          return created;
        },
      },
    };
    expect(errorOf(await writeLastSeen(racing, HOME, ID, event('Stop'))).kind).toBe('failure');
    expect([...deps.files.entries()]).toEqual([[LOCK, '2\n']]);
  });

  it('refuses a lock path that is a link, waits for nothing, and keeps the target of the link', async () => {
    const deps = createFakeDeps({ links: { [LOCK]: '/outside/target' } });
    deps.seed('/outside/target', 'victim');
    const error = errorOf(await writeLastSeen(deps, HOME, ID, event('Stop')));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain(LOCK);
    expect(deps.sleeps).toEqual([]);
    expect(deps.files.get('/outside/target')).toBe('victim');
    expect([...deps.files.keys()]).toEqual(['/outside/target']);
  });

  it('creates the lock in the heartbeat folder with mode 0600', async () => {
    const deps = createFakeDeps();
    const created: [string, number][] = [];
    const watched: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) => (created.push([path, mode]), deps.fs.writeTextExclusive(path, text, mode)),
      },
    };
    await writeLastSeen(watched, HOME, ID, event('Stop'));
    expect(created[0]).toEqual([LOCK, 0o600]);
  });

  it('removes its lock when the write of the line fails', async () => {
    const deps = createFakeDeps();
    const failing: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) =>
          path === LOCK ? deps.fs.writeTextExclusive(path, text, mode) : failure(`cannot write ${path}: disk full`),
      },
    };
    expect(errorOf(await writeLastSeen(failing, HOME, ID, event('Stop'))).message).toContain('disk full');
    expect(deps.files.size).toBe(0);
  });

  it('removes its lock when the stored line can not be read', async () => {
    const deps = createFakeDeps();
    seedLine(deps, { event: 'Stop', event_at: T0 });
    const broken: Deps = {
      ...deps,
      fs: { ...deps.fs, lstat: async (path) => (path === FILE ? failure('cannot stat: EIO') : deps.fs.lstat(path)) },
    };
    expect(errorOf(await writeLastSeen(broken, HOME, ID, percent(5))).message).toContain('EIO');
    expect([...deps.files.keys()]).toEqual([FILE]);
    expect(storedLine(deps)).toEqual(line({ event: 'Stop', event_at: T0 }));
  });

  it('removes its lock when the line is a link and the write is refused', async () => {
    const deps = createFakeDeps({ links: { [FILE]: '/outside/target' } });
    deps.seedDir(FOLDER);
    deps.seed('/outside/target', 'victim');
    expect(errorOf(await writeLastSeen(deps, HOME, ID, event('Stop'))).kind).toBe('safety');
    expect([...deps.files.keys()]).toEqual(['/outside/target']);
  });

  it('takes no lock, and makes no folder, for a change that is refused', async () => {
    const deps = createFakeDeps();
    const created: string[] = [];
    const watched: Deps = {
      ...deps,
      fs: { ...deps.fs, writeTextExclusive: async (path, text, mode) => (created.push(path), deps.fs.writeTextExclusive(path, text, mode)) },
    };
    expect(errorOf(await writeLastSeen(watched, HOME, ID, percent(101))).kind).toBe('failure');
    expect(created).toEqual([]);
    expect(deps.dirs.has(FOLDER)).toBe(false);
  });
});

describe('readLastSeen', () => {
  it('gives absent when the folder does not exist', async () => {
    expect(await readValue(createFakeDeps())).toEqual({ state: 'absent' });
  });

  it('gives absent when the file does not exist', async () => {
    const deps = createFakeDeps();
    deps.seedDir(FOLDER);
    expect(await readValue(deps)).toEqual({ state: 'absent' });
  });

  it('gives the line of a valid file', async () => {
    const deps = createFakeDeps();
    seedLine(deps, { event: 'Stop', event_at: T0, context_pct: 12.5, pct_at: T1 });
    expect(await readValue(deps)).toEqual({
      state: 'valid',
      line: line({ event: 'Stop', event_at: T0, context_pct: 12.5, pct_at: T1 }),
    });
  });

  it('reads a line that a write made', async () => {
    const deps = createFakeDeps();
    await writeLastSeen(deps, HOME, ID, event('PreCompact'));
    await writeLastSeen(deps, HOME, ID, percent(61));
    expect(await readValue(deps)).toEqual({
      state: 'valid',
      line: line({ event: 'PreCompact', event_at: T0, context_pct: 61, pct_at: T0 }),
    });
  });

  const invalid = async (text: string): Promise<string> => {
    const deps = createFakeDeps();
    deps.seed(FILE, text);
    const read = await readValue(deps);
    if (read.state !== 'invalid') throw new Error(`expected an invalid file, got ${read.state}`);
    return read.reason;
  };

  it('gives invalid with a reason for text that is not JSON', async () => {
    expect(await invalid('{"schema"')).toContain('not valid JSON');
  });

  it('gives invalid for an empty file', async () => {
    expect(await invalid('')).toContain('not valid JSON');
  });

  it.each([
    ['an unknown key', { extra: 1 }, 'extra: unknown key'],
    ['an event off the list', { event: 'Bogus', event_at: T0 }, 'event'],
    ['a percent of 101', { context_pct: 101, pct_at: T0 }, 'context_pct'],
    ['a percent of -1', { context_pct: -1, pct_at: T0 }, 'context_pct'],
    ['a percent with no time', { context_pct: 5 }, 'pct_at'],
    ['a time with no percent', { pct_at: T0 }, 'pct_at'],
    ['an event with no time', { event: 'Stop' }, 'event_at'],
    ['a time with no event', { event_at: T0 }, 'event_at'],
    ['a time that is not a date', { event: 'Stop', event_at: 'yesterday' }, 'event_at'],
    ['another schema id', { schema: 'other/v1' }, 'schema'],
    ['a session id that is not a UUID', { session_id: 'abc' }, 'session_id'],
  ])('gives invalid for %s', async (_name, fields, reason) => {
    expect(await invalid(JSON.stringify(line(fields)))).toContain(reason);
  });

  it('gives invalid for a line that is not an object', async () => {
    expect(await invalid('[1]')).toContain('(top level)');
  });

  it('gives invalid when the session id in the file differs from the file name', async () => {
    const reason = await invalid(JSON.stringify(line({ session_id: '0b9c7d5e-2f31-4a68-9c4d-5e6f708192a3' })));
    expect(reason).toContain('differs from the file name');
  });

  it('gives invalid, and reads no more than the cap, for a file over the cap', async () => {
    const reason = await invalid(`${JSON.stringify(line())}${' '.repeat(lastSeen.maxBytes)}`);
    expect(reason).toContain(`larger than ${lastSeen.maxBytes} bytes`);
  });

  it('gives invalid for a file that is a link, and does not read the target', async () => {
    const deps = createFakeDeps({ links: { [FILE]: '/outside/target' } });
    deps.seedDir(FOLDER);
    deps.seed('/outside/target', JSON.stringify(line()));
    const read = await readValue(deps);
    expect(read).toEqual({ state: 'invalid', reason: expect.stringContaining('it is a link') });
  });

  it('gives invalid for a heartbeat folder that is a link', async () => {
    const deps = createFakeDeps({ links: { [FOLDER]: '/outside' } });
    deps.seedDir(FOLDER);
    deps.seed(`/outside/${ID}`, JSON.stringify(line()));
    expect(await readValue(deps)).toEqual({ state: 'invalid', reason: expect.stringContaining('the folder is a link') });
  });

  it('gives invalid for a file that is a folder', async () => {
    const deps = createFakeDeps();
    deps.seedDir(FILE);
    expect(await readValue(deps)).toEqual({ state: 'invalid', reason: expect.stringContaining('it is not a file') });
  });

  it('gives invalid for a session id that is not a UUID, and reads no file', async () => {
    const deps = createFakeDeps();
    const seen: string[] = [];
    const watched: Deps = {
      ...deps,
      fs: { ...deps.fs, lstat: async (path) => (seen.push(path), deps.fs.lstat(path)) },
    };
    const read = await readValue(watched, '../escape');
    expect(read).toEqual({ state: 'invalid', reason: expect.stringContaining('not a UUID') });
    expect(seen).toEqual([]);
  });

  it('fails when the file system fails', async () => {
    const deps = createFakeDeps();
    const broken: Deps = { ...deps, fs: { ...deps.fs, lstat: async () => failure('cannot stat: EIO') } };
    expect(errorOf(await readLastSeen(broken, HOME, ID)).message).toContain('EIO');
  });

  it('never reads a path outside the last-seen file', async () => {
    const deps = createFakeDeps();
    seedLine(deps, { event: 'Stop', event_at: T0 });
    const reads: string[] = [];
    const watched: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        readText: async (path) => (reads.push(path), deps.fs.readText(path)),
        readTextLimited: async (path, max) => (reads.push(path), deps.fs.readTextLimited(path, max)),
        digestFile: async (path, text, max) => (reads.push(path), deps.fs.digestFile(path, text, max)),
      },
    };
    await readValue(watched);
    expect(reads).toEqual([FILE]);
  });
});

describe('promptStateOf', () => {
  const typedLine = (name: HookEvent | null): LastSeen => ({
    schema: schemaIds.lastSeen,
    session_id: ID,
    event: name,
    event_at: name === null ? null : T0,
    context_pct: null,
    pct_at: null,
  });

  it.each([
    ['SessionStart', 'prompt'],
    ['Stop', 'prompt'],
    ['UserPromptSubmit', 'busy'],
    ['PreCompact', 'busy'],
  ] as const)('reads %s as %s', (name, state) => {
    expect(promptStateOf(typedLine(name))).toBe(state);
  });

  it('says nothing for a line that holds a percent and no event', () => {
    expect(promptStateOf({ ...typedLine(null), context_pct: 40, pct_at: T0 })).toBeNull();
  });

  it('has a state for every event of the hook', () => {
    expect(Object.keys(eventState).sort()).toEqual([...hookNames.events].sort());
  });
});

describe('the session pointer of a worker', () => {
  const WORKER = 'fix-login';
  const PATHS = workerPathsOf(HOME, WORKER);
  const POINTER = PATHS.lastSessionFile;
  const NEXT = '0b9c7d5e-2f31-4a68-9c4d-5e6f708192a3';

  const withWorker = (links: Record<string, string> = {}): FakeDeps => {
    const deps = createFakeDeps({ links });
    deps.seedDir(PATHS.dir);
    return deps;
  };

  const readWorker = async (deps: Deps, worker = WORKER): Promise<LastSeenRead> => {
    const result = await readWorkerLastSeen(deps, HOME, worker);
    if (!result.ok) throw new Error(`the read failed: ${result.error.message}`);
    return result.value;
  };

  const invalidReason = async (deps: Deps, worker = WORKER): Promise<string> => {
    const read = await readWorker(deps, worker);
    if (read.state !== 'invalid') throw new Error(`expected an invalid read, got ${read.state}`);
    return read.reason;
  };

  it('puts the pointer in the folder of the worker', () => {
    expect(POINTER).toBe('/h/node/.factory/workers/fix-login/last-session');
  });

  describe('writeWorkerSession', () => {
    it('writes the session id and a new line into the file of the worker', async () => {
      const deps = withWorker();
      expect(await writeWorkerSession(deps, HOME, WORKER, ID)).toEqual({ ok: true, value: undefined });
      expect(deps.files.get(POINTER)).toBe(`${ID}\n`);
      expect([...deps.files.keys()]).toEqual([POINTER]);
    });

    it('replaces the session id with the id of a newer session', async () => {
      const deps = withWorker();
      await writeWorkerSession(deps, HOME, WORKER, ID);
      await writeWorkerSession(deps, HOME, WORKER, NEXT);
      expect(deps.files.get(POINTER)).toBe(`${NEXT}\n`);
    });

    it.each([
      ['a worker id that is not a slug', 'Fix_Login', ID],
      ['a worker id that climbs out of the folder', '../../escape', ID],
      ['an empty worker id', '', ID],
      ['a session id that is not a UUID', WORKER, 'abc'],
      ['a session id with upper case letters', WORKER, ID.toUpperCase()],
      ['a session id with a path in it', WORKER, `${ID}/../x`],
    ])('writes nothing for %s', async (_name, worker, session) => {
      const deps = withWorker();
      const before = snapshot(deps);
      expect(errorOf(await writeWorkerSession(deps, HOME, worker, session)).kind).toBe('failure');
      expect(snapshot(deps)).toBe(before);
    });

    it('refuses a pointer that is a link, and keeps its target', async () => {
      const deps = withWorker({ [POINTER]: '/outside/target' });
      deps.seed('/outside/target', 'victim');
      const before = snapshot(deps);
      expect(errorOf(await writeWorkerSession(deps, HOME, WORKER, ID)).kind).toBe('safety');
      expect(snapshot(deps)).toBe(before);
      expect(deps.files.get('/outside/target')).toBe('victim');
    });

    it('refuses a folder of the worker that is a link', async () => {
      const deps = withWorker({ [PATHS.dir]: '/outside' });
      deps.seedDir('/outside');
      expect(errorOf(await writeWorkerSession(deps, HOME, WORKER, ID)).kind).toBe('safety');
      expect(deps.files.size).toBe(0);
    });
  });

  describe('readWorkerLastSeen', () => {
    const seedSession = (deps: FakeDeps, session: string, fields: Record<string, unknown> = {}): void => {
      deps.seed(`${FOLDER}/${session}`, `${JSON.stringify(line({ session_id: session, ...fields }))}\n`);
    };

    it('gives absent when the worker has no folder', async () => {
      expect(await readWorker(createFakeDeps())).toEqual({ state: 'absent' });
    });

    it('gives absent when the worker has no pointer yet', async () => {
      expect(await readWorker(withWorker())).toEqual({ state: 'absent' });
    });

    it('gives the line of the session that the pointer names', async () => {
      const deps = withWorker();
      await writeWorkerSession(deps, HOME, WORKER, ID);
      seedSession(deps, ID, { event: 'Stop', event_at: T0, context_pct: 33, pct_at: T1 });
      expect(await readWorker(deps)).toEqual({
        state: 'valid',
        line: line({ event: 'Stop', event_at: T0, context_pct: 33, pct_at: T1 }),
      });
    });

    it('follows the pointer to the newest session and ignores the line of an older one', async () => {
      const deps = withWorker();
      seedSession(deps, ID, { event: 'Stop', event_at: T0 });
      seedSession(deps, NEXT, { event: 'UserPromptSubmit', event_at: T1 });
      await writeWorkerSession(deps, HOME, WORKER, ID);
      await writeWorkerSession(deps, HOME, WORKER, NEXT);
      expect(await readWorker(deps)).toMatchObject({ state: 'valid', line: { session_id: NEXT, event: 'UserPromptSubmit' } });
    });

    it('gives absent when the pointer names a session that has no line', async () => {
      const deps = withWorker();
      await writeWorkerSession(deps, HOME, WORKER, ID);
      expect(await readWorker(deps)).toEqual({ state: 'absent' });
    });

    it('gives invalid when the line of the session is not valid', async () => {
      const deps = withWorker();
      await writeWorkerSession(deps, HOME, WORKER, ID);
      deps.seed(FILE, 'not json');
      expect(await invalidReason(deps)).toContain('not valid JSON');
    });

    it.each([
      ['text that is not a session id', 'abc\n'],
      ['a session id with upper case letters', `${ID.toUpperCase()}\n`],
      ['a session id with a path behind it', `${ID}/../../x\n`],
      ['a second line', `${ID}\nx\n`],
      ['an empty file', ''],
    ])('gives invalid for a pointer that holds %s, and reads no line', async (_name, text) => {
      const deps = withWorker();
      deps.seed(POINTER, text);
      seedSession(deps, ID, { event: 'Stop', event_at: T0 });
      const reads: string[] = [];
      const watched: Deps = { ...deps, fs: { ...deps.fs, readTextLimited: async (path, max) => (reads.push(path), deps.fs.readTextLimited(path, max)) } };
      expect(await invalidReason(watched)).toContain('session id');
      expect(reads).toEqual([POINTER]);
    });

    it('gives invalid for a pointer over the cap', async () => {
      const deps = withWorker();
      deps.seed(POINTER, `${ID}${' '.repeat(lastSeen.pointerMaxBytes)}`);
      expect(await invalidReason(deps)).toContain(`larger than ${lastSeen.pointerMaxBytes} bytes`);
    });

    it('gives invalid for a pointer that is a link, and does not read the target', async () => {
      const deps = withWorker({ [POINTER]: '/outside/target' });
      deps.seed('/outside/target', `${ID}\n`);
      seedSession(deps, ID, { event: 'Stop', event_at: T0 });
      expect(await invalidReason(deps)).toContain('the pointer is a link');
    });

    it('gives invalid for a pointer that is a folder', async () => {
      const deps = withWorker();
      deps.seedDir(POINTER);
      expect(await invalidReason(deps)).toContain('the pointer is not a file');
    });

    it('gives invalid for a folder of the worker that is a link', async () => {
      const deps = withWorker({ [PATHS.dir]: '/outside' });
      deps.seed('/outside/last-session', `${ID}\n`);
      expect(await invalidReason(deps)).toContain('is a link');
    });

    it('gives invalid for a workers folder that is a link', async () => {
      const deps = withWorker({ [layoutOf(HOME).workersDir]: '/outside' });
      expect(await invalidReason(deps)).toContain('is a link');
    });

    it('gives invalid for a worker id that is not a slug, and touches no path', async () => {
      const deps = withWorker();
      const seen: string[] = [];
      const watched: Deps = { ...deps, fs: { ...deps.fs, lstat: async (path) => (seen.push(path), deps.fs.lstat(path)) } };
      expect(await invalidReason(watched, '../escape')).toContain('not a slug');
      expect(seen).toEqual([]);
    });

    it('fails when the file system fails', async () => {
      const deps = withWorker();
      const broken: Deps = { ...deps, fs: { ...deps.fs, lstat: async () => failure('cannot stat: EIO') } };
      expect(errorOf(await readWorkerLastSeen(broken, HOME, WORKER)).message).toContain('EIO');
    });
  });
});
