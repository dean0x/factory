import * as storeApi from '../../src/core/guard-records.js';
import { guardStorePathOf, requireGuardChannel } from '../../src/core/guard-records.js';
import { sha256Hex } from '../../src/blocks/managed.js';
import { failure } from '../../src/cli/errors.js';
import { ok } from '../../src/core/result.js';
import * as lockApi from '../../src/core/file-lock.js';
import type { GuardRecord } from '../../src/guards/effective.js';
import { guardOf, wiredGuard } from '../../src/guards/build.js';
import { guardIds, guardRecords, privateFile } from '../../src/names.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { describe, expect, it } from 'vitest';
import { userFileLock, userFileLockPath, userStatePathOf } from '../../src/core/private-file.js';
import { commandLines, env, files, guardRecordWords } from '../../src/names.js';
import { createFakeDeps, registerRoot } from '../helpers/fake-deps.js';

const root = '/work/node';
const userHome = '/users/example';
const stateHome = '/state';
const path = `${stateHome}/factory/${files.guardRecords}`;
const folder = `${stateHome}/factory`;
const at = '2030-01-02T03:04:05.678Z';
const guard = wiredGuard(guardOf('test-guard', 'Test guard', 'Test work stays safe.'));
const otherGuard = wiredGuard(guardOf('other-guard', 'Other guard', 'Other work stays safe.'));
const change = [{ guard, value: 'off' as const }];
const record = (values: GuardRecord['values'] = {}, prefix: GuardRecord['prefix'] = null): GuardRecord => ({ node: 'demo', root, values, prefix });
const storeText = (records: readonly GuardRecord[]): string => JSON.stringify({ schema: guardRecords.schema, records });
const fixture = (options: Parameters<typeof createFakeDeps>[0] = {}) => {
  const deps = createFakeDeps({ env: { [env.stateHome]: stateHome }, stdinIsTTY: true, stdoutIsTTY: true, ...options });
  deps.seedDir(root);
  deps.seedDir(stateHome);
  return deps;
};
const config = (local: Readonly<Record<string, 'on' | 'off'>> = { [guard.id]: 'off' }) => {
  const sample = sampleConfig();
  return { ...sample, core: { ...sample.core, guards: local }, entry: { ...sample.entry, guards: [guard, otherGuard] } };
};
/** The fixture with the config on disk and the root in the factory list, so that a local off value has its proof. */
const provedFixture = (options: Parameters<typeof createFakeDeps>[0] = {}) => {
  const deps = fixture(options);
  seedConfig(deps, root, config());
  registerRoot(deps, root, config().core.node.id);
  return deps;
};

describe('the guard record channel', () => {
  it.each([commandLines.guardSet, commandLines.guardConfirm])('checks the channel in order for %s', (command) => {
    const cases = [
      [{ [env.session]: 'node', [env.claudeCode]: '1' }, false, false, guardRecordWords.sessionRefused],
      [{ [env.claudeCode]: '1' }, false, false, guardRecordWords.claudeRefused],
      [{}, false, false, guardRecordWords.inputRequired],
      [{}, true, false, guardRecordWords.outputRequired],
    ] as const;
    for (const [environment, stdinIsTTY, stdoutIsTTY, message] of cases) {
      const deps = createFakeDeps({ env: environment, stdinIsTTY, stdoutIsTTY });
      const result = requireGuardChannel(deps, command);
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(JSON.stringify(result)).toContain(message);
      expect(JSON.stringify(result)).toContain(guardRecordWords.channelRemedy);
      expect(deps.files.size).toBe(0);
    }
  });

  it('accepts terminal input and output outside both session types', () => {
    expect(requireGuardChannel(createFakeDeps({ env: { [env.session]: '', [env.claudeCode]: '' }, stdinIsTTY: true, stdoutIsTTY: true }), commandLines.guardSet))
      .toEqual({ ok: true, value: undefined });
  });
});

