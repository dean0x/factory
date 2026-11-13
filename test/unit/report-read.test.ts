import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { readChildReport, type ChildReportRead } from '../../src/comms/report-read.js';
import { parseReport, type NodeReport } from '../../src/comms/report-schema.js';
import type { Deps } from '../../src/core/deps.js';
import { childReasons, layers, reportLimits, schemaIds } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { importPathsOf } from '../helpers/source-scan.js';

const HOME = '/w/child';
const ADDRESS = `file://${HOME}`;
const LAYOUT = layoutOf(HOME);
const NOW = new Date('2026-11-13T12:00:00.000Z');
const AGE_SECONDS = 90;
const OTHER_USER = 2000;
const PATHS = [
  ['the factory folder', LAYOUT.stateDir],
  ['the outbox folder', LAYOUT.outboxDir],
  ['the report file', LAYOUT.reportFile],
] as const;

const REPORT: NodeReport = {
  schema: schemaIds.report,
  schemaVersion: reportLimits.schemaVersion,
  id: 'child',
  layer: layers.coordinator,
  factoryVersion: '1.0.0',
  cursor: null,
  workers: [],
  board: { states: [], statesOmitted: 0, fields: [] },
  inProgress: [],
  requests: [],
  events: [],
  children: [],
};

const REPORT_TEXT = `${JSON.stringify(REPORT, null, 2)}\n`;
const BYTES = Buffer.byteLength(REPORT_TEXT, 'utf8');
const BIG = Number.MAX_SAFE_INTEGER;

