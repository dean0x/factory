import { describe, expect, it } from 'vitest';
import { failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { files, schemaIds, workerRecord } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import {
  listWorkerRecords,
  readWorkerRecord,
  writeWorkerRecord,
  type NewWorker,
  type WorkerList,
  type WorkerRead,
} from '../../src/workers/registry.js';
import { createFakeDeps, withFsWatch, type FakeDeps, type FakeOptions } from '../helpers/fake-deps.js';

const HOME = '/h/node';
const WORKERS = '/h/node/.factory/workers';
const T0 = '2030-01-02T03:04:05.678Z';

const worker = (change: Partial<NewWorker> = {}): NewWorker => ({
  id: 'web-search',
  project: 'web',
  workCopy: '/h/node/work-copies/web/web-search',
  branch: 'factory/web-search',
  ...change,
});

/** The record as the file holds it. The keys are written out here, so a test pins the format that a reader of the file sees. */
const fileOf = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: schemaIds.workerRecord,
  id: 'web-search',
  project: 'web',
  work_copy: '/h/node/work-copies/web/web-search',
  branch: 'factory/web-search',
  created_at: T0,
  ...fields,
});

const recordPath = (id: string): string => `${WORKERS}/${id}/worker.json`;

const seedRecord = (deps: FakeDeps, id = 'web-search', fields: Record<string, unknown> = {}): void =>
  deps.seed(recordPath(id), `${JSON.stringify(fileOf({ id, ...fields }))}\n`);

const make = (options: FakeOptions = {}): FakeDeps => createFakeDeps(options);

const errorOf = <T>(result: CliResult<T>): { kind: string; message: string } => {
  if (result.ok) throw new Error('the call should have failed');
  return result.error;
};

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`the call failed: ${result.error.message}`);
  return result.value;
};

const readOf = async (deps: Deps, id = 'web-search'): Promise<WorkerRead> => valueOf(await readWorkerRecord(deps, HOME, id));

const listOf = async (deps: Deps): Promise<WorkerList> => valueOf(await listWorkerRecords(deps, HOME));

const stored = (deps: FakeDeps, id = 'web-search'): unknown => JSON.parse(deps.files.get(recordPath(id)) ?? 'null');

const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');

describe('the paths of a worker', () => {
  it('puts the record and the inbox in a folder named by the id, below the workers folder of the state folder', () => {
    expect(layoutOf(HOME).workersDir).toBe(WORKERS);
    expect(workerPathsOf(HOME, 'web-search')).toEqual({
      dir: `${WORKERS}/web-search`,
      recordFile: `${WORKERS}/web-search/worker.json`,
      inboxDir: `${WORKERS}/web-search/inbox`,
    });
  });

  it('names the record file in names.ts', () => {
    expect(files.workerRecord).toBe('worker.json');
  });
});

