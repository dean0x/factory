import { allOn, guardRulesOf } from '../../src/guards/effective.js';
import { describe, expect, it } from 'vitest';
import { guardsFor } from '../../src/guards/registry.js';
import type { Guard } from '../../src/guards/types.js';
import { softwareRecipe } from '../helpers/blocks.js';

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
