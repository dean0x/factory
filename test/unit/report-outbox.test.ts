import { describe, expect, it } from 'vitest';
import { failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { NodeReport } from '../../src/comms/report-schema.js';
import type { Deps } from '../../src/core/deps.js';
import { layers, privateFile, reportLimits, schemaIds } from '../../src/names.js';
import { reportTextOf } from '../../src/report/build.js';
import { writeReportFile } from '../../src/report/outbox.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const HOME = '/w/node';
const LAYOUT = layoutOf(HOME);

const REPORT: NodeReport = {
  schema: schemaIds.report,
  schemaVersion: reportLimits.schemaVersion,
  id: 'alpha',
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

const WIDE_MODE = 0o755;

const nodeWithOutbox = (options: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => {
  const deps = createFakeDeps(options);
  deps.seedDir(HOME);
  deps.seedDir(LAYOUT.stateDir);
  deps.seedDir(LAYOUT.outboxDir);
  return deps;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('the call should have failed');
  return result.error;
};

describe('report file writer: the mode of an outbox folder that exists', () => {
  it('gives the folder mode 700 before it writes the file', async () => {
    const deps = nodeWithOutbox();
    deps.modes.set(LAYOUT.outboxDir, WIDE_MODE);
    const result = await writeReportFile(deps, HOME, REPORT);
    expect(result).toEqual({ ok: true, value: 'written' });
    expect(deps.modes.get(LAYOUT.outboxDir)).toBe(privateFile.folderMode);
    expect(deps.files.get(LAYOUT.reportFile)).toBe(reportTextOf(REPORT));
  });

  it('refuses the write with a failure, and leaves the older file, when the mode cannot be set', async () => {
    const deps = nodeWithOutbox();
    deps.modes.set(LAYOUT.outboxDir, WIDE_MODE);
    deps.seed(LAYOUT.reportFile, 'old text\n');
    const denied: Deps = { ...deps, fs: { ...deps.fs, chmod: async (path) => failure(`cannot change the mode of ${path}: EPERM`) } };
    const error = errorOf(await writeReportFile(denied, HOME, REPORT));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('EPERM');
    expect(deps.files.get(LAYOUT.reportFile)).toBe('old text\n');
    expect([...deps.files.keys()]).toEqual([LAYOUT.reportFile]);
    expect(deps.modes.get(LAYOUT.outboxDir)).toBe(WIDE_MODE);
  });

  it.each([
    ['the outbox folder', LAYOUT.outboxDir],
    ['the factory folder', LAYOUT.stateDir],
  ])('stops with exit 4, and changes no mode, when %s is a link', async (_name, path) => {
    const deps = nodeWithOutbox({ links: { [path]: '/outside/place' } });
    deps.modes.set(LAYOUT.outboxDir, WIDE_MODE);
    const changed: string[] = [];
    const watched: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        chmod: async (target, mode) => {
          changed.push(target);
          return deps.fs.chmod(target, mode);
        },
      },
    };
    expect(errorOf(await writeReportFile(watched, HOME, REPORT)).kind).toBe('safety');
    expect(changed).toEqual([]);
    expect(deps.modes.get(LAYOUT.outboxDir)).toBe(WIDE_MODE);
  });
});