/** A child node with a report file that is `AGE_SECONDS` old. */
const childWith = (text: string | null = REPORT_TEXT, options: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => {
  const deps = createFakeDeps({ now: NOW, ...options });
  deps.seedDir(HOME);
  deps.seedDir(LAYOUT.stateDir);
  deps.seedDir(LAYOUT.outboxDir);
  if (text !== null) {
    deps.seed(LAYOUT.reportFile, text);
    deps.mtimes.set(LAYOUT.reportFile, NOW.getTime() - AGE_SECONDS * 1000);
  }
  return deps;
};

const unknownOf = (result: ChildReportRead): Extract<ChildReportRead, { state: 'unknown' }> => {
  if (result.state !== 'unknown') throw new Error('the read should be unknown');
  return result;
};

const FIXED_REASONS: readonly string[] = Object.values(childReasons);

describe('child report reader: a report that passes every check', () => {
  it('gives the report, the age in whole seconds, the bytes that it read and the path of the file', async () => {
    const result = await readChildReport(childWith(), ADDRESS, BIG);
    expect(result).toEqual({ state: 'read', report: REPORT, age: AGE_SECONDS, bytes: BYTES, source: LAYOUT.reportFile });
  });

  it('reads a file that others can read but not write', async () => {
    const deps = childWith();
    deps.modes.set(LAYOUT.reportFile, 0o644);
    expect((await readChildReport(deps, ADDRESS, BIG)).state).toBe('read');
  });

  it('rounds the age down to whole seconds', async () => {
    const deps = childWith();
    deps.mtimes.set(LAYOUT.reportFile, NOW.getTime() - 1_900);
    expect(await readChildReport(deps, ADDRESS, BIG)).toMatchObject({ state: 'read', age: 1 });
  });

  it('gives the age 0 for a file from the future', async () => {
    const deps = childWith();
    deps.mtimes.set(LAYOUT.reportFile, NOW.getTime() + 60_000);
    expect(await readChildReport(deps, ADDRESS, BIG)).toMatchObject({ state: 'read', age: 0 });
  });

  it('caps the age at the largest number that a report holds', async () => {
    const deps = childWith();
    deps.mtimes.set(LAYOUT.reportFile, NOW.getTime() - (reportLimits.maxNumber + 100) * 1000);
    expect(await readChildReport(deps, ADDRESS, BIG)).toMatchObject({ state: 'read', age: reportLimits.maxNumber });
  });
});

describe('child report reader: an address that is not valid', () => {
  it.each(['ssh://host/child', 'file://relative/path', 'file:///a/../b', 'file:///a%2Fb', 'file:///a#b', `file://${HOME}\n`, ''])(
    'gives unknown with a fixed reason and touches no path for %j',
    async (address) => {
      const touched: string[] = [];
      const deps = withFsWatch(childWith(), (method, path) => void touched.push(`${method} ${path}`));
      const result = await readChildReport(deps, address, BIG);
      expect(result).toEqual({ state: 'unknown', reason: childReasons.addressInvalid, age: null, bytes: 0, source: null });
      expect(touched).toEqual([]);
    },
  );
});

describe('child report reader: no file', () => {
  it('gives noReport when the outbox folder has no report file', async () => {
    const result = await readChildReport(childWith(null), ADDRESS, BIG);
    expect(result).toEqual({ state: 'unknown', reason: childReasons.noReport, age: null, bytes: 0, source: LAYOUT.reportFile });
  });

  it('gives noReport when the child has no factory folder', async () => {
    const deps = createFakeDeps({ now: NOW });
    deps.seedDir(HOME);
    expect(unknownOf(await readChildReport(deps, ADDRESS, BIG)).reason).toBe(childReasons.noReport);
  });
});

describe('child report reader: a path that must not be trusted', () => {
  it.each(PATHS)('gives reportLink, and no age, when %s is a link', async (_name, path) => {
    const deps = childWith(REPORT_TEXT, { links: { [path]: '/elsewhere' } });
    const result = unknownOf(await readChildReport(deps, ADDRESS, BIG));
    expect(result).toMatchObject({ reason: childReasons.reportLink, age: null, bytes: 0, source: LAYOUT.reportFile });
  });

  it('gives reportWrongKind, and no age, when the report file is a folder', async () => {
    const deps = childWith(null);
    deps.seedDir(LAYOUT.reportFile);
    expect(unknownOf(await readChildReport(deps, ADDRESS, BIG))).toMatchObject({ reason: childReasons.reportWrongKind, age: null, bytes: 0 });
  });

  it('gives reportWrongKind when the outbox is a file', async () => {
    const deps = createFakeDeps({ now: NOW });
    deps.seedDir(LAYOUT.stateDir);
    deps.seed(LAYOUT.outboxDir, 'text');
    expect(unknownOf(await readChildReport(deps, ADDRESS, BIG)).reason).toBe(childReasons.reportWrongKind);
  });

  it.each(PATHS)('gives reportOtherOwner, with the age and no report, when another account owns %s', async (_name, path) => {
    const deps = childWith();
    deps.owners.set(path, OTHER_USER);
    const result = unknownOf(await readChildReport(deps, ADDRESS, BIG));
    expect(result).toMatchObject({ reason: childReasons.reportOtherOwner, age: AGE_SECONDS, source: LAYOUT.reportFile });
    expect(result).not.toHaveProperty('report');
  });

  it.each(PATHS)('gives reportOtherOwner when %s has another owner and the file is not valid JSON', async (_name, path) => {
    const deps = childWith('{ not json');
    deps.owners.set(path, OTHER_USER);
    expect(unknownOf(await readChildReport(deps, ADDRESS, BIG)).reason).toBe(childReasons.reportOtherOwner);
  });

  it.each(PATHS.flatMap(([name, path]) => [0o020, 0o002, 0o022, 0o666].map((mode) => [name, path, mode] as const)))(
    'gives reportWritable, with the age and no report, when %s has the mode %o',
    async (_name, path, mode) => {
      const deps = childWith();
      deps.modes.set(path, mode);
      const result = unknownOf(await readChildReport(deps, ADDRESS, BIG));
      expect(result).toMatchObject({ reason: childReasons.reportWritable, age: AGE_SECONDS });
      expect(result).not.toHaveProperty('report');
    },
  );

  it('skips the owner check on a platform with no user ids, and keeps the mode check', async () => {
    const owned = childWith(REPORT_TEXT, { uid: null });
    owned.owners.set(LAYOUT.reportFile, OTHER_USER);
    expect((await readChildReport(owned, ADDRESS, BIG)).state).toBe('read');
    const writable = childWith(REPORT_TEXT, { uid: null });
    writable.modes.set(LAYOUT.reportFile, 0o666);
    expect(unknownOf(await readChildReport(writable, ADDRESS, BIG)).reason).toBe(childReasons.reportWritable);
  });
});

describe('child report reader: the byte cap', () => {
  it('gives reportTooLarge, with the age and no bytes read, when the file is larger than the cap of the call', async () => {
    const result = await readChildReport(childWith(), ADDRESS, BYTES - 1);
    expect(result).toEqual({ state: 'unknown', reason: childReasons.reportTooLarge, age: AGE_SECONDS, bytes: 0, source: LAYOUT.reportFile });
  });

  it('reads a file that is exactly as large as the cap of the call', async () => {
    expect((await readChildReport(childWith(), ADDRESS, BYTES)).state).toBe('read');
  });

  it('never reads past the cap of a report, also when the caller allows more', async () => {
    const deps = childWith(' '.repeat(reportLimits.maxBytes + 1));
    expect(unknownOf(await readChildReport(deps, ADDRESS, BIG)).reason).toBe(childReasons.reportTooLarge);
  });

  it.each([0, -1, Number.NaN, 1.5])('reads no text when the cap of the call is %s', async (cap) => {
    const reads: string[] = [];
    const deps = withFsWatch(childWith(), (method, path) => void (method === 'readTextLimited' && reads.push(path)));
    expect(unknownOf(await readChildReport(deps, ADDRESS, cap)).reason).toBe(childReasons.reportTooLarge);
    expect(reads).toEqual([]);
  });
});

describe('child report reader: a file that does not read', () => {
  it('gives reportUnreadable, with the age, for bytes that are not UTF-8', async () => {
    const deps = childWith();
    deps.invalidUtf8.add(LAYOUT.reportFile);
    const result = unknownOf(await readChildReport(deps, ADDRESS, BIG));
    expect(result).toMatchObject({ reason: childReasons.reportUnreadable, age: AGE_SECONDS });
  });

  it('gives reportUnreadable, and shows no text of the fault, when the read fails', async () => {
    const base = childWith();
    const deps: Deps = { ...base, fs: { ...base.fs, readTextLimited: async () => failure('EIO on /secret/place') } };
    const result = await readChildReport(deps, ADDRESS, BIG);
    expect(unknownOf(result).reason).toBe(childReasons.reportUnreadable);
    expect(JSON.stringify(result)).not.toContain('EIO');
    expect(JSON.stringify(result)).not.toContain('/secret/place');
  });

  it.each(['lstat', 'statInfo'] as const)('gives reportUnreadable, and does not throw, when %s fails', async (call) => {
    const base = childWith();
    const deps: Deps = { ...base, fs: { ...base.fs, [call]: async () => failure('EACCES on /secret/place') } };
    const result = await readChildReport(deps, ADDRESS, BIG);
    expect(unknownOf(result).reason).toBe(childReasons.reportUnreadable);
    expect(JSON.stringify(result)).not.toContain('/secret/place');
  });
});

describe('child report reader: the content of the file', () => {
  it('gives reportNotJson, with the age and the bytes, and none of the text', async () => {
    const text = '{ "token": "SECRET-VALUE" ';
    const result = await readChildReport(childWith(text), ADDRESS, BIG);
    expect(result).toEqual({
      state: 'unknown',
      reason: childReasons.reportNotJson,
      age: AGE_SECONDS,
      bytes: Buffer.byteLength(text, 'utf8'),
      source: LAYOUT.reportFile,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET-VALUE');
  });

  it.each([
    ['one more than the version that this program reads', reportLimits.schemaVersion + 1],
    ['a far higher version', 99],
  ])('gives reportNewer for %s, also when the rest of the document does not pass the schema', async (_name, version) => {
    const text = JSON.stringify({ schemaVersion: version, somethingNew: { shape: 'unknown' } });
    expect(unknownOf(await readChildReport(childWith(text), ADDRESS, BIG))).toMatchObject({
      reason: childReasons.reportNewer,
      age: AGE_SECONDS,
    });
  });

  it.each([
    ['a document with a key that is not on the list', { ...REPORT, session: 'abc' }],
    ['a document with a wrong type', { ...REPORT, workers: 'none' }],
    ['a document of version 1.5, which is not a whole number', { ...REPORT, schemaVersion: 1.5 }],
    ['a document of version 0', { ...REPORT, schemaVersion: 0 }],
    ['a document of a version that is a text', { ...REPORT, schemaVersion: '2' }],
    ['a list', [REPORT]],
    ['a text', 'report'],
    ['null', null],
    ['a number', 7],
  ])('gives reportInvalid for %s', async (_name, value) => {
    expect(unknownOf(await readChildReport(childWith(JSON.stringify(value)), ADDRESS, BIG))).toMatchObject({
      reason: childReasons.reportInvalid,
      age: AGE_SECONDS,
    });
  });

  it('shows no key name or value of a document that does not pass the schema', async () => {
    const text = JSON.stringify({ ...REPORT, leakedKeyName: 'LEAKED-VALUE' });
    const result = await readChildReport(childWith(text), ADDRESS, BIG);
    expect(unknownOf(result).reason).toBe(childReasons.reportInvalid);
    expect(JSON.stringify(result)).not.toContain('leakedKeyName');
    expect(JSON.stringify(result)).not.toContain('LEAKED-VALUE');
  });

  it('gives a report that passes the schema as the schema returns it', async () => {
    const result = await readChildReport(childWith(), ADDRESS, BIG);
    const parsed = parseReport(REPORT);
    if (!parsed.ok || result.state !== 'read') throw new Error('the report should read');
    expect(result.report).toEqual(parsed.value);
  });
});

describe('child report reader: every unknown value', () => {
  it('holds a reason from the fixed list and no text of the child', () => {
    for (const reason of FIXED_REASONS) {
      expect(reason).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(reason.length).toBeLessThanOrEqual(reportLimits.maxTextChars);
    }
    expect(new Set(FIXED_REASONS).size).toBe(FIXED_REASONS.length);
  });

  it('fits in the reason of a child row of a report', () => {
    for (const reason of FIXED_REASONS) {
      const row = { id: 'web', address: 'file:///h/web', state: 'unknown', reason, counts: null, age: null };
      expect(parseReport({ ...REPORT, children: [row] }).ok, reason).toBe(true);
    }
  });
});

describe('child report reader: where it sits', () => {
  const imports = importPathsOf(readFileSync(join(__dirname, '..', '..', 'src', 'comms', 'report-read.ts'), 'utf8'));

  it('imports no module of the report builder, and no tmux, launch or subprocess module', () => {
    expect(imports.filter((path) => /report\/|tmux|launch|child_process|recipes/.test(path))).toEqual([]);
  });
});
