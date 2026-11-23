import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeFor, failure, type CliResult } from '../../src/cli/errors.js';
import { files } from '../../src/names.js';
import { writeEventFile, type EventFields } from '../../src/report/event-file.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps } from '../helpers/fake-deps.js';

const HOME = '/w/node';
const LAYOUT = layoutOf(HOME);
const EVENT = { name: 'work-42.json', fields: { kind: 'done', count: 42, kept: true, note: null } };
const FILE = join(LAYOUT.outboxDir, EVENT.name);
const OUTSIDE = '/outside';
const WIDE_MODE = 0o755;

const node = (options?: Parameters<typeof createFakeDeps>[0]) => {
  const deps = createFakeDeps(options);
  deps.seedDir(HOME);
  deps.seedDir(LAYOUT.stateDir);
  return deps;
};

const expectRefusal = (result: CliResult<unknown>, code: number, message: string, hint: string): void => {
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(message), hint: expect.stringContaining(hint) } });
  if (!result.ok) expect(exitCodeFor(result.error)).toBe(code);
};

const fieldsWithBytes = (bytes: number) => ({ value: 'é'.repeat(Math.floor((bytes - 13) / 2)) + 'a'.repeat((bytes - 13) % 2) });

describe('the event file writer', () => {
  it('writes one JSON object with the given fields and private modes', async () => {
    const deps = node();
    expect(await writeEventFile(deps, HOME, EVENT)).toEqual({ ok: true, value: 'written' });
    expect([...deps.files.keys()]).toEqual([FILE]);
    expect(JSON.parse(deps.files.get(FILE) ?? '')).toEqual(EVENT.fields);
    expect(deps.modes.get(FILE)).toBe(0o600);
    expect(deps.modes.get(LAYOUT.outboxDir)).toBe(0o700);
  });

  it('tightens the mode of an outbox that exists', async () => {
    const deps = node();
    deps.seedDir(LAYOUT.outboxDir);
    deps.modes.set(LAYOUT.outboxDir, WIDE_MODE);
    expect(await writeEventFile(deps, HOME, EVENT)).toEqual({ ok: true, value: 'written' });
    expect(deps.modes.get(LAYOUT.outboxDir)).toBe(0o700);
  });

  it('does not write a file when it cannot tighten the outbox mode', async () => {
    const deps = node();
    deps.seedDir(LAYOUT.outboxDir);
    deps.modes.set(LAYOUT.outboxDir, WIDE_MODE);
    const refused = failure('cannot change the folder mode');
    const denied = { ...deps, fs: { ...deps.fs, chmod: async () => refused } };
    expect(await writeEventFile(denied, HOME, EVENT)).toEqual(refused);
    expect([...deps.files.keys()]).toEqual([]);
  });

  it('keeps the first file when two writes use the same name', async () => {
    const deps = node();
    expect(await writeEventFile(deps, HOME, EVENT)).toEqual({ ok: true, value: 'written' });
    expect(await writeEventFile(deps, HOME, { ...EVENT, fields: { ...EVENT.fields, count: 43 } })).toEqual({ ok: true, value: 'exists' });
    expect([...deps.files.keys()]).toEqual([FILE]);
    expect(JSON.parse(deps.files.get(FILE) ?? '')).toEqual(EVENT.fields);
  });

  it('skips a node with no state folder', async () => {
    const deps = createFakeDeps();
    deps.seedDir(HOME);
    expect(await writeEventFile(deps, HOME, EVENT)).toEqual({ ok: true, value: 'skipped' });
    expect(deps.dirs.has(LAYOUT.stateDir)).toBe(false);
    expect([...deps.files.keys()]).toEqual([]);
  });

  it.each(['../work-42.json', 'work_42.json', 'Work-42.json', 'work-42.txt', `${'a'.repeat(97)}.json`, 'work-42.json\n', files.report])(
    'refuses the event name %j', async (name) => {
      const deps = node();
      expectRefusal(await writeEventFile(deps, HOME, { ...EVENT, name }), 1, 'invalid event file name', 'Use a new event file name');
      expect(deps.dirs.has(LAYOUT.outboxDir)).toBe(false);
      expect([...deps.files.keys()]).toEqual([]);
    },
  );

  it('accepts a name with 96 characters before the suffix', async () => {
    const deps = node();
    const name = `${'a'.repeat(96)}.json`;
    expect(await writeEventFile(deps, HOME, { ...EVENT, name })).toEqual({ ok: true, value: 'written' });
    expect([...deps.files.keys()]).toEqual([join(LAYOUT.outboxDir, name)]);
  });

  it.each([['object', {}], ['array', ['done']], ['non-finite number', Infinity], ['undefined', undefined]])(
    'refuses a field with a value of type %s', async (_kind, value) => {
      const deps = node();
      const fields = { ...EVENT.fields, kind: value };
      expectRefusal(await writeEventFile(deps, HOME, { ...EVENT, fields: fields as EventFields }), 1, 'invalid event fields', 'Use only text, finite numbers');
      expect(deps.dirs.has(LAYOUT.outboxDir)).toBe(false);
    },
  );

  it('accepts JSON text with exactly 1024 UTF-8 bytes', async () => {
    const deps = node();
    const fields = fieldsWithBytes(1024);
    expect(await writeEventFile(deps, HOME, { ...EVENT, fields })).toEqual({ ok: true, value: 'written' });
    expect(Buffer.byteLength(deps.files.get(FILE) ?? '', 'utf8')).toBe(1024);
    expect(JSON.parse(deps.files.get(FILE) ?? '')).toEqual(fields);
  });

  it('refuses JSON text with 1025 UTF-8 bytes', async () => {
    const deps = node();
    const fields = fieldsWithBytes(1025);
    expectRefusal(await writeEventFile(deps, HOME, { ...EVENT, fields }), 1, 'exceeds 1024 bytes', 'Use fewer bytes');
    expect(deps.dirs.has(LAYOUT.outboxDir)).toBe(false);
  });

  it.each([
    ['the state folder', LAYOUT.stateDir, OUTSIDE],
    ['the outbox folder', LAYOUT.outboxDir, OUTSIDE],
    ['the event file', FILE, join(OUTSIDE, EVENT.name)],
  ])('stops with exit 4 at a link at %s and keeps the target', async (_label, path, target) => {
    const deps = node({ links: { [path]: target } });
    const outsideFile = join(OUTSIDE, EVENT.name);
    deps.seed(outsideFile, 'keep this text\n');
    if (path === FILE) deps.seedDir(LAYOUT.outboxDir);
    expectRefusal(await writeEventFile(deps, HOME, EVENT), 4, 'is a link', 'Replace the link');
    expect([...deps.files]).toEqual([[outsideFile, 'keep this text\n']]);
    expect(deps.modes.has(OUTSIDE)).toBe(false);
  });

  it('does not call a folder at the event file path an existing event', async () => {
    const deps = node();
    deps.seedDir(FILE);
    const result = await writeEventFile(deps, HOME, EVENT);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure', message: expect.stringContaining('is not a file') } });
    expect([...deps.files.keys()]).toEqual([]);
  });
});
