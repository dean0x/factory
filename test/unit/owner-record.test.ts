import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import {
  delegationReport,
  effectiveModes,
  readOwnerRecords,
  recordDelegation,
  recordScope,
  type OwnerRecord,
} from '../../src/core/owner-record.js';
import { startSteps } from '../../src/launch/tmux.js';
import { env, ownerRecords, values } from '../../src/names.js';
import type { ApprovalMode } from '../../src/recipes/index.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';

const [owner, delegated] = values.approvalModes;
const ROOT = '/w/factory-root';
const OTHER_ROOT = '/w/other-root';
const STATE = '/state';
const FOLDER = '/state/factory';
const STORE = '/state/factory/owner-records.json';
const NODE = 'demo';

interface Options {
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly env?: Record<string, string | undefined>;
}

/** Fake deps for a person in a terminal window outside a factory session, with a state folder and two roots. */
const person = (options: Options = {}): FakeDeps => {
  const deps = createFakeDeps({
    env: options.env ?? { XDG_STATE_HOME: STATE, HOME: '/home/me' },
    stdinIsTTY: options.stdinIsTTY ?? true,
    stdoutIsTTY: options.stdoutIsTTY ?? true,
  });
  deps.seedDir(ROOT);
  deps.seedDir(OTHER_ROOT);
  return deps;
};

const delegation = (overrides: Partial<Extract<OwnerRecord, { kind: 'delegation' }>> = {}): OwnerRecord => ({
  kind: 'delegation',
  node: NODE,
  root: ROOT,
  point: 'merge',
  mode: delegated,
  at: '2030-01-02T03:04:05.678Z',
  ...overrides,
});

const storeOf = (records: readonly OwnerRecord[]): string => `${JSON.stringify({ schema: 1, records })}\n`;

const seedStore = (deps: FakeDeps, records: readonly OwnerRecord[]): void => deps.seed(STORE, storeOf(records));

const storedRecords = (deps: FakeDeps): OwnerRecord[] =>
  (JSON.parse(deps.files.get(STORE) ?? '{"records":[]}') as { records: OwnerRecord[] }).records;

const configWith = (approval: Record<string, ApprovalMode>, nodeId = NODE): FactoryConfig => {
  const config = sampleConfig();
  return { ...config, core: { ...config.core, node: { ...config.core.node, id: nodeId }, approval: { ...config.core.approval, ...approval } } };
};

const setMode = (deps: Deps, point: string, mode: ApprovalMode, root = ROOT, node = NODE) =>
  recordDelegation(deps, { root, node, point, mode });