describe('the pure guard store place', () => {
  it.each([
    [{ [env.userHome]: userHome, [env.stateHome]: stateHome }, '/state/factory/' + files.guardRecords],
    [{ [env.userHome]: userHome, [env.stateHome]: 'relative' }, '/users/example/.local/state/factory/' + files.guardRecords],
    [{ [env.stateHome]: stateHome }, '/state/factory/' + files.guardRecords],
    [{ [env.userHome]: 'relative' }, null],
    [{}, null],
  ])('finds the place without file access for %j', (environment, path) => {
    const deps = createFakeDeps({ env: environment });
    const noFs = { ...deps, fs: new Proxy(deps.fs, { get: () => { throw new Error('place must not read files'); } }) };
    expect(guardStorePathOf(noFs, root)).toEqual({ path, inside: false });
  });

  it.each([
    [root, 'linux'],
    [`${userHome}/.claude/state`, 'linux'],
    ['/WORK/NODE', 'darwin'],
    ['/USERS/EXAMPLE/.CLAUDE/state', 'darwin'],
  ])('marks a store inside a protected folder at %s', (state, os) => {
    const deps = createFakeDeps({ env: { [env.userHome]: userHome, [env.stateHome]: state }, os });
    expect(guardStorePathOf(deps, root)).toMatchObject({ inside: true });
  });

  it('does not treat a sibling with the same prefix as inside', () => {
    const deps = createFakeDeps({ env: { [env.userHome]: userHome, [env.stateHome]: '/work/node-other' } });
    expect(guardStorePathOf(deps, root)).toMatchObject({ inside: false });
  });

  it('keeps the existing user-state caller refusal and default path', async () => {
    expect(await userStatePathOf(createFakeDeps({ env: { [env.userHome]: userHome } }), files.guardRecords))
      .toEqual({ ok: true, value: `${userHome}/.local/state/factory/${files.guardRecords}` });
    expect(await userStatePathOf(createFakeDeps({ env: { [env.userHome]: userHome, [env.stateHome]: `${userHome}/.claude` } }), files.guardRecords))
      .toMatchObject({ ok: false, error: { kind: 'safety' } });
  });
});

