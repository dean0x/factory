import type { ProxyConfig } from '../config/schema.js';
import { guardStartWords, guardValues } from '../names.js';
import type { Guard, GuardState, GuardValue, GuardValues } from './types.js';

/** An absent value means on. This constant has no file or environment dependency. */
export const allOn: GuardValues = Object.freeze({});

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

export interface GuardFacts {
  readonly node: string;
  readonly root: string;
  readonly local?: GuardValues;
  readonly shared?: GuardValues;
  readonly record?: GuardRecord | null;
  readonly loadError?: boolean;
  readonly fault?: string | null;
  readonly proxies?: readonly Pick<ProxyConfig, 'id' | 'on_fail'>[];
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
