import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import {
  decisionIdsOf,
  decisionPlaceOf,
  delegationReport,
  effectiveModes,
  putDecision,
  readDecisionProof,
  readOwnerRecords,
  recordDelegation,
  recordScope,
  requireDecideChannel,
  type DecisionInput,
  type DecisionPlace,
  type DecisionRecord,
  type OwnerRecord,
} from '../../src/core/owner-record.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { startSteps } from '../../src/launch/tmux.js';
import { commands, env, ownerDecisions, ownerRecords, values } from '../../src/names.js';
import type { ApprovalMode } from '../../src/recipes/index.js';
import { createFakeDeps, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { stripComments } from '../helpers/source-scan.js';

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

  it('refuses with the session marker that the start steps put in the environment of the session', async () => {
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
  it('is a file in the state folder of the user with mode 0600, in a folder of mode 0700', async () => {
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

  it('keeps only the newest record for a node id, a root and a point', async () => {
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

  it('refuses a file over its size cap, in the reader and in the writer', async () => {
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

  describe('who may use the file', () => {
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

describe('the delegation report', () => {
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

describe('effective modes', () => {
  const modeOf = async (deps: Deps, config: FactoryConfig, point = 'merge'): Promise<string | undefined> =>
    (await effectiveModes(deps, ROOT, config))[point];

  it('gives owner for every point when each local value is owner, with or without a record', async () => {
    const deps = person();
    expect(await effectiveModes(deps, ROOT, configWith({}))).toEqual({ merge: owner, release: owner });
    seedStore(deps, [delegation(), delegation({ point: 'release' })]);
    expect(await effectiveModes(deps, ROOT, configWith({}))).toEqual({ merge: owner, release: owner });
  });

  it('gives owner for a delegated value with no matching record', async () => {
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

  it('does not count a record file inside the folder or inside its state folder', async () => {
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

const DECISIONS = '/state/factory/owner-decisions.json';
const DECISIONS_LOCK = `${DECISIONS}.lock`;
const STORE_LOCK = `${STORE}.lock`;
const ID = 'D-3';
const ENTRY = {
  id: ID,
  title: 'Pick a path',
  question: 'Which path do we take?',
  options: [
    { key: 'a', text: 'One' },
    { key: 'b', text: 'Two', rec: true },
  ],
};

const textOfEntry = (entry: Readonly<Record<string, unknown>>): string => {
  const text = canonicalRequestText(entry);
  if (!text.ok) throw new Error(text.error);
  return text.value;
};

const TEXT = textOfEntry(ENTRY);
const HASH = requestHashOf(TEXT);
const AT = '2030-01-02T03:04:05.678Z';

const decisionRecord = (overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  node: NODE,
  root: ROOT,
  id: ID,
  option: 'a',
  hash: HASH,
  at: AT,
  ...overrides,
});

const decisionsText = (records: readonly DecisionRecord[]): string =>
  `${JSON.stringify({ schema: ownerDecisions.schema, records }, null, 2)}\n`;

const seedDecisions = (deps: FakeDeps, records: readonly DecisionRecord[]): void =>
  deps.seed(DECISIONS, decisionsText(records));

const storedDecisions = (deps: FakeDeps): DecisionRecord[] =>
  (JSON.parse(deps.files.get(DECISIONS) ?? '{"records":[]}') as { records: DecisionRecord[] }).records;

const placeOf = async (deps: Deps, root = ROOT, node = NODE): Promise<DecisionPlace> => {
  const place = await decisionPlaceOf(deps, root, node);
  if (!place.ok) throw new Error(place.error.message);
  return place.value;
};

const decisionInput = (overrides: Partial<DecisionInput> = {}): DecisionInput => ({
  id: ID,
  option: 'a',
  hash: HASH,
  at: AT,
  ...overrides,
});

const put = async (deps: Deps, overrides: Partial<DecisionInput> = {}, root = ROOT, node = NODE) =>
  putDecision(deps, await placeOf(deps, root, node), decisionInput(overrides));

const sessionEnv = { XDG_STATE_HOME: STATE, HOME: '/home/me', [env.session]: 'demo' };
const claudeEnv = { XDG_STATE_HOME: STATE, HOME: '/home/me', [env.claudeCode]: '1' };

describe('the decide channel', () => {
  it('lets a person with a terminal window for input and for output through', () => {
    expect(requireDecideChannel(person())).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['a factory session', { env: sessionEnv }],
    ['a Claude Code session', { env: claudeEnv }],
    ['no terminal window for input', { stdinIsTTY: false }],
    ['no terminal window for output', { stdoutIsTTY: false }],
  ])('exits 4 with %s, and the remedy names decide', (_name, options: Options) => {
    const result = requireDecideChannel(person(options));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: expect.stringContaining(`factory ${commands.decide}`) } });
  });

  it('checks in order: the factory session, then Claude Code, then input, then output', () => {
    const both = requireDecideChannel(person({ env: { ...sessionEnv, [env.claudeCode]: '1' }, stdinIsTTY: false, stdoutIsTTY: false }));
    expect(both).toMatchObject({ ok: false, error: { message: expect.stringContaining('factory session') } });
    const claude = requireDecideChannel(person({ env: claudeEnv, stdinIsTTY: false, stdoutIsTTY: false }));
    expect(claude).toMatchObject({ ok: false, error: { message: expect.stringContaining('Claude Code') } });
    const input = requireDecideChannel(person({ stdinIsTTY: false, stdoutIsTTY: false }));
    expect(input).toMatchObject({ ok: false, error: { message: expect.stringContaining('input') } });
  });

  it('does not count an empty CLAUDECODE as a Claude Code session', () => {
    expect(requireDecideChannel(person({ env: { ...claudeEnv, [env.claudeCode]: '' } }))).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['CLAUDECODE set', { env: claudeEnv }],
    ['a factory session', { env: sessionEnv }],
    ['stdout not a terminal', { stdoutIsTTY: false }],
    ['stdin not a terminal', { stdinIsTTY: false }],
  ])('makes the writer run the same check itself: %s exits 4 and the file stays the same', async (_name, options: Options) => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ id: 'D-9' })]);
    const before = deps.files.get(DECISIONS);
    const place = await placeOf(deps);
    const refused = person(options);
    refused.seed(DECISIONS, before ?? '');
    const result = await putDecision(refused, place, decisionInput());
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(refused.files.get(DECISIONS)).toBe(before);
    expect(refused.atomicWrites).toEqual([]);
    expect(refused.files.has(DECISIONS_LOCK)).toBe(false);
  });
});

describe('the place of the decision file', () => {
  it('is a file in the state folder, with the real path of the root and the node id', async () => {
    const place = await placeOf(person());
    expect(place).toEqual({ node: NODE, root: ROOT, path: DECISIONS });
  });

  it('has a null path when no variable names a state folder', async () => {
    const place = await placeOf(person({ env: {} }));
    expect(place.path).toBeNull();
  });

  it('refuses a place inside the factory folder, exit 4', async () => {
    const result = await decisionPlaceOf(person({ env: { XDG_STATE_HOME: `${ROOT}/state`, HOME: '/home/me' } }), ROOT, NODE);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('gives an error for a root that does not exist', async () => {
    expect(await decisionPlaceOf(person(), '/w/missing', NODE)).toMatchObject({ ok: false });
  });
});

describe('the decision writer', () => {
  it('writes one record with the node id, the real root, the D-n, the option, the hash and the time, and no note', async () => {
    const deps = person();
    expect(await put(deps)).toEqual({ ok: true, value: { outcome: 'stored', warning: null } });
    expect(storedDecisions(deps)).toEqual([{ node: NODE, root: ROOT, id: ID, option: 'a', hash: HASH, at: AT }]);
    expect(Object.keys(storedDecisions(deps)[0] ?? {}).sort()).toEqual(['at', 'hash', 'id', 'node', 'option', 'root']);
    expect(deps.files.get(DECISIONS)).toBe(decisionsText([decisionRecord()]));
  });

  it('makes the file with mode 0600 in a folder of mode 0700', async () => {
    const deps = person();
    await put(deps);
    expect(deps.modes.get(DECISIONS)).toBe(0o600);
    expect(deps.modes.get(FOLDER)).toBe(0o700);
  });

  it('changes nothing for the same option and hash, and says existing', async () => {
    const deps = person();
    await put(deps);
    const before = deps.files.get(DECISIONS);
    expect(await put(deps)).toEqual({ ok: true, value: { outcome: 'existing', warning: null } });
    expect(deps.files.get(DECISIONS)).toBe(before);
  });

  it.each([
    ['another option', { option: 'b' }],
    ['another hash', { hash: requestHashOf('another text') }],
  ])('exits 1 for %s, names the stored option and time, and changes nothing', async (_name, overrides) => {
    const deps = person();
    seedDecisions(deps, [decisionRecord()]);
    const before = deps.files.get(DECISIONS);
    const result = await put(deps, overrides);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    const message = result.ok ? '' : result.error.message;
    expect([ID, '"a"', AT].filter((part) => !message.includes(part))).toEqual([]);
    expect(deps.files.get(DECISIONS)).toBe(before);
  });

  it('keeps the records of another D-n, another node id and another root next to the new one', async () => {
    const deps = person();
    seedDecisions(deps, [
      decisionRecord({ id: 'D-1' }),
      decisionRecord({ node: 'other', option: 'b' }),
      decisionRecord({ root: OTHER_ROOT, option: 'b' }),
    ]);
    expect(await put(deps)).toMatchObject({ ok: true, value: { outcome: 'stored' } });
    expect(storedDecisions(deps)).toHaveLength(4);
  });

  it('is a file of its own: the approval records stay as they are, and each file has its own lock', async () => {
    const deps = person();
    seedStore(deps, [delegation()]);
    const approvals = deps.files.get(STORE);
    deps.seed(STORE_LOCK, 'other\n');
    expect(await put(deps)).toMatchObject({ ok: true });
    expect(deps.files.get(STORE)).toBe(approvals);
    expect(deps.files.get(STORE_LOCK)).toBe('other\n');
    expect(deps.files.has(DECISIONS_LOCK)).toBe(false);
  });

  it('leaves the decision file as it is when an approval record is written', async () => {
    const deps = person();
    await put(deps);
    const decisions = deps.files.get(DECISIONS);
    await setMode(deps, 'merge', delegated);
    expect(deps.files.get(DECISIONS)).toBe(decisions);
  });

  it('exits 1 with a full file, names the file and the cap, and drops no record', async () => {
    const deps = person();
    const full = Array.from({ length: ownerDecisions.maxRecords }, (_, index) => decisionRecord({ id: `D-${index + 10}` }));
    seedDecisions(deps, full);
    const before = deps.files.get(DECISIONS);
    const result = await put(deps);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'failure', message: expect.stringContaining(`${DECISIONS}`) },
    });
    expect(result).toMatchObject({ error: { message: expect.stringContaining(String(ownerDecisions.maxRecords)) } });
    expect(deps.files.get(DECISIONS)).toBe(before);
  });

  it('still gives existing for a record that the full file holds', async () => {
    const deps = person();
    const full = Array.from({ length: ownerDecisions.maxRecords - 1 }, (_, index) => decisionRecord({ id: `D-${index + 10}` }));
    seedDecisions(deps, [...full, decisionRecord()]);
    expect(await put(deps)).toMatchObject({ ok: true, value: { outcome: 'existing' } });
    expect(storedDecisions(deps)).toHaveLength(ownerDecisions.maxRecords);
  });

  it('exits 1 when the new text would be over the size cap, names the file and the cap, and drops nothing', async () => {
    const deps = person();
    // Roots stay under the 4096-character path cap, so the filler root also fits after the last full record.
    const roomy = (index: number): DecisionRecord => decisionRecord({ id: `D-${index + 10}`, root: `/${'r'.repeat(3500)}${index}` });
    const sizeOf = (records: readonly DecisionRecord[]): number => Buffer.byteLength(decisionsText(records), 'utf8');
    const step = sizeOf([roomy(100), roomy(101)]) - sizeOf([roomy(100)]);
    const base = Array.from({ length: Math.floor((ownerDecisions.maxBytes - 300) / step) }, (_, index) => roomy(index));
    const filler = (length: number): DecisionRecord => decisionRecord({ id: 'D-9', node: 'filler', root: `/${'f'.repeat(length)}` });
    const length = ownerDecisions.maxBytes - 30 - sizeOf([...base, filler(0)]);
    const records = [...base, filler(length)];
    expect(sizeOf(records)).toBeLessThanOrEqual(ownerDecisions.maxBytes);
    expect(sizeOf(records)).toBeGreaterThan(ownerDecisions.maxBytes - 60);
    seedDecisions(deps, records);
    const before = deps.files.get(DECISIONS);
    const result = await put(deps);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(String(ownerDecisions.maxBytes)) } });
    expect(result).toMatchObject({ error: { message: expect.stringContaining(DECISIONS) } });
    expect(deps.files.get(DECISIONS)).toBe(before);
  });

  it.each([
    ['bad JSON', '{"schema":1,'],
    ['a record with a note key', JSON.stringify({ schema: 1, records: [{ ...decisionRecord({ id: 'D-9' }), note: 'x' }] })],
    ['another schema number', JSON.stringify({ schema: 2, records: [] })],
    ['a bad option key', JSON.stringify({ schema: 1, records: [decisionRecord({ id: 'D-9', option: 'a b' })] })],
    ['a hash that is not lower case hex', JSON.stringify({ schema: 1, records: [decisionRecord({ id: 'D-9', hash: HASH.toUpperCase() })] })],
    ['an id with a leading zero', JSON.stringify({ schema: 1, records: [decisionRecord({ id: 'D-09' })] })],
    ['a root that is not absolute', JSON.stringify({ schema: 1, records: [decisionRecord({ id: 'D-9', root: 'relative' })] })],
    ['two records for one D-n', decisionsText([decisionRecord(), decisionRecord({ option: 'b' })])],
  ])('exits 1 for a file with %s, and leaves it as it was', async (_name, content) => {
    const deps = person();
    deps.seed(DECISIONS, content);
    const result = await put(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.files.get(DECISIONS)).toBe(content);
  });

  it.each([
    ['a file that a group may write', DECISIONS, 0o660],
    ['a folder that a group may write', FOLDER, 0o770],
  ])('refuses %s', async (_name, path, mode) => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ id: 'D-9' })]);
    deps.modes.set(path, mode);
    expect(await put(deps)).toMatchObject({ ok: false });
    expect(storedDecisions(deps)).toHaveLength(1);
  });

  it.each([
    ['file', DECISIONS],
    ['folder', FOLDER],
  ])('refuses a %s that another user owns', async (_name, path) => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ id: 'D-9' })]);
    deps.owners.set(path, 2000);
    expect(await put(deps)).toMatchObject({ ok: false, error: { message: expect.stringContaining('another user') } });
    expect(storedDecisions(deps)).toHaveLength(1);
  });

  it('writes nothing and exits 1 when another process took the lock over', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ id: 'D-9' })]);
    const before = deps.files.get(DECISIONS);
    const place = await placeOf(deps);
    const taken: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        readTextLimited: async (path, maxBytes) => {
          const read = await deps.fs.readTextLimited(path, maxBytes);
          if (path === DECISIONS) deps.files.set(DECISIONS_LOCK, 'other\n');
          return read;
        },
      },
    };
    const result = await putDecision(taken, place, decisionInput());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure', message: expect.stringContaining(DECISIONS_LOCK) } });
    expect(deps.files.get(DECISIONS)).toBe(before);
    expect(deps.files.get(DECISIONS_LOCK)).toBe('other\n');
  });

  it('counts a saved change with a left lock file as saved, with a warning that names the lock file', async () => {
    const deps = person();
    const place = await placeOf(deps);
    const stuck: FakeDeps = { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove: EBUSY') } };
    const result = await putDecision(stuck, place, decisionInput());
    expect(result).toMatchObject({ ok: true, value: { outcome: 'stored', warning: expect.stringContaining(DECISIONS_LOCK) } });
    expect(storedDecisions(deps)).toEqual([decisionRecord()]);
  });

  it('keeps the outcome existing when the lock file is left', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord()]);
    const place = await placeOf(deps);
    const stuck: FakeDeps = { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove: EBUSY') } };
    expect(await putDecision(stuck, place, decisionInput())).toMatchObject({
      ok: true,
      value: { outcome: 'existing', warning: expect.stringContaining(DECISIONS_LOCK) },
    });
  });

  it('exits 1 and writes nothing when no variable names a state folder', async () => {
    const deps = person({ env: {} });
    const result = await put(deps);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.atomicWrites).toEqual([]);
  });

  it.each([
    ['an id with a leading zero', { id: 'D-05' }],
    ['an option that is not a token', { option: 'a b' }],
    ['a hash that is not lower case hex', { hash: HASH.toUpperCase() }],
    ['a time that is not ISO', { at: 'yesterday' }],
  ])('refuses %s before it writes, so the file stays readable', async (_name, overrides) => {
    const deps = person();
    expect(await put(deps, overrides)).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.files.has(DECISIONS)).toBe(false);
  });
});

