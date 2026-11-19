import { resolve } from 'node:path';
import type { ProxyConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { comparable } from '../core/paths.js';
import { guardStartWords, guardValues, keys } from '../names.js';
import type { Guard, GuardContext, GuardSource, GuardState, GuardValue, GuardValues } from './types.js';

/** An absent value means on. This constant has no file or environment dependency. */
export const allOn: GuardValues = Object.freeze({});

/** The values when no node home was read: every guard is on for every home. */
export const noGuardHome: GuardContext = Object.freeze({ home: null, values: allOn });

/** The source of every command that finds no home, and of every deps that no pre-read changed. It reads no file. */
export const allGuardsOn: GuardSource = Object.freeze({ read: async () => noGuardHome });

/**
 * The effective values for the node home that a site acts on: the values of the pre-read when the site names its home, else every
 * guard on. A caller that has the deps gives these values as a parameter to a site that has none.
 */
export const guardValuesFor = async (deps: Deps, home: string): Promise<GuardValues> => {
  const read = await deps.guards.read();
  const same = read.home !== null && comparable(deps, resolve(deps.cwd, read.home)) === comparable(deps, resolve(deps.cwd, home));
  return same ? read.values : allOn;
};

/** True unless the values hold the guard off. A site with no deps reads the values that its nearest caller with the deps gives. */
export const isGuardOn = (values: GuardValues, id: string): boolean => values[id] !== guardValues.off;

/** True unless the pre-read found the guard off for the node home that the site acts on. Only a wired guard can be off there. */
export const guardOn = async (deps: Deps, id: string, home: string): Promise<boolean> =>
  isGuardOn(await guardValuesFor(deps, home), id);

export interface RecordedGuardValue {
  readonly value: GuardValue;
  readonly at: string;
}

/** A record key uses the real root, in the compared form of the platform. */
export interface GuardRecord {
  readonly node: string;
  readonly root: string;
  readonly values: Readonly<Record<string, RecordedGuardValue>>;
  readonly prefix: { readonly hash: string; readonly at: string } | null;
}

/** The proxies of a node, as the list of loosened guards names them. */
export type GuardProxies = readonly Pick<ProxyConfig, typeof keys.proxy.id | typeof keys.proxy.onFail>[];

export interface GuardFacts {
  readonly node: string;
  readonly root: string;
  readonly local?: GuardValues;
  readonly shared?: GuardValues;
  readonly record?: GuardRecord | null;
  readonly loadError?: boolean;
  readonly fault?: string | null;
  readonly proxies?: GuardProxies;
}

export interface GuardRules {
  readonly values: GuardValues;
  readonly sources: Readonly<Record<string, GuardState['source']>>;
  readonly since: Readonly<Record<string, string | null>>;
  readonly unmatched: readonly string[];
  readonly loosened: readonly string[];
}

/** Only a matching owner record can allow a local off value. A failed load keeps every guard on. */
export const guardRulesOf = (guards: readonly Guard[], facts: GuardFacts): GuardRules => {
  const healthy = facts.loadError !== true && facts.fault == null;
  const record = healthy && facts.record?.node === facts.node && facts.record.root === facts.root ? facts.record : null;
  const states = guards.map((guard) => {
    const local = facts.local?.[guard.id] ?? guardValues.on;
    const saved = record?.values[guard.id];
    const shared = facts.shared?.[guard.id] === guardValues.on;
    const matched = healthy && guard.wired && !shared && facts.local?.[guard.id] !== undefined && saved?.value === local;
    const off = matched && local === guardValues.off;
    let source: GuardState['source'] = 'missing';
    if (healthy && guard.wired) {
      if (shared) source = 'shared';
      else if (matched) source = 'local';
      else if (local === guardValues.off) source = 'noRecord';
    }
    return {
      id: guard.id,
      value: off ? guardValues.off : guardValues.on,
      source,
      since: matched ? saved.at : null,
      unmatched: guard.wired && local !== (saved?.value ?? guardValues.on),
    };
  });
  return {
    values: Object.fromEntries(states.map((state) => [state.id, state.value])),
    sources: Object.fromEntries(states.map((state) => [state.id, state.source])),
    since: Object.fromEntries(states.map((state) => [state.id, state.since])),
    unmatched: states.filter((state) => state.unmatched).map((state) => state.id),
    loosened: [
      ...states.filter((state) => state.value === guardValues.off).map((state) => state.id),
      ...(facts.proxies ?? []).filter((proxy) => proxy.on_fail === 'direct').map((proxy) => guardStartWords.directProxy(proxy.id)),
    ],
  };
};
