import { allOn, guardOn, guardRulesOf, guardSourceOf, isGuardOn } from '../../src/guards/effective.js';
import { describe, expect, it } from 'vitest';
import { withGuards, type Deps } from '../../src/core/deps.js';
import { readGuardState } from '../../src/core/guard-records.js';
import { guardReadOf, guardSourceFor } from '../../src/core/guard-source.js';
import { guardsFor } from '../../src/guards/registry.js';
import type { Guard, GuardSource } from '../../src/guards/types.js';
import { loadConfig } from '../../src/config/load.js';
import { commands, guardIds, guardRecordWords, guardValues, reservedFieldNames } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { softwareRecipe } from '../helpers/blocks.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import {
  GUARD_STORE, GUARDED_HOME, guardedNode, OFF_GUARD, OTHER_HOME, OTHER_NODE_ID, PRE_READ_FAULTS, withFirstConfigReadFault, withGuardsOff,
} from '../helpers/guarded-node.js';
import { countReadsOf } from '../helpers/read-count.js';
import { sampleBoard, sampleConfig, sampleConfigWithBoard } from '../helpers/sample-config.js';

const guards = guardsFor(softwareRecipe).map((guard): Guard => ({ ...guard, wired: true, fixed: false }));
const node = 'demo';
const root = '/work/demo';
const at = '2026-11-17T00:00:00.000Z';
const local = Object.fromEntries(guards.map(({ id }) => [id, 'off' as const]));
const record = { node, root, values: Object.fromEntries(guards.map(({ id }) => [id, { value: 'off' as const, at }])), prefix: null };

describe('effective guard values', () => {
  it('keeps every guard on without a local value', () => {
    expect(guardRulesOf(guards, { node, root })).toMatchObject({ values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])) });
    expect(allOn).toEqual({});
  });

  it('accepts off only with an off record for the same node and real root', () => {
    expect(guardRulesOf(guards, { node, root, local, record })).toMatchObject({
      values: local,
      sources: Object.fromEntries(guards.map(({ id }) => [id, 'local'])),
      since: Object.fromEntries(guards.map(({ id }) => [id, at])),
      unmatched: [],
      loosened: guards.map(({ id }) => id),
    });
  });

  it.each([
    ['no record', null],
    ['an on record', { ...record, values: Object.fromEntries(guards.map(({ id }) => [id, { value: 'on' as const, at }])) }],
    ['another node', { ...record, node: 'other' }],
    ['another root', { ...record, root: '/work/other' }],
  ])('keeps off requests on with %s', (_name, candidate) => {
    expect(guardRulesOf(guards, { node, root, local, record: candidate })).toMatchObject({
      values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])),
      since: Object.fromEntries(guards.map(({ id }) => [id, null])),
      unmatched: guards.map(({ id }) => id),
      loosened: [],
    });
  });

  it.each([{ loadError: true }, { fault: 'unreadable' }])('fails closed when state cannot load: %j', (fault) => {
    expect(guardRulesOf(guards, { node, root, local, record, ...fault })).toMatchObject({
      values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])),
      sources: Object.fromEntries(guards.map(({ id }) => [id, 'unread'])),
      loosened: [],
    });
  });

  it('keeps unwired guards on even with an off record', () => {
    expect(guardRulesOf(guards.map((guard) => ({ ...guard, wired: false })), { node, root, local, record })).toMatchObject({
      values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])), unmatched: [], loosened: [],
    });
  });

  it('keeps a fixed guard on by its fixed mark, also when it is marked wired and has an off value with a matching record', () => {
    const fixed = guards.map((guard): Guard => ({ ...guard, fixed: true }));
    expect(guardRulesOf(fixed, { node, root, local, record })).toMatchObject({
      values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])),
      sources: Object.fromEntries(guards.map(({ id }) => [id, 'missing'])),
      unmatched: [],
      loosened: [],
    });
  });

  it('lets shared on take precedence over local off and its record', () => {
    expect(guardRulesOf(guards, { node, root, local, shared: Object.fromEntries(guards.map(({ id }) => [id, 'on' as const])), record })).toMatchObject({
      values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])),
      sources: Object.fromEntries(guards.map(({ id }) => [id, 'shared'])),
      loosened: [],
    });
  });

  it('reports the source and time of a matching on record', () => {
    const on = Object.fromEntries(guards.map(({ id }) => [id, 'on' as const]));
    const onRecord = { ...record, values: Object.fromEntries(guards.map(({ id }) => [id, { value: 'on' as const, at }])) };
    expect(guardRulesOf(guards, { node, root, local: on, record: onRecord })).toMatchObject({
      values: on,
      sources: Object.fromEntries(guards.map(({ id }) => [id, 'local'])),
      since: Object.fromEntries(guards.map(({ id }) => [id, at])),
      unmatched: [],
    });
  });

  it('reports a difference in either direction and counts a missing local key as on', () => {
    expect(guardRulesOf(guards, { node, root, record })).toMatchObject({ unmatched: guards.map(({ id }) => id), loosened: [] });
    expect(guardRulesOf(guards, { node, root, local: Object.fromEntries(guards.map(({ id }) => [id, 'on' as const])), record })).toMatchObject({
      values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])), unmatched: guards.map(({ id }) => id),
    });
  });

  it('lists only direct proxies along with off guards', () => {
    expect(guardRulesOf(guards, { node, root, local, record, proxies: [{ id: 'direct', on_fail: 'direct' }, { id: 'closed', on_fail: 'stop' }] })).toMatchObject({
      loosened: [...guards.map(({ id }) => id), 'direct proxy direct'],
    });
  });
});

