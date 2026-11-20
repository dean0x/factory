import { basename, dirname, resolve } from 'node:path';
import type { ProxyConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { dirs, guardStartWords, guardValues, keys } from '../names.js';
import type { Guard, GuardContext, GuardSource, GuardState, GuardValue, GuardValues } from './types.js';

/** An absent value means on. This constant has no file or environment dependency. */
export const allOn: GuardValues = Object.freeze({});

/** The values when no node home was read: every guard is on for every home, and no read was made. */
export const noGuardHome: GuardContext = Object.freeze({ home: null, values: allOn, state: null });

/** A source that gives one read to every site that asks. A command that read the guard state itself gives its sites that read. */
export const guardSourceOf = (context: GuardContext): GuardSource => Object.freeze({ read: async () => context });

/** The source of every command that finds no home, and of every deps that no pre-read changed. It reads no file. */
export const allGuardsOn: GuardSource = guardSourceOf(noGuardHome);

/**
 * True when the read is of the node home that a site acts on. The paths compare exactly, with no letter case fold: on a volume that
 * tells letter case apart, two homes that differ only in letter case are two folders.
 */
export const isReadOf = (deps: Deps, read: GuardContext, home: string): boolean =>
  read.home !== null && resolve(deps.cwd, read.home) === resolve(deps.cwd, home);

/**
 * The effective values for the node home that a site acts on: the values of the pre-read when the site names its home, else every
 * guard on. A caller that has the deps gives these values as a parameter to a site that has none.
 */
export const guardValuesFor = async (deps: Deps, home: string): Promise<GuardValues> => {
  const read = await deps.guards.read();
  return isReadOf(deps, read, home) ? read.values : allOn;
};

/** True unless the values hold the guard off. A site with no deps reads the values that its nearest caller with the deps gives. */
export const isGuardOn = (values: GuardValues, id: string): boolean => values[id] !== guardValues.off;

/** True unless the pre-read found the guard off for the node home that the site acts on. Only a wired guard can be off there. */
export const guardOn = async (deps: Deps, id: string, home: string): Promise<boolean> =>
  isGuardOn(await guardValuesFor(deps, home), id);

/** The node home of a state folder: the folder above it. Null for a folder with another name, for example a staging folder of init. */
export const guardedHomeOf = (stateDir: string): string | null => (basename(stateDir) === dirs.state ? dirname(stateDir) : null);

/** `guardOn` for the node home above a state folder. A folder with another name is no node, so every guard is on there. */
export const guardOnAtState = async (deps: Deps, id: string, stateDir: string): Promise<boolean> => {
  const home = guardedHomeOf(stateDir);
  return home === null || (await guardOn(deps, id, home));
};

export interface RecordedGuardValue {
  readonly value: GuardValue;
  readonly at: string;
}

/** A record key uses the real root, exactly as the file system gives it. */
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

/**
 * True when a value can turn the guard off: the guard is wired, and it is not fixed. A fixed guard has no setting, so every read of
 * the values keeps it on by its fixed mark, whatever its wired mark says.
 */
export const isSettable = (guard: Pick<Guard, 'wired' | 'fixed'>): boolean => guard.wired && !guard.fixed;

/** Only a matching owner record can allow a local off value. A failed load keeps every guard on. */
export const guardRulesOf = (guards: readonly Guard[], facts: GuardFacts): GuardRules => {
  const healthy = facts.loadError !== true && facts.fault == null;
  const record = healthy && facts.record?.node === facts.node && facts.record.root === facts.root ? facts.record : null;
  const states = guards.map((guard) => {
    const settable = isSettable(guard);
    const local = facts.local?.[guard.id] ?? guardValues.on;
    const saved = record?.values[guard.id];
    const shared = facts.shared?.[guard.id] === guardValues.on;
    const matched = healthy && settable && !shared && facts.local?.[guard.id] !== undefined && saved?.value === local;
    const off = matched && local === guardValues.off;
    let source: GuardState['source'] = 'missing';
    if (healthy && settable) {
      if (shared) source = 'shared';
      else if (matched) source = 'local';
      else if (local === guardValues.off) source = 'noRecord';
    } else if (settable && facts.local?.[guard.id] !== undefined) {
      source = 'unread';
    }
    return {
      id: guard.id,
      value: off ? guardValues.off : guardValues.on,
      source,
      since: matched ? saved.at : null,
      unmatched: settable && local !== (saved?.value ?? guardValues.on),
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
