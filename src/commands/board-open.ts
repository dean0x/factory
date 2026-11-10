import type { LocalBoard } from '../board/contract.js';
import { createLocalBoard } from '../board/local.js';
import type { CliResult } from '../cli/errors.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import type { CommandName } from '../names.js';
import { queueKeyOf, type RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';

/** The board of one node: its folder, its config and its connector. */
export interface OpenBoard {
  readonly home: string;
  readonly config: FactoryConfig;
  readonly connector: LocalBoard;
}

/**
 * Find the node folder, load its config and build the board connector for it. `command` is the command that a stop of the
 * connector tells the person to run again. The tracker kind of the config decides whether a write is allowed: only the kind `local`
 * writes. Every command that reads or changes the board opens it here.
 */
export const openBoard = async (
  deps: Deps,
  homeFlag: string | undefined,
  registry: RecipeRegistry,
  command: CommandName,
): Promise<CliResult<OpenBoard>> => {
  const located = await locateHomeFolder(
    deps,
    homeFlag,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    command,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const config = loaded.value;
  const connector = createLocalBoard(deps, layoutOf(home), {
    queueKey: queueKeyOf(config.entry),
    recipe: config.entry.board,
    config: config.core.board,
    command,
    tracker: config.core.tracker.kind,
  });
  return ok({ home, config, connector });
};