describe('the guard value of a code site', () => {
  const offSource: GuardSource = { read: async () => ({ home: GUARDED_HOME, values: { [OFF_GUARD]: guardValues.off }, state: null }) };
  const deps = withGuards(createFakeDeps(), offSource);

  it('reads off only for the guard that the pre-read found off', async () => {
    expect(await guardOn(deps, OFF_GUARD, GUARDED_HOME)).toBe(false);
    expect(await guardOn(deps, guardIds.resumeRoutines, GUARDED_HOME)).toBe(true);
  });

  it('reads every guard as on for a site that acts on another home than the pre-read home', async () => {
    expect(await guardOn(deps, OFF_GUARD, OTHER_HOME)).toBe(true);
  });

  it('reads every guard as on with deps that no pre-read changed', async () => {
    expect(await guardOn(createFakeDeps(), OFF_GUARD, GUARDED_HOME)).toBe(true);
  });
});

describe('the pre-read of the guard values', () => {
  const sourceOf = (deps: Deps): GuardSource => guardSourceFor(deps, GUARDED_HOME, recipes, commands.status);
  const offIn = async (deps: Deps, source: GuardSource): Promise<boolean> => !(await guardOn(withGuards(deps, source), OFF_GUARD, GUARDED_HOME));

  it('reads nothing before the first ask, then gives the off value of a matching record with one store read for every ask', async () => {
    const counted = countReadsOf(guardedNode(), GUARD_STORE);
    const source = sourceOf(counted.deps);
    expect(counted.count()).toBe(0);
    expect([await offIn(counted.deps, source), await offIn(counted.deps, source)]).toEqual([true, true]);
    expect(counted.count()).toBe(1);
  });

  it.each(PRE_READ_FAULTS)('gives every guard on and prints nothing with %s', async (_name, fault) => {
    const node = guardedNode();
    const deps = fault(node);
    expect(await offIn(deps, sourceOf(deps))).toBe(false);
    expect(node.warned).toEqual([]);
    expect(node.written).toEqual([]);
  });

  it('gives every guard on and names the reason when only the proof finds that the factory list names another node id', async () => {
    const deps = withFirstConfigReadFault(guardedNode({}, { listed: OTHER_NODE_ID }));
    const source = sourceOf(deps);
    const read = await source.read();
    expect(read.values).toEqual(allOn);
    expect(read.state).toMatchObject({ proof: guardRecordWords.unproved });
    expect(await offIn(deps, source)).toBe(false);
  });
});

describe('a key of a fixed guard that the owner wrote by hand', () => {
  const sample = sampleConfig();
  const shared = { ...sample, core: { ...sample.core, shared_guards: { [guardIds.cloneRules]: guardValues.on } } };
  it.each([
    ['the local file, with the value off and a matching record', guardedNode({}, { off: [guardIds.cloneRules, OFF_GUARD] })],
    ['the shared file', guardedNode({}, { config: shared })],
  ])('keeps the fixed guard on in the full load, the pre-read and the proof, and keeps the off value of another guard: %s', async (_name, deps) => {
    const loaded = await loadConfig(deps, GUARDED_HOME, recipes);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const read = await guardSourceFor(deps, GUARDED_HOME, recipes, commands.status).read();
    const state = await readGuardState(deps, GUARDED_HOME, loaded.value, 'always');
    for (const values of [read.values, state.values]) {
      expect(isGuardOn(values, guardIds.cloneRules)).toBe(true);
      expect(isGuardOn(values, OFF_GUARD)).toBe(false);
    }
    expect(state.unmatched).toEqual([]);
  });
});