describe('approval records: who may write', () => {
  it('writes a delegation for a person in a terminal window outside a factory session', async () => {
    const deps = person();
    expect(await setMode(deps, 'merge', delegated)).toEqual({ ok: true, value: undefined });
    expect(storedRecords(deps)).toEqual([
      { kind: 'delegation', node: NODE, root: ROOT, point: 'merge', mode: delegated, at: '2030-01-02T03:04:05.678Z' },
    ]);
  });

  it('refuses with no terminal window, exits 4 and writes no file', async () => {
    const deps = person({ stdinIsTTY: false });
    const result = await setMode(deps, 'merge', delegated);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.files.has(STORE)).toBe(false);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('refuses inside a factory session although a terminal window is there, and writes no file', async () => {
    const deps = person({ env: { XDG_STATE_HOME: STATE, HOME: '/home/me', [env.session]: 'demo' } });
    expect(deps.stdinIsTTY).toBe(true);
    const result = await setMode(deps, 'merge', delegated);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.files.has(STORE)).toBe(false);
  });

  it('refuses inside a factory session with no terminal window, too', async () => {
    const deps = person({ stdinIsTTY: false, env: { XDG_STATE_HOME: STATE, [env.session]: 'demo' } });
    expect(await setMode(deps, 'merge', delegated)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('refuses the mode owner in the same two cases, because it writes through the same writer', async () => {
    const noWindow = person({ stdinIsTTY: false });
    const inSession = person({ env: { XDG_STATE_HOME: STATE, [env.session]: 'demo' } });
    for (const deps of [noWindow, inSession]) {
      expect(await setMode(deps, 'merge', owner)).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.files.has(STORE)).toBe(false);
    }
  });

  it('needs input from a terminal window, and lets the output go elsewhere', async () => {
    const deps = person({ stdoutIsTTY: false });
    expect(await setMode(deps, 'merge', delegated)).toMatchObject({ ok: true });
  });

  it('refuses a scope in the same two cases', async () => {
    const noWindow = person({ stdinIsTTY: false });
    const inSession = person({ env: { XDG_STATE_HOME: STATE, [env.session]: 'demo' } });
    for (const deps of [noWindow, inSession]) {
      const result = await recordScope(deps, { root: ROOT, node: NODE, project: 'web', version: '1.2.0', items: ['#1'] });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.files.has(STORE)).toBe(false);
    }
  });

  it('refuses with the session marker that the start steps put in the environment of the session (TP-80)', async () => {
    const program = ['/opt/bin/node', '/opt/lib/factory.js'] as const;
    const steps = startSteps({ id: NODE, home: ROOT, coordinatorDir: `${ROOT}/coordinator`, launch: ['claude'], program });
    const call = steps.find((step) => step.includes('set-environment') && step.includes(env.session));
    expect(call).toBeDefined();
    const at = (call ?? []).indexOf(env.session);
    const marker = { [(call ?? [])[at] ?? '']: (call ?? [])[at + 1] };
    const deps = person({ env: { XDG_STATE_HOME: STATE, ...marker } });
    expect(await setMode(deps, 'merge', delegated)).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.files.has(STORE)).toBe(false);
  });
});