describe('the proof read', () => {
  it('gives a record with the stored option, D-n, node, root and time when the hash of the row text matches', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ option: 'b' })]);
    const proof = await readDecisionProof(deps, await placeOf(deps), ID, TEXT);
    expect(proof).toEqual({ kind: 'record', node: NODE, root: ROOT, id: ID, option: 'b', at: AT });
  });

  it('hashes the given text itself: the hash of the text as input gives no proof', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord()]);
    expect(await readDecisionProof(deps, await placeOf(deps), ID, HASH)).toMatchObject({ kind: 'mismatch' });
  });

  it('gives a mismatch for an edited row text, with the stored option and time and no proof', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord()]);
    const edited = TEXT.replace('Which path', 'Which road');
    expect(await readDecisionProof(deps, await placeOf(deps), ID, edited)).toEqual({ kind: 'mismatch', option: 'a', at: AT });
  });

  it('gives a mismatch for a record with another hash', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ hash: requestHashOf('another text') })]);
    expect(await readDecisionProof(deps, await placeOf(deps), ID, TEXT)).toMatchObject({ kind: 'mismatch' });
  });

  it('takes the option only from the record: the result has no field that comes from the row', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ option: 'a' })]);
    const proof = await readDecisionProof(deps, await placeOf(deps), ID, TEXT);
    expect(proof).toMatchObject({ kind: 'record', option: 'a' });
    expect(Object.keys(proof).sort()).toEqual(['at', 'id', 'kind', 'node', 'option', 'root']);
  });

  it('gives none, and so no proof, for a D-n that has no record, whatever a log row says', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ id: 'D-9' })]);
    expect(await readDecisionProof(deps, await placeOf(deps), ID, TEXT)).toEqual({ kind: 'none' });
  });

  it('gives none for a missing file and for a null path', async () => {
    const deps = person();
    expect(await readDecisionProof(deps, await placeOf(deps), ID, TEXT)).toEqual({ kind: 'none' });
    const noPlace = person({ env: {} });
    expect(await readDecisionProof(noPlace, await placeOf(noPlace), ID, TEXT)).toEqual({ kind: 'none' });
  });

  it('counts only the records of this node id and this real root', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord({ node: 'other' }), decisionRecord({ root: OTHER_ROOT })]);
    expect(await readDecisionProof(deps, await placeOf(deps), ID, TEXT)).toEqual({ kind: 'none' });
    expect(await readDecisionProof(deps, await placeOf(deps, ROOT, 'other'), ID, TEXT)).toMatchObject({ kind: 'record' });
    expect(await readDecisionProof(deps, await placeOf(deps, OTHER_ROOT), ID, TEXT)).toMatchObject({ kind: 'record' });
  });

  it('reads only the decision file: no other file of the user or of the factory folder', async () => {
    const deps = person();
    seedDecisions(deps, [decisionRecord()]);
    seedStore(deps, [delegation()]);
    deps.seed(`${ROOT}/decision-log.json`, '{"rows":[{"item":"D-3 x","decision":"b","date":"2030-01-01","by":"owner"}]}');
    const place = await placeOf(deps);
    const seen = new Set<string>();
    const watched = withFsWatch(deps, (_method, path) => seen.add(path));
    await readDecisionProof(watched, place, ID, TEXT);
    expect([...seen].filter((path) => path !== DECISIONS && path !== FOLDER)).toEqual([]);
  });

  it('is not part of the board contract: the contract names no proof read and imports no owner record', () => {
    const contract = stripComments(readFileSync(join(__dirname, '..', '..', 'src', 'board', 'contract.ts'), 'utf8'));
    expect(contract).not.toMatch(/readDecisionProof|owner-record/);
  });

  it.each([
    ['bad JSON', '{"schema":1,'],
    ['a schema error', JSON.stringify({ schema: 1, records: [{ node: NODE }] })],
    ['two records for one D-n', decisionsText([decisionRecord(), decisionRecord({ option: 'b' })])],
  ])('gives an error, never none, for a file with %s, and names the file', async (_name, content) => {
    const deps = person();
    deps.seed(DECISIONS, content);
    const proof = await readDecisionProof(deps, await placeOf(deps), ID, TEXT);
    expect(proof).toMatchObject({ kind: 'error', message: expect.stringContaining(DECISIONS) });
  });

  it('gives an error for a file that a group may write, another user owns or that is over the size cap', async () => {
    for (const break_ of [
      (deps: FakeDeps) => deps.modes.set(DECISIONS, 0o660),
      (deps: FakeDeps) => deps.owners.set(DECISIONS, 2000),
      (deps: FakeDeps) => deps.seed(DECISIONS, ' '.repeat(ownerDecisions.maxBytes + 1)),
    ]) {
      const deps = person();
      seedDecisions(deps, [decisionRecord()]);
      break_(deps);
      expect(await readDecisionProof(deps, await placeOf(deps), ID, TEXT)).toMatchObject({ kind: 'error' });
    }
  });
});

