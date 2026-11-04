import { describe, expect, it } from 'vitest';
import { failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { hookNames, lastSeen, schemaIds, type HookEvent } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { parsePercent, readLastSeen, writeLastSeen, type LastSeenRead } from '../../src/workers/last-seen.js';
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

  it.each([101, -1, Number.NaN, Number.POSITIVE_INFINITY])('writes nothing for the percent %j', async (value) => {
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