describe('approval records: the store', () => {
  it('is a file in the state folder of the user with mode 0600, in a folder of mode 0700 (TP-41)', async () => {
    const deps = person();
    await setMode(deps, 'merge', delegated);
    expect(deps.files.has(STORE)).toBe(true);
    expect(deps.modes.get(STORE)).toBe(0o600);
    expect(deps.modes.get(FOLDER)).toBe(0o700);
  });

  it('is outside the factory folder: a state folder inside the folder is refused and nothing is written', async () => {
    const deps = person({ env: { XDG_STATE_HOME: `${ROOT}/state`, HOME: '/home/me' } });
    const result = await setMode(deps, 'merge', delegated);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.files.has(`${ROOT}/state/factory/owner-records.json`)).toBe(false);
  });

  it('has no place when no variable names a state folder', async () => {
    const deps = person({ env: {} });
    const result = await setMode(deps, 'merge', delegated);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('keeps only the newest record for a node id, a root and a point (TP-92)', async () => {
    const deps = person();
    await setMode(deps, 'merge', delegated);
    deps.advance(1000);
    await setMode(deps, 'merge', owner);
    deps.advance(1000);
    await setMode(deps, 'merge', delegated);
    const records = storedRecords(deps);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ point: 'merge', mode: delegated, at: '2030-01-02T03:04:07.678Z' });
  });

  it('keeps a record for another point, another node id and another root next to it', async () => {
    const deps = person();
    await setMode(deps, 'merge', delegated);
    await setMode(deps, 'release', delegated);
    await setMode(deps, 'merge', delegated, ROOT, 'other');
    await setMode(deps, 'merge', delegated, OTHER_ROOT);
    expect(storedRecords(deps)).toHaveLength(4);
    await setMode(deps, 'merge', owner);
    expect(storedRecords(deps)).toHaveLength(4);
  });

  it('removes a second record of one key when it writes, so the store keeps one', async () => {
    const deps = person();
    seedStore(deps, [delegation(), delegation({ at: '2029-01-01T00:00:00.000Z', mode: owner })]);
    await setMode(deps, 'merge', delegated);
    expect(storedRecords(deps)).toHaveLength(1);
  });

  it('refuses a file over its size cap, in the reader and in the writer (TP-92)', async () => {
    const deps = person();
    deps.seed(STORE, ' '.repeat(ownerRecords.maxBytes + 1));
    const read = await readOwnerRecords(deps, STORE);
    expect(read).toMatchObject({ ok: false, error: expect.stringContaining('larger than') });
    const written = await setMode(deps, 'merge', delegated);
    expect(written).toMatchObject({ ok: false });
    expect(deps.files.get(STORE)).toBe(' '.repeat(ownerRecords.maxBytes + 1));
  });

  it('reads a file at its size cap', async () => {
    const deps = person();
    const body = storeOf([]);
    deps.seed(STORE, body + ' '.repeat(ownerRecords.maxBytes - Buffer.byteLength(body, 'utf8')));
    expect(await readOwnerRecords(deps, STORE)).toEqual({ ok: true, value: [] });
  });

  it('holds at most the number of records that the cap names, and still replaces a record at the cap', async () => {
    const deps = person();
    const full = Array.from({ length: ownerRecords.maxRecords }, (_, index) => delegation({ node: `n${index}` }));
    seedStore(deps, full);
    const more = await setMode(deps, 'merge', delegated, ROOT, 'one-more');
    expect(more).toMatchObject({ ok: false });
    expect(storedRecords(deps)).toHaveLength(ownerRecords.maxRecords);
    expect(await setMode(deps, 'merge', owner, ROOT, 'n7')).toMatchObject({ ok: true });
    expect(storedRecords(deps)).toHaveLength(ownerRecords.maxRecords);
  });

  it('refuses a store that is not valid, and leaves it as it was', async () => {
    const deps = person();
    deps.seed(STORE, '{"schema":1,"records":[{"kind":"delegation","node":"demo"}]}');
    const result = await setMode(deps, 'merge', delegated);
    expect(result).toMatchObject({ ok: false });
    expect(deps.files.get(STORE)).toBe('{"schema":1,"records":[{"kind":"delegation","node":"demo"}]}');
  });

  describe('who may use the file (TP-41)', () => {
    const seeded = (): FakeDeps => {
      const deps = person();
      seedStore(deps, [delegation()]);
      return deps;
    };

    it.each([
      ['a file that a group may write', STORE, 0o660],
      ['a file that other users may write', STORE, 0o606],
      ['a folder that a group may write', FOLDER, 0o770],
    ])('refuses %s', async (_name, path, mode) => {
      const deps = seeded();
      deps.modes.set(path, mode);
      expect(await readOwnerRecords(deps, STORE)).toMatchObject({ ok: false, error: expect.stringContaining('written') });
      expect(await setMode(deps, 'release', delegated)).toMatchObject({ ok: false });
      expect(storedRecords(deps)).toHaveLength(1);
    });

    it.each([
      ['file', STORE],
      ['folder', FOLDER],
    ])('refuses a %s that another user owns', async (_name, path) => {
      const deps = seeded();
      deps.owners.set(path, 2000);
      expect(await readOwnerRecords(deps, STORE)).toMatchObject({ ok: false, error: expect.stringContaining('another user') });
      expect(await setMode(deps, 'release', delegated)).toMatchObject({ ok: false });
      expect(storedRecords(deps)).toHaveLength(1);
    });
  });
});