describe('guard store reads and writes', () => {
  it('records only named values and keeps the prefix and other records', async () => {
    const deps = fixture();
    const prefix = { hash: sha256Hex('prefix'), at };
    const kept = { value: 'on' as const, at };
    deps.seed(path, storeText([record({ [otherGuard.id]: kept }, prefix), { ...record(), node: 'other' }]));
    expect(await storeApi.recordGuards(deps, { root, node: 'demo', change })).toEqual(ok({ warning: null }));
    expect(await storeApi.readGuardStore(deps, path)).toEqual(ok([
      record({ [otherGuard.id]: kept, [guard.id]: { value: 'off', at } }, prefix), { ...record(), node: 'other' },
    ]));
    expect(deps.modes.get(path)).toBe(0o600);
    expect(deps.files.get(path)).not.toContain('\n');
  });

  it('refuses a liveness policy in the age-only lock path', async () => {
    const deps = fixture();
    const result = await lockApi.takeAgeLock(deps, `${path}.lock`, {
      attempts: 1, waitMs: 0, staleMs: 1000, takeoverSuffix: '.claim', mode: 0o600, liveness: { startToleranceMs: 0 },
    });
    expect(result.ok).toBe(false);
    expect(deps.files.size).toBe(0);
  });

  it('keeps the store and holder unchanged when the guard lock is busy', async () => {
    const deps = fixture();
    const original = storeText([record()]);
    deps.seed(path, original);
    deps.seed(userFileLockPath(path), 'other-holder\n');
    expect(await storeApi.changeGuardStore(deps, path, () => ok([]))).toEqual({ ok: false, error: guardRecordWords.lockBusy });
    expect(deps.atomicWrites).toEqual([]);
    expect(deps.files.get(path)).toBe(original);
    expect(deps.files.get(userFileLockPath(path))).toBe('other-holder\n');
  });

  it('keeps the store and target unchanged when the guard lock is a link', async () => {
    const deps = fixture({ links: { [userFileLockPath(path)]: '/other/lock' } });
    const original = storeText([record()]);
    deps.seed(path, original);
    deps.seed('/other/lock', 'other-holder\n');
    expect(await storeApi.changeGuardStore(deps, path, () => ok([]))).toEqual({ ok: false, error: guardRecordWords.lockLink });
    expect(deps.atomicWrites).toEqual([]);
    expect(deps.files.get(path)).toBe(original);
    expect(deps.files.get('/other/lock')).toBe('other-holder\n');
    expect(await deps.fs.lstat(userFileLockPath(path))).toEqual(ok('link'));
  });

  it('leaves a fresh age-only lock with its holder', async () => {
    const deps = fixture();
    const lock = userFileLockPath(path);
    deps.seed(lock, 'other-holder\n');
    expect(await lockApi.takeAgeLock(deps, lock, userFileLock)).toEqual(ok({ kind: 'held' }));
    expect(deps.files.get(lock)).toBe('other-holder\n');
    expect(deps.files.has(`${lock}${userFileLock.takeoverSuffix}`)).toBe(false);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('takes over an older age-only lock and saves the record', async () => {
    const deps = fixture();
    deps.seed(path, storeText([record()]));
    const lock = userFileLockPath(path);
    deps.seed(lock, 'other-holder\n');
    deps.advance(userFileLock.staleMs + 1);
    expect(await storeApi.recordGuards(deps, { root, node: 'demo', change })).toEqual(ok({ warning: null }));
    expect(await storeApi.readGuardStore(deps, path)).toEqual(ok([record({ [guard.id]: { value: 'off', at: deps.now().toISOString() } })]));
    expect(deps.atomicWrites).toEqual([path]);
    expect(deps.files.has(lock)).toBe(false);
    expect(deps.files.has(`${lock}${userFileLock.takeoverSuffix}`)).toBe(false);
  });

  it('creates and checks the private folder before the lock', async () => {
    const deps = fixture();
    const seen: string[] = [];
    const watched = { ...deps, fs: { ...deps.fs,
      mkdirOne: async (target: string, mode?: number) => { seen.push(`mkdir:${target}:${mode}`); return deps.fs.mkdirOne(target, mode); },
      lstatInfo: async (target: string) => { seen.push(`check:${target}`); return deps.fs.lstatInfo(target); },
      writeTextExclusive: async (target: string, text: string, mode: number) => { seen.push(`lock:${target}`); return deps.fs.writeTextExclusive(target, text, mode); },
    } };
    expect(await storeApi.recordGuards(watched, { root, node: 'demo', change })).toEqual(ok({ warning: null }));
    const made = seen.indexOf(`mkdir:${folder}:448`);
    const checked = seen.indexOf(`check:${folder}`, made + 1);
    expect(made).toBeGreaterThanOrEqual(0);
    expect(checked).toBeGreaterThan(made);
    expect(seen.indexOf(`lock:${path}${privateFile.lockSuffix}`)).toBeGreaterThan(checked);
    expect(deps.modes.get(folder)).toBe(0o700);
  });

  it.each(['folder-link', 'file-link', 'folder-owner', 'file-owner', 'folder-mode', 'file-mode', 'folder-kind', 'file-kind'])('refuses %s on reads and writes', async (fault) => {
    const linkPlaces: Readonly<Record<string, string>> = { 'folder-link': folder, 'file-link': path };
    const link = linkPlaces[fault];
    const links = link === undefined ? {} : { [link]: '/elsewhere' };
    const deps = fixture({ links });
    const original = storeText([record({ [guard.id]: { value: 'off', at } })]);
    deps.seed(path, original);
    const target = fault.startsWith('folder-') ? folder : path;
    if (fault.endsWith('-owner')) deps.owners.set(target, 99);
    if (fault.endsWith('-mode')) deps.modes.set(target, 0o622);
    if (fault === 'folder-kind') { deps.dirs.delete(folder); deps.files.set(folder, 'file'); }
    if (fault === 'file-kind') { deps.files.delete(path); deps.seedDir(path); }
    expect((await storeApi.readGuardStore(deps, path)).ok).toBe(false);
    expect((await storeApi.recordGuards(deps, { root, node: 'demo', change })).ok).toBe(false);
    expect(deps.atomicWrites).toEqual([]);
    const state = await storeApi.readGuardState(deps, root, config(), 'always');
    expect(state.values[guard.id]).toBe('on');
    expect(state.fault).not.toBeNull();
  });

  it('refuses a link that appears before the open without a target read', async () => {
    const deps = fixture();
    deps.seed(path, storeText([record()]));
    let opened = 0;
    const raced = { ...deps, fs: { ...deps.fs, openCheckedCore: async () => { opened += 1; return ok({ state: 'link' as const }); } } };
    expect((await storeApi.readGuardStore(raced, path)).ok).toBe(false);
    expect(opened).toBe(1);
    expect(deps.atomicWrites).toEqual([]);
  });

  it.each(['otherOwner', 'writableByOthers', 'wrong-kind', 'size'] as const)('refuses an open handle with %s', async (fault) => {
    const deps = fixture();
    deps.seed(path, storeText([record()]));
    const changed = { ...deps, fs: { ...deps.fs, openCheckedCore: async () => ok({
      state: 'refused' as const, fault, info: { kind: 'file' as const, uid: 99, mode: 0o666, mtimeMs: 0, size: 1 }, bytes: 0,
    }) } };
    expect((await storeApi.readGuardStore(changed, path)).ok).toBe(false);
  });

  it.each(['{', '{"schema":1,"records":[],"extra":true}', storeText([record(), record()]), storeText([{ ...record(), prefix: { hash: 'bad', at } }])])('keeps invalid store text unchanged', async (text) => {
    const deps = fixture();
    deps.seed(path, text);
    expect(await storeApi.recordGuards(deps, { root, node: 'demo', change })).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.files.get(path)).toBe(text);
    expect(deps.atomicWrites).toEqual([]);
  });

  it.each(['records', 'bytes'])('refuses the %s cap and keeps the file', async (cap) => {
    const deps = fixture();
    const records = cap === 'records'
      ? Array.from({ length: guardRecords.maxRecords }, (_, index) => ({ ...record(), node: `node-${index}` }))
      : Array.from({ length: 300 }, (_, index) => ({ ...record(), node: `node-${index}`, root: '/' + 'a'.repeat(3400) }));
    let padding = cap === 'bytes' ? guardRecords.maxBytes - 50 - Buffer.byteLength(storeText(records)) : 0;
    const filled = records.map((saved) => {
      const extra = Math.min(padding, 4096 - saved.root.length);
      padding -= extra;
      return { ...saved, root: saved.root + 'a'.repeat(extra) };
    });
    expect(padding).toBe(0);
    const original = storeText(filled);
    deps.seed(path, original);
    const result = await storeApi.recordPrefix(deps, { root, node: 'demo', prefix: 'prefix' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(JSON.stringify(result)).toContain(String(cap === 'records' ? guardRecords.maxRecords : guardRecords.maxBytes));
    expect(JSON.stringify(result)).toContain('doctor');
    expect(deps.files.get(path)).toBe(original);
  });

  it('allows a new record after the full store is moved and resets the old node state', async () => {
    const deps = fixture();
    const old = record({ [guard.id]: { value: 'off', at } }, { hash: sha256Hex('old prefix'), at });
    deps.seed(path, storeText(Array.from({ length: guardRecords.maxRecords }, (_, index) => ({ ...old, node: index === 0 ? 'demo' : `node-${index}` }))));
    expect((await storeApi.recordPrefix(deps, { root, node: 'new-node', prefix: 'new prefix' })).ok).toBe(false);
    expect(await deps.fs.rename(path, `${path}.saved`)).toEqual(ok(undefined));
    expect(await storeApi.recordPrefix(deps, { root, node: 'new-node', prefix: 'new prefix' })).toEqual(ok({ warning: null }));
    expect(await storeApi.readGuardStore(deps, path)).toEqual(ok([{ ...record(), node: 'new-node', prefix: { hash: sha256Hex('new prefix'), at } }]));
    expect(await storeApi.readGuardState(deps, root, config(), 'always')).toMatchObject({ values: { [guard.id]: 'on' }, prefix: null });
  });

  it('keeps the change made when the lock is taken', async () => {
    const deps = fixture();
    deps.seed(path, storeText([record()]));
    const concurrent = { ...deps, fs: { ...deps.fs, writeTextExclusive: async (target: string, text: string, mode: number) => {
      const taken = await deps.fs.writeTextExclusive(target, text, mode);
      if (taken.ok && taken.value) deps.seed(path, storeText([record({ [otherGuard.id]: { value: 'off', at } })]));
      return taken;
    } } };
    expect(await storeApi.recordGuards(concurrent, { root, node: 'demo', change })).toEqual(ok({ warning: null }));
    expect(await storeApi.readGuardStore(deps, path)).toEqual(ok([record({ [guard.id]: { value: 'off', at }, [otherGuard.id]: { value: 'off', at } })]));
  });

  it('does not write after another holder takes the lock', async () => {
    const deps = fixture();
    deps.seed(path, storeText([record()]));
    const raced = { ...deps, fs: { ...deps.fs, openCheckedCore: async (...args: Parameters<NonNullable<typeof deps.fs.openCheckedCore>>) => {
      deps.files.set(`${path}${privateFile.lockSuffix}`, 'another-holder\n');
      return deps.fs.openCheckedCore?.(...args) ?? failure('record core is absent');
    } } };
    expect((await storeApi.recordGuards(raced, { root, node: 'demo', change })).ok).toBe(false);
    expect(deps.atomicWrites).toEqual([]);
    expect(deps.files.get(`${path}${privateFile.lockSuffix}`)).toBe('another-holder\n');
  });

  it('reports a saved record when only lock removal fails', async () => {
    const deps = provedFixture();
    deps.seed(path, storeText([record()]));
    const stuck = { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove lock') } };
    expect(await storeApi.recordGuards(stuck, { root, node: 'demo', change }))
      .toEqual(ok({ warning: guardRecordWords.lockLeft }));
    expect((await storeApi.readGuardState(deps, root, config(), 'always')).values[guard.id]).toBe('off');
  });

  it('refuses an unwired guard without a write', async () => {
    const deps = fixture();
    expect(await storeApi.recordGuards(deps, { root, node: 'demo', change: [{ guard: { ...guard, wired: false }, value: 'off' }] }))
      .toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(deps.files.size).toBe(0);
  });

  it.each(['guards', 'prefix', 'letter case'])('checks the channel before file access for %s', async (kind) => {
    const deps = fixture({ env: { [env.session]: 'node', [env.stateHome]: stateHome } });
    const blocked = { ...deps, fs: new Proxy(deps.fs, { get: () => { throw new Error('channel must run first'); } }) };
    const writes = {
      guards: () => storeApi.recordGuards(blocked, { root, node: 'demo', change }),
      prefix: () => storeApi.recordPrefix(blocked, { root, node: 'demo', prefix: 'prefix' }),
      'letter case': () => storeApi.recordExactRoot(blocked, { root, node: 'demo' }),
    } as const;
    expect(await writes[kind as keyof typeof writes]()).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('changes only the prefix and hashes its exact text', async () => {
    const deps = fixture();
    const values = { [guard.id]: { value: 'off' as const, at } };
    deps.seed(path, storeText([record(values)]));
    expect(await storeApi.recordPrefix(deps, { root, node: 'demo', prefix: ' exact prefix ' })).toEqual(ok({ warning: null }));
    expect(await storeApi.readGuardStore(deps, path)).toEqual(ok([record(values, { hash: sha256Hex(' exact prefix '), at })]));
  });

  it('refuses hidden prefix text with no write', async () => {
    const deps = fixture();
    const result = await storeApi.recordPrefix(deps, { root, node: 'demo', prefix: 'prefix' + String.fromCodePoint(0x200b) });
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(JSON.stringify(result)).toContain('owner.prefix');
    expect(deps.files.size).toBe(0);
  });

  it.each(['missing', 'inside-root', 'inside-claude', 'real-inside'])('refuses a write with %s place', async (place) => {
    const states: Readonly<Record<string, string>> = { 'inside-root': root, 'inside-claude': `${userHome}/.claude`, 'real-inside': stateHome };
    const environment = place === 'missing' ? {} : { [env.userHome]: userHome, [env.stateHome]: states[place] };
    const deps = fixture({ env: environment, links: place === 'real-inside' ? { [stateHome]: root } : {} });
    const result = await storeApi.recordPrefix(deps, { root, node: 'demo', prefix: 'prefix' });
    expect(result).toMatchObject({ ok: false, error: { kind: place === 'missing' ? 'failure' : 'safety' } });
    expect(deps.atomicWrites).toEqual([]);
  });

  it('fails closed when an adapter has no record file cores', async () => {
    const deps = fixture();
    deps.seed(path, storeText([record()]));
    const noCores = { ...deps, fs: { ...deps.fs, openCheckedCore: undefined, writeTextAtomicCore: undefined } };
    expect((await storeApi.readGuardStore(noCores, path)).ok).toBe(false);
    expect((await storeApi.recordPrefix(noCores, { root, node: 'demo', prefix: 'prefix' })).ok).toBe(false);
    expect(deps.atomicWrites).toEqual([]);
  });
});

describe('the letter case rewrite of a record root', () => {
  const folded = root.toUpperCase();
  /** A volume that ignores letter case: the real path of the root in any letter case is the root. */
  const caseBlind = (deps: ReturnType<typeof fixture>) => ({
    ...deps, fs: { ...deps.fs, realpath: async (target: string) => deps.fs.realpath(target.toLowerCase() === root ? root : target) },
  });

  it('writes the one record of the node with the root in other letter case again with the real root, and keeps its values, its prefix and the other records', async () => {
    const deps = fixture();
    const values = { [guard.id]: { value: 'off' as const, at } };
    const prefix = { hash: sha256Hex('prefix'), at };
    const other = { ...record(), node: 'other', root: folded };
    deps.seed(path, storeText([{ ...record(values, prefix), root: folded }, other]));
    expect(await storeApi.recordExactRoot(caseBlind(deps), { root, node: 'demo' })).toEqual(ok({ warning: null }));
    expect(await storeApi.readGuardStore(deps, path)).toEqual(ok([record(values, prefix), other]));
    expect(deps.modes.get(path)).toBe(0o600);
  });

  it('writes nothing when two records of the node differ from the root only in letter case', async () => {
    const deps = fixture();
    deps.seed(path, storeText([{ ...record(), root: folded }, { ...record(), root: '/Work/Node' }]));
    expect(await storeApi.recordExactRoot(caseBlind(deps), { root, node: 'demo' })).toEqual(ok(null));
    expect(deps.atomicWrites).toEqual([]);
  });
});

describe('one guard state read', () => {
  it.each(['on', 'off', 'unwired'] as const)('reads the store only for a wired off in when-off mode: %s', async (value) => {
    const deps = provedFixture();
    let opens = 0;
    deps.seed(path, storeText([record({ [guard.id]: { value: 'off', at } })]));
    const watched = { ...deps, fs: { ...deps.fs, openCheckedCore: async (...args: Parameters<NonNullable<typeof deps.fs.openCheckedCore>>) => {
      opens += 1;
      return deps.fs.openCheckedCore?.(...args) ?? failure('record core is absent');
    } } };
    const state = await storeApi.readGuardState(watched, root, config(value === 'unwired' ? { [guardIds.ownerGo]: 'off' } : { [guard.id]: value }), 'when-off');
    expect(opens).toBe(value === 'off' ? 1 : 0);
    expect(state.values[guard.id]).toBe(value === 'off' ? 'off' : 'on');
    if (value === 'off') expect(state).toMatchObject({ sources: { [guard.id]: 'local' }, since: { [guard.id]: at }, record: true, fault: null });
  });

  it.each(['absent', 'on', 'other-node', 'other-root', 'fault'] as const)('keeps a local off on for %s record', async (kind) => {
    const deps = fixture();
    const saved = record({ [guard.id]: { value: kind === 'on' ? 'on' : 'off', at } });
    const candidate = { ...saved, node: kind === 'other-node' ? 'other' : saved.node, root: kind === 'other-root' ? '/other' : saved.root };
    if (kind !== 'absent') deps.seed(path, kind === 'fault' ? '{' : storeText([candidate]));
    const state = await storeApi.readGuardState(deps, root, config(), 'always');
    expect(state.values[guard.id]).toBe('on');
    expect(state.unmatched).toContain(guard.id);
  });

  it.each([false, true])('uses the exact record or reports a folder fault (exact record: %s)', async (hasExact) => {
    const deps = provedFixture({ os: 'darwin' });
    const saved = record({ [guard.id]: { value: 'off', at } }, { hash: sha256Hex('current prefix'), at });
    const folded = { ...saved, root: root.toUpperCase(), prefix: { hash: sha256Hex('other prefix'), at } };
    deps.seed(path, storeText(hasExact ? [folded, saved] : [folded]));

    const state = await storeApi.readGuardState(deps, root, config(), 'always');
    expect(state).toMatchObject({
      record: hasExact, prefix: hasExact ? saved.prefix : null, fault: hasExact ? null : expect.any(String),
      values: { [guard.id]: hasExact ? 'off' : 'on', [otherGuard.id]: 'on' },
    });
  });

  it('treats no state place as an absent store on a read', async () => {
    const state = await storeApi.readGuardState(fixture({ env: {} }), root, config(), 'always');
    expect(state).toMatchObject({ values: { [guard.id]: 'on' }, record: false, prefix: null, fault: null });
  });

  it('uses the real root for records through an alias', async () => {
    const deps = provedFixture({ links: { '/alias': root } });
    deps.seedDir('/alias');
    // The fake file system resolves a link only for a real path, so the config is also put at the path through the alias.
    seedConfig(deps, '/alias', config());
    expect(await storeApi.recordGuards(deps, { root: '/alias', node: 'demo', change })).toEqual(ok({ warning: null }));
    expect(await storeApi.readGuardStore(deps, path)).toEqual(ok([record({ [guard.id]: { value: 'off', at } })]));
    expect((await storeApi.readGuardState(deps, '/alias', config(), 'always')).values[guard.id]).toBe('off');
  });

  it.each([root, `${userHome}/.claude`, stateHome])('keeps the state-folder remedy for a place fault at %s', async (state) => {
    const deps = fixture({ env: { [env.userHome]: userHome, [env.stateHome]: state }, links: { [stateHome]: root } });
    const found = await storeApi.readGuardState(deps, root, config(), 'always');
    expect(found).toMatchObject({ values: { [guard.id]: 'on' }, record: false, prefix: null,
      fault: guardRecordWords.inside, remedy: guardRecordWords.placeRemedy,
    });
    expect(deps.atomicWrites).toEqual([]);
  });

  it('returns a fault when the root cannot resolve', async () => {
    const deps = fixture();
    const failed = { ...deps, fs: { ...deps.fs, realpath: async () => failure('cannot resolve') } };
    expect(await storeApi.readGuardState(failed, root, config(), 'always')).toMatchObject({ values: { [guard.id]: 'on' }, fault: expect.any(String) });
  });
});
