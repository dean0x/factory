import { inspectGuardConfig, readNodeIdentity } from '../config/load.js';
import { guardValues, guardRecordWords, type CommandName } from '../names.js';
import { allOn, guardSourceOf, isReadOf } from '../guards/effective.js';
import type { GuardContext, GuardNeed, GuardSource } from '../guards/types.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { withGuards, type Deps } from './deps.js';
import { readGuardState, readsStore, unprovedState, type GuardConfig, type GuardReadState } from './guard-records.js';
import { locateHome, type NodeIdReader } from './home.js';

/** A read with no facts of the node: every guard is on for every home, and the state keeps the reason. */
const unproved = (reason: string): GuardContext => ({ home: null, values: allOn, state: unprovedState(reason) });

/**
 * The pre-read: the home in the order of the command (the home flag, FACTORY_HOME, the nearest config, the home index) with its
 * registration check, then the guard keys of the two config files, then `readGuardState`, which proves an off value. It reads no
 * work copy and no child node. Every check of the read runs with every guard on, because no value is known before it. A fault of
 * any kind gives every guard on: a throw, and also a failed read of the node id in the registration check, which that check
 * itself lets pass. No later step of the read can undo such a fault.
 */
const preReadGuards = async (deps: Deps, homeFlag: string | undefined, registry: RecipeRegistry, command: CommandName): Promise<GuardContext> => {
  // The read prints nothing: a warning of a step never reaches the person.
  const quiet: Deps = { ...deps, warn: () => undefined };
  try {
    const faults: string[] = [];
    const readId: NodeIdReader = async (readDeps, home) => {
      const identity = await readNodeIdentity(readDeps, home, registry);
      if (!identity.ok) faults.push(identity.error);
      return identity;
    };
    const located = await locateHome(quiet, homeFlag, readId, command);
    if (!located.ok || faults.length > 0) return unproved(guardRecordWords.unproved);
    const { home } = located.value;
    const narrow = await inspectGuardConfig(quiet, home, registry);
    if (!narrow.ok) return unproved(guardRecordWords.unproved);
    const state = await readGuardState(quiet, home, narrow.value, 'when-off');
    return { home, values: state.values, state };
  } catch {
    return unproved(guardRecordWords.unproved);
  }
};

/**
 * The guard source of one command line. The pre-read runs at most once, at the first ask, and every later ask gets the same
 * values. A command that asks for no value, for example one that refuses its words, reads no file for it.
 */
export const guardSourceFor = (deps: Deps, homeFlag: string | undefined, registry: RecipeRegistry, command: CommandName): GuardSource => {
  let pending: Promise<GuardContext> | null = null;
  return {
    read: () => {
      pending ??= preReadGuards(deps, homeFlag, registry, command);
      return pending;
    },
  };
};

/** The one guard read of a command, and the deps that give it to every later step and site. */
export interface GuardRead {
  readonly deps: Deps;
  readonly state: GuardReadState;
}

const installed = (deps: Deps, home: string, state: GuardReadState): GuardRead =>
  ({ deps: withGuards(deps, guardSourceOf({ home, values: state.values, state })), state });

/** The config with no local off value: a read of it can add the facts of the store, and never an off value. */
const withNoOff = (config: GuardConfig): GuardConfig => ({
  ...config,
  core: { ...config.core, guards: Object.fromEntries(Object.entries(config.core.guards).filter(([, value]) => value !== guardValues.off)) },
});

/**
 * The one owner of the guard decision of a command for the home that it acts on. Every policy reader of a command takes its state
 * here. The read of the command line comes first: when it is of this home and holds what `need` asks, it is the state. For
 * another home, a read with no facts or a read with no store facts, the state keeps every guard on: one read of `config` with no
 * off value adds the store facts, and the reason stays. Only deps whose command line made no read (a direct call) read here, once,
 * with the proof of `readGuardState`. The prefix check and the record checks use the store fields, never the values.
 */
export const guardReadOf = async (deps: Deps, home: string, config: GuardConfig, need: GuardNeed): Promise<GuardRead> => {
  const read = await deps.guards.read();
  if (read.state === null) return installed(deps, home, await readGuardState(deps, home, config, need));
  const own = isReadOf(deps, read, home);
  if (own && (need === 'when-off' || readsStore(read.state))) return { deps, state: read.state };
  const kept = await readGuardState(deps, home, withNoOff(config), need);
  return installed(deps, home, { ...kept, proof: read.state.proof ?? (own ? null : guardRecordWords.otherHome) });
};