describe('the delegation report (TP-78)', () => {
  const NEWER = '2030-06-07T08:09:10.000Z';

  it('lists no delegation and no unmatched value when each local value is owner', async () => {
    const deps = person();
    seedStore(deps, [delegation()]);
    expect(await delegationReport(deps, ROOT, configWith({}))).toEqual({
      modes: { merge: owner, release: owner },
      active: [],
      unmatched: [],
    });
  });

  it('lists an active delegation with the time of its record, in the order of the recipe', async () => {
    const deps = person();
    seedStore(deps, [delegation({ point: 'release', at: NEWER }), delegation()]);
    const report = await delegationReport(deps, ROOT, configWith({ merge: delegated, release: delegated }));
    expect(report.active).toEqual([
      { point: 'merge', at: '2030-01-02T03:04:05.678Z' },
      { point: 'release', at: NEWER },
    ]);
    expect(report.unmatched).toEqual([]);
    expect(report.modes).toEqual({ merge: delegated, release: delegated });
  });

  it('names a delegated value with no record as unmatched, and counts it as owner', async () => {
    const deps = person();
    seedStore(deps, [delegation()]);
    const report = await delegationReport(deps, ROOT, configWith({ merge: delegated, release: delegated }));
    expect(report.unmatched).toEqual(['release']);
    expect(report.active.map((entry) => entry.point)).toEqual(['merge']);
    expect(report.modes).toEqual({ merge: delegated, release: owner });
  });

  it('names a delegated value as unmatched when a newer record ends the delegation', async () => {
    const deps = person();
    seedStore(deps, [delegation(), delegation({ mode: owner, at: NEWER })]);
    const report = await delegationReport(deps, ROOT, configWith({ merge: delegated }));
    expect(report.active).toEqual([]);
    expect(report.unmatched).toEqual(['merge']);
  });

  it('names every delegated value as unmatched when the store cannot be used', async () => {
    const deps = person();
    deps.seed(STORE, 'not json');
    const report = await delegationReport(deps, ROOT, configWith({ merge: delegated }));
    expect(report.unmatched).toEqual(['merge']);
    expect(report.modes).toEqual({ merge: owner, release: owner });
  });

  it('gives the same modes as effectiveModes', async () => {
    const deps = person();
    seedStore(deps, [delegation()]);
    const config = configWith({ merge: delegated, release: delegated });
    expect((await delegationReport(deps, ROOT, config)).modes).toEqual(await effectiveModes(deps, ROOT, config));
  });
});

