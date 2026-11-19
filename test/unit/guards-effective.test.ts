import { allOn, guardOn, guardRulesOf } from '../../src/guards/effective.js';
import { describe, expect, it } from 'vitest';
import { withGuards, type Deps } from '../../src/core/deps.js';
import { guardSourceFor } from '../../src/core/guard-source.js';
import { guardsFor } from '../../src/guards/registry.js';
import type { Guard, GuardSource } from '../../src/guards/types.js';
import { commands, guardIds, guardValues } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { softwareRecipe } from '../helpers/blocks.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { GUARD_STORE, GUARDED_HOME, guardedNode, OFF_GUARD, OTHER_HOME, PRE_READ_FAULTS } from '../helpers/guarded-node.js';
import { countReadsOf } from '../helpers/read-count.js';

const guards = guardsFor(softwareRecipe).map((guard): Guard => ({ ...guard, wired: true }));
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
      loosened: [],
    });
  });

  it('keeps unwired guards on even with an off record', () => {
    expect(guardRulesOf(guards.map((guard) => ({ ...guard, wired: false })), { node, root, local, record })).toMatchObject({
      values: Object.fromEntries(guards.map(({ id }) => [id, 'on'])), unmatched: [], loosened: [],
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
  const offSource: GuardSource = { read: async () => ({ home: GUARDED_HOME, values: { [OFF_GUARD]: guardValues.off } }) };
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
});