describe('writeWorkerRecord (TP-9)', () => {
  it('writes the record of one worker to its own file, with the time of the clock, and returns it', async () => {
    const deps = make();
    const result = valueOf(await writeWorkerRecord(deps, HOME, worker()));
    expect(result).toEqual({
      id: 'web-search',
      project: 'web',
      workCopy: '/h/node/work-copies/web/web-search',
      branch: 'factory/web-search',
      createdAt: T0,
    });
    expect(stored(deps)).toEqual(fileOf());
  });

  it('holds exactly the six keys of the format, and no process id', async () => {
    const deps = make();
    await writeWorkerRecord(deps, HOME, worker());
    expect(Object.keys(stored(deps) as Record<string, unknown>).sort()).toEqual(
      ['branch', 'created_at', 'id', 'project', 'schema', 'work_copy'].sort(),
    );
  });

  it('writes one file for each of two workers, and neither file holds the other worker', async () => {
    const deps = make();
    await writeWorkerRecord(deps, HOME, worker());
    await writeWorkerRecord(deps, HOME, worker({ id: 'api-fix', project: 'api', workCopy: '/h/node/work-copies/api/api-fix', branch: 'factory/api-fix' }));
    expect([...deps.files.keys()].filter((path) => path.endsWith('/worker.json')).sort()).toEqual([
      recordPath('api-fix'),
      recordPath('web-search'),
    ]);
    expect(stored(deps, 'web-search')).toMatchObject({ id: 'web-search', project: 'web' });
    expect(stored(deps, 'api-fix')).toMatchObject({ id: 'api-fix', project: 'api' });
  });

  it('makes the folder of the worker and its inbox folder, and sets the private modes', async () => {
    const deps = make();
    await writeWorkerRecord(deps, HOME, worker());
    expect(deps.dirs.has(`${WORKERS}/web-search/inbox`)).toBe(true);
    expect(deps.modes.get(`${WORKERS}/web-search`)).toBe(workerRecord.folderMode);
    expect(deps.modes.get(recordPath('web-search'))).toBe(workerRecord.fileMode);
  });

  it('fails for a second write with the same id, and keeps the first record as it was', async () => {
    const deps = make();
    await writeWorkerRecord(deps, HOME, worker());
    const before = snapshot(deps);
    const second = await writeWorkerRecord(deps, HOME, worker({ project: 'api', branch: 'factory/other' }));
    expect(errorOf(second).kind).toBe('failure');
    expect(errorOf(second).message).toContain('web-search');
    expect(snapshot(deps)).toBe(before);
  });

  it('fails for an id that has a record already, also when the record is not valid', async () => {
    const deps = make();
    deps.seed(recordPath('web-search'), 'not json');
    expect(errorOf(await writeWorkerRecord(deps, HOME, worker())).kind).toBe('failure');
    expect(deps.files.get(recordPath('web-search'))).toBe('not json');
  });

  it.each([
    ['an id that is not a slug', { id: 'Web Search' }],
    ['an id that is a path', { id: '../web' }],
    ['an empty id', { id: '' }],
    ['an id that starts with a dash', { id: '-x' }],
    ['a project that is not a slug', { project: 'Web' }],
    ['a work copy that is not an absolute path', { workCopy: 'work-copies/web/web-search' }],
    ['an empty work copy', { workCopy: '' }],
    ['a branch that starts with a dash', { branch: '--delete' }],
    ['a branch with a space', { branch: 'a b' }],
    ['an empty branch', { branch: '' }],
  ])('refuses %s, and writes and makes nothing', async (_name, change) => {
    const deps = make();
    const before = snapshot(deps);
    expect(errorOf(await writeWorkerRecord(deps, HOME, worker(change))).kind).toBe('failure');
    expect(snapshot(deps)).toBe(before);
  });

  it('never writes a field that the format does not have, such as a process id', async () => {
    const deps = make();
    const withPid = { ...worker(), pid: 1234 } as unknown as NewWorker;
    await writeWorkerRecord(deps, HOME, withPid);
    expect(stored(deps)).toEqual(fileOf());
  });

  it('does not repeat a refused value in the error', async () => {
    const deps = make();
    const result = await writeWorkerRecord(deps, HOME, worker({ branch: '--secret-branch-value' }));
    expect(errorOf(result).message).not.toContain('secret-branch-value');
  });

  it('stops with a security refusal when the workers folder is a link, and writes nothing', async () => {
    const deps = make({ links: { [WORKERS]: '/elsewhere' } });
    deps.seedDir(WORKERS);
    const before = snapshot(deps);
    expect(errorOf(await writeWorkerRecord(deps, HOME, worker())).kind).toBe('safety');
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with a security refusal when the folder of the worker is a link, and writes nothing', async () => {
    const deps = make({ links: { [`${WORKERS}/web-search`]: '/elsewhere' } });
    deps.seedDir(WORKERS);
    const before = snapshot(deps);
    expect(errorOf(await writeWorkerRecord(deps, HOME, worker())).kind).toBe('safety');
    expect(snapshot(deps)).toBe(before);
  });

  it('fails when the workers folder is a file', async () => {
    const deps = make();
    deps.seed(WORKERS, 'x');
    expect(errorOf(await writeWorkerRecord(deps, HOME, worker())).kind).toBe('failure');
  });

  it('passes the failure of the exclusive write on, and returns no record', async () => {
    const deps = make();
    const broken: Deps = { ...deps, fs: { ...deps.fs, writeTextExclusive: async () => failure('disk full') } };
    expect(errorOf(await writeWorkerRecord(broken, HOME, worker())).message).toContain('disk full');
  });

  it('writes with the exclusive call, and never with an overwrite', async () => {
    const deps = make();
    const calls: string[] = [];
    await writeWorkerRecord(
      withFsWatch(deps, (method) => calls.push(method)),
      HOME,
      worker(),
    );
    expect(calls).toContain('writeTextExclusive');
    expect(calls.filter((method) => ['writeText', 'writeTextAtomic', 'rename', 'remove'].includes(method))).toEqual([]);
  });
});