describe('effective modes (TP-79)', () => {
  const modeOf = async (deps: Deps, config: FactoryConfig, point = 'merge'): Promise<string | undefined> =>
    (await effectiveModes(deps, ROOT, config))[point];

  it('gives owner for every point when each local value is owner, with or without a record', async () => {
    const deps = person();
    expect(await effectiveModes(deps, ROOT, configWith({}))).toEqual({ merge: owner, release: owner });
    seedStore(deps, [delegation(), delegation({ point: 'release' })]);
    expect(await effectiveModes(deps, ROOT, configWith({}))).toEqual({ merge: owner, release: owner });
  });

  it('gives owner for a delegated value with no matching record (TP-40)', async () => {
    const deps = person();
    expect(await modeOf(deps, configWith({ merge: delegated }))).toBe(owner);
  });

  it('gives delegated for a delegated value with a delegated record, and owner for the other point', async () => {
    const deps = person();
    await setMode(deps, 'merge', delegated);
    expect(await effectiveModes(deps, ROOT, configWith({ merge: delegated, release: delegated }))).toEqual({
      merge: delegated,
      release: owner,
    });
  });

  it('gives owner for a delegated value when the newest record has the mode owner', async () => {
    const deps = person();
    await setMode(deps, 'merge', owner);
    expect(await modeOf(deps, configWith({ merge: delegated }))).toBe(owner);
  });

  it('ends a delegation with a newer record of the mode owner', async () => {
    const deps = person();
    await setMode(deps, 'merge', delegated);
    const config = configWith({ merge: delegated });
    expect(await modeOf(deps, config)).toBe(delegated);
    deps.advance(1000);
    await setMode(deps, 'merge', owner);
    expect(await modeOf(deps, config)).toBe(owner);
  });

  it('takes the newest of two records of one key in a file, whatever their order', async () => {
    const older = delegation({ mode: owner, at: '2029-01-01T00:00:00.000Z' });
    const newer = delegation({ mode: delegated, at: '2030-01-01T00:00:00.000Z' });
    for (const records of [[older, newer], [newer, older]]) {
      const deps = person();
      seedStore(deps, records);
      expect(await modeOf(deps, configWith({ merge: delegated }))).toBe(delegated);
    }
  });

  it('gives owner when two records of one key have one time and one of them has the mode owner', async () => {
    const deps = person();
    seedStore(deps, [delegation({ mode: delegated }), delegation({ mode: owner })]);
    expect(await modeOf(deps, configWith({ merge: delegated }))).toBe(owner);
  });

  it('does not count a record of another node id, another folder or another point', async () => {
    for (const record of [delegation({ node: 'other' }), delegation({ root: OTHER_ROOT }), delegation({ point: 'release' })]) {
      const deps = person();
      seedStore(deps, [record]);
      expect(await modeOf(deps, configWith({ merge: delegated }))).toBe(owner);
    }
  });

  it('compares the real path of the folder: a folder behind a link finds the record of its real path', async () => {
    const deps = createFakeDeps({
      env: { XDG_STATE_HOME: STATE },
      stdinIsTTY: true,
      links: { '/w/link': ROOT },
    });
    deps.seedDir(ROOT);
    deps.seedDir('/w/link');
    seedStore(deps, [delegation()]);
    expect(await effectiveModes(deps, '/w/link', configWith({ merge: delegated }))).toMatchObject({ merge: delegated });
  });

  it('ends a delegation when the folder moves, because the record names the old real path', async () => {
    const deps = person();
    await setMode(deps, 'merge', delegated);
    const moved = '/w/moved-root';
    deps.seedDir(moved);
    expect(await effectiveModes(deps, moved, configWith({ merge: delegated }))).toMatchObject({ merge: owner });
  });

  it('does not count a record file inside the folder or inside its state folder (TP-40)', async () => {
    const deps = person();
    for (const inside of [`${ROOT}/owner-records.json`, `${ROOT}/.factory/owner-records.json`, `${ROOT}/state/factory/owner-records.json`]) {
      deps.seed(inside, storeOf([delegation()]));
    }
    expect(await modeOf(deps, configWith({ merge: delegated }))).toBe(owner);
  });

  it('gives owner when the state folder is inside the factory folder, also with a record in it', async () => {
    const deps = person({ env: { XDG_STATE_HOME: `${ROOT}/state`, HOME: '/home/me' } });
    deps.seed(`${ROOT}/state/factory/owner-records.json`, storeOf([delegation()]));
    expect(await modeOf(deps, configWith({ merge: delegated }))).toBe(owner);
  });

  it('gives owner when the store file belongs to another user or a group can write it', async () => {
    const other = person();
    seedStore(other, [delegation()]);
    other.owners.set(STORE, 2000);
    expect(await modeOf(other, configWith({ merge: delegated }))).toBe(owner);

    const writable = person();
    seedStore(writable, [delegation()]);
    writable.modes.set(STORE, 0o664);
    expect(await modeOf(writable, configWith({ merge: delegated }))).toBe(owner);
  });

  it('gives owner when the store is not valid, too large or has no place', async () => {
    const broken = person();
    broken.seed(STORE, 'not json');
    expect(await modeOf(broken, configWith({ merge: delegated }))).toBe(owner);

    const large = person();
    large.seed(STORE, ' '.repeat(ownerRecords.maxBytes + 1));
    expect(await modeOf(large, configWith({ merge: delegated }))).toBe(owner);

    const nowhere = person({ env: {} });
    expect(await modeOf(nowhere, configWith({ merge: delegated }))).toBe(owner);
  });

  it('does not read the store when no local value is delegated', async () => {
    const deps = person();
    seedStore(deps, [delegation()]);
    let reads = 0;
    const watched: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        readTextLimited: async (path, max) => {
          reads += 1;
          return deps.fs.readTextLimited(path, max);
        },
      },
    };
    await effectiveModes(watched, ROOT, configWith({}));
    expect(reads).toBe(0);
    await effectiveModes(watched, ROOT, configWith({ merge: delegated }));
    expect(reads).toBe(1);
  });

  describe('a scope is a record of its own kind', () => {
    const scope = { root: ROOT, node: NODE, project: 'web', version: '1.2.0', items: ['#10', '#11'] };

    it('does not replace a delegation record, and leaves the effective mode as it was', async () => {
      const deps = person();
      await setMode(deps, 'release', delegated);
      deps.advance(1000);
      expect(await recordScope(deps, scope)).toMatchObject({ ok: true });
      const records = storedRecords(deps);
      expect(records).toHaveLength(2);
      expect(records.filter((record) => record.kind === 'delegation')).toEqual([
        expect.objectContaining({ point: 'release', mode: delegated, at: '2030-01-02T03:04:05.678Z' }),
      ]);
      expect(await modeOf(deps, configWith({ release: delegated }), 'release')).toBe(delegated);
    });

    it('does not end a delegation, also with the same node id, folder and a project named like the point', async () => {
      const deps = person();
      await setMode(deps, 'release', delegated);
      await recordScope(deps, { ...scope, project: 'release', version: 'release' });
      expect(await modeOf(deps, configWith({ release: delegated }), 'release')).toBe(delegated);
    });

    it('does not make a delegation: a delegated value with only a scope gives owner', async () => {
      const deps = person();
      await recordScope(deps, scope);
      expect(await modeOf(deps, configWith({ release: delegated }), 'release')).toBe(owner);
    });

    it('is replaced only by a scope with the same node id, folder, project and version', async () => {
      const deps = person();
      await recordScope(deps, scope);
      await recordScope(deps, { ...scope, items: ['#12'] });
      expect(storedRecords(deps)).toHaveLength(1);
      await recordScope(deps, { ...scope, version: '1.3.0' });
      await recordScope(deps, { ...scope, project: 'api' });
      expect(storedRecords(deps)).toHaveLength(3);
    });

    it('is not replaced by a delegation record', async () => {
      const deps = person();
      await recordScope(deps, scope);
      await setMode(deps, 'release', owner);
      expect(storedRecords(deps).map((record) => record.kind).sort()).toEqual(['delegation', 'scope']);
    });
  });
});

