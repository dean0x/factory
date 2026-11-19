import { inspectGuardConfig, loadConfig, readNodeIdentity } from '../config/load.js';
import { CONFIG_SCHEMA_VERSION, type FactoryConfig } from '../config/schema.js';
import { noGuardHome } from '../guards/effective.js';
import type { GuardContext, GuardSource } from '../guards/types.js';
import type { CommandName } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import type { Deps } from './deps.js';
import { holdsLocalOff, readGuardState } from './guard-records.js';
import { entryProblemOf, locateHome } from './home.js';
import { ok } from './result.js';

/**
 * The full config of a home whose guard keys hold an off value, read with every guard on. An off value counts only when the full
 * load passes and the factory list names the home with the node id of that load: the registration check does not compare the
 * node id when its own read of the id fails. Else the value is null, and every guard is on.
 */
const provenConfig = async (deps: Deps, home: string, registry: RecipeRegistry): Promise<FactoryConfig | null> => {
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return null;
  const identity = { id: loaded.value.core.node.id, schema: CONFIG_SCHEMA_VERSION };
  const listed = await entryProblemOf(deps, home, async () => ok(identity));
  return listed.ok && listed.value === null ? loaded.value : null;
};

/**
 * The pre-read: the home in the order of the command (the home flag, FACTORY_HOME, the nearest config, the home index) with its
 * registration check, then the guard keys of the two config files. When a local value is off, the full config and its node id in
 * the factory list, then the guard store. It reads no work copy and no child node. Every check of the read runs with every guard
 * on, because no value is known before it. A fault of any kind, a throw too, gives every guard on.
 */
const preReadGuards = async (deps: Deps, homeFlag: string | undefined, registry: RecipeRegistry, command: CommandName): Promise<GuardContext> => {
  // The read prints nothing: a warning of a step never reaches the person.
  const quiet: Deps = { ...deps, warn: () => undefined };
  try {
    const located = await locateHome(quiet, homeFlag, (readDeps, home) => readNodeIdentity(readDeps, home, registry), command);
    if (!located.ok) return noGuardHome;
    const { home } = located.value;
    const narrow = await inspectGuardConfig(quiet, home, registry);
    if (!narrow.ok) return noGuardHome;
    const config = holdsLocalOff(narrow.value) ? await provenConfig(quiet, home, registry) : narrow.value;
    if (config === null) return noGuardHome;
    const state = await readGuardState(quiet, home, config, 'when-off');
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