describe('the D-n list of the decision records', () => {
  it('gives the D-n of this node id and this real root only', async () => {
    const deps = person();
    seedDecisions(deps, [
      decisionRecord({ id: 'D-2' }),
      decisionRecord({ id: 'D-7', node: 'other' }),
      decisionRecord({ id: 'D-8', root: OTHER_ROOT }),
      decisionRecord({ id: 'D-5' }),
    ]);
    expect(await decisionIdsOf(deps, await placeOf(deps))).toEqual({ ok: true, value: ['D-2', 'D-5'] });
  });

  it('gives an empty list for a missing file and for a null path', async () => {
    const deps = person();
    expect(await decisionIdsOf(deps, await placeOf(deps))).toEqual({ ok: true, value: [] });
    const noPlace = person({ env: {} });
    expect(await decisionIdsOf(noPlace, await placeOf(noPlace))).toEqual({ ok: true, value: [] });
  });

  it('gives an error that names the file and the reason when the file can not be read', async () => {
    const deps = person();
    deps.seed(DECISIONS, 'not json');
    expect(await decisionIdsOf(deps, await placeOf(deps))).toMatchObject({
      ok: false,
      error: expect.stringContaining(DECISIONS),
    });
  });
});

describe('the approval writer, when the lock file stays', () => {
  it('says in its error that the approval record is saved', async () => {
    const deps = person();
    const stuck: FakeDeps = { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove: EBUSY') } };
    const result = await setMode(stuck, 'merge', delegated);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('saved') } });
    expect(result).not.toMatchObject({ error: { message: expect.stringContaining('not updated') } });
    expect(storedRecords(deps)).toHaveLength(1);
  });

  it('keeps the old text when nothing is saved', async () => {
    const deps = person({ stdinIsTTY: true });
    deps.seed(STORE, '{"schema":1,');
    const result = await setMode(deps, 'merge', delegated);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('The approval records were not updated') } });
  });
});