describe('the proof of an off value with a check of the config parse', () => {
  const withField = (name: string) => {
    const board = sampleBoard();
    return sampleConfigWithBoard({ ...board, fields: [...(board.fields ?? []), { name, target: 'item', kind: 'token', required: false }] });
  };
  const readOf = async (name: string, off: readonly string[] = [OFF_GUARD]) => {
    const deps = guardedNode({}, { config: withField(name), off });
    return { loaded: await loadConfig(deps, GUARDED_HOME, recipes), read: await guardSourceFor(deps, GUARDED_HOME, recipes, commands.status).read() };
  };

  it('gives the off value of a matching record when the board field name is free', async () => {
    const { loaded, read } = await readOf('effort');
    expect(loaded.ok).toBe(true);
    expect(isGuardOn(read.values, OFF_GUARD)).toBe(false);
  });

  it('keeps every guard on with a matching record when the config holds a reserved board field name', async () => {
    const { loaded, read } = await readOf(reservedFieldNames[0] ?? '');
    expect(loaded.ok).toBe(false);
    expect(guards.filter((guard) => !isGuardOn(read.values, guard.id)).map((guard) => guard.id)).toEqual([]);
    expect(read.state).toMatchObject({ proof: guardRecordWords.unproved });
  });

  it('gives the board edits guard off with a matching record only when the config loads: its field name check runs before the values', async () => {
    const free = await readOf('effort', [guardIds.boardEdits]);
    expect(free.loaded.ok).toBe(true);
    expect(isGuardOn(free.read.values, guardIds.boardEdits)).toBe(false);
    const reserved = await readOf(reservedFieldNames[0] ?? '', [guardIds.boardEdits]);
    expect(reserved.loaded.ok).toBe(false);
    expect(guards.filter((guard) => !isGuardOn(reserved.read.values, guard.id)).map((guard) => guard.id)).toEqual([]);
    expect(reserved.read.state).toMatchObject({ proof: guardRecordWords.unproved });
  });
});

describe('the one owner of the guard decision', () => {
  const config = withGuardsOff(sampleConfig(), [OFF_GUARD]);

  it('gives a direct call the off value only with its proof, and its deps give the same value to each site', async () => {
    const proved = await guardReadOf(guardedNode(), GUARDED_HOME, config, 'when-off');
    expect(proved.state).toMatchObject({ values: { [OFF_GUARD]: guardValues.off }, proof: null });
    expect(await guardOn(proved.deps, OFF_GUARD, GUARDED_HOME)).toBe(false);
    const unproved = await guardReadOf(guardedNode({}, { listed: OTHER_NODE_ID }), GUARDED_HOME, config, 'when-off');
    expect(unproved.state).toMatchObject({ values: { [OFF_GUARD]: guardValues.on }, proof: guardRecordWords.unproved });
    expect(await guardOn(unproved.deps, OFF_GUARD, GUARDED_HOME)).toBe(true);
  });

  it('keeps every guard on with the store facts and names the reason when the read of the command line is of another home', async () => {
    const deps = guardedNode();
    const other = await guardSourceFor(deps, GUARDED_HOME, recipes, commands.status).read();
    expect(other.values).toMatchObject({ [OFF_GUARD]: guardValues.off });
    const read = await guardReadOf(withGuards(deps, guardSourceOf({ ...other, home: OTHER_HOME })), GUARDED_HOME, config, 'always');
    expect(read.state).toMatchObject({ values: { [OFF_GUARD]: guardValues.on }, record: true, proof: guardRecordWords.otherHome });
    expect(await guardOn(read.deps, OFF_GUARD, GUARDED_HOME)).toBe(true);
  });

  it('keeps every guard on when the read of the command line found no off value and the config of the command has one', async () => {
    const deps = guardedNode();
    const state = await readGuardState(deps, GUARDED_HOME, sampleConfig(), 'when-off');
    const own = withGuards(deps, guardSourceOf({ home: GUARDED_HOME, values: state.values, state }));
    const read = await guardReadOf(own, GUARDED_HOME, config, 'always');
    expect(read.state).toMatchObject({ values: { [OFF_GUARD]: guardValues.on }, record: true, recordCount: 1, proof: null });
    expect(await guardOn(read.deps, OFF_GUARD, GUARDED_HOME)).toBe(true);
  });
});