describe('readWorkerRecord', () => {
  it('reads a valid record', async () => {
    const deps = make();
    seedRecord(deps);
    expect(await readOf(deps)).toEqual({
      state: 'valid',
      record: { id: 'web-search', project: 'web', workCopy: '/h/node/work-copies/web/web-search', branch: 'factory/web-search', createdAt: T0 },
    });
  });

  it('reads back the record that the write made', async () => {
    const deps = make();
    const written = valueOf(await writeWorkerRecord(deps, HOME, worker()));
    expect(await readOf(deps)).toEqual({ state: 'valid', record: written });
  });

  it('gives absent when there is no workers folder, no folder of the worker, or no record file', async () => {
    const deps = make();
    expect(await readOf(deps)).toEqual({ state: 'absent' });
    deps.seedDir(WORKERS);
    expect(await readOf(deps)).toEqual({ state: 'absent' });
    deps.seedDir(`${WORKERS}/web-search`);
    expect(await readOf(deps)).toEqual({ state: 'absent' });
  });

  it.each([
    ['an id that is not a slug', '../web'],
    ['an id with upper case letters', 'Web'],
    ['an empty id', ''],
  ])('gives invalid for %s, and touches no path', async (_name, id) => {
    const deps = make();
    const touched: string[] = [];
    const result = valueOf(await readWorkerRecord(withFsWatch(deps, (_method, path) => touched.push(path)), HOME, id));
    expect(result).toMatchObject({ state: 'invalid' });
    expect(touched).toEqual([]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON text that is not an object', '[1,2]'],
    ['an empty file', ''],
  ])('gives invalid for %s', async (_name, text) => {
    const deps = make();
    deps.seed(recordPath('web-search'), text);
    expect(await readOf(deps)).toMatchObject({ state: 'invalid' });
  });

  it.each([
    ['a key that the format does not have', { pid: 1234 }],
    ['another schema id', { schema: 'factory.worker/v2' }],
    ['no schema id', { schema: undefined }],
    ['an id that is not a slug', { id: 'Web' }],
    ['an id that differs from the folder name', { id: 'api-fix' }],
    ['a project that is not a slug', { project: 'Web' }],
    ['a work copy that is not absolute', { work_copy: 'a/b' }],
    ['a branch that starts with a dash', { branch: '-x' }],
    ['a time that is not ISO', { created_at: 'yesterday' }],
    ['no time', { created_at: undefined }],
    ['a number for the project', { project: 5 }],
  ])('gives invalid for %s', async (_name, fields) => {
    const deps = make();
    seedRecord(deps, 'web-search', fields);
    expect(await readOf(deps)).toMatchObject({ state: 'invalid' });
  });

  it('never holds the content of the file in the reason', async () => {
    const deps = make();
    seedRecord(deps, 'web-search', { branch: '--secret-branch-value', note: 'secret-extra-value' });
    const read = await readOf(deps);
    expect(read).toMatchObject({ state: 'invalid' });
    expect(JSON.stringify(read)).not.toContain('secret');
  });

  it('gives invalid for a file that is a link, a folder that is a link and a workers folder that is a link, and reads no file', async () => {
    for (const link of [recordPath('web-search'), `${WORKERS}/web-search`, WORKERS]) {
      const deps = make({ links: { [link]: '/elsewhere' } });
      seedRecord(deps);
      const reads: string[] = [];
      const watched = withFsWatch(deps, (method, path) => {
        if (method.startsWith('read')) reads.push(path);
      });
      expect(valueOf(await readWorkerRecord(watched, HOME, 'web-search'))).toMatchObject({ state: 'invalid' });
      expect(reads).toEqual([]);
    }
  });

  it('gives invalid when the record path is a folder', async () => {
    const deps = make();
    deps.seedDir(recordPath('web-search'));
    expect(await readOf(deps)).toMatchObject({ state: 'invalid' });
  });

  it('gives invalid for a file of more bytes than the cap, and reads none of it', async () => {
    const deps = make();
    deps.seed(recordPath('web-search'), 'x'.repeat(workerRecord.maxBytes + 1));
    const reads: string[] = [];
    const watched = withFsWatch(deps, (method, path) => {
      if (method.startsWith('read')) reads.push(path);
    });
    expect(valueOf(await readWorkerRecord(watched, HOME, 'web-search'))).toMatchObject({ state: 'invalid' });
    expect(reads).toEqual([]);
  });

  it('reads a file of exactly the cap', async () => {
    const deps = make();
    const base = `${JSON.stringify(fileOf())}\n`;
    const padded = base + ' '.repeat(workerRecord.maxBytes - Buffer.byteLength(base, 'utf8'));
    deps.seed(recordPath('web-search'), padded);
    expect(await readOf(deps)).toMatchObject({ state: 'valid' });
  });

  it('fails with the fault of the file system', async () => {
    const deps = make();
    seedRecord(deps);
    const broken: Deps = { ...deps, fs: { ...deps.fs, readTextLimited: async () => failure('EIO') } };
    expect(errorOf(await readWorkerRecord(broken, HOME, 'web-search')).message).toContain('EIO');
  });

  it('changes nothing', async () => {
    const deps = make();
    seedRecord(deps);
    const before = snapshot(deps);
    await readOf(deps);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('listWorkerRecords', () => {
  it('gives an empty list when there is no workers folder, and when it is empty', async () => {
    const deps = make();
    expect(await listOf(deps)).toEqual({ workers: [], invalid: [] });
    deps.seedDir(WORKERS);
    expect(await listOf(deps)).toEqual({ workers: [], invalid: [] });
  });

  it('lists every valid record in the order of the ids', async () => {
    const deps = make();
    seedRecord(deps, 'web-search', { project: 'web' });
    seedRecord(deps, 'api-fix', { project: 'api' });
    seedRecord(deps, 'docs', { project: 'docs' });
    const list = await listOf(deps);
    expect(list.workers.map((entry) => entry.id)).toEqual(['api-fix', 'docs', 'web-search']);
    expect(list.invalid).toEqual([]);
  });

  it('lists the two records that two writes made (TP-9)', async () => {
    const deps = make();
    await writeWorkerRecord(deps, HOME, worker());
    await writeWorkerRecord(deps, HOME, worker({ id: 'api-fix', project: 'api', workCopy: '/h/node/work-copies/api/api-fix', branch: 'factory/api-fix' }));
    expect((await listOf(deps)).workers.map((entry) => entry.id)).toEqual(['api-fix', 'web-search']);
  });

  it('names an invalid record, and still lists the valid ones', async () => {
    const deps = make();
    seedRecord(deps, 'api-fix');
    deps.seed(recordPath('broken'), '{"secret":"secret-file-content"');
    seedRecord(deps, 'docs');
    seedRecord(deps, 'mismatch', { id: 'docs' });
    const list = await listOf(deps);
    expect(list.workers.map((entry) => entry.id)).toEqual(['api-fix', 'docs']);
    expect(list.invalid.map((entry) => entry.name)).toEqual(['broken', 'mismatch']);
    expect(list.invalid.every((entry) => entry.reason !== '')).toBe(true);
    expect(JSON.stringify(list.invalid)).not.toContain('secret');
  });

  it('names a folder that has no record file', async () => {
    const deps = make();
    seedRecord(deps, 'api-fix');
    deps.seedDir(`${WORKERS}/half-made/inbox`);
    const list = await listOf(deps);
    expect(list.workers.map((entry) => entry.id)).toEqual(['api-fix']);
    expect(list.invalid).toEqual([{ name: 'half-made', reason: `the folder has no ${files.workerRecord}` }]);
  });

  it('names an entry that is a file, an entry that is a link and an entry that is not a slug, and does not follow the link', async () => {
    const deps = make({ links: { [`${WORKERS}/linked`]: '/elsewhere' } });
    seedRecord(deps, 'api-fix');
    deps.seed(`${WORKERS}/notes`, 'x');
    deps.seedDir(`${WORKERS}/linked`);
    deps.seedDir(`${WORKERS}/Bad Name`);
    const list = await listOf(deps);
    expect(list.workers.map((entry) => entry.id)).toEqual(['api-fix']);
    expect(list.invalid.map((entry) => entry.name).sort()).toEqual([JSON.stringify('Bad Name'), 'linked', 'notes']);
  });

  it('shows a name with a control character as an escaped text', async () => {
    const deps = make();
    deps.seedDir(`${WORKERS}/a\u001b[2Jb`);
    const names = (await listOf(deps)).invalid.map((entry) => entry.name);
    expect(names).toEqual([JSON.stringify('a\u001b[2Jb')]);
    expect(names.join('')).not.toContain('\u001b');
  });

  it('keeps the valid records when the read of one record meets a fault of the file system', async () => {
    const deps = make();
    seedRecord(deps, 'api-fix');
    seedRecord(deps, 'docs');
    const broken: Deps = {
      ...deps,
      fs: { ...deps.fs, readTextLimited: async (path, max) => (path === recordPath('api-fix') ? failure('EIO') : deps.fs.readTextLimited(path, max)) },
    };
    const list = valueOf(await listWorkerRecords(broken, HOME));
    expect(list.workers.map((entry) => entry.id)).toEqual(['docs']);
    expect(list.invalid.map((entry) => entry.name)).toEqual(['api-fix']);
  });

  it('stops with a security refusal when the workers folder is a link', async () => {
    const deps = make({ links: { [WORKERS]: '/elsewhere' } });
    deps.seedDir(WORKERS);
    seedRecord(deps);
    expect(errorOf(await listWorkerRecords(deps, HOME)).kind).toBe('safety');
  });

  it('fails when the workers folder is a file', async () => {
    const deps = make();
    deps.seed(WORKERS, 'x');
    expect(errorOf(await listWorkerRecords(deps, HOME)).kind).toBe('failure');
  });

  it('fails with the fault of the file system when the folder cannot be listed', async () => {
    const deps = make();
    deps.seedDir(WORKERS);
    const broken: Deps = { ...deps, fs: { ...deps.fs, list: async () => failure('EACCES') } };
    expect(errorOf(await listWorkerRecords(broken, HOME)).message).toContain('EACCES');
  });

  it('fails, and does not cut the list short, when the folder holds more entries than the bound', async () => {
    const deps = make();
    for (let index = 0; index <= workerRecord.maxEntries; index += 1) deps.seedDir(`${WORKERS}/w${index}`);
    expect(errorOf(await listWorkerRecords(deps, HOME)).kind).toBe('failure');
  });

  it('lists a folder with exactly the bound of entries', async () => {
    const deps = make();
    for (let index = 0; index < workerRecord.maxEntries; index += 1) deps.seedDir(`${WORKERS}/w${index}`);
    const list = await listOf(deps);
    expect(list.invalid).toHaveLength(workerRecord.maxEntries);
  });

  it('changes nothing', async () => {
    const deps = make();
    seedRecord(deps);
    deps.seed(recordPath('broken'), 'x');
    const before = snapshot(deps);
    await listOf(deps);
    expect(snapshot(deps)).toBe(before);
  });
});
