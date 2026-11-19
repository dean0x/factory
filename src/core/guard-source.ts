import { inspectGuardConfig, readNodeIdentity } from '../config/load.js';
import { noGuardHome } from '../guards/effective.js';
import type { GuardContext, GuardSource } from '../guards/types.js';
import type { CommandName } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import type { Deps } from './deps.js';
import { readGuardState } from './guard-records.js';
import { locateHome } from './home.js';

/**
 * The pre-read: the home in the order of the command (the home flag, FACTORY_HOME, the nearest config, the home index) with its
 * registration check, then the guard keys of the two config files, then the guard store when a local value is off. It reads no
 * work copy and no child node. Every check of the read runs with every guard on, because no value is known before it. A fault of
 * any kind, a throw too, gives every guard on.
 */
const preReadGuards = async (deps: Deps, homeFlag: string | undefined, registry: RecipeRegistry, command: CommandName): Promise<GuardContext> => {
  // The read prints nothing: a warning of a step never reaches the person.
  const quiet: Deps = { ...deps, warn: () => undefined };
  try {
    const located = await locateHome(quiet, homeFlag, (readDeps, home) => readNodeIdentity(readDeps, home, registry), command);
    if (!located.ok) return noGuardHome;
    const { home } = located.value;
    const config = await inspectGuardConfig(quiet, home, registry);
    if (!config.ok) return noGuardHome;
    const state = await readGuardState(quiet, home, config.value, 'when-off');
    return state.fault === null ? { home, values: state.values } : noGuardHome;
  } catch {
    return noGuardHome;
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