describe('approval records, with a real file system', () => {
  let folder = '';
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'factory-owner-record-'));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const real = async (name: string): Promise<{ deps: Deps; root: string; store: string }> => {
    const state = join(folder, name, 'state');
    const root = join(folder, name, 'root');
    await mkdir(root, { recursive: true });
    const deps: Deps = {
      ...createNodeDeps(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { XDG_STATE_HOME: state, HOME: join(folder, name, 'home') },
    };
    return { deps, root, store: join(state, 'factory', 'owner-records.json') };
  };

  it('creates the folder with mode 0700 and the file with mode 0600, and the effective mode follows it', async () => {
    const { deps, root, store } = await real('modes');
    expect(await recordDelegation(deps, { root, node: NODE, point: 'merge', mode: delegated })).toMatchObject({ ok: true });
    expect((await stat(join(store, '..'))).mode & 0o777).toBe(0o700);
    expect((await stat(store)).mode & 0o777).toBe(0o600);
    expect(await effectiveModes(deps, root, configWith({ merge: delegated }))).toMatchObject({ merge: delegated });
  });

  it('refuses a file that a group can write, in the reader and in the effective mode', async () => {
    const { deps, root, store } = await real('group');
    await recordDelegation(deps, { root, node: NODE, point: 'merge', mode: delegated });
    await chmod(store, 0o660);
    expect(await readOwnerRecords(deps, store)).toMatchObject({ ok: false });
    expect(await effectiveModes(deps, root, configWith({ merge: delegated }))).toMatchObject({ merge: owner });
  });

  it('keeps one record for a point after two writes', async () => {
    const { deps, root, store } = await real('newest');
    await recordDelegation(deps, { root, node: NODE, point: 'merge', mode: delegated });
    await recordDelegation(deps, { root, node: NODE, point: 'merge', mode: owner });
    const records = await readOwnerRecords(deps, store);
    expect(records.ok && records.value).toHaveLength(1);
  });
});
